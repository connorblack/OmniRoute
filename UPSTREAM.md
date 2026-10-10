# Upstream log

This fork tracks diegosouzapw/OmniRoute. Before designing a fix, check upstream for it and port theirs. This file records what has been ported, what is waiting, and what exists only here.

## Upstream

- Remote: `upstream`, https://github.com/diegosouzapw/OmniRoute.git
- Branch: `release/v3.8.52`, upstream's default branch
- Merge base: `a2c6f7188d71479e1ae771bcbe1c28885fdbf546`, 2026-09-17, package version 3.8.51, on upstream's `release/v3.8.51` branch

Find it again with `git merge-base HEAD upstream/release/v3.8.52`.

## Ported from upstream

| Upstream commit | Upstream reference | Fork commit | Fork commit date | Note |
| --- | --- | --- | --- | --- |
| `3f63efea05` | PR #14473, issue #13995 | `6cb484aab1` | 2026-10-10 | Cherry-picked unchanged. The route guard now reads the saved `localOnlyManageScopeBypassPrefixes`, because the policy lives in a `globalThis` store that every bundle shares. |
| `8c8ab3db69` | PR #14349 | `a78e37c454` | 2026-10-08 | Cherry-picked. The provider dashboard honors the chat-scoped hidden flag. |
| `36f889fa83` | PR #14626 | `d649ac51df` | 2026-10-09 | Partial. Only the grok client version and its OAuth test. The CLI fingerprint drift check is left out because `scripts/check/check-cli-fingerprint-drift.ts` does not exist at the merge base. |

## Waiting

- Upstream `release/v3.8.52` is 1,559 commits ahead of the merge base (`git rev-list --count a2c6f7188d..upstream/release/v3.8.52`, measured 2026-10-10). It has no release tag, so it is unreleased. It is not merged here yet.

## Fork only

These changes exist only in this fork. Re-check each against upstream whenever `release/v3.8.52` merges.

- `OMNIROUTE_PROXIED_LAN_CIDRS`, fork commit `bc8ef2c2a1` (2026-09-11). A comma-separated list of IPv4 CIDRs. `isPrivateLanRequest` in `src/server/authz/peerContext.ts` counts a proxied request as LAN when the rightmost `X-Forwarded-For` entry is in a listed range, the proxy peer is loopback or private LAN, and no Cloudflare edge header is present. Unset, a proxied request is never LAN, as upstream behaves. Upstream `release/v3.8.52` has no equivalent (checked 2026-10-10). Tests are in `tests/unit/authz/proxied-lan.test.ts`.
- Webhook request events, fork commit `f04df40e21` (bic-infra #56), merged in `ade1d77fed`. `request.completed` and `request.failed` are also sent from round-robin combos, runtime units, nested combo references and direct model calls. The payload lives in `open-sse/services/combo/requestWebhookEvents.ts`. Upstream `release/v3.8.52` has no `notifyWebhookEvent` in `roundRobinCombo.ts`, `runtimeUnits.ts` or `src/sse/handlers/chat.ts` (checked 2026-10-10).
