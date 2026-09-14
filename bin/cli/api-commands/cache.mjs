// AUTO-GENERATED from docs/openapi.yaml. Do not edit.
import { apiFetch, readApiResponse } from "../api.mjs";
import { emit } from "../output.mjs";
import { readFileSync } from "node:fs";

export function register_cache(parent) {
  const tag = parent.command("cache").description("Cache endpoints");
  tag.command("delete-api-cache-entries")
    .description("DELETE cache › entries")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/cache/entries";
      const res = await apiFetch(url, { ...gOpts, method: "DELETE", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-cache-entries")
    .description("GET cache › entries")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/cache/entries";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("delete-api-cache-reasoning")
    .description("DELETE cache › reasoning")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/cache/reasoning";
      const res = await apiFetch(url, { ...gOpts, method: "DELETE", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-cache-reasoning")
    .description("GET cache › reasoning")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/cache/reasoning";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
}
