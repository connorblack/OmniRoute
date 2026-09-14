// AUTO-GENERATED from docs/openapi.yaml. Do not edit.
import { apiFetch, readApiResponse } from "../api.mjs";
import { emit } from "../output.mjs";
import { readFileSync } from "node:fs";

export function register_models(parent) {
  const tag = parent.command("models").description("Models endpoints");
  tag.command("get-api-v1-models")
    .description("List available models")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/v1/models";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-v1-providers-provider-models")
    .description("List models for a specific provider")
    .requiredOption("--provider <provider>", "Provider id or alias (for example `openai`, `claude`, `cc`).")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/v1/providers/{provider}/models";
      url = url.replace("{provider}", encodeURIComponent(opts.provider ?? ""));
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-models")
    .description("List models (management)")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/models";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-models-alias")
    .description("Create or update a model alias")
    .requiredOption("--body <jsonOrPath>", "JSON body or @path/to/file.json")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/models/alias";
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
  tag.command("get-api-models-catalog")
    .description("Get full model catalog")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/models/catalog";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-v1beta-models")
    .description("List models (Gemini format)")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/v1beta/models";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-v1beta-models-path-")
    .description("Gemini generateContent")
    .requiredOption("--path <path>", "")
    .requiredOption("--body <jsonOrPath>", "JSON body or @path/to/file.json")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/v1beta/models/{path}";
      url = url.replace("{path}", encodeURIComponent(opts.path ?? ""));
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
  tag.command("get-api-models-openrouter-catalog")
    .description("GET models › openrouter catalog")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/models/openrouter-catalog";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-models-test")
    .description("POST models › test")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/models/test";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-models-test-all")
    .description("POST models › test all")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/models/test-all";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
}
