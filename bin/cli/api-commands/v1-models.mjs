// AUTO-GENERATED from docs/openapi.yaml. Do not edit.
import { apiFetch, readApiResponse } from "../api.mjs";
import { emit } from "../output.mjs";
import { readFileSync } from "node:fs";

export function register_v1_models(parent) {
  const tag = parent.command("v1-models").description("V1 Models endpoints");
  tag.command("get-api-v1-models-model-")
    .description("GET models › <model>")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/v1/models/{model}";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
}
