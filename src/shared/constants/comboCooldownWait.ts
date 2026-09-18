// Ceilings shared by the Zod PATCH schema and normalizeComboCooldownWaitSettings
// so the API never rejects a value the normalizer would accept.
export const COMBO_COOLDOWN_WAIT_MAX_WAIT_MS = 5 * 60 * 1000;
export const COMBO_COOLDOWN_WAIT_MAX_BUDGET_MS = 60 * 60 * 1000;
