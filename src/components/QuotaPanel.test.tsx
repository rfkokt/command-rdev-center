// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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

afterEach(() => {
  cleanup();
  invoke.mockReset();
  confirm.mockReset();
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
};

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
    await screen.findByRole("meter", { name: "Claude 5-hour" }),
  ).toHaveAttribute("aria-valuenow", "57");
  expect(screen.getByText("pro", { exact: false })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "VPS" })).toBeInTheDocument();
  expect(
    screen.getByRole("meter", { name: "me@example.com Weekly" }),
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
