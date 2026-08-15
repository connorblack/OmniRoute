/**
 * cursorAcpTransport — drives `acpx cursor exec` and translates ACP JSON-RPC
 * frames into OpenAI-compatible SSE / chat.completion bodies.
 *
 * Invoked from executors/cursor.ts when a connection selects
 * `providerSpecificData.transport = "acp"`. Model selection, discovery and the
 * spawn environment live in services/cursorAcp.ts.
 */

import { spawn } from "node:child_process";
import { buildErrorBody, errorResponse, sanitizeErrorMessage } from "../utils/error.ts";
import {
  buildCursorAcpArgs,
  cursorAcpChildEnv,
  getCursorAcpModels,
  isCursorAcpModelFailure,
  resolveAcpxBin,
  resolveCursorAcpCwd,
  resolveCursorAcpModel,
} from "./cursorAcp.ts";

export const CURSOR_ACP_URL = "acpx://cursor/acp";

type OpenAIMsg = { role?: string; content?: unknown };

export function buildCursorAcpPrompt(messages: OpenAIMsg[]): string {
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

export type CursorAcpEvent =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "done"; finishReason: string }
  | { kind: "error"; message: string };

/**
 * Translate one ACP JSON-RPC frame into zero or one events.
 *
 * Only `agent_message_chunk` becomes assistant content. The caller's own prompt
 * travels on the same wire inside the `session/prompt` REQUEST, so matching on
 * any `text` field would replay the prompt back as model output.
 */
export function translateCursorAcpFrame(frame: unknown): CursorAcpEvent | null {
  if (!frame || typeof frame !== "object") return null;
  const rec = frame as Record<string, unknown>;

  const error = rec.error as Record<string, unknown> | undefined;
  if (error && typeof error === "object") {
    return {
      kind: "error",
      message: typeof error.message === "string" ? error.message : "Cursor ACP error",
    };
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

export type CursorAcpExecuteInput = {
  model: string;
  body: unknown;
  stream: boolean;
  signal?: AbortSignal | null;
  log?: {
    debug?: (tag: string, message: string) => void;
    info?: (tag: string, message: string) => void;
  } | null;
};

export async function executeCursorAcp({
  model,
  body,
  stream,
  signal,
  log,
}: CursorAcpExecuteInput): Promise<{
  response: Response;
  url: string;
  headers: Record<string, string>;
  transformedBody: unknown;
}> {
  const b = (body ?? {}) as Record<string, unknown>;
  const messages: OpenAIMsg[] = Array.isArray(b.messages) ? (b.messages as OpenAIMsg[]) : [];
  const promptText = buildCursorAcpPrompt(messages);
  const wantsStream = stream !== false;

  const advertised = await getCursorAcpModels({ signal });
  const resolution = resolveCursorAcpModel(model, advertised);
  if (isCursorAcpModelFailure(resolution)) {
    const response = wantsStream
      ? buildSseError(resolution.error)
      : errorResponse(400, resolution.error);
    return { response, url: CURSOR_ACP_URL, headers: {}, transformedBody: { error: true } };
  }

  const acpModelId = resolution.acpModelId;
  const cwd = resolveCursorAcpCwd();
  const acpxBin = resolveAcpxBin();
  log?.info?.("CURSOR-ACP", `acpx cursor exec → model=${acpModelId}, stream=${wantsStream}`);

  const response = wantsStream
    ? runStreaming(acpxBin, acpModelId, model, cwd, promptText, signal, log)
    : await runNonStreaming(acpxBin, acpModelId, model, cwd, promptText, signal, log);

  return {
    response,
    url: CURSOR_ACP_URL,
    headers: {},
    transformedBody: { model: acpModelId, promptLength: promptText.length },
  };
}

function spawnAcpx(acpxBin: string, acpModelId: string, cwd: string, promptText: string) {
  const child = spawn(acpxBin, buildCursorAcpArgs(acpModelId, cwd), {
    env: cursorAcpChildEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
    windowsHide: true,
  });
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

function runStreaming(
  acpxBin: string,
  acpModelId: string,
  echoModel: string,
  cwd: string,
  promptText: string,
  signal: AbortSignal | null | undefined,
  log: CursorAcpExecuteInput["log"]
): Response {
  const responseId = `chatcmpl-cursor-acp-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  const sseStream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const emit = (data: string) => controller.enqueue(enc.encode(data));
      let closed = false;
      let roleEmitted = false;
      let finished = false;
      let sawDone = false;

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
          model: echoModel,
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
        child = spawnAcpx(acpxBin, acpModelId, cwd, promptText);
      } catch (err) {
        emitError(failureMessage(acpxBin, err instanceof Error ? err.message : String(err)));
        return;
      }

      if (signal) {
        signal.addEventListener("abort", () => {
          if (!child.killed) child.kill("SIGTERM");
          finish();
        });
      }

      child.on("error", (err: NodeJS.ErrnoException) => {
        emitError(failureMessage(acpxBin, err?.message || String(err)));
      });

      let stderrTail = "";
      let buffer = "";

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
          const event = translateCursorAcpFrame(frame);
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
        log?.debug?.("CURSOR-ACP", `stderr: ${text.slice(0, 200)}`);
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

function runNonStreaming(
  acpxBin: string,
  acpModelId: string,
  echoModel: string,
  cwd: string,
  promptText: string,
  signal: AbortSignal | null | undefined,
  log: CursorAcpExecuteInput["log"]
): Promise<Response> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnAcpx(acpxBin, acpModelId, cwd, promptText);
    } catch (err) {
      resolve(
        errorResponse(
          502,
          failureMessage(acpxBin, err instanceof Error ? err.message : String(err))
        )
      );
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
        settle(errorResponse(502, sanitizeErrorMessage("Cursor ACP request aborted")));
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
        const event = translateCursorAcpFrame(frame);
        if (!event) continue;
        if (event.kind === "text") content += event.text;
        else if (event.kind === "thought") reasoning += event.text;
        else if (event.kind === "error") {
          settle(errorResponse(502, sanitizeErrorMessage(event.message)));
          return;
        } else if (event.kind === "done") {
          finishReason = event.finishReason;
          settle(buildCompletion(echoModel, promptText, content, reasoning, finishReason));
          return;
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      stderrTail = (stderrTail + text).slice(-2000);
      log?.debug?.("CURSOR-ACP", `stderr: ${text.slice(0, 200)}`);
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      settle(errorResponse(502, failureMessage(acpxBin, err?.message || String(err))));
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
      settle(buildCompletion(echoModel, promptText, content, reasoning, finishReason));
    });
  });
}

function buildCompletion(
  model: string,
  promptText: string,
  content: string,
  reasoning: string,
  finishReason: string
): Response {
  const trimmed = content.trim();
  const message: Record<string, unknown> = { role: "assistant", content: trimmed };
  if (reasoning.trim()) message.reasoning_content = reasoning.trim();
  return new Response(
    JSON.stringify({
      id: `chatcmpl-cursor-acp-${Date.now()}`,
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
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

function failureMessage(acpxBin: string, message: string): string {
  if (message.includes("ENOENT") || message.includes("not found")) {
    return (
      `Cursor ACP transport could not start "${acpxBin}". Install acpx and the cursor-agent ` +
      `CLI on the router host, or set ACPX_BIN to an absolute path.`
    );
  }
  return sanitizeErrorMessage(message);
}

/** One-shot SSE error for pre-spawn rejections (no subprocess was started). */
function buildSseError(message: string): Response {
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
