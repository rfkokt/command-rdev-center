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
  /** Panel heading: "Claude" or the 9router's name. */
  group: string;
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
  /** 9routers with a stored password. */
  routers: number;
  checked_at: number;
};

export const QUOTA_POLL_MS = 5 * 60 * 1000;
/** Providers book usage a moment after a reply ends. */
export const REPLY_REFRESH_DELAY_MS = 3_000;
/** Replies from several chats collapse into one lookup per window. */
export const REPLY_REFRESH_MIN_MS = 20_000;

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
let inflight: { force: boolean; promise: Promise<QuotaSnapshot> } | null = null;

export function refreshQuota(force = false): Promise<QuotaSnapshot> {
  // Concurrent callers (poll, reply, panel open) share one lookup; a forced
  // refresh behind a cached one waits for it, then fetches fresh data.
  if (inflight && (inflight.force || !force)) return inflight.promise;
  if (inflight)
    return inflight.promise.catch(() => null).then(() => refreshQuota(true));
  const promise = invoke<QuotaSnapshot>("get_quota", { refresh: force })
    .then((next) => {
      for (const message of detectResets(current, next)) notify?.(message);
      current = next;
      for (const listener of listeners) listener(next);
      return next;
    })
    .finally(() => {
      inflight = null;
    });
  inflight = { force, promise };
  return promise;
}

/**
 * Refresh shortly after each agent reply, at most once per
 * `REPLY_REFRESH_MIN_MS`; a reply inside that window schedules one trailing
 * refresh so the last reply of a burst is always reflected.
 */
export function createReplyRefresher(
  refresh: () => void,
  now: () => number = Date.now,
) {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    onReply() {
      if (timer !== undefined) return;
      const wait = Math.max(
        REPLY_REFRESH_DELAY_MS,
        last + REPLY_REFRESH_MIN_MS - now(),
      );
      timer = setTimeout(() => {
        timer = undefined;
        last = now();
        refresh();
      }, wait);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** One poller for the whole app; panels subscribe to its snapshots. */
export function startQuotaPolling(toast: (message: string) => void) {
  notify = toast;
  const tick = () => void refreshQuota().catch(() => {});
  tick();
  const id = window.setInterval(tick, QUOTA_POLL_MS);
  const replies = createReplyRefresher(
    () => void refreshQuota(true).catch(() => {}),
  );
  const onActivity = (event: Event) => {
    if (
      (event as CustomEvent<{ type?: string }>).detail?.type === "agent_settled"
    )
      replies.onReply();
  };
  window.addEventListener("crc-agent-activity", onActivity);
  return () => {
    window.clearInterval(id);
    replies.cancel();
    window.removeEventListener("crc-agent-activity", onActivity);
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
