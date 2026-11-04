// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: string }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (name: string, handler: (event: { payload: string }) => void) => {
      listeners.set(name, handler);
      return () => listeners.delete(name);
    },
  ),
}));
vi.mock("./terminal-warmup", () => ({ terminalEventId: (key: string) => key }));

import {
  claudeLoginContinuation,
  isClaudeLoginExpired,
  useClaudeAuthRecovery,
} from "./use-claude-auth-recovery";

const expired =
  "Failed to authenticate: OAuth session expired and could not be refreshed";
const onAuthenticated = vi.fn();
const onToast = vi.fn();
const options = { chatId: "demo", cwd: "/tmp/demo", onAuthenticated, onToast };
const commands = () =>
  invoke.mock.calls.filter(([command]) => command === "terminal_write");

beforeEach(() => invoke.mockResolvedValue(""));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  listeners.clear();
});

it("recognizes expired Claude logins without treating usage limits or other agents as expired", () => {
  expect(isClaudeLoginExpired("claude-code", expired)).toBe(true);
  expect(isClaudeLoginExpired("claude-code", "OAuth token has expired.")).toBe(
    true,
  );
  expect(
    isClaudeLoginExpired("claude-code", "Login expired · Please run /login"),
  ).toBe(true);
  expect(isClaudeLoginExpired("pi", expired)).toBe(false);
  expect(
    isClaudeLoginExpired("claude-code", "Claude AI usage limit reached"),
  ).toBe(false);
  expect(
    isClaudeLoginExpired(
      "claude-code",
      "Failed to authenticate: connection refused",
    ),
  ).toBe(false);
});

it("opens a separate login once and reconnects only after a successful exit, including split output", async () => {
  const { result } = renderHook(() => useClaudeAuthRecovery(options));
  act(() => {
    result.current.recover("claude-code", expired);
    result.current.recover("claude-code", expired);
  });
  await waitFor(() => expect(commands()).toHaveLength(1));
  const { chatId, data } = commands()[0][1];
  expect(chatId).toMatch(/^demo__claude_login_.+__0$/);
  expect(data).toContain("claude auth login");
  const output = listeners.get(`terminal://data/${chatId}`)!;
  act(() => output({ payload: data })); // Echoing the command isn't success.
  expect(onAuthenticated).not.toHaveBeenCalled();
  act(() => output({ payload: "\r\n__KERN_CLAUDE_LOGIN_EX" }));
  expect(onAuthenticated).not.toHaveBeenCalled();
  act(() => output({ payload: "IT__:0\r\n" }));
  expect(onAuthenticated).toHaveBeenCalledTimes(1);
  expect(result.current.terminal).toBeNull();
  expect(listeners.size).toBe(0);
  expect(invoke).toHaveBeenCalledWith("terminal_close", { chatId });
  act(() => result.current.recover("claude-code", expired));
  expect(commands()).toHaveLength(1); // A failed retry must not loop sign-in.
  act(() => result.current.markHealthy());
  act(() => result.current.recover("claude-code", expired));
  await waitFor(() => expect(commands()).toHaveLength(2));
});

it("keeps failures visible and permits an explicit retry without reconnecting", async () => {
  const { result } = renderHook(() => useClaudeAuthRecovery(options));
  act(() => result.current.recover("claude-code", expired));
  await waitFor(() => expect(commands()).toHaveLength(1));
  const { chatId } = commands()[0][1];
  act(() =>
    listeners.get(`terminal://data/${chatId}`)!({
      payload: "\r\n__KERN_CLAUDE_LOGIN_EXIT__:1\r\n",
    }),
  );
  expect(onAuthenticated).not.toHaveBeenCalled();
  expect(result.current.visible).toBe(true);
  expect(onToast).toHaveBeenCalledWith(
    expect.stringContaining("did not complete"),
  );
  act(() => result.current.recover("claude-code", expired, true));
  await waitFor(() => expect(commands()).toHaveLength(2));
  expect(commands()[1][1].chatId).not.toBe(chatId);
  expect(invoke).toHaveBeenCalledWith("terminal_close", { chatId });
});

it("deduplicates browser sign-in across chats and reconnects waiting chats after success", async () => {
  const secondAuthenticated = vi.fn();
  const first = renderHook(() => useClaudeAuthRecovery(options));
  const second = renderHook(() =>
    useClaudeAuthRecovery({
      ...options,
      chatId: "second",
      onAuthenticated: secondAuthenticated,
    }),
  );
  act(() => {
    first.result.current.recover("claude-code", expired);
    second.result.current.recover("claude-code", expired);
    second.result.current.recover("claude-code", expired);
    second.result.current.markHealthy();
    second.result.current.recover("claude-code", expired);
  });
  await waitFor(() => expect(commands()).toHaveLength(1));
  expect(
    onToast.mock.calls.filter(([text]) => text.includes("another chat")),
  ).toHaveLength(1);
  const { chatId } = commands()[0][1];
  act(() =>
    listeners.get(`terminal://data/${chatId}`)!({
      payload: "\r\n__KERN_CLAUDE_LOGIN_EXIT__:0\r\n",
    }),
  );
  expect(onAuthenticated).toHaveBeenCalledTimes(1);
  expect(secondAuthenticated).toHaveBeenCalledTimes(1);
  act(() => second.result.current.recover("claude-code", expired));
  expect(commands()).toHaveLength(1);
  expect(secondAuthenticated).toHaveBeenCalledTimes(1);
});

