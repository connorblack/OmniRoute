// AUTO-GENERATED from docs/openapi.yaml. Do not edit.
import { apiFetch, readApiResponse } from "../api.mjs";
import { emit } from "../output.mjs";
import { readFileSync } from "node:fs";

export function register_model_capability_overrides(parent) {
  const tag = parent.command("model-capability-overrides").description("Model capability overrides endpoints");
  tag.command("delete-api-model-capability-overrides")
    .description("DELETE model capability overrides")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/model-capability-overrides";
      const res = await apiFetch(url, { ...gOpts, method: "DELETE", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-model-capability-overrides")
    .description("GET model capability overrides")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/model-capability-overrides";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("patch-api-model-capability-overrides")
    .description("PATCH model capability overrides")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/model-capability-overrides";
      const res = await apiFetch(url, { ...gOpts, method: "PATCH", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
}
