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
import ConnectionsSettings, {
  slugify,
  type ConnectionsView,
} from "./ConnectionsSettings";

const empty: ConnectionsView = {
  profiles: [],
  assignments: {},
  compatibility: {
    pi: ["openai-chat", "openai-responses", "anthropic"],
    "oh-my-pi": ["openai-chat", "openai-responses", "anthropic"],
    opencode: ["openai-chat", "openai-responses", "anthropic"],
    "claude-code": ["anthropic"],
    codex: ["openai-responses"],
  },
  assignment_required: ["claude-code", "codex"],
};

const withProfiles: ConnectionsView = {
  ...empty,
  profiles: [
    {
      id: "openrouter",
      name: "OpenRouter",
      protocol: "openai-chat",
      base_url: "https://openrouter.ai/api/v1",
      models: ["deepseek/deepseek-v4"],
      has_api_key: true,
    },
    {
      id: "zai",
      name: "Z.ai",
      protocol: "anthropic",
      base_url: "https://api.z.ai/api/anthropic",
      models: ["glm-5"],
      has_api_key: true,
    },
  ],
};

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

test("slugify makes valid connection ids", () => {
  expect(slugify("Z.ai GLM (prod)")).toBe("z-ai-glm-prod");
});

test("creates a connection from a preset, fetches and picks models", async () => {
  invoke.mockImplementation((command: string) => {
    if (command === "list_connections") return Promise.resolve(empty);
    if (command === "fetch_connection_models")
      return Promise.resolve(["deepseek/deepseek-v4", "qwen/qwen3-coder"]);
    if (command === "save_connection") return Promise.resolve(withProfiles);
    return Promise.resolve(undefined);
  });
  const toast = vi.fn();
  render(<ConnectionsSettings onToast={toast} />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("list_connections"));
  fireEvent.click(screen.getByRole("button", { name: "OpenRouter" }));
  const save = screen.getByRole("button", { name: "Save connection" });
  expect(save).toBeDisabled();
  fireEvent.change(screen.getByLabelText("API key"), {
    target: { value: "sk-or" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "qwen/qwen3-coder" }),
  );
  fireEvent.click(save);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("save_connection", {
      profile: {
        id: "openrouter",
        name: "OpenRouter",
        protocol: "openai-chat",
        base_url: "https://openrouter.ai/api/v1",
        models: ["qwen/qwen3-coder"],
      },
      apiKey: "sk-or",
    }),
  );
  expect(invoke).toHaveBeenCalledWith("fetch_connection_models", {
    protocol: "openai-chat",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "sk-or",
    id: null,
  });
  expect(toast).toHaveBeenCalled();
});

test("only offers protocol-compatible connections per agent", async () => {
  invoke.mockImplementation((command: string) =>
    Promise.resolve(
      command === "list_connections" ? withProfiles : withProfiles,
    ),
  );
  render(<ConnectionsSettings onToast={vi.fn()} />);
  const claude = await screen.findByLabelText("Connection for Claude Code");
  const options = Array.from(claude.querySelectorAll("option")).map(
    (option) => option.textContent,
  );
  expect(options).toEqual(["Own login / env", "Z.ai"]);
  expect(screen.getByLabelText("Connection for Codex")).toBeDisabled();
  expect(
    screen.getByText("Needs a connection using OpenAI Responses"),
  ).toBeInTheDocument();
  fireEvent.change(claude, { target: { value: "zai" } });
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("set_connection_assignment", {
      harness: "claude-code",
      profileId: "zai",
    }),
  );
});

test("editing keeps the saved key unless a new one is typed", async () => {
  invoke.mockImplementation((command: string) =>
    Promise.resolve(
      command === "list_connections" ? withProfiles : withProfiles,
    ),
  );
  render(<ConnectionsSettings onToast={vi.fn()} />);
  fireEvent.click((await screen.findAllByRole("button", { name: "Edit" }))[1]);
  expect(screen.getByLabelText("API key")).toHaveAttribute(
    "placeholder",
    "Saved; leave blank to keep",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      "save_connection",
      expect.objectContaining({
        apiKey: null,
        profile: expect.objectContaining({ id: "zai", protocol: "anthropic" }),
      }),
    ),
  );
});
