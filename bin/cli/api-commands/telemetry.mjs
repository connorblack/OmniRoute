// AUTO-GENERATED from docs/openapi.yaml. Do not edit.
import { apiFetch, readApiResponse } from "../api.mjs";
import { emit } from "../output.mjs";
import { readFileSync } from "node:fs";

export function register_telemetry(parent) {
  const tag = parent.command("telemetry").description("Telemetry endpoints");
  tag.command("get-api-telemetry-summary")
    .description("Get telemetry summary")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/telemetry/summary";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-token-health")
    .description("Get token health status")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/token-health";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-v1-explain-routing")
    .description("Routing explainability snapshot")
    .option("--limit <limit>", "Events/quality rows to return; clamped to 1–500 (default 50).")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/v1/explain/routing";
      const qs = new URLSearchParams();
      if (opts.limit != null) qs.set("limit", String(opts.limit));
      if (qs.toString()) url += "?" + qs.toString();
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
}
