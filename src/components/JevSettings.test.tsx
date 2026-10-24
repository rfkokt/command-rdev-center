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
let onSettingsChanged: (() => void) | undefined;
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, callback: () => void) => {
    onSettingsChanged = callback;
    return Promise.resolve(vi.fn());
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
import JevSettings, { remainingBalance } from "./JevSettings";

const config = {
  mode: "off",
  endpoint: "https://api.typesafe.ai/v1/systemone",
  model: "jev-1.13.0",
  timeout_ms: 2500,
  has_api_key: false,
};
afterEach(() => {
  cleanup();
  invoke.mockReset();
  onSettingsChanged = undefined;
});

test("requires credentials to opt in, but allows saving Off without a key", async () => {
  invoke.mockResolvedValue(config);
  render(<JevSettings onToast={vi.fn()} />);
  const save = screen.getByRole("button", { name: "Save" });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.change(screen.getByLabelText(/^Routing mode/), {
    target: { value: "shadow" },
  });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/^API key/), {
    target: { value: "test-secret" },
  });
  expect(save).toBeEnabled();
});

test("saves settings through the host and clears entered credentials", async () => {
  invoke.mockImplementation((command: string) =>
    Promise.resolve(
      command === "save_jev_settings"
        ? { ...config, mode: "shadow", has_api_key: true }
        : config,
    ),
  );
  const toast = vi.fn();
  render(<JevSettings onToast={toast} />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText(/^Routing mode/), {
    target: { value: "shadow" },
  });
  fireEvent.change(screen.getByLabelText(/^API key/), {
    target: { value: "test-secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("save_jev_settings", {
      settings: { ...config, mode: "shadow" },
      apiKey: "test-secret",
    }),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "restart project chat",
  );
  expect(screen.getByLabelText(/^API key/)).toHaveValue("");
  expect(toast).toHaveBeenCalledTimes(1);
});

test("shows a configuration load error without enabling a provider", async () => {
  invoke.mockRejectedValue(new Error("Cannot read Jev settings"));
  render(<JevSettings onToast={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Cannot read Jev settings",
  );
  expect(screen.getByLabelText(/^Routing mode/)).toHaveValue("off");
  expect(invoke).not.toHaveBeenCalledWith(
    "save_jev_settings",
    expect.anything(),
  );
});

test("reflects automatic billing Off while retaining the user's unsaved fields", async () => {
  invoke.mockResolvedValue({ ...config, mode: "shadow", has_api_key: true });
  render(<JevSettings onToast={vi.fn()} />);
  await waitFor(() =>
    expect(screen.getByLabelText(/^Routing mode/)).toHaveValue("shadow"),
  );
  fireEvent.change(screen.getByLabelText("Model"), {
    target: { value: "my-new-model" },
  });
  const { act } = await import("@testing-library/react");
  act(() => onSettingsChanged?.());
  expect(screen.getByLabelText(/^Routing mode/)).toHaveValue("off");
  expect(screen.getByLabelText("Model")).toHaveValue("my-new-model");
  expect(screen.getByRole("status")).toHaveTextContent(
    "automatically switched Off",
  );
});

const usage = {
  month_requests: 312,
  month_input_tokens: 1_200_000,
  total_input_tokens: 3_000_000,
  balance_usd: 4.86,
  balance_tokens: 1_000_000,
  balance_set_at: 1,
  billing_exhausted_at: null,
};

test("estimates what is left from the entered balance", () => {
  // 2M tokens since the balance was entered, at $0.042 per million.
  expect(remainingBalance(usage)).toBeCloseTo(4.776, 6);
  expect(remainingBalance({ ...usage, balance_usd: null })).toBeNull();
  expect(remainingBalance({ ...usage, balance_usd: 0.01 })).toBe(0);
});

test("updates the balance read off the TypeSafe dashboard", async () => {
  invoke.mockImplementation((command: string) =>
    Promise.resolve(
      command === "get_jev_usage" || command === "set_jev_balance"
        ? {
            ...usage,
            balance_usd: 4.86,
            balance_tokens: usage.total_input_tokens,
          }
        : config,
    ),
  );
  const toast = vi.fn();
  render(<JevSettings onToast={toast} />);
  const input = await screen.findByLabelText(/^Current balance/);
  await waitFor(() =>
    expect(screen.getByText(/left of \$4\.86/)).toBeInTheDocument(),
  );
  fireEvent.change(input, { target: { value: "4.86" } });
  fireEvent.click(screen.getByRole("button", { name: "Update balance" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("set_jev_balance", {
      balanceUsd: 4.86,
    }),
  );
  expect(toast).toHaveBeenCalledWith("Jev balance set to $4.86");
});
