import { expect, test } from "vitest";
import {
  detectResets,
  formatReset,
  type QuotaAccount,
  type QuotaSnapshot,
} from "./quota";

const account = (overrides: Partial<QuotaAccount>): QuotaAccount => ({
  id: "claude",
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
  router_configured: true,
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
