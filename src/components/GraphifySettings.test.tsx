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
import GraphifySettings from "./GraphifySettings";
afterEach(() => {
  cleanup();
  invoke.mockReset();
});
test("Graphify defaults off and can opt in without a semantic provider", async () => {
  const config = {
    enabled: false,
    base_url: "",
    model: "",
    has_api_key: false,
  };
  invoke.mockResolvedValue(config);
  render(<GraphifySettings onToast={vi.fn()} />);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("get_graphify_settings"),
  );
  const toggle = screen.getByRole("checkbox", {
    name: "Enable Graphify integration (optional)",
  });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  fireEvent.click(
    screen.getByRole("button", { name: "SAVE GRAPHIFY SETTINGS" }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("save_graphify_settings", {
      enabled: true,
      baseUrl: "",
      model: "",
      apiKey: null,
    }),
  );
});
