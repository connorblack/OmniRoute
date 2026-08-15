/**
 * CursorCliExecutor — routes completions through the local Cursor agent CLI
 * over ACP (Agent Client Protocol), driven by `acpx`.
 *
 * Flow:
 *   1. Discover the live model catalog (see services/cursorCliModels.ts) and
 *      validate the requested model against it.
 *   2. Flatten the OpenAI-shaped `messages[]` into a single prompt string.
 *   3. Spawn `acpx --model <id> cursor exec -f -` and pipe the prompt on stdin.
 *   4. Translate the ACP JSON-RPC frames on stdout into OpenAI-compatible SSE
 *      deltas (stream=true) or a single chat.completion body (stream=false).
 *   5. Kill the subprocess on abort / stream close.
 *
 * ── Why acpx and not api2.cursor.sh ─────────────────────────────────────────
 * The HTTP `cursor` provider posts suffix-form model ids (`claude-sonnet-5-
 * thinking-high`) to api2.cursor.sh, which rejects them. Routing through the
 * agent CLI sidesteps the id-namespace problem entirely — the CLI accepts the
 * ids it advertises — and reuses the operator's existing `cursor-agent login`
 * instead of a separate API credential.
 *
 * ── Why the agent is pinned to "pure model" mode ────────────────────────────
 * ACP is an *agent* protocol: left to its defaults the agent will read files,
 * run terminal commands, and load AGENTS.md / rules / skills from its cwd. None
 * of that is correct for a chat-completions endpoint, where tools belong to the
 * caller and arrive in the request body. Worse, it is a live code-execution
 * surface on the router host driven by third-party prompt text.
 *
 * So every spawn is pinned to:
 *   --deny-all --no-fs --no-terminal --allowed-tools ""   (no capabilities)
 *   --cwd <neutral scratch dir>                           (no repo context)
 *
 * This is a deliberate capability reduction, not an oversight: it makes cursor
 * behave as a model rather than as an agent. Client-supplied `tools` in the
 * request body are consequently NOT executed here.
 *
 * Authentication:
 *   None stored by OmniRoute. Auth is delegated entirely to the host's
 *   `cursor-agent login` session, so the connection is registered with
 *   `authType: "none"` and refreshCredentials() is a no-op.
 *
 *   In a container, set AGENT_CLI_CREDENTIAL_STORE=file and mount the host's
 *   credential; cursor-agent resolves it (linux) at
 *   `${XDG_CONFIG_HOME:-~/.config}/cursor/auth.json`. See docs.
 */

import { spawn } from "node:child_process";
import { BaseExecutor, type ExecuteInput, type ProviderCredentials } from "./base.ts";
import { buildErrorBody, errorResponse, sanitizeErrorMessage } from "../utils/error.ts";
import {
  cursorCliChildEnv,
  getCursorCliModels,
  isCursorCliModelFailure,
  resolveAcpxBin,
  resolveCursorCliCwd,
  resolveCursorCliModel,
} from "../services/cursorCliModels.ts";

const CURSOR_CLI_URL = "acpx://cursor/acp";

type OpenAIMsg = { role?: string; content?: unknown };

/**
 * Build the acpx argv.
 *
 * `model` MUST already be validated against the live catalog by
 * resolveCursorCliModel(). The capability flags are load-bearing security
 * settings, not defaults — see the file header.
 */
export function buildCursorCliArgs(model: string, cwd: string): string[] {
  return [
    "--deny-all",
    "--no-fs",
    "--no-terminal",
    "--allowed-tools",
    "",
    "--format",
    "json",
    "--json-strict",
    "--cwd",
    cwd,
    "--model",
    model,
    "cursor",
    "exec",
    "-f",
    "-",
  ];
}

/**
 * `shell: true` on win32 only: since Node's CVE-2024-27980 fix, spawn() refuses
 * to launch `.cmd` shims without shell interpretation. The argv is a fixed
 * literal list plus an allowlist-validated model, never interpolated into a
 * shell string, so this does not reopen argument injection.
 */
