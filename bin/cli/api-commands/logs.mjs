// AUTO-GENERATED from docs/openapi.yaml. Do not edit.
import { apiFetch, readApiResponse } from "../api.mjs";
import { emit } from "../output.mjs";
import { readFileSync } from "node:fs";

export function register_logs(parent) {
  const tag = parent.command("logs").description("Logs endpoints");
  tag.command("get-api-logs-id-")
    .description("GET logs › <id>")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/logs/{id}";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-logs-console")
    .description("GET logs › console")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/logs/console";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-logs-detail")
    .description("GET logs › detail")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/logs/detail";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-logs-detail")
    .description("POST logs › detail")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/logs/detail";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-logs-export")
    .description("GET logs › export")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/logs/export";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
}
