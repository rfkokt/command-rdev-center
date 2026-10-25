// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
import WorktreeSetup, { setupFingerprint, shellQuote } from "./WorktreeSetup";

const setup = { copy: [".env"], commands: ["pnpm install"] };
beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => {
    if (command === "inspect_worktree_setup") return setup;
    if (command === "prepare_worktree_setup")
      return { copied: "Copied .env\n", script: "/tmp/kern setup.sh" };
    throw new Error(command);
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("asks before the first run, then runs the script in the chat terminal", async () => {
  const runInTerminal = vi.fn(async (_command: string) => {});
  render(
    <WorktreeSetup
      project="/p"
      worktree="/w"
      onToast={vi.fn()}
      runInTerminal={runInTerminal}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Run setup" }));
  await waitFor(() => expect(runInTerminal).toHaveBeenCalledOnce());
  expect(runInTerminal.mock.calls[0][0]).toContain("sh '/tmp/kern setup.sh'");
  expect(invoke).toHaveBeenCalledWith("prepare_worktree_setup", {
    project: "/p",
    worktree: "/w",
    approvedSetup: setupFingerprint(setup),
  });
  expect(localStorage.getItem("kern:setup-trust:/p")).toBe(
    setupFingerprint(setup),
  );
});

test("runs an already approved config automatically for a new worktree, once", async () => {
  localStorage.setItem("kern:setup-trust:/p", setupFingerprint(setup));
  const runInTerminal = vi.fn(async (_command: string) => {});
  const view = render(
    <WorktreeSetup
      project="/p"
      worktree="/w2"
      onToast={vi.fn()}
      runInTerminal={runInTerminal}
    />,
  );
  await waitFor(() => expect(runInTerminal).toHaveBeenCalledOnce());
  expect(screen.queryByRole("button", { name: "Run setup" })).toBeNull();
  view.unmount();
  render(
    <WorktreeSetup
      project="/p"
      worktree="/w2"
      onToast={vi.fn()}
      runInTerminal={runInTerminal}
    />,
  );
  await screen.findByText("Worktree setup (kern.yaml)");
  expect(runInTerminal).toHaveBeenCalledOnce();
});

test("a changed kern.yaml needs approval again; skip leaves the chat alone", async () => {
  localStorage.setItem(
    "kern:setup-trust:/p",
    setupFingerprint({ copy: [], commands: ["echo old"] }),
  );
  const runInTerminal = vi.fn(async (_command: string) => {});
  render(
    <WorktreeSetup
      project="/p"
      worktree="/w3"
      onToast={vi.fn()}
      runInTerminal={runInTerminal}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
  expect(runInTerminal).not.toHaveBeenCalled();
  expect(localStorage.getItem("kern:setup-done:/w3")).toBe(
    setupFingerprint(setup),
  );
});

test("shell quoting survives single quotes", () => {
  expect(shellQuote("/tmp/it's")).toBe("'/tmp/it'\\''s'");
});