function cursorCliSpawnOptions(stdio: ["pipe", "pipe", "pipe"]) {
  return {
    env: cursorCliChildEnv(),
    stdio,
    shell: process.platform === "win32",
    windowsHide: true,
  };
}

export function buildCursorCliPrompt(messages: OpenAIMsg[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role = String(m.role || "user");
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text") {
          text += String((part as Record<string, unknown>).text || "");
        }
      }
    }
    if (!text.trim()) continue;

    if (role === "system") lines.push(`[System]\n${text}`);
    else if (role === "assistant") lines.push(`[Assistant]\n${text}`);
    else lines.push(`[User]\n${text}`);
  }
  return lines.join("\n\n") || "(empty)";
}

/** ACP stop reasons → OpenAI finish_reason. */
export function mapStopReason(stopReason: unknown): string {
  switch (stopReason) {
    case "max_tokens":
      return "length";
    case "refusal":
      return "content_filter";
    case "cancelled":
    case "end_turn":
    default:
      return "stop";
  }
}

export type CursorCliFrameEvent =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "done"; finishReason: string }
  | { kind: "error"; message: string };

/**
 * Translate one ACP JSON-RPC frame into zero or one executor events.
 *
 * Only `agent_message_chunk` becomes assistant content. The prompt itself also
 * appears on the wire (inside the `session/prompt` request params), so matching
 * on any `text` field would echo the user's own prompt back as output.
 */
export function translateCursorCliFrame(frame: unknown): CursorCliFrameEvent | null {
  if (!frame || typeof frame !== "object") return null;
  const rec = frame as Record<string, unknown>;

  const error = rec.error as Record<string, unknown> | undefined;
  if (error && typeof error === "object") {
    const message = typeof error.message === "string" ? error.message : "Cursor ACP error";
    return { kind: "error", message };
  }

  const result = rec.result as Record<string, unknown> | undefined;
  if (result && typeof result === "object" && "stopReason" in result) {
    return { kind: "done", finishReason: mapStopReason(result.stopReason) };
  }

  if (rec.method !== "session/update") return null;
  const params = rec.params as Record<string, unknown> | undefined;
  const update = params?.update as Record<string, unknown> | undefined;
  if (!update || typeof update !== "object") return null;

  const kind = update.sessionUpdate;
  if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk") return null;

  const content = update.content as Record<string, unknown> | undefined;
  if (!content || content.type !== "text") return null;
  const text = typeof content.text === "string" ? content.text : "";
  if (!text) return null;

  return kind === "agent_thought_chunk" ? { kind: "thought", text } : { kind: "text", text };
}

export class CursorCliExecutor extends BaseExecutor {
  constructor(provider = "cursor-cli") {
    super(provider, {});
  }

  needsRefresh(): boolean {
    return false;
  }

  async refreshCredentials(): Promise<Partial<ProviderCredentials> | null> {
    return null;
  }

  async execute({ model, body, stream, signal, log }: ExecuteInput): Promise<{
    response: Response;
    url: string;
    headers: Record<string, string>;
    transformedBody: unknown;
  }> {
    const b = (body ?? {}) as Record<string, unknown>;
    const messages: OpenAIMsg[] = Array.isArray(b.messages) ? (b.messages as OpenAIMsg[]) : [];
    const promptText = buildCursorCliPrompt(messages);
    const wantsStream = stream !== false;

    // Live catalog — never a hardcoded list. Cursor's lineup is account-scoped
    // and changes without a CLI release.
    const models = await getCursorCliModels({ signal });
    const resolution = resolveCursorCliModel(model, models);
    if (isCursorCliModelFailure(resolution)) {
      const response = wantsStream
        ? buildCursorCliSseError(resolution.error)
        : errorResponse(400, resolution.error);
      return { response, url: CURSOR_CLI_URL, headers: {}, transformedBody: { error: true } };
    }
    // `acpModelId` is the exact advertised id handed to the child process;
    // `echoModel` is what the client asked for and what the response reports.
    const acpModelId = resolution.acpModelId;
    const echoModel = resolution.id;
    const cwd = resolveCursorCliCwd();
    const acpxBin = resolveAcpxBin();

    log?.info?.(
      "CURSOR-CLI",
      `acpx cursor exec → model=${acpModelId}, bin=${acpxBin}, stream=${wantsStream}`
    );

    const response = wantsStream
      ? this.runStreaming(acpxBin, acpModelId, echoModel, cwd, promptText, signal, log)
      : await this.runNonStreaming(acpxBin, acpModelId, echoModel, cwd, promptText, signal, log);

    return {
      response,
      url: CURSOR_CLI_URL,
      headers: {},
      transformedBody: { model: acpModelId, promptLength: promptText.length },
    };
  }

