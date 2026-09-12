# hermes-timeout-sync

Derives Hermes agent request timeouts from OmniRoute's own worst-case combo
latency, so Hermes never aborts a request (HTTP 499, "Request aborted")
while OmniRoute is still legitimately retrying or walking a combo's fallback
targets. OmniRoute is the source of truth; Hermes's `timeout:` values are
kept in sync with it, not chosen independently.

## Usage

```bash
# Dry run (default): prints a per-profile table, writes current-mapping.json,
# changes nothing on disk.
uv run sync_hermes_timeouts.py

# Apply: rewrites only the specific `timeout:` scalars the policy names, in
# place, after writing a timestamped .bak of each touched file.
uv run sync_hermes_timeouts.py --apply

# Restrict to one or more profiles (label from policy.yaml `profiles:`)
uv run sync_hermes_timeouts.py --profile default --profile code-reviewer
```

Requires network access to `https://gateway.dev.sellie.ai` and a readable
`~/.omniroute/config.json` with a `contexts."gateway.dev.sellie.ai".accessToken`
(the same management token the `omniroute` CLI context uses). The token is
read at call time and never written to disk or printed.

## The formula

```
hermes_timeout_s = ceil(omniroute_budget_s + margin_s)
margin_s         = max(margin_floor_s, omniroute_budget_s * margin_pct)     # policy.yaml: formula.margin_floor_s / margin_pct
```

`omniroute_budget_s` is the worst-case wall-clock time OmniRoute can spend on
one call to a combo before it returns a final response (success or
exhausted failure) to Hermes:

```
per_target_ms      = (maxRetries + 1) * targetTimeoutMs + maxRetries * retryDelayMs
attempted_members  = min(members, max(1, max_global_attempts // (maxRetries + 1)))
raw_sum_ms         = per_target_ms * attempted_members
cap_ms             = comboTimeoutMs if comboTimeoutMs > 0 else combo_loop_safety_timeout_s * 1000
omniroute_budget_ms = min(raw_sum_ms, cap_ms)
```

`maxRetries`, `retryDelayMs`, `targetTimeoutMs`, `comboTimeoutMs` and
`members` come live from `GET /api/combos` for that combo, falling back to
`GET /api/settings/combo-defaults` for any field the combo leaves unset.
`max_global_attempts` and `combo_loop_safety_timeout_s` are policy knobs
mirroring OmniRoute source constants (below) that aren't exposed by either
API endpoint.

### Why every combo we checked hits the same 600s cap

None of the 14 combos Hermes calls (`pool/orchestrator`, `pool/subagent`,
and the 12 `hermes/*` one-off task combos) has `comboTimeoutMs` set on the
live gateway (checked 2026-09-12). Every one of them falls back to
OmniRoute's blanket `COMBO_LOOP_SAFETY_TIMEOUT_MS` (600s / 10 min), because
`raw_sum_ms` — 1 to 11 members at a 300s-or-120s per-target timeout, each
retried once or twice — comfortably exceeds 600s in every case. That is a
real, verifiable finding, not a script bug: **no combo Hermes talks to has a
deliberately-tuned ceiling**; they all share one generic safety net. That is
exactly the case `policy.yaml`'s `flag_above_seconds` (default 300s) is
meant to catch — every auxiliary caller in the dry-run table below is
flagged `COMBO_TIMEOUT_MS`, and the fix that best matches intent is
**setting a per-combo `comboTimeoutMs` on OmniRoute** (e.g. ~60-90s for
`hermes/title-generation`, `hermes/triage-specifier`,
`hermes/kanban-decomposer`, `hermes/goal-judge` — all single-member, meant
to be cheap and fast), not blanket-raising every Hermes timeout to ~660s.

### File:line citations — OmniRoute (`gx10:/home/ken/github/OmniRoute/.worktrees/deploy/v3.8.51-gx10-service`)

- Per-target deadline is a hard `Promise.race`, unconditionally resolves and
  returns a typed 504 (`combo_target_timeout`) so the combo can fall over —
  `open-sse/services/combo/targetTimeoutRunner.ts:129-166` (timer + race),
  `:147-163` (504 body).
- Retries hit the **same target** first, sleeping `retryDelayMs` between
  tries: `open-sse/services/combo/executeTargetAttempt.ts:141` (`for (let
  retry = 0; retry <= deps.maxRetries; retry++)`), `:113`/`:208` (sleep
  `retryDelayMs`). Only opt-in `failoverBeforeRetryExplicit` skips further
  same-target retries early (`:1013-1035`).
- Outer loop then tries the next member: `open-sse/services/combo/comboAttemptLoop.ts:210`
  (`for (let i = 0; i < state.orderedTargets.length; i++)`).
- `comboTimeoutMs`, when set, is a **hard ceiling** that aborts mid-attempt —
  `comboAttemptLoop.ts:153-154` (`loopSafetyMs = extra.comboTimeoutMs > 0 ?
  extra.comboTimeoutMs : COMBO_LOOP_SAFETY_TIMEOUT_MS`), `:264-266`
  (`Promise.race([task, globalPromise, loopSafetyPromise])`), `:271-277`
  (secondary check stops launching further members once elapsed time exceeds
  `comboTimeoutMs`).
