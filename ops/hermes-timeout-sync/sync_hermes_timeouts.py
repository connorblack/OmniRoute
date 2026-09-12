#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.10"
# dependencies = ["ruamel.yaml>=0.18"]
# ///
"""Sync Hermes agent request timeouts to OmniRoute's own worst-case combo budget.

Reads policy.yaml (the caller -> combo mapping and the margin/cap formula),
the live OmniRoute gateway (GET /api/combos, GET /api/settings/combo-defaults),
and the five Hermes config files it names. Prints a per-profile table of
(caller, combo, OmniRoute budget, current Hermes timeout, proposed Hermes
timeout, flag). Writes current-mapping.json unconditionally.

Default mode is dry-run: nothing on disk changes. --apply rewrites only the
specific `timeout` scalars named by the policy's callers, in place, via a
ruamel.yaml round trip that preserves comments, key order and formatting,
after writing a timestamped backup of each file it touches.

See README.md for the budget formula derivation with file:line citations
into both the Hermes and OmniRoute source trees.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from ruamel.yaml import YAML

SCRIPT_DIR = Path(__file__).resolve().parent
_MISSING = object()

# Hermes's own fallback when an auxiliary `timeout` key is omitted entirely.
# agent/auxiliary_client.py:5696 (_DEFAULT_AUX_TIMEOUT = 30.0) and
# agent/auxiliary_client.py:5797-5805 (_get_task_timeout falls back to it).
HERMES_DEFAULT_AUX_TIMEOUT_S = 30.0


def make_yaml() -> YAML:
    yaml = YAML()
    yaml.preserve_quotes = True
    yaml.width = 4096  # avoid re-wrapping long lines on write
    return yaml


# --------------------------------------------------------------------------
# Dot-path helpers over a ruamel CommentedMap tree
# --------------------------------------------------------------------------


def get_path(doc: Any, dotted: str) -> Any:
    node = doc
    for part in dotted.split("."):
        if node is _MISSING or node is None:
            return _MISSING
        try:
            node = node[part]
        except (KeyError, TypeError):
            return _MISSING
    return node


def parent_and_leaf(doc: Any, dotted: str) -> tuple[Any, str]:
    parts = dotted.split(".")
    node = doc
    for part in parts[:-1]:
        node = node[part]
    return node, parts[-1]


_NUMBER_RE = re.compile(r"^-?\d+(?:\.\d+)?")


def line_edit_for(doc: Any, dotted: str, new_value: int) -> dict:
    """Compute a byte-precise edit for one `key: value` line, using ruamel's
    round-trip line/col tracking — never a full re-dump of the document.

    Returns either {"op": "replace", "line": <0-indexed>, ...} when the key
    already has a value on some line, or {"op": "insert", "after_line": ...}
    when the key is absent (Hermes falls back to its own implicit default)
    and a new `key: value` line must be added at the end of that mapping,
    matching sibling indentation.
    """
    parent, leaf = parent_and_leaf(doc, dotted)
    if leaf in parent:
        value_line, value_col = parent.lc.value(leaf)
        return {"op": "replace", "line": value_line, "col": value_col, "key": leaf}
    # Key absent: insert after the last existing sibling, at its indent.
    if not parent.lc.data:
        raise ValueError(f"cannot locate insertion point for {dotted!r}: empty mapping")
    last_key = max(parent.lc.data, key=lambda k: parent.lc.data[k][2])
    key_line, key_col, _, _ = parent.lc.data[last_key]
    return {"op": "insert", "after_line": key_line, "col": key_col, "key": leaf}


def apply_line_edit(lines: list[str], edit: dict, new_value: int) -> None:
    if edit["op"] == "replace":
        line = lines[edit["line"]]
        col = edit["col"]
        m = _NUMBER_RE.match(line[col:])
        if not m:
            raise ValueError(f"expected a numeric scalar at {edit['line'] + 1}:{col}, got {line[col:col + 20]!r}")
        lines[edit["line"]] = line[:col] + str(new_value) + line[col:][m.end():]
    else:  # insert
        indent = " " * edit["col"]
        lines.insert(edit["after_line"] + 1, f"{indent}{edit['key']}: {new_value}\n")


# --------------------------------------------------------------------------
# OmniRoute live data
# --------------------------------------------------------------------------


def load_omniroute_token(policy: dict) -> str:
    cfg_path = Path(policy["omniroute"]["token_config_path"]).expanduser()
    context_key = policy["omniroute"]["token_context_key"]
    data = json.loads(cfg_path.read_text())
    try:
        return data["contexts"][context_key]["accessToken"]
    except KeyError as exc:
        raise SystemExit(
            f"Could not find accessToken for context {context_key!r} in {cfg_path}"
        ) from exc


def fetch_json(base_url: str, path: str, token: str) -> dict:
    req = urllib.request.Request(
        base_url.rstrip("/") + path,
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.URLError as exc:
        raise SystemExit(f"OmniRoute request failed: GET {path}: {exc}") from exc


def fetch_combos(base_url: str, token: str) -> dict[str, dict]:
    data = fetch_json(base_url, "/api/combos", token)
    return {c["name"]: c for c in data["combos"]}


def fetch_combo_defaults(base_url: str, token: str) -> dict:
    data = fetch_json(base_url, "/api/settings/combo-defaults", token)
    return data["comboDefaults"]


# --------------------------------------------------------------------------
# Budget formula
#
# Formula (README.md has the full derivation with file:line citations):
#
#   per_target_ms   = (maxRetries + 1) * targetTimeoutMs + maxRetries * retryDelayMs
#   attempted_members = min(members, max(1, max_global_attempts // (maxRetries + 1)))
#   raw_sum_ms      = per_target_ms * attempted_members
#   cap_ms          = comboTimeoutMs if comboTimeoutMs > 0 else combo_loop_safety_timeout_s * 1000
#   budget_ms       = min(raw_sum_ms, cap_ms)
#
# `comboTimeoutMs` unset (0) on every combo we found live on the gateway, so
# `combo_loop_safety_timeout_s` (OmniRoute's own blanket ceiling) currently
# dominates for all of them — see README "Why every combo is flagged".
# --------------------------------------------------------------------------


@dataclass
class Budget:
    combo: str
    members: int
    attempted_members: int
    max_retries: int
    retry_delay_ms: float
    target_timeout_ms: float
    combo_timeout_ms: float
    per_target_ms: float
    raw_sum_ms: float
    cap_ms: float
    budget_ms: float
    capped_by_safety_net: bool

    @property
    def budget_s(self) -> float:
        return self.budget_ms / 1000.0


def compute_budget(
    combo: dict, defaults: dict, formula: dict
) -> Budget:
    cfg = combo["config"]
    n_members = len(combo.get("models", []))
    max_retries = cfg.get("maxRetries")
    if max_retries is None:
        max_retries = defaults["maxRetries"]
    retry_delay_ms = cfg.get("retryDelayMs")
    if retry_delay_ms is None:
        retry_delay_ms = defaults["retryDelayMs"]
    target_timeout_ms = cfg.get("targetTimeoutMs")
    if target_timeout_ms is None:
        target_timeout_ms = defaults["targetTimeoutMs"]
    combo_timeout_ms = cfg.get("comboTimeoutMs") or 0

    per_target_ms = (max_retries + 1) * target_timeout_ms + max_retries * retry_delay_ms

    attempts_per_member = max_retries + 1
    max_members_by_attempts = max(1, formula["max_global_attempts"] // attempts_per_member)
    attempted_members = min(n_members, max_members_by_attempts) if n_members else 0
    raw_sum_ms = per_target_ms * max(attempted_members, 1)

    cap_ms = (
        combo_timeout_ms
        if combo_timeout_ms > 0
        else formula["combo_loop_safety_timeout_s"] * 1000
    )
    budget_ms = min(raw_sum_ms, cap_ms)

    return Budget(
        combo=combo["name"],
        members=n_members,
        attempted_members=attempted_members,
        max_retries=max_retries,
        retry_delay_ms=retry_delay_ms,
        target_timeout_ms=target_timeout_ms,
        combo_timeout_ms=combo_timeout_ms,
        per_target_ms=per_target_ms,
        raw_sum_ms=raw_sum_ms,
        cap_ms=cap_ms,
        budget_ms=budget_ms,
        capped_by_safety_net=raw_sum_ms > cap_ms and combo_timeout_ms <= 0,
    )


def margin_s(budget_s: float, formula: dict) -> float:
    return max(formula["margin_floor_s"], budget_s * formula["margin_pct"])


# --------------------------------------------------------------------------
# Per-profile, per-caller evaluation
# --------------------------------------------------------------------------


@dataclass
class CallerResult:
    profile: str
    caller: str
    kind: str
    config_key: str
    combo: Optional[str]
    skipped_reason: Optional[str]
    budget: Optional[Budget]
    current_s: Optional[float]
    current_is_implicit_default: bool
    proposed_s: Optional[float]
    flagged: bool


def resolve_combo_name(doc: Any, caller_cfg: dict) -> Optional[str]:
    value = get_path(doc, caller_cfg["combo_source"])
    if value is _MISSING or not value:
        return None
    return str(value)


def evaluate_caller(
    profile_label: str,
    caller_name: str,
    caller_cfg: dict,
    doc: Any,
    combos: dict[str, dict],
    combo_defaults: dict,
    formula: dict,
) -> CallerResult:
    kind = caller_cfg["kind"]
    config_key = caller_cfg["config_key"]

    combo_name = resolve_combo_name(doc, caller_cfg)
    if not combo_name:
        return CallerResult(
            profile_label, caller_name, kind, config_key, None,
            "no combo resolved (provider not omni-route / empty model)",
            None, None, False, None, False,
        )
    combo = combos.get(combo_name)
    if combo is None:
        return CallerResult(
            profile_label, caller_name, kind, config_key, combo_name,
            f"combo {combo_name!r} not found on live gateway",
            None, None, False, None, False,
        )

    budget = compute_budget(combo, combo_defaults, formula)
    m_s = margin_s(budget.budget_s, formula)
    formula_proposed_s = budget.budget_s + m_s

    raw_current = get_path(doc, config_key)
    if raw_current is _MISSING or raw_current is None:
        current_s = HERMES_DEFAULT_AUX_TIMEOUT_S
        current_is_implicit = True
    else:
        current_s = float(raw_current)
        current_is_implicit = False

    if kind == "auxiliary":
        proposed_s = math.ceil(formula_proposed_s)
    else:  # kind == "turn": never propose shrinking a whole-turn/child budget
        proposed_s = math.ceil(max(current_s, formula_proposed_s))

    flagged = formula_proposed_s > formula["flag_above_seconds"]

    return CallerResult(
        profile_label, caller_name, kind, config_key, combo_name, None,
        budget, current_s, current_is_implicit, proposed_s, flagged,
    )


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------


def print_table(profile_label: str, results: list[CallerResult]) -> None:
    print(f"\n=== profile: {profile_label} ===")
    header = f"{'caller':30s} {'combo':26s} {'budget_s':>9s} {'current_s':>10s} {'proposed_s':>11s} {'delta':>7s}  flag"
    print(header)
    print("-" * len(header))
    for r in results:
        if r.skipped_reason:
            print(f"{r.caller:30s} {'-':26s} {'-':>9s} {'-':>10s} {'-':>11s} {'-':>7s}  skip: {r.skipped_reason}")
            continue
        budget_s = f"{r.budget.budget_s:.0f}"
        cur = f"{r.current_s:.0f}{'*' if r.current_is_implicit_default else ''}"
        delta = r.proposed_s - r.current_s
        delta_s = f"{delta:+.0f}"
        flag = "COMBO_TIMEOUT_MS" if r.flagged else ""
        print(f"{r.caller:30s} {r.combo:26s} {budget_s:>9s} {cur:>10s} {r.proposed_s:>11.0f} {delta_s:>7s}  {flag}")
    print("  * current value is Hermes's implicit default (key absent from config)")


def to_mapping_dict(results: list[CallerResult]) -> dict:
    out: dict[str, dict] = {}
    for r in results:
        entry: dict[str, Any] = {
            "kind": r.kind,
            "config_key": r.config_key,
            "combo": r.combo,
        }
        if r.skipped_reason:
            entry["skipped"] = r.skipped_reason
        else:
            b = r.budget
            entry.update(
                {
                    "budget_s": round(b.budget_s, 1),
                    "budget_detail": {
                        "members": b.members,
                        "attempted_members": b.attempted_members,
                        "max_retries": b.max_retries,
                        "retry_delay_ms": b.retry_delay_ms,
                        "target_timeout_ms": b.target_timeout_ms,
                        "combo_timeout_ms": b.combo_timeout_ms,
                        "raw_sum_s": round(b.raw_sum_ms / 1000.0, 1),
                        "capped_by_safety_net": b.capped_by_safety_net,
                    },
                    "current_s": r.current_s,
                    "current_is_implicit_default": r.current_is_implicit_default,
                    "proposed_s": r.proposed_s,
                    "flagged_needs_combo_timeout_ms": r.flagged,
                }
            )
        out[r.caller] = entry
    return out


# --------------------------------------------------------------------------
# Apply (rewrite in place, preserving formatting)
# --------------------------------------------------------------------------


def backup_path(path: Path) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return path.with_suffix(path.suffix + f".{stamp}.bak")


def apply_profile(path: Path, doc: Any, results: list[CallerResult]) -> list[str]:
    """Rewrite only the specific `timeout:` scalars this profile's proposals
    touch, as precise line edits (see line_edit_for/apply_line_edit) — never
    a full YAML re-dump, so comments/key order/formatting elsewhere in the
    file are untouched byte-for-byte.
    """
    to_change = [
        r
        for r in results
        if not r.skipped_reason
        and r.kind == "auxiliary"  # never auto-apply turn-kind proposals; see README
        and (r.proposed_s != r.current_s or r.current_is_implicit_default)
    ]
    if not to_change:
        return []

    edits = [(r, line_edit_for(doc, r.config_key, int(r.proposed_s))) for r in to_change]
    # Apply bottom-to-top so an insertion never invalidates a not-yet-applied
    # edit's line number above it.
    edits.sort(key=lambda pair: pair[1].get("line", pair[1].get("after_line")), reverse=True)

    bak = backup_path(path)
    shutil.copy2(path, bak)
    lines = path.read_text().splitlines(keepends=True)
    changed: list[str] = []
    for r, edit in edits:
        apply_line_edit(lines, edit, int(r.proposed_s))
        changed.append(f"{r.config_key}: {r.current_s:.0f} -> {r.proposed_s:.0f}")
    path.write_text("".join(lines))

    print(f"  applied {len(changed)} change(s) to {path} (backup: {bak})")
    for c in reversed(changed):  # report in file order, not application order
        print(f"    {c}")
    return changed


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", default=str(SCRIPT_DIR / "policy.yaml"))
    parser.add_argument("--mapping-out", default=str(SCRIPT_DIR / "current-mapping.json"))
    parser.add_argument("--profile", action="append", help="restrict to one or more profile labels")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="rewrite auxiliary `timeout` values in place (default: dry-run only)",
    )
    args = parser.parse_args()

    yaml = make_yaml()
    policy = yaml.load(Path(args.policy).read_text())

    token = load_omniroute_token(policy)
    base_url = policy["omniroute"]["base_url"]
    combos = fetch_combos(base_url, token)
    combo_defaults = fetch_combo_defaults(base_url, token)
    formula = policy["formula"]
    callers = policy["callers"]

    mapping: dict[str, dict] = {}
    any_flagged = False

    for profile_name, profile_cfg in policy["profiles"].items():
        if args.profile and profile_name not in args.profile:
            continue
        path = Path(profile_cfg["path"]).expanduser()
        label = profile_cfg["label"]
        doc = yaml.load(path.read_text())

        results = [
            evaluate_caller(label, caller_name, caller_cfg, doc, combos, combo_defaults, formula)
            for caller_name, caller_cfg in callers.items()
        ]
        print_table(label, results)
        mapping[profile_name] = to_mapping_dict(results)
        any_flagged = any_flagged or any(r.flagged for r in results if not r.skipped_reason)

        if args.apply:
            apply_profile(path, doc, results)

    Path(args.mapping_out).write_text(json.dumps(mapping, indent=2) + "\n")
    print(f"\nwrote {args.mapping_out}")
    if any_flagged:
        print(
            "\nNote: callers flagged COMBO_TIMEOUT_MS have no comboTimeoutMs of their "
            "own on OmniRoute, so their budget is OmniRoute's blanket "
            f"{formula['combo_loop_safety_timeout_s']}s safety net, not a value tuned "
            "for that task. Prefer setting config.comboTimeoutMs on the OmniRoute combo "
            "over raising Hermes's timeout to match — see README.md."
        )
    if not args.apply:
        print("\nDry run: no files were changed. Re-run with --apply to write changes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
