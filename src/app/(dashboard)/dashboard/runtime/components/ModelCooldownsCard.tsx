"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Card } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { formatRemaining } from "@/shared/utils/formatRemaining";

type SlowStartStateItem = {
  provider: string;
  connectionId: string;
  accountLabel: string;
  model: string;
  modelFamily: string | null;
  slowCount: number;
  escalationLevel: number;
  cooldownUntil: number | null;
  cooldownRemainingMs: number;
  expiresAt: string | null;
  lastObservationAt: number;
  lastUpstreamHeadersMs: number | null;
  lastStatus: number | null;
  lastLifecycleStatus: string | null;
  lastUpstreamRequestId: string | null;
};

type CooldownItem = {
  scope: "connection-model" | "provider-model";
  provider: string;
  connectionId: string;
  accountLabel: string;
  model: string;
  modelFamily: string | null;
  reason: string;
  remainingMs: number;
  failureCount: number;
  lockedAt: string;
  until: number;
  expiresAt: string | null;
  slowStartState: SlowStartStateItem | null;
};

function scopeKey(provider: string, connectionId: string, model: string): string {
  return `${provider}::${connectionId}::${model}`;
}

function formatAbsolute(timestamp: number, iso: string | null): string {
  const formatted = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date(timestamp));
  return iso ? `${formatted} (${iso})` : formatted;
}

function slowStartDetails(state: SlowStartStateItem): string {
  const parts = [`slow=${state.slowCount}`, `escalation=${state.escalationLevel}`];
  if (state.lastUpstreamHeadersMs !== null) parts.push(`TTFB=${state.lastUpstreamHeadersMs}ms`);
  if (state.lastStatus !== null) parts.push(`status=${state.lastStatus}`);
  if (state.lastLifecycleStatus) parts.push(`lifecycle=${state.lastLifecycleStatus}`);
  return parts.join(" · ");
}

export default function ModelCooldownsCard() {
  const t = useTranslations("settings");
  const notify = useNotificationStore();
  const [items, setItems] = useState<CooldownItem[]>([]);
  const [slowStartStates, setSlowStartStates] = useState<SlowStartStateItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/resilience/model-cooldowns", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setItems(Array.isArray(json.items) ? json.items : []);
      setSlowStartStates(Array.isArray(json.slowStartStates) ? json.slowStartStates : []);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t("modelCooldownsLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [notify, t]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
    const timer = setInterval(() => {
      void load();
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const clearOne = useCallback(
    async (provider: string, connectionId: string | null, model: string) => {
      const key = scopeKey(provider, connectionId ?? "*", model);
      setBusyKey(key);
      try {
        const res = await fetch("/api/resilience/model-cooldowns", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, ...(connectionId ? { connectionId } : {}), model }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
        notify.success(t("modelCooldownReactivated", { model: `${provider}/${model}` }));
        await load();
      } catch (error) {
        notify.error(error instanceof Error ? error.message : t("modelCooldownClearFailed"));
      } finally {
        setBusyKey(null);
      }
    },
    [load, notify, t]
  );

  const clearAll = useCallback(async () => {
    setBusyKey("ALL");
    try {
      const res = await fetch("/api/resilience/model-cooldowns", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      notify.success(t("modelCooldownsAllReactivated"));
      await load();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : t("modelCooldownsClearFailed"));
    } finally {
      setBusyKey(null);
    }
  }, [load, notify, t]);

  const sorted = useMemo(() => [...items].sort((a, b) => b.remainingMs - a.remainingMs), [items]);
  const visibleSlowStartStates = useMemo(() => {
    const lockScopes = new Set(
      items.map((item) => scopeKey(item.provider, item.connectionId, item.model))
    );
    return slowStartStates.filter(
      (state) => !lockScopes.has(scopeKey(state.provider, state.connectionId, state.model))
    );
  }, [items, slowStartStates]);
  const hasItems = sorted.length > 0 || visibleSlowStartStates.length > 0;

  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-text-main">{t("modelCooldownsTitle")}</h2>
          <p className="mt-1 text-sm text-text-muted">{t("modelCooldownsDescription")}</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => void load()} disabled={loading}>
            {t("refresh")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void clearAll()}
            disabled={!hasItems || busyKey === "ALL"}
          >
            {t("modelCooldownsReactivateAll")}
          </Button>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {loading ? (
          <p className="text-sm text-text-muted">{t("loading")}</p>
        ) : !hasItems ? (
          <p className="text-sm text-text-muted">{t("modelCooldownsEmpty")}</p>
        ) : (
          <>
            {sorted.map((item) => {
              const rowKey = scopeKey(item.provider, item.connectionId, item.model);
              const exactConnectionId =
                item.scope === "connection-model" ? item.connectionId : null;
              return (
                <div
                  key={rowKey}
                  className="rounded-lg border border-border bg-bg-subtle px-3 py-2 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-main truncate">
                      {item.provider}/{item.model}
                    </p>
                    <p className="text-xs text-text-muted truncate">
                      {item.accountLabel} · {item.scope}
                      {item.modelFamily ? ` · family:${item.modelFamily}` : ""}
                    </p>
                    <p className="text-xs text-text-muted">
                      {t("modelCooldownsReasonRemaining", {
                        reason: item.reason,
                        remaining: formatRemaining(item.remainingMs),
                      })}
                      {` · ${formatAbsolute(item.until, item.expiresAt)}`}
                    </p>
                    {item.slowStartState ? (
                      <p className="text-xs text-text-muted">
                        slow_start · {slowStartDetails(item.slowStartState)}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void clearOne(item.provider, exactConnectionId, item.model)}
                    disabled={busyKey === rowKey}
                  >
                    {t("modelCooldownsReactivate")}
                  </Button>
                </div>
              );
            })}
            {visibleSlowStartStates.map((state) => {
              const rowKey = scopeKey(state.provider, state.connectionId, state.model);
              return (
                <div
                  key={`slow-start::${rowKey}`}
                  className="rounded-lg border border-border bg-bg-subtle px-3 py-2 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-main truncate">
                      {state.provider}/{state.model}
                    </p>
                    <p className="text-xs text-text-muted truncate">
                      {state.accountLabel} · connection-model
                      {state.modelFamily ? ` · family:${state.modelFamily}` : ""}
                    </p>
                    <p className="text-xs text-text-muted">
                      slow_start · {slowStartDetails(state)}
                    </p>
                    <p className="text-xs text-text-muted">
                      {state.cooldownUntil !== null
                        ? `${formatRemaining(state.cooldownRemainingMs)} · ${formatAbsolute(
                            state.cooldownUntil,
                            state.expiresAt
                          )}`
                        : formatAbsolute(state.lastObservationAt, null)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void clearOne(state.provider, state.connectionId, state.model)}
                    disabled={busyKey === rowKey}
                  >
                    {t("modelCooldownsReactivate")}
                  </Button>
                </div>
              );
            })}
          </>
        )}
      </div>
    </Card>
  );
}
