// AUTO-GENERATED from docs/openapi.yaml. Do not edit.
import { apiFetch, readApiResponse } from "../api.mjs";
import { emit } from "../output.mjs";
import { readFileSync } from "node:fs";

export function register_system(parent) {
  const tag = parent.command("system").description("System endpoints");
  tag.command("get-api-v1")
    .description("API v1 root endpoint")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/v1";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-tags")
    .description("List Ollama-compatible model tags")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/tags";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-auth-login")
    .description("Authenticate user")
    .requiredOption("--body <jsonOrPath>", "JSON body or @path/to/file.json")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/auth/login";
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
  tag.command("post-api-auth-logout")
    .description("Log out")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/auth/logout";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-auth-oidc-login")
    .description("Start OIDC login for the dashboard admin gate")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/auth/oidc/login";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-auth-oidc-callback")
    .description("Complete OIDC login for the dashboard admin gate")
    .requiredOption("--code <code>", "")
    .requiredOption("--state <state>", "")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/auth/oidc/callback";
      const qs = new URLSearchParams();
      if (opts.code != null) qs.set("code", String(opts.code));
      if (opts.state != null) qs.set("state", String(opts.state));
      if (qs.toString()) url += "?" + qs.toString();
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-init")
    .description("Initialize application")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/init";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-restart")
    .description("Restart the application")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/restart";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-shutdown")
    .description("Shutdown the application")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/shutdown";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-db-backups")
    .description("List database backups")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/db-backups";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-db-backups")
    .description("Create database backup")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/db-backups";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("patch-api-db-backups")
    .description("Save database backup retention settings")
    .requiredOption("--body <jsonOrPath>", "JSON body or @path/to/file.json")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/db-backups";
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
  tag.command("get-api-storage-health")
    .description("Check storage health")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/storage/health";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-sync-cloud")
    .description("Sync with cloud")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/sync/cloud";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-sync-initialize")
    .description("Initialize cloud sync")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/sync/initialize";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-jobs")
    .description("List registered background jobs")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/jobs";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-jobs-id-enable")
    .description("Enable a background job")
    .requiredOption("--id <id>", "")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/jobs/{id}/enable";
      url = url.replace("{id}", encodeURIComponent(opts.id ?? ""));
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-jobs-id-disable")
    .description("Disable a background job")
    .requiredOption("--id <id>", "")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/jobs/{id}/disable";
      url = url.replace("{id}", encodeURIComponent(opts.id ?? ""));
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-jobs-id-run-now")
    .description("Trigger a background job")
    .requiredOption("--id <id>", "")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/jobs/{id}/run-now";
      url = url.replace("{id}", encodeURIComponent(opts.id ?? ""));
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-jobs-id-runs")
    .description("Read background-job run history")
    .requiredOption("--id <id>", "")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/jobs/{id}/runs";
      url = url.replace("{id}", encodeURIComponent(opts.id ?? ""));
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-log-export-types")
    .description("List log-export destination types")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/log-export/types";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-log-export-destinations")
    .description("List log-export destinations")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/log-export/destinations";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-log-export-destinations")
    .description("Create a log-export destination")
    .requiredOption("--body <jsonOrPath>", "JSON body or @path/to/file.json")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/log-export/destinations";
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
  tag.command("get-api-log-export-destinations-id-")
    .description("Read one log-export destination")
    .requiredOption("--id <id>", "")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/log-export/destinations/{id}";
      url = url.replace("{id}", encodeURIComponent(opts.id ?? ""));
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("put-api-log-export-destinations-id-")
    .description("Update a log-export destination")
    .requiredOption("--id <id>", "")
    .requiredOption("--body <jsonOrPath>", "JSON body or @path/to/file.json")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/log-export/destinations/{id}";
      url = url.replace("{id}", encodeURIComponent(opts.id ?? ""));
      let body;
      if (opts.body) {
        body = opts.body.startsWith("@")
          ? JSON.parse(readFileSync(opts.body.slice(1), "utf8"))
          : JSON.parse(opts.body);
      }
      const res = await apiFetch(url, { ...gOpts, method: "PUT", body, timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("delete-api-log-export-destinations-id-")
    .description("Delete a log-export destination")
    .requiredOption("--id <id>", "")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/log-export/destinations/{id}";
      url = url.replace("{id}", encodeURIComponent(opts.id ?? ""));
      const res = await apiFetch(url, { ...gOpts, method: "DELETE", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-log-export-destinations-id-test")
    .description("Test a log-export destination")
    .requiredOption("--id <id>", "")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/log-export/destinations/{id}/test";
      url = url.replace("{id}", encodeURIComponent(opts.id ?? ""));
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-log-export-destinations-id-run")
    .description("Run a log-export destination now")
    .requiredOption("--id <id>", "")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/log-export/destinations/{id}/run";
      url = url.replace("{id}", encodeURIComponent(opts.id ?? ""));
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-log-export-status")
    .description("Log-export scheduler status")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/log-export/status";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-resilience")
    .description("Get resilience configuration")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/resilience";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("patch-api-resilience")
    .description("Update resilience configuration")
    .requiredOption("--body <jsonOrPath>", "JSON body or @path/to/file.json")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/resilience";
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
  tag.command("get-api-resilience-connections")
    .description("Inspect connection resilience state")
    .option("--window-ms <windowMs>", "")
    .option("--provider <provider>", "")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/resilience/connections";
      const qs = new URLSearchParams();
      if (opts.windowMs != null) qs.set("windowMs", String(opts.windowMs));
      if (opts.provider != null) qs.set("provider", String(opts.provider));
      if (qs.toString()) url += "?" + qs.toString();
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-telegram-update")
    .description("Receive Telegram updates or Mini App messages")
    .requiredOption("--body <jsonOrPath>", "JSON body or @path/to/file.json")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/telegram/update";
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
  tag.command("post-api-resilience-reset")
    .description("Reset circuit breakers")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/resilience/reset";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-health")
    .description("Liveness probe")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/health";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-monitoring-health")
    .description("System health check")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/monitoring/health";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-monitoring-compression")
    .description("Get compression result-memo statistics")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/monitoring/compression";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-rate-limits")
    .description("Get per-account rate limit status")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/rate-limits";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-sessions")
    .description("Get active sessions")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/sessions";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-cache")
    .description("Get cache statistics")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/cache";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("delete-api-cache")
    .description("Clear all caches")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/cache";
      const res = await apiFetch(url, { ...gOpts, method: "DELETE", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-modality-bridge-stats")
    .description("Get Modality Bridge telemetry")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/modality-bridge/stats";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-modality-bridge-video-runtime")
    .description("Get Video Bridge runtime status")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/modality-bridge/video/runtime";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-modality-bridge-video-extract")
    .description("Extract bounded Video Bridge frames through the internal broker")
    .requiredOption("--frames <frames>", "")
    .option("--sampling-policy <samplingPolicy>", "Optional deterministic sampling policy. Scene-aware detection falls back to uniform sampling on detector failure.")
    .option("--start <start>", "Optional focus-window start in seconds. The broker clamps it to the media duration.")
    .option("--end <end>", "Optional focus-window end in seconds. It must be greater than the normalized start.")
    .requiredOption("--body <jsonOrPath>", "JSON body or @path/to/file.json")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/modality-bridge/video/extract";
      const qs = new URLSearchParams();
      if (opts.frames != null) qs.set("frames", String(opts.frames));
      if (opts.samplingPolicy != null) qs.set("samplingPolicy", String(opts.samplingPolicy));
      if (opts.start != null) qs.set("start", String(opts.start));
      if (opts.end != null) qs.set("end", String(opts.end));
      if (qs.toString()) url += "?" + qs.toString();
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
  tag.command("get-api-modality-bridge-video-drilldown")
    .description("Read a bounded Video Bridge drill-down slice")
    .requiredOption("--session-id <sessionId>", "Canonical opaque ID without surrounding whitespace")
    .requiredOption("--video-ref <videoRef>", "Canonical opaque reference without surrounding whitespace")
    .option("--start <start>", "")
    .option("--end <end>", "")
    .option("--frames <frames>", "")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/modality-bridge/video/drilldown";
      const qs = new URLSearchParams();
      if (opts.sessionId != null) qs.set("sessionId", String(opts.sessionId));
      if (opts.videoRef != null) qs.set("videoRef", String(opts.videoRef));
      if (opts.start != null) qs.set("start", String(opts.start));
      if (opts.end != null) qs.set("end", String(opts.end));
      if (opts.frames != null) qs.set("frames", String(opts.frames));
      if (qs.toString()) url += "?" + qs.toString();
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-modality-bridge-video-drilldown")
    .description("Store a bounded Video Bridge drill-down result")
    .requiredOption("--body <jsonOrPath>", "JSON body or @path/to/file.json")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/modality-bridge/video/drilldown";
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
  tag.command("delete-api-modality-bridge-video-drilldown")
    .description("Delete a Video Bridge drill-down session")
    .requiredOption("--session-id <sessionId>", "Canonical opaque ID without surrounding whitespace")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/modality-bridge/video/drilldown";
      const qs = new URLSearchParams();
      if (opts.sessionId != null) qs.set("sessionId", String(opts.sessionId));
      if (qs.toString()) url += "?" + qs.toString();
      const res = await apiFetch(url, { ...gOpts, method: "DELETE", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-cache-stats")
    .description("Get detailed cache statistics")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/cache/stats";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("delete-api-cache-stats")
    .description("Clear cache statistics")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/cache/stats";
      const res = await apiFetch(url, { ...gOpts, method: "DELETE", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-evals")
    .description("List eval suites")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/evals";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-evals")
    .description("Run evaluation")
    .requiredOption("--body <jsonOrPath>", "JSON body or @path/to/file.json")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/evals";
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
  tag.command("get-api-evals-suite-id-")
    .description("Get eval suite details")
    .requiredOption("--suite-id <suiteId>", "")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/evals/{suiteId}";
      url = url.replace("{suiteId}", encodeURIComponent(opts.suiteId ?? ""));
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-policies")
    .description("List routing policies")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/policies";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-policies")
    .description("Create routing policy")
    .requiredOption("--body <jsonOrPath>", "JSON body or @path/to/file.json")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/policies";
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
  tag.command("delete-api-policies")
    .description("Delete routing policy")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/policies";
      const res = await apiFetch(url, { ...gOpts, method: "DELETE", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-compliance-audit-log")
    .description("Get compliance audit log")
    .option("--level <level>", "high = Activity feed events only; all = all audit events")
    .option("--action <action>", "Filter by exact action string (e.g. \"provider.added\")")
    .option("--actor <actor>", "Filter by actor identifier")
    .option("--limit <limit>", "")
    .option("--offset <offset>", "")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/compliance/audit-log";
      const qs = new URLSearchParams();
      if (opts.level != null) qs.set("level", String(opts.level));
      if (opts.action != null) qs.set("action", String(opts.action));
      if (opts.actor != null) qs.set("actor", String(opts.actor));
      if (opts.limit != null) qs.set("limit", String(opts.limit));
      if (opts.offset != null) qs.set("offset", String(opts.offset));
      if (qs.toString()) url += "?" + qs.toString();
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-openapi-spec")
    .description("Get OpenAPI specification catalog")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/openapi/spec";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-openapi-try")
    .description("Proxy an API Explorer request to an OmniRoute endpoint")
    .requiredOption("--body <jsonOrPath>", "JSON body or @path/to/file.json")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/openapi/try";
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
  tag.command("get-api-system-env-repair")
    .description("GET system › env › repair")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/system/env/repair";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-system-env-repair")
    .description("POST system › env › repair")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/system/env/repair";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("get-api-system-version")
    .description("GET system › version")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/system/version";
      const res = await apiFetch(url, { ...gOpts, method: "GET", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
  tag.command("post-api-system-version")
    .description("POST system › version")
    .action(async (opts, cmd) => {
      const gOpts = cmd.optsWithGlobals();
      let url = "/api/system/version";
      const res = await apiFetch(url, { ...gOpts, method: "POST", timeout: Number.parseInt(gOpts.timeout, 10) });
      const data = await readApiResponse(res);
      emit(data, gOpts);
    });
}
