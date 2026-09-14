// AUTO-GENERATED from docs/openapi.yaml. Do not edit.
import { apiFetch, readApiResponse } from "../api.mjs";
import { emit } from "../output.mjs";
import { readFileSync } from "node:fs";

export function register_tunnels(parent) {
  const tag = parent.command("tunnels").description("Tunnels endpoints");
  tag.command("get-api-tunnels-cloudflared")
    .description("GET tunnels › cloudflared")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/tunnels/cloudflared";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-tunnels-cloudflared")
    .description("POST tunnels › cloudflared")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/tunnels/cloudflared";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-tunnels-ngrok")
    .description("GET tunnels › ngrok")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/tunnels/ngrok";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-tunnels-ngrok")
    .description("POST tunnels › ngrok")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/tunnels/ngrok";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-tunnels-tailscale")
    .description("GET tunnels › tailscale")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/tunnels/tailscale";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-tunnels-tailscale-check")
    .description("GET tunnels › tailscale › check")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/tunnels/tailscale/check";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-tunnels-tailscale-disable")
    .description("POST tunnels › tailscale › disable")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/tunnels/tailscale/disable";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-tunnels-tailscale-enable")
    .description("POST tunnels › tailscale › enable")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/tunnels/tailscale/enable";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-tunnels-tailscale-install")
    .description("POST tunnels › tailscale › install")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/tunnels/tailscale/install";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-tunnels-tailscale-login")
    .description("POST tunnels › tailscale › login")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/tunnels/tailscale/login";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-tunnels-tailscale-start-daemon")
    .description("POST tunnels › tailscale › start daemon")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/tunnels/tailscale/start-daemon";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
}
