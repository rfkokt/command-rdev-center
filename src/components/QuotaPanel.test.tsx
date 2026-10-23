// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
const confirm = vi.fn();
vi.mock("./ConfirmDialog", () => ({
  confirm: (...args: unknown[]) => confirm(...args),
}));
import QuotaPanel from "./QuotaPanel";
import { refreshQuota, type QuotaSnapshot } from "../lib/quota";

afterEach(() => {
  cleanup();
  invoke.mockReset();
  confirm.mockReset();
  localStorage.clear();
  vi.restoreAllMocks();
});

const snapshot = {
  routers: 1,
  checked_at: 1_792_772_000,
  accounts: [
    {
      id: "claude",
      group: "Claude",
      source: "claude",
      provider: "claude",
      name: "Claude",
      plan: "pro",
      windows: [{ label: "5-hour", used_percent: 57, resets_at: null }],
      reset_credits: 0,
      note: null,
      error: null,
    },
    {
      id: "9router:vps:abc",
      group: "VPS",
      source: "9router",
      provider: "codex",
      name: "me@example.com",
      plan: "plus",
      windows: [{ label: "Weekly", used_percent: 95, resets_at: null }],
      reset_credits: 1,
      note: null,
      error: null,
    },
  ],
} satisfies QuotaSnapshot;

test("shows each account's windows and redeems a credit after confirming", async () => {
  invoke.mockImplementation((command: string) =>
    Promise.resolve(
      command === "redeem_quota_reset" ? "Limits reset" : snapshot,
    ),
  );
  confirm.mockResolvedValue(true);
  const toast = vi.fn();
  render(<QuotaPanel onToast={toast} />);

  expect(
    await screen.findByRole("meter", { name: "Claude 5-hour remaining" }),
  ).toHaveAttribute("aria-valuenow", "43");
  expect(screen.getByText("pro", { exact: false })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "VPS" })).toBeInTheDocument();
  expect(
    screen.getByRole("meter", { name: "me@example.com Weekly remaining" }),
  ).toHaveClass("is-critical");

  fireEvent.click(
    screen.getByRole("button", { name: "Use reset credit (1 left)" }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("redeem_quota_reset", {
      accountId: "9router:vps:abc",
    }),
  );
  expect(toast).toHaveBeenCalledWith("me@example.com: Limits reset");
});

