// AUTO-GENERATED from docs/openapi.yaml. Do not edit.
import { apiFetch, readApiResponse } from "../api.mjs";
import { emit } from "../output.mjs";
import { readFileSync } from "node:fs";

export function register_oauth(parent) {
  const tag = parent.command("oauth").description("OAuth endpoints");
  tag.command("get-api-oauth-provider-action-")
    .description("OAuth flow handler")
    .requiredOption("--provider <provider>", "")
    .requiredOption("--action <action>", "")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/{provider}/{action}";
      url = url.replace("{provider}", encodeURIComponent(opts.provider ?? ""));
      url = url.replace("{action}", encodeURIComponent(opts.action ?? ""));
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-oauth-cursor-auto-import")
    .description("Auto-import Cursor OAuth credentials")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/cursor/auto-import";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-oauth-cursor-import")
    .description("Get Cursor import status")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/cursor/import";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-oauth-cursor-import")
    .description("Import Cursor OAuth credentials")
    .requiredOption("--body <jsonOrPath>", "JSON body or @path/to/file.json")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/cursor/import";
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
  tag.command("get-api-oauth-kiro-auto-import")
    .description("Auto-import Kiro OAuth credentials")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/kiro/auto-import";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-oauth-kiro-import")
    .description("Get Kiro import status")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/kiro/import";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-oauth-kiro-import")
    .description("Import Kiro OAuth credentials")
    .requiredOption("--body <jsonOrPath>", "JSON body or @path/to/file.json")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/kiro/import";
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
  tag.command("get-api-oauth-kiro-social-authorize")
    .description("Initiate Kiro social OAuth authorization")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/kiro/social-authorize";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-oauth-kiro-social-exchange")
    .description("Exchange Kiro social OAuth token")
    .requiredOption("--body <jsonOrPath>", "JSON body or @path/to/file.json")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/kiro/social-exchange";
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
  tag.command("post-api-oauth-codex-import-token")
    .description("Import a Codex connection from a bare access token")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/codex/import-token";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-oauth-provider-paste-credentials")
    .description("POST oauth › <provider> › paste credentials")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/{provider}/paste-credentials";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-oauth-cliproxy-import")
    .description("GET oauth › cliproxy import")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/cliproxy-import";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-oauth-cliproxy-import")
    .description("POST oauth › cliproxy import")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/cliproxy-import";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-oauth-codex-import")
    .description("POST oauth › codex › import")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/codex/import";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-oauth-cursor-login-cancel")
    .description("POST oauth › cursor › login › cancel")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/cursor/login/cancel";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-oauth-cursor-login-poll")
    .description("POST oauth › cursor › login › poll")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/cursor/login/poll";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-oauth-cursor-login-start")
    .description("POST oauth › cursor › login › start")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/cursor/login/start";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-oauth-kiro-api-key")
    .description("POST oauth › kiro › api key")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/kiro/api-key";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-oauth-trae-import")
    .description("GET oauth › trae › import")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/trae/import";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-oauth-trae-import")
    .description("POST oauth › trae › import")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/oauth/trae/import";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
}
