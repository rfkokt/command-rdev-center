import { expect, test, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import {
  createReplyRefresher,
  detectResets,
  formatReset,
  REPLY_REFRESH_DELAY_MS,
  REPLY_REFRESH_MIN_MS,
  refreshQuota,
  type QuotaAccount,
  type QuotaSnapshot,
} from "./quota";

const account = (overrides: Partial<QuotaAccount>): QuotaAccount => ({
  id: "claude",
  group: "Claude",
  source: "claude",
  provider: "claude",
  name: "Claude",
  plan: "pro",
  windows: [],
  reset_credits: 0,
  note: null,
  error: null,
  ...overrides,
});

const snapshot = (accounts: QuotaAccount[]): QuotaSnapshot => ({
  accounts,
  routers: 1,
  checked_at: 0,
});

const windows = (session: number, weekly: number) => [
  { label: "5-hour", used_percent: session, resets_at: null },
  { label: "Weekly", used_percent: weekly, resets_at: null },
];

test("reports windows whose usage dropped as resets", () => {
  const before = snapshot([
    account({ windows: windows(57, 34) }),
    account({ id: "9router:c", name: "Codex", windows: windows(80, 90) }),
  ]);
  const after = snapshot([
    account({ windows: windows(0, 34) }),
    account({ id: "9router:c", name: "Codex", windows: windows(0, 0) }),
  ]);
  expect(detectResets(before, after)).toEqual([
    "Claude: 5-hour quota reset",
    "Codex: 5-hour + Weekly quota reset",
  ]);
});

test("ignores small drops, low usage, errors and the first snapshot", () => {
  const after = snapshot([account({ windows: windows(0, 30) })]);
  expect(detectResets(null, after)).toEqual([]);
  expect(
    detectResets(snapshot([account({ windows: windows(5, 35) })]), after),
  ).toEqual([]);
  expect(
    detectResets(
      snapshot([account({ windows: windows(60, 30), error: "expired" })]),
      after,
    ),
  ).toEqual([]);
});

test("announces new reset credits", () => {
  const before = snapshot([account({ name: "Codex", reset_credits: 0 })]);
  const after = snapshot([account({ name: "Codex", reset_credits: 1 })]);
  expect(detectResets(before, after)).toEqual([
    "Codex: limit reset credit available",
  ]);
});

test("formatReset counts down within a day", () => {
  const now = 1_000_000_000_000;
  expect(formatReset(null, now)).toBe("");
  expect(formatReset(now / 1000 + 25 * 60, now)).toBe("resets in 25m");
  expect(formatReset(now / 1000 + 3 * 3600 + 5 * 60, now)).toBe(
    "resets in 3h 5m",
  );
  expect(formatReset(now / 1000 + 3 * 86400, now)).toMatch(/^resets /);
});

test("reply refreshes wait for usage to land and collapse bursts", () => {
  vi.useFakeTimers();
  try {
    const refresh = vi.fn();
    const replies = createReplyRefresher(refresh, () => Date.now());
    replies.onReply();
    replies.onReply();
    vi.advanceTimersByTime(REPLY_REFRESH_DELAY_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Another reply right away waits out the minimum gap, then refreshes once.
    replies.onReply();
    replies.onReply();
    vi.advanceTimersByTime(REPLY_REFRESH_MIN_MS - 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);

    replies.onReply();
    replies.cancel();
    vi.advanceTimersByTime(REPLY_REFRESH_MIN_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test("refreshQuota shares lookups and lets a forced one follow a cached one", async () => {
  const { invoke } = await import("@tauri-apps/api/core");
  const calls: boolean[] = [];
  let release!: () => void;
  vi.mocked(invoke).mockImplementation(((
    _: string,
    args: { refresh: boolean },
  ) => {
    calls.push(args.refresh);
    return calls.length === 1
      ? new Promise((resolve) => (release = () => resolve(snapshot([]))))
      : Promise.resolve(snapshot([]));
  }) as never);
  const cached = refreshQuota(false);
  const shared = refreshQuota(false);
  const forced = refreshQuota(true);
  release();
  await Promise.all([cached, shared, forced]);
  expect(calls).toEqual([false, true]);
});