  private spawnAcpx(acpxBin: string, model: string, cwd: string, promptText: string) {
    const child = spawn(
      acpxBin,
      buildCursorCliArgs(model, cwd),
      cursorCliSpawnOptions(["pipe", "pipe", "pipe"])
    );
    // A fast-exiting child delivers EPIPE asynchronously as an 'error' event on
    // stdin, so a try/catch around the write cannot catch it; without this
    // handler an unhandled stream error takes down the process.
    child.stdin?.on("error", () => {});
    try {
      child.stdin?.write(promptText);
      child.stdin?.end();
    } catch {
      /* ignore — 'error'/'close' handlers surface the failure */
    }
    return child;
  }

  private runStreaming(
    acpxBin: string,
    acpModelId: string,
    model: string,
    cwd: string,
    promptText: string,
    signal: AbortSignal | null | undefined,
    log: ExecuteInput["log"]
  ): Response {
    const responseId = `chatcmpl-cursor-cli-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const spawnChild = () => this.spawnAcpx(acpxBin, acpModelId, cwd, promptText);

    const sseStream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const enc = new TextEncoder();
        const emit = (data: string) => controller.enqueue(enc.encode(data));
        let closed = false;
        let roleEmitted = false;
        let finished = false;

        const finish = () => {
          if (finished) return;
          finished = true;
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        };

        const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
          `data: ${JSON.stringify({
            id: responseId,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`;

        const ensureRole = () => {
          if (roleEmitted) return;
          emit(chunk({ role: "assistant", content: "" }, null));
          roleEmitted = true;
        };

        const emitText = (text: string) => {
          ensureRole();
          emit(chunk({ content: text }, null));
        };

        const emitThought = (text: string) => {
          ensureRole();
          emit(chunk({ reasoning_content: text }, null));
        };

        const emitError = (message: string) => {
          emit(`data: ${JSON.stringify(buildErrorBody(502, message))}\n\n`);
          emit("data: [DONE]\n\n");
          finish();
        };

        const emitStop = (finishReason: string) => {
          ensureRole();
          emit(chunk({}, finishReason));
          emit("data: [DONE]\n\n");
          finish();
        };

        let child: ReturnType<typeof spawn>;
        try {
          child = spawnChild();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          emitError(cursorCliFailureMessage(acpxBin, message));
          return;
        }

        if (signal) {
          signal.addEventListener("abort", () => {
            if (!child.killed) child.kill("SIGTERM");
            finish();
          });
        }

        child.on("error", (err: NodeJS.ErrnoException) => {
          emitError(cursorCliFailureMessage(acpxBin, err?.message || String(err)));
        });

        let stderrTail = "";
        let buffer = "";
        let sawDone = false;

        child.stdout?.on("data", (data: Buffer) => {
          buffer += data.toString("utf8");
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            if (!line) continue;
            let frame: unknown;
            try {
              frame = JSON.parse(line);
            } catch {
              continue;
            }
            const event = translateCursorCliFrame(frame);
            if (!event) continue;
            if (event.kind === "text") emitText(event.text);
            else if (event.kind === "thought") emitThought(event.text);
            else if (event.kind === "error") {
              emitError(sanitizeErrorMessage(event.message));
              return;
            } else if (event.kind === "done") {
              sawDone = true;
              emitStop(event.finishReason);
              if (!child.killed) child.kill("SIGTERM");
              return;
            }
          }
        });

        child.stderr?.on("data", (data: Buffer) => {
          const text = data.toString("utf8");
          stderrTail = (stderrTail + text).slice(-2000);
          log?.debug?.("CURSOR-CLI", `stderr: ${text.slice(0, 200)}`);
        });

        child.on("close", (code) => {
          if (finished || sawDone) return;
          if (code !== 0) {
            emitError(
              sanitizeErrorMessage(
                `acpx exited with code ${code}${stderrTail ? `: ${stderrTail}` : ""}`
              )
            );
            return;
          }
          emitStop("stop");
        });
      },
      cancel: () => {
        // Consumer cancelled — the abort listener above kills the child when a
        // signal was supplied.
      },
    });

    return new Response(sseStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  private runNonStreaming(
    acpxBin: string,
    acpModelId: string,
    model: string,
    cwd: string,
    promptText: string,
    signal: AbortSignal | null | undefined,
    log: ExecuteInput["log"]
  ): Promise<Response> {
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = this.spawnAcpx(acpxBin, acpModelId, cwd, promptText);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        resolve(errorResponse(502, cursorCliFailureMessage(acpxBin, message)));
        return;
      }

      let content = "";
      let reasoning = "";
      let finishReason = "stop";
      let stderrTail = "";
      let buffer = "";
      let settled = false;

      const settle = (response: Response) => {
        if (settled) return;
        settled = true;
        if (!child.killed) child.kill("SIGTERM");
        resolve(response);
      };

      if (signal) {
        signal.addEventListener("abort", () => {
          settle(errorResponse(502, sanitizeErrorMessage("Cursor CLI request aborted")));
        });
      }

      child.stdout?.on("data", (data: Buffer) => {
        buffer += data.toString("utf8");
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (!line) continue;
          let frame: unknown;
          try {
            frame = JSON.parse(line);
          } catch {
            continue;
          }
          const event = translateCursorCliFrame(frame);
          if (!event) continue;
          if (event.kind === "text") content += event.text;
          else if (event.kind === "thought") reasoning += event.text;
          else if (event.kind === "error") {
            settle(errorResponse(502, sanitizeErrorMessage(event.message)));
            return;
          } else if (event.kind === "done") {
            finishReason = event.finishReason;
            settle(buildCursorCliCompletion(model, promptText, content, reasoning, finishReason));
            return;
          }
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        const text = data.toString("utf8");
        stderrTail = (stderrTail + text).slice(-2000);
        log?.debug?.("CURSOR-CLI", `stderr: ${text.slice(0, 200)}`);
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        settle(errorResponse(502, cursorCliFailureMessage(acpxBin, err?.message || String(err))));
      });

      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          settle(
            errorResponse(
              502,
              sanitizeErrorMessage(
                `acpx exited with code ${code}${stderrTail ? `: ${stderrTail}` : ""}`
              )
            )
          );
          return;
        }
        settle(buildCursorCliCompletion(model, promptText, content, reasoning, finishReason));
      });
    });
  }
}

function buildCursorCliCompletion(
  model: string,
  promptText: string,
  content: string,
  reasoning: string,
  finishReason: string
): Response {
  const trimmed = content.trim();
  const message: Record<string, unknown> = { role: "assistant", content: trimmed };
  if (reasoning.trim()) message.reasoning_content = reasoning.trim();
  const body = {
    id: `chatcmpl-cursor-cli-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: Math.ceil(promptText.length / 4),
      completion_tokens: Math.ceil(trimmed.length / 4),
      total_tokens: Math.ceil((promptText.length + trimmed.length) / 4),
      estimated: true,
    },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function cursorCliFailureMessage(acpxBin: string, message: string): string {
  if (message.includes("ENOENT") || message.includes("not found")) {
    return (
      `Cursor CLI provider could not start "${acpxBin}". Install acpx and the cursor-agent ` +
      `CLI on the router host, or set ACPX_BIN to an absolute path.`
    );
  }
  return sanitizeErrorMessage(message);
}

/** One-shot SSE error for pre-spawn rejections (no subprocess was started). */
function buildCursorCliSseError(message: string): Response {
  const enc = new TextEncoder();
  const sseStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(`data: ${JSON.stringify(buildErrorBody(400, message))}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(sseStream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
