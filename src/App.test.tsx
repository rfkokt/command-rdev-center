// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const unmounted = vi.fn();
const { checkUpdate } = vi.hoisted(() => ({ checkUpdate: vi.fn() }));
const unreadCallbacks: Array<(chatId: string) => void> = [];

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(() => Promise.resolve("1.2.3")) }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: checkUpdate }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock("./components/ProjectList", () => ({
  default: ({ tabs, onResume, onSelect, onNewSession }: { tabs: Array<{ id: string; project: { name: string } }>; onResume: (id: string, project: unknown) => void; onSelect: (project: unknown) => void; onNewSession: (project: unknown) => void }) => (
    <>{tabs.map((tab) => <span key={tab.id}><button onClick={() => onResume(tab.id, tab.project)}>Open {tab.id}</button><button onClick={() => onSelect(tab.project)}>Select {tab.project.name}</button><button onClick={() => onNewSession(tab.project)}>New {tab.project.name}</button></span>)}</>
  ),
}));
vi.mock("./components/SettingsPanel", () => ({ default: () => null }));
vi.mock("./components/PipelineView", () => ({ default: () => <div>Pipeline view</div> }));
vi.mock("./components/KanbanBoard", () => ({ default: () => <div>Kanban view</div> }));
vi.mock("./components/RagKnowledge", () => ({ default: () => <div>Knowledge view</div> }));
vi.mock("./components/ChatView", async () => {
  const { useEffect } = await import("react");
  return {
    default: ({ onUnread }: { onUnread: (chatId: string) => void }) => {
      unreadCallbacks.push(onUnread);
      useEffect(() => () => unmounted(), []);
      return <div>Chat view</div>;
    },
  };
});

import App from "./App";

beforeEach(() => {
  unmounted.mockClear();
  checkUpdate.mockReset();
  checkUpdate.mockResolvedValue(null);
  unreadCallbacks.length = 0;
  localStorage.setItem("crc-chat-tabs", JSON.stringify([{
    id: "chat-1",
    project: { name: "demo", path: "/tmp/demo", kinds: [], mtime_ms: 0, is_git: false },
  }]));
});

afterEach(cleanup);

test("shows the runtime app version at the bottom of the sidebar", async () => {
  render(<App />);

  expect(await screen.findByText("v1.2.3")).toBeInTheDocument();
});

test("notifies when an update is available", async () => {
  checkUpdate.mockResolvedValue({ version: "1.3.0", downloadAndInstall: vi.fn() });

  render(<App />);

  expect(await screen.findByRole("status")).toHaveTextContent("Update 1.3.0 is available");
  expect(screen.getByRole("button", { name: /UPDATE v1.3.0/ })).toBeInTheDocument();
});

test("opens the dedicated knowledge workspace", async () => {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: /Knowledge/ }));
  expect(await screen.findByText("Knowledge view")).toBeInTheDocument();
});

test("exposes the Deep Research report library", () => {
  render(<App />);
  expect(screen.getByTitle("Deep Research")).toBeInTheDocument();
});

test("shows project operations in the workspace toolbar, not the sidebar", () => {
  render(<App />);

  const toolbar = screen.getByRole("navigation", { name: "demo views" });
  expect(toolbar).toHaveTextContent("Tasks");
  expect(toolbar).toHaveTextContent("Pipeline");
  expect(screen.getByRole("complementary", { name: "Projects and sessions" })).not.toHaveTextContent("Project operations");
});

test("keeps the active chat mounted while Kanban is open", async () => {
  render(<App />);

  fireEvent.click(screen.getByRole("button", { name: "Tasks" }));

  expect(await screen.findByText("Kanban view")).toBeInTheDocument();
  expect(screen.getByText("Chat view")).not.toBeVisible();
  expect(unmounted).not.toHaveBeenCalled();
});

test("creates and lists multiple Global Chat sessions", () => {
  localStorage.setItem("crc-chat-tabs", "[]");
  render(<App />);

  fireEvent.click(screen.getByRole("button", { name: /OPEN GLOBAL CHAT/ }));
  fireEvent.click(screen.getByRole("button", { name: "New Global Chat" }));

  expect(screen.getAllByText("UNTITLED SESSION")).toHaveLength(2);
});

test("creates a project session after switching from Global Chat to a project", () => {
  localStorage.setItem("crc-chat-tabs", JSON.stringify([
    { id: "global-1", global: true, project: { name: "GLOBAL CHAT", path: "global", kinds: [], mtime_ms: 0, is_git: false } },
    { id: "chat-1", project: { name: "demo", path: "/tmp/demo", kinds: [], mtime_ms: 0, is_git: false } },
  ]));
  render(<App />);

  fireEvent.click(screen.getByRole("button", { name: "Select demo" }));
  fireEvent.click(screen.getByRole("button", { name: "New demo" }));

  const saved = JSON.parse(localStorage.getItem("crc-chat-tabs") ?? "[]") as Array<{ global?: boolean; project: { path: string } }>;
  expect(saved.filter((tab) => tab.project.path === "/tmp/demo")).toHaveLength(2);
  expect(saved.filter((tab) => tab.global)).toHaveLength(1);
});

test("keeps chat callbacks stable when the active tab changes", () => {
  localStorage.setItem("crc-chat-tabs", JSON.stringify([
    { id: "chat-1", project: { name: "one", path: "/tmp/one", kinds: [], mtime_ms: 0, is_git: false } },
    { id: "chat-2", project: { name: "two", path: "/tmp/two", kinds: [], mtime_ms: 0, is_git: false } },
  ]));
  render(<App />);
  const initialUnread = unreadCallbacks[0];

  fireEvent.click(screen.getByRole("button", { name: "Open chat-1" }));

  expect(unreadCallbacks[unreadCallbacks.length - 1]).toBe(initialUnread);
});
