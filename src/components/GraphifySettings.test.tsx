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
    name: /^Enable Graphify/,
  });
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("save_graphify_settings", {
      enabled: true,
      baseUrl: "",
      model: "",
      apiKey: null,
      connectionId: null,
    }),
  );
});

test("Graphify can reuse an OpenAI-compatible connection", async () => {
  const config = {
    enabled: true,
    base_url: "",
    model: "",
    has_api_key: false,
  };
  invoke.mockImplementation((command: string) => {
    if (command === "list_connections")
      return Promise.resolve({
        profiles: [
          {
            id: "openrouter",
            name: "OpenRouter",
            protocol: "openai-chat",
            base_url: "https://openrouter.ai/api/v1",
            models: [],
            has_api_key: true,
          },
          {
            id: "zai",
            name: "Z.ai",
            protocol: "anthropic",
            base_url: "https://api.z.ai/api/anthropic",
            models: [],
            has_api_key: true,
          },
        ],
        assignments: {},
        compatibility: {},
        assignment_required: [],
      });
    if (command === "fetch_connection_models")
      return Promise.resolve(["deepseek/deepseek-v4"]);
    return Promise.resolve(config);
  });
  render(<GraphifySettings onToast={vi.fn()} />);
  const select = await screen.findByLabelText(/^Connection/);
  expect(
    Array.from(select.querySelectorAll("option")).map((o) => o.textContent),
  ).toEqual(["Custom endpoint", "OpenRouter"]);
  fireEvent.change(select, { target: { value: "openrouter" } });
  expect(screen.queryByLabelText("Base URL")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "deepseek/deepseek-v4" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("save_graphify_settings", {
      enabled: true,
      baseUrl: "",
      model: "deepseek/deepseek-v4",
      apiKey: null,
      connectionId: "openrouter",
    }),
  );
});
