// AUTO-GENERATED from docs/openapi.yaml. Do not edit.
import { apiFetch, readApiResponse } from "../api.mjs";
import { emit } from "../output.mjs";
import { readFileSync } from "node:fs";

export function register_v1_antigravity(parent) {
  const tag = parent.command("v1-antigravity").description("V1 Antigravity endpoints");
  tag.command("post-api-v1-antigravity")
    .description("POST antigravity")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/v1/antigravity";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
}