- When unset, `COMBO_LOOP_SAFETY_TIMEOUT_MS = 10 * 60 * 1000` (600s) governs
  — `open-sse/services/combo/comboPredicates.ts:34`. `MAX_GLOBAL_ATTEMPTS = 30`
  (hard cap 200 via `config.maxGlobalAttempts`) bounds total attempts across
  all members combined — `comboPredicates.ts:107,112,128-137`.
- Combo-level config defaults (`maxRetries: 1`, `retryDelayMs: 2000`,
  `DEFAULT_COMBO_TARGET_TIMEOUT_MS = 120_000`) —
  `open-sse/services/comboConfig.ts:28` (target timeout constant), `:98-99`
  (retry defaults). The live `GET /api/settings/combo-defaults` we read at
  runtime reports `targetTimeoutMs: 300000` — the gateway's actual
  configured default (higher than the 120s source constant), which the
  script uses as ground truth over the source-level constant.
- `resilienceSettings.comboCooldownWait` only raises the **default**
  per-target timeout floor (`max(DEFAULT_COMBO_TARGET_TIMEOUT_MS,
  comboCooldownWait.budgetMs + COMBO_TARGET_TIMEOUT_WAIT_BUFFER_MS)`,
  buffer = 10_000ms) so a cooldown-wait in progress isn't cut off mid-wait —
  `comboConfig.ts:38` (buffer constant), `:69-80`
  (`resolveComboTargetTimeoutMsForCombo`). It is **not** an additive cost on
  top of the per-target timeout; both are already folded into whatever
  `targetTimeoutMs` the live API reports, so the script does not add it
  separately. `resilienceSettings.waitForCooldown` explicitly "Applies to
  direct (non-combo) model requests" (`src/lib/resilience/settings.ts:107`)
  — not a combo-path cost at all, so it plays no role in this formula.
  `resilienceSettings.requestQueue.maxWaitMs` is a per-provider-connection
  queue wait nested inside a target's own `targetTimeoutMs` budget, not
  additive before the combo loop starts.
- `OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS` (default 30s) is a **separate,
  independent** first-byte-of-headers clock one layer below the per-target
  timeout, in the raw fetch (`open-sse/services/directResponseStartTimeout.ts:7,13`;
  retry-on-fresh-socket in `open-sse/services/proxyFetch.ts:850-871`). It can
  trigger an internal low-level retry, but the combo loop's wall-clock
  exposure for that target is still capped at `targetTimeoutMs` regardless —
  it does not add to the formula above.

### File:line citations — Hermes (`~/github/hermes-agent`; `~/.hermes/hermes-agent` is a separate, independently-checked-out copy with identical logic, not a symlink)

- `auxiliary.<task>.timeout` binds a **per-attempt** deadline, not a shared
  budget across retries: `agent/auxiliary_client.py:7373-7396` (retry loop
  calling `_primary()`, `agent/auxiliary_client.py:7350`) reuses the full
  `timeout` on every attempt. Default when the key is omitted: 30.0s
  (`agent/auxiliary_client.py:5696`, `_DEFAULT_AUX_TIMEOUT`), applied by
  `_get_task_timeout` (`:5797-5805`) — this is what `auxiliary.goal_judge`
  (default config) and `auxiliary.tts_audio_tags` (all 5 configs) fall back
  to today.
