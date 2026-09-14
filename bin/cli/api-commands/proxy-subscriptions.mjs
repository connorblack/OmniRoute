// AUTO-GENERATED from docs/openapi.yaml. Do not edit.
import { apiFetch, readApiResponse } from "../api.mjs";
import { emit } from "../output.mjs";
import { readFileSync } from "node:fs";

export function register_proxy_subscriptions(parent) {
  const tag = parent.command("proxy-subscriptions").description("Proxy Subscriptions endpoints");
  tag.command("get-api-v1-management-proxy-subscriptions")
    .description("List proxy subscriptions")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/v1/management/proxy-subscriptions";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-v1-management-proxy-subscriptions")
    .description("Create a proxy subscription")
    .requiredOption("--body <jsonOrPath>", "JSON body or @path/to/file.json")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/v1/management/proxy-subscriptions";
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
  tag.command("get-api-v1-management-proxy-subscriptions-id-")
    .description("Get a proxy subscription")
    .requiredOption("--id <id>", "")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/v1/management/proxy-subscriptions/{id}";
      url = url.replace("{id}", encodeURIComponent(opts.id ?? ""));
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("patch-api-v1-management-proxy-subscriptions-id-")
    .description("Update a proxy subscription")
    .requiredOption("--id <id>", "")
    .requiredOption("--body <jsonOrPath>", "JSON body or @path/to/file.json")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/v1/management/proxy-subscriptions/{id}";
      url = url.replace("{id}", encodeURIComponent(opts.id ?? ""));
      let body;
      if (opts.body) {
        body = opts.body.startsWith("@")
          ? JSON.parse(readFileSync(opts.body.slice(1), "utf8"))
          : JSON.parse(opts.body);
      }
      const res = await apiFetch(url, { ...gOpts, method: "PATCH", body, timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("delete-api-v1-management-proxy-subscriptions-id-")
    .description("Delete a proxy subscription")
    .requiredOption("--id <id>", "")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/v1/management/proxy-subscriptions/{id}";
      url = url.replace("{id}", encodeURIComponent(opts.id ?? ""));
      const res = await apiFetch(url, { ...gOpts, method: "DELETE", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-v1-management-proxy-subscriptions-id-nodes")
    .description("Get a subscription's last-parsed node summary")
    .requiredOption("--id <id>", "")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/v1/management/proxy-subscriptions/{id}/nodes";
      url = url.replace("{id}", encodeURIComponent(opts.id ?? ""));
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-v1-management-proxy-subscriptions-id-refresh")
    .description("Refresh a proxy subscription")
    .requiredOption("--id <id>", "")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/v1/management/proxy-subscriptions/{id}/refresh";
      url = url.replace("{id}", encodeURIComponent(opts.id ?? ""));
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
}
