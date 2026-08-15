---
title: "Cursor ACP transport"
version: 3.8.50
lastUpdated: 2026-08-15
---

# Cursor ACP transport

ACP (Agent Client Protocol) is an **alternative transport for the existing
`cursor` provider**, not a second provider. A connection opts in with:

```json
{ "providerSpecificData": { "transport": "acp" } }
```

Anything else keeps the protobuf/HTTP path to `api2.cursor.sh`, so existing
connections are untouched. This follows the framing already in
`src/lib/acp/registry.ts` — _"ACP transport as an alternative to the HTTP proxy
method"_ — where agents map onto existing providers via `providerAlias`.

|                  | HTTP (default)                            | ACP                                               |
| ---------------- | ----------------------------------------- | ------------------------------------------------- |
| Wire             | Connect-RPC / protobuf → `api2.cursor.sh` | JSON-RPC over stdio → `acpx` → `cursor-agent acp` |
| Model parameters | arbitrary `effort` / `reasoning`          | only what the agent advertises                    |
| Tools            | Cursor tool bridge                        | disabled (pure model)                             |
| Requires         | network                                   | `acpx` + `cursor-agent` on the router host        |

## Why it exists

`api2.cursor.sh` rejects the 5-series model ids OmniRoute sends over HTTP.
Driving the locally-installed agent sidesteps that entirely, because the agent
only ever sees ids it advertised itself.

## Auth: no new credential

Nothing extra is stored, and no bearer is injected. `cursor-agent`
authenticates from its own store — `${XDG_CONFIG_HOME:-~/.config}/cursor/auth.json`
on Linux — which is **the same file
`src/lib/cursor/tokenExtractor.ts::tryAgentAuth()` already imports into the
cursor connection**. Same identity, so the connection's `testStatus` and expiry
stay meaningful and `src/lib/cursor/renewal.ts` keeps working.

If a deployment mounts that credential outside the container user's `$HOME`,
set `CURSOR_ACP_CONFIG_HOME`: it is applied as `XDG_CONFIG_HOME` **to the
spawned agent only**, because setting it globally would relocate every other
CLI's config (codex, claude, droid and openclaw share the config home).

## Model ids: no bespoke mapping

Cursor's canonical representation is `RequestedModel { model_id, parameters[] }`,
and `resolveRequestedModel()` (`open-sse/utils/cursorAgentProtobuf.ts`) already
decomposes the flattened client id into it:

```text
"claude-opus-4-8-high" → { model_id: "claude-opus-4-8", [effort=high] }
"gpt-5.5-high"         → { model_id: "gpt-5.5",         [reasoning=high] }
"auto"                 → { model_id: "default",         [] }
```

ACP's bracket id is that same structure serialised:

```text
claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]
```

So selection is: decompose with the shared resolver, match the base against
what the agent advertised. There is no ACP-specific `auto` branch — the
resolver's `default` already covers it.

Note this means the flattened list from `cursor-agent models` and the
parameterised list from ACP are **two presentations of one catalog**, not two
catalogs of different sizes.

## The one real transport difference

The agent's ACP adapter accepts **only its advertised parameterisations** — one
canonical set per base model. A constructed combination is refused by the
_agent_, not merely by acpx:

```console
$ acpx cursor set model 'claude-sonnet-5[thinking=true,context=300k,effort=xhigh]'
Agent rejected session/set_config_option ... Invalid params (ACP -32602)
```

Advertised effort is per model — `claude-sonnet-5` advertises `effort=high`,
`claude-opus-4-7` advertises `effort=xhigh`. The HTTP path can carry arbitrary
values in `RequestedModel.parameters`; ACP cannot.

When a request asks for a parameter the agent did not advertise, the transport
**fails and names the alternative** rather than substituting — an effort
downgrade is a quality and cost change the caller did not ask for:

```text
Cursor model "claude-sonnet-5-xhigh" requests effort=xhigh, but the agent only
advertises effort=high for claude-sonnet-5 over ACP (claude-sonnet-5[...]).
Use that model, or route this connection over the HTTP transport.
```

Run an HTTP connection and an ACP connection side by side when you need both.

## Pure-model mode

Every spawn is pinned to:

```text
--deny-all --no-fs --no-terminal --allowed-tools ""   # no capabilities
--cwd <neutral scratch dir>                           # no repo context
```

ACP is an _agent_ protocol: at its defaults the agent reads files and runs shell
commands on the router host under third-party prompt text, and running inside a
checkout prepends that repo's `AGENTS.md` / rules / skills to every completion.
A chat-completions endpoint must expose it as a model. Client-supplied `tools`
are therefore **not** executed on this transport.

Override the scratch directory with `CURSOR_ACP_CWD`.

## Discovery

The advertised catalog is read live and cached for 10 minutes. ACP returns
`availableModels` in the `session/new` **result**, which lands before generation
starts, so discovery kills the child immediately and costs no completion
(~1.9s cold).

`acpx cursor sessions new` cannot serve this: it performs the handshake but
prints only its own session record, and the frame log under `~/.acpx/sessions/`
is not written until a prompt actually runs.

## Requirements

| Requirement    | Notes                                                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acpx`         | Installed into the image in `runner-base`, so every target inherits it. Override with `ACPX_BIN`.                                                                |
| `cursor-agent` | Not on npm — `curl https://cursor.com/install -fsS \| bash`, or bind-mount from the host. The npm package named `cursor-agent` (v1.0.3) is **not** Cursor's CLI. |
| A Cursor login | `cursor-agent login` on the host whose state is mounted.                                                                                                         |

## Environment variables

| Variable                     | Purpose                                                                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACPX_BIN` / `CLI_ACPX_BIN`  | Absolute path to `acpx` when not on `PATH`.                                                                                                                                                   |
| `CURSOR_ACP_CWD`             | Neutral working directory. Defaults to `<tmp>/omniroute-cursor-acp`.                                                                                                                          |
| `CURSOR_ACP_CONFIG_HOME`     | Applied as `XDG_CONFIG_HOME` to the spawned agent only.                                                                                                                                       |
| `AGENT_CLI_CREDENTIAL_STORE` | `file` \| `memory` \| `default`. Passed through untouched — set `file` in containers. Not defaulted, because forcing it would break a macOS developer whose credential lives in the Keychain. |

## Gotchas

- **Inspect containers with `sh -c`, not `sh -lc`.** A login shell sources
  `/etc/profile` and resets `PATH`, hiding host-mounted bin directories and
  making `cursor-agent` look missing when it is not.
- On macOS the default credential store is the Keychain, which writes nothing to
  disk and cannot be mounted. `AGENT_CLI_CREDENTIAL_STORE=file cursor-agent login`
  produces a mountable `auth.json`.
- `src/lib/acp/manager.ts` is unrelated scaffolding (no JSON-RPC framing, 2s
  idle heuristic, and an `ALLOWED_AGENTS` list that excludes cursor). This
  transport does not use it.
