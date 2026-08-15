---
title: "Cursor via agent CLI (cursor-cli)"
version: 3.8.50
lastUpdated: 2026-08-15
---

# Cursor via agent CLI (`cursor-cli`)

`cursor-cli` routes completions through the **local Cursor agent CLI** over ACP
(Agent Client Protocol), driven by [`acpx`](https://github.com/openclaw/acpx).
It is a separate provider from `cursor`, which posts to `api2.cursor.sh`.

|           | `cursor`                                      | `cursor-cli`                                 |
| --------- | --------------------------------------------- | -------------------------------------------- |
| Transport | HTTPS → `api2.cursor.sh`                      | stdio → `acpx` → `cursor-agent acp`          |
| Auth      | stored OAuth credential                       | host's `cursor-agent login` (nothing stored) |
| Model ids | suffix form (`claude-sonnet-5-thinking-high`) | base form (`claude-sonnet-5`)                |
| Catalog   | synced, static registry fallback              | live only, no static fallback                |

## Why a second provider

The two surfaces do not share a model-id namespace:

```text
cursor-agent --list-models   →  claude-sonnet-5-thinking-high      (suffix form)
ACP session/new              →  claude-sonnet-5[thinking=true,     (bracket form)
                                  context=300k,effort=high]
```

acpx validates `--model` against the **ACP-advertised** list only, so ids from
`cursor-agent --list-models` are not routable through it even though the CLI
prints them. `cursor-cli` therefore discovers and routes the bracket namespace,
and exposes each model under its bare base name (`claude-sonnet-5`); the
executor hands acpx the exact advertised id.

Cursor's "Auto" router is advertised as `default[]` and is exposed as `auto`.

## Model discovery is live, always

The registry entry
(`open-sse/config/providers/registry/cursor-cli/index.ts`) ships **no models**.
Cursor's lineup is account-scoped and changes without a CLI release, so any
baked list is wrong for somebody the day it ships.

Discovery reads `availableModels` out of the ACP `session/new` result, which
arrives _before_ generation starts — the executor takes the list and kills the
child immediately, so no completion is billed (~1.9s cold, then cached for 10
minutes). Implementation: `open-sse/services/cursorCliModels.ts`.

`acpx cursor sessions new` cannot be used for this: it performs the handshake
but prints only its own session record, and the frame log under
`~/.acpx/sessions/` is not written until a prompt actually runs.

## The agent runs as a pure model, not as an agent

Every spawn is pinned to:

```text
--deny-all --no-fs --no-terminal --allowed-tools ""   # no capabilities
--cwd <neutral scratch dir>                           # no repo context
```

This is deliberate. ACP is an _agent_ protocol: left at its defaults the agent
reads files, runs terminal commands, and loads `AGENTS.md` / rules / skills from
its working directory — a live code-execution surface on the router host driven
by third-party prompt text. It also leaks context: running inside a checkout
prepends that repo's instructions to every completion.

Consequence: client-supplied `tools` in the request body are **not** executed by
this provider.

Override the scratch directory with `CURSOR_CLI_CWD` if `/tmp` is unsuitable.

## Requirements

| Requirement    | Notes                                                                                                                                                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acpx`         | Installed into the image in `runner-base`, so every target (`runner-cli`, `runner-web`) inherits it. Not available on the gx10 host, which is why it ships in the image. Override the path with `ACPX_BIN`.                                                          |
| `cursor-agent` | Not on npm — install with `curl https://cursor.com/install -fsS \| bash`, or bind-mount it from the host as the Coolify stack does. The npm package named `cursor-agent` (v1.0.3) is **not** Cursor's CLI; the genuine build is versioned like `2026.07.23-e383d2b`. |
| A Cursor login | `cursor-agent login` on the host whose state is mounted.                                                                                                                                                                                                             |

## The self-hosted Coolify stack

The gx10 deployment (`omniroute-stack`, build pack `dockercompose`, compose file
`/docker-compose.coolify.yml`, target `runner-cli`) already satisfies every
requirement **except** `acpx`, which is why `acpx` is installed into
`runner-base` in the image rather than mounted.

Verified inside the running container:

```console
$ docker exec <container> env | grep -E 'PATH|HOME|CURSOR'
PATH=/home/ken/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CURSOR_DATA_DIR=/home/ken/.local/share/cursor-agent
HOME=/home/node

$ docker exec <container> sh -c 'command -v cursor-agent; cursor-agent status'
/home/ken/.local/bin/cursor-agent
✓ Logged in as ...
```

Why it already works, with no extra env and no new mount:

- The compose file binds the host's Cursor state:
  `/home/ken/.config/cursor:/home/node/.config/cursor`, plus
  `/home/ken/.local/bin` (the binary) and `/home/ken/.local/share/cursor-agent`
  (the version store) at their **host-side** paths, which is what the
  Coolify-managed `PATH` and `CURSOR_DATA_DIR` point at.
- The container user is `node` with `HOME=/home/node` and `XDG_CONFIG_HOME`
  unset, so cursor-agent's Linux resolution lands exactly on the mounted
  `/home/node/.config/cursor/auth.json`.
- npm global bins install to `/usr/local/bin`, which is on that `PATH`, so the
  image-installed `acpx` resolves.

> Use a non-login shell when inspecting this. `docker exec … sh -lc` sources
> `/etc/profile` and **resets `PATH`** to the system default, which hides
> `/home/ken/.local/bin` and makes `cursor-agent` look missing.

## Credential stores (local development)

The Linux host already holds a file-backed credential, so the above needs no
bootstrap. On **macOS** the CLI stores its credential in the Keychain instead,
which writes nothing to disk and cannot be mounted — mounting `~/.cursor` from a
Mac carries no credential at all. The two stores are independent:

```console
$ cursor-agent status
✓ Logged in as you@example.com

$ AGENT_CLI_CREDENTIAL_STORE=file cursor-agent status
Not logged in
```

To produce a mountable credential on macOS:

```bash
AGENT_CLI_CREDENTIAL_STORE=file cursor-agent login   # writes ~/.cursor/auth.json
mkdir -p ~/.config/cursor && cp ~/.cursor/auth.json ~/.config/cursor/auth.json
```

### Path resolution

`cursor-agent` resolves `auth.json` per platform:

| Platform | Path                                             |
| -------- | ------------------------------------------------ |
| darwin   | `~/.cursor/auth.json`                            |
| linux    | `${XDG_CONFIG_HOME:-~/.config}/cursor/auth.json` |
| win32    | `%APPDATA%/Cursor/auth.json`                     |

If a deployment ever mounts the credential somewhere `$HOME` does not reach,
set **`CURSOR_CLI_CONFIG_HOME`**: the executor applies it as `XDG_CONFIG_HOME`
to the spawned agent alone. Setting `XDG_CONFIG_HOME` globally would relocate
every other CLI's config, since codex, claude, droid and openclaw share the
config home. The gx10 stack does not need it.

## Environment variables

| Variable                     | Purpose                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ACPX_BIN` / `CLI_ACPX_BIN`  | Absolute path to `acpx` when not on `PATH`.                                                                                                                                                                  |
| `CURSOR_CLI_CWD`             | Neutral working directory for the agent. Defaults to `<tmp>/omniroute-cursor-cli`.                                                                                                                           |
| `CURSOR_CLI_CONFIG_HOME`     | Applied as `XDG_CONFIG_HOME` to the spawned agent only, so it finds a mounted credential.                                                                                                                    |
| `AGENT_CLI_CREDENTIAL_STORE` | `file` \| `memory` \| `default`. Passed through untouched — set it to `file` in containers. Not defaulted, because forcing `file` would break a macOS developer whose working credential is in the Keychain. |

## Troubleshooting

**"Cursor CLI model discovery returned no models"** — the agent is not
authenticated in the context the router runs as. Run `cursor-agent status`; in a
container also check `AGENT_CLI_CREDENTIAL_STORE=file` and that
`$CURSOR_CLI_CONFIG_HOME/cursor/auth.json` exists inside the container.

**"could not start acpx"** — `acpx` is not on `PATH`. Set `ACPX_BIN`.

**"Unknown Cursor CLI model"** — the id is not in the live advertised list. The
error message lists every id currently routable for that account. Note that
effort/fast variants visible in `cursor-agent models` (`...-thinking-xhigh`,
`...-fast`) are **not** individually routable here: ACP advertises one
parameterized entry per base model, and acpx rejects constructed combinations.
