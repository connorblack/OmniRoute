import { readFileSync, writeFileSync } from "node:fs";
import { apiFetch, readApiResponse } from "../api.mjs";
import { emit } from "../output.mjs";
import { t } from "../i18n.mjs";

function truncate(v, max = 40) {
  if (!v) return "-";
  const s = String(v);
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function toYaml(obj, indent = 0) {
  const pad = "  ".repeat(indent);
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "boolean") return String(obj);
  if (typeof obj === "number") return String(obj);
  if (typeof obj === "string") {
    if (/[\n:#{}[\],&*?|<>=!%@`]/.test(obj) || obj.trim() !== obj) {
      return JSON.stringify(obj);
    }
    return obj || '""';
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    return obj.map((v) => `\n${pad}- ${toYaml(v, indent + 1)}`).join("");
  }
  const entries = Object.entries(obj);
  if (entries.length === 0) return "{}";
  return entries
    .map(([k, v]) => {
      const safeKey = /[^a-zA-Z0-9_-]/.test(k) ? JSON.stringify(k) : k;
      if (v !== null && typeof v === "object") {
        const nested = toYaml(v, indent + 1);
        if (Array.isArray(v) && v.length > 0) return `\n${pad}${safeKey}:${nested}`;
        if (!Array.isArray(v) && Object.keys(v).length > 0) return `\n${pad}${safeKey}:\n${nested}`;
        return `\n${pad}${safeKey}: ${nested}`;
      }
      return `\n${pad}${safeKey}: ${toYaml(v, indent + 1)}`;
    })
    .join("")
    .trimStart();
}

// Keys that live alongside operations inside a Path Item Object but are not
// themselves operations (OpenAPI 3.x Path Item fields).
const NON_OPERATION_PATH_KEYS = new Set([
  "parameters",
  "summary",
  "description",
  "servers",
  "$ref",
]);

/**
 * `GET /api/openapi/spec` answers with a compact catalog
 * (`{ info, servers, tags, endpoints[], schemas }`) rather than an OpenAPI
 * document with a `paths` object, while `dist/docs/openapi.yaml` is a real
 * spec. Normalize either shape into the flat rows the CLI renders so the
 * commands work against both instead of silently printing nothing.
 */
export function extractEndpoints(spec) {
  if (!spec || typeof spec !== "object") return [];

  if (spec.paths && typeof spec.paths === "object") {
    const rows = [];
    for (const [path, pathItem] of Object.entries(spec.paths)) {
      if (!pathItem || typeof pathItem !== "object") continue;
      for (const [method, def] of Object.entries(pathItem)) {
        if (NON_OPERATION_PATH_KEYS.has(method)) continue;
        if (!def || typeof def !== "object") continue;
        rows.push({
          method: method.toUpperCase(),
          path,
          summary: def.summary ?? def.description ?? "",
          operationId: def.operationId,
        });
      }
    }
    return rows;
  }

  if (Array.isArray(spec.endpoints)) {
    return spec.endpoints
      .filter((entry) => entry && typeof entry === "object" && entry.path)
      .map((entry) => ({
        method: String(entry.method ?? "GET").toUpperCase(),
        path: entry.path,
        summary: entry.summary ?? entry.description ?? "",
        operationId: entry.operationId,
      }));
  }

  return [];
}

/** Sorted, de-duplicated list of paths across either shape. */
export function extractPaths(spec) {
  return [...new Set(extractEndpoints(spec).map((row) => row.path))].sort();
}

function matchesSearch(row, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return row.path.includes(query) || String(row.summary).toLowerCase().includes(needle);
}

function validateBasic(spec) {
  if (!spec || typeof spec !== "object") throw new Error("spec is not an object");
  if (!spec.info) throw new Error("missing info object");

  // A real OpenAPI document must carry a version field and a paths object.
  if (spec.openapi || spec.swagger) {
    if (!spec.paths) throw new Error("missing paths object");
    return;
  }

  // The compact catalog served by /api/openapi/spec carries endpoints[] instead.
  if (Array.isArray(spec.endpoints)) return;

  throw new Error("missing openapi/swagger version field and no endpoints[] catalog");
}

const endpointSchema = [
  { key: "method", header: "Method", width: 8 },
  { key: "path", header: "Path", width: 45 },
  { key: "operationId", header: "Operation ID", width: 25 },
  { key: "summary", header: "Summary", width: 40, formatter: (v) => truncate(v, 40) },
];

const RESERVED_REQUEST_HEADERS = new Set(["authorization", "cookie", "x-omniroute-cli-token"]);

function parsePairs(values = []) {
  return values.map((value) => {
    if (Array.isArray(value)) return [String(value[0] ?? ""), String(value[1] ?? "")];
    const raw = String(value);
    const index = raw.indexOf("=");
    return index < 0 ? [raw, ""] : [raw.slice(0, index), raw.slice(index + 1)];
  });
}

export async function runOpenapiTry(path, opts = {}, globalOpts = {}) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new Error("openapi try requires a relative path beginning with /");
  }
  const method = String(opts.method || "GET").toUpperCase();
  const query = new URLSearchParams();
  for (const [key, value] of parsePairs(opts.query)) {
    if (key) query.append(key, value);
  }
  const headers = new Headers();
  for (const [key, value] of parsePairs(opts.header)) {
    const normalized = key.toLowerCase();
    if (RESERVED_REQUEST_HEADERS.has(normalized)) {
      throw new Error(`openapi try reserves the ${normalized} header for context authentication`);
    }
    if (key) headers.set(key, value);
  }
  if ((method === "GET" || method === "HEAD") && opts.body !== undefined) {
    throw new Error(`${method} requests cannot include a body`);
  }
  const suffix = query.size > 0 ? `?${query}` : "";
  const timeout = Number.parseInt(globalOpts.timeout, 10);
  const res = await apiFetch(`${path}${suffix}`, {
    ...globalOpts,
    method,
    body: opts.body,
    headers,
    timeout: Number.isFinite(timeout) ? timeout : undefined,
  });
  const body = await readApiResponse(res);
  return {
    status: res.status,
    statusText: res.statusText || "",
    contentType: res.headers.get("content-type"),
    requestId: res.headers.get("x-request-id") || res.headers.get("x-correlation-id"),
    body,
  };
}