it("does not reconnect waiting chats after a failed login, and lets them retry explicitly", async () => {
  const secondAuthenticated = vi.fn();
  const first = renderHook(() => useClaudeAuthRecovery(options));
  const second = renderHook(() =>
    useClaudeAuthRecovery({
      ...options,
      chatId: "second",
      onAuthenticated: secondAuthenticated,
    }),
  );
  act(() => {
    first.result.current.recover("claude-code", expired);
    second.result.current.recover("claude-code", expired);
  });
  await waitFor(() => expect(commands()).toHaveLength(1));
  const { chatId } = commands()[0][1];
  act(() => listeners.get(`terminal://exit/${chatId}`)!({ payload: "" }));
  expect(onAuthenticated).not.toHaveBeenCalled();
  expect(secondAuthenticated).not.toHaveBeenCalled();
  act(() => second.result.current.recover("claude-code", expired));
  expect(commands()).toHaveLength(1);
  act(() => second.result.current.recover("claude-code", expired, true));
  await waitFor(() => expect(commands()).toHaveLength(2));
  expect(commands()[1][1].chatId).toMatch(/^second__claude_login_/);
});

it("does not reconnect a waiting chat that unmounted", async () => {
  const secondAuthenticated = vi.fn();
  const first = renderHook(() => useClaudeAuthRecovery(options));
  const second = renderHook(() =>
    useClaudeAuthRecovery({
      ...options,
      chatId: "second",
      onAuthenticated: secondAuthenticated,
    }),
  );
  act(() => {
    first.result.current.recover("claude-code", expired);
    second.result.current.recover("claude-code", expired);
  });
  await waitFor(() => expect(commands()).toHaveLength(1));
  second.unmount();
  const { chatId } = commands()[0][1];
  act(() =>
    listeners.get(`terminal://data/${chatId}`)!({
      payload: "\r\n__KERN_CLAUDE_LOGIN_EXIT__:0\r\n",
    }),
  );
  expect(onAuthenticated).toHaveBeenCalledTimes(1);
  expect(secondAuthenticated).not.toHaveBeenCalled();
});

it("builds the continuation from the typed request without attachment envelopes", () => {
  const text = `Fix the bug\n\n<authoritative_attachments>\nThe user explicitly attached the files below.\n--- a.ts (/a.ts) ---\nsecret\n--- end a.ts ---\n</authoritative_attachments>\n\nAttached image files (JSON records):\n{"path":"/tmp/x.png"}\n`;
  const prompt = claudeLoginContinuation(text)!;
  expect(prompt).toContain("Last user request:\nFix the bug");
  expect(prompt).not.toContain("authoritative_attachments");
  expect(prompt).not.toContain("Attached image files");
  expect(prompt).not.toContain("secret");
  expect(claudeLoginContinuation(undefined)).toBeUndefined();
  expect(claudeLoginContinuation("   ")).toBeUndefined();
});

it("releases the login lock when opening fails", async () => {
  invoke.mockImplementation((command) =>
    command === "terminal_open"
      ? Promise.reject("PTY unavailable")
      : Promise.resolve(""),
  );
  const { result } = renderHook(() => useClaudeAuthRecovery(options));
  act(() => result.current.recover("claude-code", expired));
  await waitFor(() =>
    expect(onToast).toHaveBeenCalledWith(
      expect.stringContaining("PTY unavailable"),
    ),
  );
  expect(onAuthenticated).not.toHaveBeenCalled();
  expect(commands()).toHaveLength(0);
  expect(listeners.size).toBe(0);
  invoke.mockResolvedValue("");
  act(() => result.current.recover("claude-code", expired, true));
  await waitFor(() => expect(commands()).toHaveLength(1));
});

it("does not launch login if the chat unmounts while the terminal is opening", async () => {
  let opened!: () => void;
  invoke.mockImplementation((command) =>
    command === "terminal_open"
      ? new Promise<void>((resolve) => {
          opened = resolve;
        })
      : Promise.resolve(""),
  );
  const { result, unmount } = renderHook(() => useClaudeAuthRecovery(options));
  act(() => result.current.recover("claude-code", expired));
  await waitFor(() => expect(opened).toBeDefined());
  unmount();
  await act(async () => opened());
  expect(commands()).toHaveLength(0);
  expect(listeners.size).toBe(0);
  expect(onAuthenticated).not.toHaveBeenCalled();
});

it("ends a timed-out login without retrying the task", async () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useClaudeAuthRecovery(options));
  await act(async () => result.current.recover("claude-code", expired));
  await act(async () => vi.advanceTimersByTime(10 * 60_000));
  expect(onAuthenticated).not.toHaveBeenCalled();
  expect(onToast).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  expect(listeners.size).toBe(0);
});
