// AUTO-GENERATED from docs/openapi.yaml. Do not edit.
import { apiFetch, readApiResponse } from "../api.mjs";
import { emit } from "../output.mjs";
import { readFileSync } from "node:fs";

export function register_session_leases(parent) {
  const tag = parent.command("session-leases").description("Session Leases endpoints");
  tag.command("post-api-v1-session-leases")
    .description("Acquire, inspect, renew, or release an exclusive managed connection lease")
    .requiredOption("--body <jsonOrPath>", "JSON body or @path/to/file.json")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/v1/session-leases";
      let body;
      if (opts.body) {
        body = opts.body.startsWith("@")
          ? JSON.parse(readFileSync(opts.body.slice(1), "utf8"))
          : JSON.parse(opts.body);
      }
      const res = await apiFetch(url, { ...gOpts, method: "POST", body, timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
}