async function fetchSpec(globalOpts) {
  const timeout = Number.parseInt(globalOpts.timeout, 10);
  const res = await apiFetch("/api/openapi/spec", {
    ...globalOpts,
    timeout: Number.isFinite(timeout) ? timeout : undefined,
  });
  return readApiResponse(res);
}

export function registerOpenapi(program) {
  const api = program.command("openapi").description(t("openapi.description"));

  api
    .command("dump")
    .description(t("openapi.dump.description"))
    .option("--format <f>", t("openapi.dump.format"), "yaml")
    .option("--out <path>", t("openapi.dump.out"))
    .action(async (opts, cmd) => {
      const data = await fetchSpec(cmd.optsWithGlobals());
      const serialized =
        opts.format === "yaml" ? toYaml(data) + "\n" : JSON.stringify(data, null, 2);
      if (opts.out) {
        writeFileSync(opts.out, serialized);
        process.stdout.write(`Saved to ${opts.out}\n`);
      } else {
        process.stdout.write(serialized);
      }
    });

  api
    .command("validate")
    .description(t("openapi.validate.description"))
    .action(async (opts, cmd) => {
      const spec = await fetchSpec(cmd.optsWithGlobals());
      try {
        validateBasic(spec);
        process.stdout.write("Spec is valid\n");
      } catch (err) {
        process.stderr.write(`Invalid: ${err.message}\n`);
        process.exit(1);
      }
    });

  api
    .command("try <path>")
    .description(t("openapi.try.description"))
    .option("--method <m>", t("openapi.try.method"), "GET")
    .option("--body <file>", t("openapi.try.body"))
    .option("--query <kv>", t("openapi.try.query"), (v, prev = []) => [...prev, v], [])
    .option("--header <kv>", t("openapi.try.header"), (v, prev = []) => [...prev, v], [])
    .action(async (path, opts, cmd) => {
      const body = opts.body ? JSON.parse(readFileSync(opts.body, "utf8")) : undefined;
      const globalOpts = cmd.optsWithGlobals();
      emit(await runOpenapiTry(path, { ...opts, body }, globalOpts), globalOpts);
    });

  api
    .command("endpoints")
    .description(t("openapi.endpoints.description"))
    .option("--search <q>", t("openapi.endpoints.search"))
    .action(async (opts, cmd) => {
      const spec = await fetchSpec(cmd.optsWithGlobals());
      const rows = extractEndpoints(spec).filter((row) => matchesSearch(row, opts.search));
      emit(rows, cmd.optsWithGlobals(), endpointSchema);
    });

  api
    .command("paths")
    .description(t("openapi.paths.description"))
    .action(async (opts, cmd) => {
      const spec = await fetchSpec(cmd.optsWithGlobals());
      emit(
        extractPaths(spec).map((p) => ({ path: p })),
        cmd.optsWithGlobals()
      );
    });
}