- `auxiliary.transient_retries` (code default 2, `hermes_cli/config_defaults.py:683`;
  the operator's 5 configs all override it to 3) adds up to that many extra
  same-request attempts with exponential backoff capped at 8s
  (`agent/auxiliary_client.py:3104` base, `:7385` formula) — a Hermes-level
  safety net layered *on top of* whichever single-attempt `timeout` this
  tool proposes, not folded into the proposed number itself (the user's
  formula is budget + margin per attempt, matching the operator's stated
  rule).
- `agent.gateway_timeout` (default 1800s, `hermes_cli/config_defaults.py:62`)
  is an **inactivity watchdog** on the whole agent turn, not a request
  deadline — it resets on any activity (tool calls, API responses) and only
  fires on true idling (`gateway/run_turn.py:3080` comment,
  `_watch_gateway_turn_inactivity` at `:3130`).
- `delegation.child_timeout_seconds` (code default: **no timeout at all** —
  `tools/delegate_tool_config.py:27`, `DEFAULT_CHILD_TIMEOUT = None`; all 5
  configs explicitly set 3600s, floored at 30s by `_parse_timeout`,
  `:126-129`) bounds the **entire child subagent task** (its own tool calls
  and nested turns), as one wall-clock `future.result(timeout=...)`
  (`tools/delegate_tool_child_run.py:663-665`), not a single LLM request.
- Because of the two points above, `main_agent`/`delegation` are **not**
  literal per-request deadlines the way `auxiliary.<task>.timeout` is —
  see "Why main_agent/delegation are handled differently" below.
- Separately, Codex-path per-call watchdogs (`HERMES_CODEX_TTFB_TIMEOUT_SECONDS`
  default 120s, `HERMES_CODEX_TTFB_MAX_SECONDS` cap default 120s,
  `HERMES_CODEX_EVENT_STALE_TIMEOUT_SECONDS` idle-between-chunks,
  `HERMES_CODEX_HARD_TIMEOUT_SECONDS` default 1500s hard backstop — all in
  `agent/chat_completion_helpers.py`, `_resolve_nonstream_watchdogs:1063-1133`)
  and a streamed-auxiliary-call ceiling (`_AUX_STREAM_CEILING_FLOOR_SECONDS =
  600.0`, `_AUX_STREAM_CEILING_MULTIPLIER = 4.0`,
  `agent/auxiliary_client.py:6250-6264` — for a streaming aux call, the
  configured `timeout` is repurposed as an **inter-chunk idle timeout**, and
  the real ceiling is `max(600, 4x timeout)`) sit underneath these config
  keys and are env-var-driven, not something this tool's `policy.yaml`/config
  edits reach. Whether a given auxiliary task streams its response
  determines which of these actually fires first — worth the operator's own
  check in `auxiliary_client.py` before assuming the config `timeout` is the
  literal enforced ceiling for every task.

### Why `main_agent`/`delegation` are handled differently

`agent.gateway_timeout` and `delegation.child_timeout_seconds` bound a whole
turn or child task, not one OmniRoute request, so applying "budget + margin"
literally would be wrong: shrinking `delegation.child_timeout_seconds` from
3600s to ~660s would break any legitimately long-running delegated task that
makes many short tool calls with no single stuck LLM request. The script
still computes and reports the OmniRoute budget for these two callers (using
`model.default` / `delegation.model` to find the combo), but only ever
proposes `max(current, budget + margin)` for them — it flags insufficiency,
never proposes shrinking. With today's data both are already comfortably
above budget + margin (1800s and 3600s vs. ~660s), so no change is proposed
for either in the current dry run.

## `policy.yaml`

- `formula`: `margin_floor_s`, `margin_pct`, `combo_loop_safety_timeout_s`,
  `max_global_attempts`, `flag_above_seconds` — all configurable, see
  inline comments in the file for what each mirrors.
- `callers`: the caller catalog. Every caller resolves its OmniRoute combo
  **live**, from `combo_source` (a dot path into that profile's own Hermes
  config), never a hardcoded name — the same caller (e.g.
  `auxiliary.monitor`) can be bound to a real combo in one profile
  (`code-reviewer`: `hermes/monitor`) and unbound (`provider: auto`, empty
  model) in another (`default` and the other three profiles). A caller
  whose resolved combo name is empty or not found on the live gateway is
  skipped for that profile and reported as `skip: ...` in the table.
- `profiles`: the five Hermes config files this tool covers (`default` plus
  `code-reviewer`, `daytona-smoke`, `kanban-code-orchestrator`,
  `kanban-code-worker`).

## `--apply` mechanics

`--apply` never re-serializes a whole YAML document (ruamel's default
round-trip dump reformats things like list-item indentation and re-wraps
long scalar lines — verified against these files, see git history of this
tool for the failed first attempt). Instead it:

1. Parses each config with `ruamel.yaml` in round-trip mode to get exact
   `(line, column)` positions for each caller's `timeout` key via
   `CommentedMap.lc`.
2. For a key that already has a value, replaces only the numeric token at
   that exact column on that exact line.
3. For a key that is absent entirely (Hermes's implicit default applies —
   `auxiliary.tts_audio_tags` everywhere, `auxiliary.goal_judge` in the
   default config), inserts one new `key: value` line immediately after the
   mapping's last existing key, at that key's indentation.
4. Applies all edits within a file bottom-to-top (by line number) so an
   insertion never shifts a not-yet-applied edit above it.
5. Writes a timestamped `.bak` of the original file before touching it.

Verified: applying to scratch copies of `~/.hermes/config.yaml` and
`~/.hermes/profiles/code-reviewer/config.yaml` produced a diff touching only
the intended `timeout:` lines (plus the two insertions above) — no
reformatting, no reordering, no change to any other line. `git diff --stat`
equivalent: file line count changed by exactly the number of insertions (+1
each), nothing else moved.

`--apply` only ever touches `kind: auxiliary` callers. `kind: turn` callers
(`main_agent`, `delegation`) are never auto-applied, per "Why
main_agent/delegation are handled differently" above — raising them is a
human call, not something this tool should do unattended even under
`--apply`.

## `current-mapping.json`

Regenerated on every run (dry-run or `--apply`), keyed by profile then
caller: combo name, full budget breakdown (members, attempted members,
retries, per-target timeout, raw sum before capping, whether the safety net
capped it), current Hermes value (and whether that's an implicit default),
proposed value, and the `flagged_needs_combo_timeout_ms` bit. Commit it so
future runs diff cleanly against what was last reviewed.
