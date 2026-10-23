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
import HarnessSettings, { type HarnessInfo } from "./HarnessSettings";

const harness = (overrides: Partial<HarnessInfo>): HarnessInfo => ({
  id: "pi",
  label: "pi",
  protocol: "native",
  command: "pi",
  resolved_path: "/usr/local/bin/pi",
  available: true,
  install_hint: "",
  is_default: false,
  custom: false,
  ...overrides,
});

const list = [
  harness({ is_default: true }),
  harness({
    id: "opencode",
    label: "OpenCode",
    protocol: "acp",
    command: "opencode",
    resolved_path: "/opt/homebrew/bin/opencode",
  }),
  harness({
    id: "claude-code",
    label: "Claude Code",
    protocol: "acp",
    command: "claude-agent-acp",
    resolved_path: null,
    available: false,
    install_hint: "npm i -g @agentclientprotocol/claude-agent-acp",
  }),
];

afterEach(() => {
  cleanup();
  invoke.mockReset();
});

test("lists harnesses and disables the ones that are not installed", async () => {
  invoke.mockResolvedValue(list);
  render(<HarnessSettings onToast={vi.fn()} />);
  const claude = await screen.findByLabelText(/Claude Code/);
  expect(claude).toBeDisabled();
  expect(
    screen.getByText("npm i -g @agentclientprotocol/claude-agent-acp"),
  ).toBeInTheDocument();
  expect(screen.getByLabelText(/^pi/)).toBeChecked();
  expect(
    screen.getByRole("button", { name: "Use for new chats" }),
  ).toBeDisabled();
});

test("saves the default harness", async () => {
  invoke.mockImplementation((command: string) =>
    Promise.resolve(command === "list_harnesses" ? list : undefined),
  );
  const toast = vi.fn();
  render(<HarnessSettings onToast={toast} />);
  fireEvent.click(await screen.findByLabelText(/OpenCode/));
  fireEvent.click(screen.getByRole("button", { name: "Use for new chats" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("set_default_harness", {
      id: "opencode",
    }),
  );
  expect(toast).toHaveBeenCalledWith(
    "New chats use OpenCode. Existing chats keep their own agent.",
  );
});

test("adds a custom ACP agent", async () => {
  invoke.mockImplementation((command: string) =>
    Promise.resolve(command === "list_harnesses" ? list : undefined),
  );
  render(<HarnessSettings onToast={vi.fn()} />);
  await screen.findByLabelText(/OpenCode/);
  fireEvent.change(screen.getByLabelText(/^ID/), { target: { value: "kimi" } });
  fireEvent.change(screen.getByLabelText(/^Command/), {
    target: { value: "kimi" },
  });
  fireEvent.change(screen.getByLabelText(/^Arguments/), {
    target: { value: "--acp  --quiet" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add agent" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("save_custom_harness", {
      harness: {
        id: "kimi",
        label: "kimi",
        command: "kimi",
        args: ["--acp", "--quiet"],
        install_hint: "",
      },
    }),
  );
});

test("installs a missing harness from its row and refreshes the list", async () => {
  const missing = list.map((item) =>
    item.id === "claude-code" ? { ...item, installable: true } : item,
  );
  const installed = list.map((item) =>
    item.id === "claude-code"
      ? {
          ...item,
          available: true,
          resolved_path: "/Users/me/.npm-global/bin/claude-agent-acp",
        }
      : item,
  );
  invoke.mockImplementation((command: string) =>
    Promise.resolve(command === "install_harness" ? installed : missing),
  );
  const onToast = vi.fn();
  render(<HarnessSettings onToast={onToast} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Install Claude Code" }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("install_harness", {
      id: "claude-code",
    }),
  );
  expect(onToast).toHaveBeenCalledWith("Claude Code installed.");
  expect(await screen.findByLabelText(/Claude Code/)).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: "Install Claude Code" }),
  ).not.toBeInTheDocument();
});

test("shows npm output when an install fails", async () => {
  const missing = list.map((item) =>
    item.id === "claude-code" ? { ...item, installable: true } : item,
  );
  invoke.mockImplementation((command: string) =>
    command === "install_harness"
      ? Promise.reject("npm install failed:\nEACCES: permission denied")
      : Promise.resolve(missing),
  );
  render(<HarnessSettings onToast={vi.fn()} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Install Claude Code" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("EACCES");
});
