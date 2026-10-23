import { invoke } from "@tauri-apps/api/core";

/** Mirrors `quota::QuotaWindow`. */
export type QuotaWindow = {
  label: string;
  used_percent: number;
  /** Unix seconds. */
  resets_at: number | null;
};

/** Mirrors `quota::QuotaAccount`. */
export type QuotaAccount = {
  id: string;
  source: "claude" | "9router";
  provider: string;
  name: string;
  plan: string | null;
  windows: QuotaWindow[];
  reset_credits: number;
  note: string | null;
  error: string | null;
};

export type QuotaSnapshot = {
  accounts: QuotaAccount[];
  router_configured: boolean;
  checked_at: number;
};

export const QUOTA_POLL_MS = 5 * 60 * 1000;

/**
 * A window counts as reset when its usage drops by at least 10 points from
 * a meaningful level (scheduled rollover, a redeemed credit, or a bonus
 * reset granted by the provider). New reset credits are reported too.
 */
export function detectResets(
  previous: QuotaSnapshot | null,
  next: QuotaSnapshot,
): string[] {
  if (!previous) return [];
  const messages: string[] = [];
  for (const account of next.accounts) {
    const before = previous.accounts.find((item) => item.id === account.id);
    if (!before || account.error || before.error) continue;
    const reset = account.windows.filter((window) => {
      const old = before.windows.find((item) => item.label === window.label);
      return (
        old !== undefined &&
        old.used_percent >= 10 &&
        old.used_percent - window.used_percent >= 10
      );
    });
    if (reset.length > 0)
      messages.push(
        `${account.name}: ${reset.map((window) => window.label).join(" + ")} quota reset`,
      );
    if (account.reset_credits > before.reset_credits)
      messages.push(`${account.name}: limit reset credit available`);
  }
  return messages;
}

let current: QuotaSnapshot | null = null;
const listeners = new Set<(snapshot: QuotaSnapshot) => void>();

export function quotaSnapshot(): QuotaSnapshot | null {
  return current;
}

export function subscribeQuota(listener: (snapshot: QuotaSnapshot) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let notify: ((message: string) => void) | null = null;

export async function refreshQuota(force = false): Promise<QuotaSnapshot> {
  const next = await invoke<QuotaSnapshot>("get_quota", { refresh: force });
  for (const message of detectResets(current, next)) notify?.(message);
  current = next;
  for (const listener of listeners) listener(next);
  return next;
}

/** One poller for the whole app; panels subscribe to its snapshots. */
export function startQuotaPolling(toast: (message: string) => void) {
  notify = toast;
  const tick = () => void refreshQuota().catch(() => {});
  tick();
  const id = window.setInterval(tick, QUOTA_POLL_MS);
  return () => {
    window.clearInterval(id);
    notify = null;
  };
}

export function formatReset(resetsAt: number | null, now = Date.now()) {
  if (!resetsAt) return "";
  const minutes = Math.max(0, Math.round((resetsAt * 1000 - now) / 60000));
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets ${new Date(resetsAt * 1000).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}