test("does nothing when the reset is not confirmed", async () => {
  invoke.mockResolvedValue(snapshot);
  confirm.mockResolvedValue(false);
  render(<QuotaPanel onToast={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Use reset credit (1 left)" }),
  );
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  expect(invoke).not.toHaveBeenCalledWith(
    "redeem_quota_reset",
    expect.anything(),
  );
});

test("pins accounts above their source groups and remembers the choice", async () => {
  invoke.mockResolvedValue(snapshot);
  const { unmount } = render(<QuotaPanel onToast={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Pin me@example.com (VPS)" }),
  );
  expect(screen.getAllByRole("heading")[0]).toHaveTextContent("Pinned");
  expect(screen.getAllByRole("region")[0]).toHaveAccessibleName(
    "me@example.com",
  );
  expect(
    screen.getAllByRole("region", { name: "me@example.com" }),
  ).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "Unpin me@example.com (VPS)" }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(JSON.parse(localStorage.getItem("crc:quota-pinned:v1")!)).toEqual([
    "9router:vps:abc",
  ]);

  unmount();
  render(<QuotaPanel onToast={vi.fn()} />);
  expect(screen.getAllByRole("region")[0]).toHaveAccessibleName(
    "me@example.com",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Unpin me@example.com (VPS)" }),
  );
  expect(
    screen.queryByRole("heading", { name: "Pinned" }),
  ).not.toBeInTheDocument();
  expect(screen.getAllByRole("region")[0]).toHaveAccessibleName("Claude");
  expect(screen.getByRole("heading", { name: "VPS" })).toBeInTheDocument();
});

test("keeps pin preferences in sync between mounted chat panels", async () => {
  invoke.mockResolvedValue(snapshot);
  const first = render(<QuotaPanel onToast={vi.fn()} />);
  const second = render(<QuotaPanel onToast={vi.fn()} />);
  fireEvent.click(
    await within(first.container).findByRole("button", {
      name: "Pin Claude (Claude)",
    }),
  );
  expect(
    within(second.container).getByRole("button", {
      name: "Unpin Claude (Claude)",
    }),
  ).toHaveAttribute("aria-pressed", "true");
  act(() => {
    localStorage.setItem(
      "crc:quota-pinned:v1",
      JSON.stringify(["9router:vps:abc"]),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: "crc:quota-pinned:v1" }),
    );
  });
  for (const panel of [first, second]) {
    expect(
      within(panel.container).getByRole("button", {
        name: "Unpin me@example.com (VPS)",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(panel.container).getByRole("button", {
        name: "Pin Claude (Claude)",
      }),
    ).toHaveAttribute("aria-pressed", "false");
  }
});

test("shows the five most used quotas and allows expanding the complete list", async () => {
  invoke.mockResolvedValue({
    ...snapshot,
    accounts: [
      {
        ...snapshot.accounts[1],
        windows: Array.from({ length: 7 }, (_, index) => ({
          label: `Model ${index}`,
          used_percent: index === 6 ? 95 : 0,
          resets_at: null,
        })),
      },
    ],
  });
  render(<QuotaPanel onToast={vi.fn()} />);
  expect(
    await screen.findByRole("meter", {
      name: "me@example.com Model 6 remaining",
    }),
  ).toHaveAttribute("aria-valuenow", "5");
  expect(screen.getAllByRole("meter")).toHaveLength(5);
  expect(
    screen.queryByRole("meter", { name: "me@example.com Model 5 remaining" }),
  ).not.toBeInTheDocument();
  const expand = screen.getByRole("button", { name: "Show 2 more quotas" });
  expect(expand).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(expand);
  expect(screen.getAllByRole("meter")).toHaveLength(7);
  expect(
    screen.getByRole("meter", { name: "me@example.com Model 5 remaining" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show fewer quotas" }));
  expect(screen.getAllByRole("meter")).toHaveLength(5);
});

test("retains pinned accounts when live quota snapshots are refreshed", async () => {
  invoke.mockResolvedValue(snapshot);
  render(<QuotaPanel onToast={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Pin me@example.com (VPS)" }),
  );
  invoke.mockResolvedValue({
    ...snapshot,
    accounts: [snapshot.accounts[1]],
  });
  await act(async () => {
    await refreshQuota(true);
  });
  expect(screen.getAllByRole("region")).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "Unpin me@example.com (VPS)" }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("ignores corrupt saved pins and still supports pinning without storage", async () => {
  localStorage.setItem("crc:quota-pinned:v1", "not json");
  invoke.mockResolvedValue(snapshot);
  const toast = vi.fn();
  render(<QuotaPanel onToast={toast} />);
  const pin = await screen.findByRole("button", {
    name: "Pin me@example.com (VPS)",
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  fireEvent.click(pin);
  expect(screen.getAllByRole("region")[0]).toHaveAccessibleName(
    "me@example.com",
  );
  expect(toast).toHaveBeenCalledWith(
    expect.stringContaining("for this session"),
  );
});

test("keeps available and exhausted quota values unambiguous", async () => {
  invoke.mockResolvedValue({
    ...snapshot,
    accounts: [
      {
        ...snapshot.accounts[0],
        windows: [
          { label: "Available", used_percent: 0, resets_at: null },
          { label: "Exhausted", used_percent: 100, resets_at: null },
        ],
      },
    ],
  });
  render(<QuotaPanel onToast={vi.fn()} />);
  const available = await screen.findByRole("meter", {
    name: "Claude Available remaining",
  });
  expect(available).toHaveAttribute("aria-valuenow", "100");
  expect(available).toHaveAttribute(
    "aria-valuetext",
    "100% remaining, 0% used",
  );
  expect(available.firstElementChild).toHaveStyle({ width: "100%" });
  const exhausted = screen.getByRole("meter", {
    name: "Claude Exhausted remaining",
  });
  expect(exhausted).toHaveAttribute("aria-valuenow", "0");
  expect(exhausted.firstElementChild).toHaveStyle({ width: "0%" });
});
