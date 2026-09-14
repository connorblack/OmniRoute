// AUTO-GENERATED from docs/openapi.yaml. Do not edit.
import { apiFetch, readApiResponse } from "../api.mjs";
import { emit } from "../output.mjs";
import { readFileSync } from "node:fs";

export function register_v1_images(parent) {
  const tag = parent.command("v1-images").description("V1 Images endpoints");
  tag.command("post-api-v1-images-edits")
    .description("POST images › edits")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/v1/images/edits";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-v1-images-upscale")
    .description("GET images › upscale")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/v1/images/upscale";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-v1-images-upscale")
    .description("POST images › upscale")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/v1/images/upscale";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
}
