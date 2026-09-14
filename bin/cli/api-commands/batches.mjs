// AUTO-GENERATED from docs/openapi.yaml. Do not edit.
import { apiFetch, readApiResponse } from "../api.mjs";
import { emit } from "../output.mjs";
import { readFileSync } from "node:fs";

export function register_batches(parent) {
  const tag = parent.command("batches").description("Batches endpoints");
  tag.command("get-api-batches")
    .description("GET batches")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/batches";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-batches-id-")
    .description("GET batches › <id>")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/batches/{id}";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
}
