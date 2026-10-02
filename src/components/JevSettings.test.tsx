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
import JevSettings from "./JevSettings";

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
  const save = screen.getByRole("button", { name: "SAVE JEV SETTINGS" });
  await waitFor(() => expect(save).toBeEnabled());
  fireEvent.change(screen.getByLabelText("ROUTING MODE"), {
    target: { value: "shadow" },
  });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText("API KEY"), {
    target: { value: "test-secret" },
  });
  expect(save).toBeEnabled();
});

test("saves settings through the host and clears entered credentials", async () => {
  invoke
    .mockResolvedValueOnce(config)
    .mockResolvedValueOnce({ ...config, mode: "shadow", has_api_key: true });
  const toast = vi.fn();
  render(<JevSettings onToast={toast} />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "SAVE JEV SETTINGS" }),
    ).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText("ROUTING MODE"), {
    target: { value: "shadow" },
  });
  fireEvent.change(screen.getByLabelText("API KEY"), {
    target: { value: "test-secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "SAVE JEV SETTINGS" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenLastCalledWith("save_jev_settings", {
      settings: { ...config, mode: "shadow" },
      apiKey: "test-secret",
    }),
  );
  expect(await screen.findByRole("status")).toHaveTextContent(
    "restart project chat",
  );
  expect(screen.getByLabelText("API KEY")).toHaveValue("");
  expect(toast).toHaveBeenCalledTimes(1);
});

test("shows a configuration load error without enabling a provider", async () => {
  invoke.mockRejectedValue(new Error("Cannot read Jev settings"));
  render(<JevSettings onToast={vi.fn()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Cannot read Jev settings",
  );
  expect(screen.getByLabelText("ROUTING MODE")).toHaveValue("off");
  expect(invoke).toHaveBeenCalledTimes(1);
});

test("reflects automatic billing Off while retaining the user's unsaved fields", async () => {
  invoke.mockResolvedValue({ ...config, mode: "shadow", has_api_key: true });
  render(<JevSettings onToast={vi.fn()} />);
  await waitFor(() =>
    expect(screen.getByLabelText("ROUTING MODE")).toHaveValue("shadow"),
  );
  fireEvent.change(screen.getByLabelText("MODEL"), {
    target: { value: "my-new-model" },
  });
  const { act } = await import("@testing-library/react");
  act(() => onSettingsChanged?.());
  expect(screen.getByLabelText("ROUTING MODE")).toHaveValue("off");
  expect(screen.getByLabelText("MODEL")).toHaveValue("my-new-model");
  expect(screen.getByRole("status")).toHaveTextContent(
    "automatically switched Off",
  );
});
