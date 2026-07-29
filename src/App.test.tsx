// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const unmounted = vi.fn();
const unreadCallbacks: Array<(chatId: string) => void> = [];

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(() => Promise.resolve("1.2.3")) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  registerActionTypes: vi.fn(() => Promise.resolve()),
  onAction: vi.fn(() => Promise.resolve({ unregister: vi.fn(() => Promise.resolve()) })),
}));
vi.mock("./components/ProjectList", () => ({
  default: ({ tabs, onResume }: { tabs: Array<{ id: string; project: unknown }>; onResume: (id: string, project: unknown) => void }) => (
    <>{tabs.map((tab) => <button key={tab.id} onClick={() => onResume(tab.id, tab.project)}>Open {tab.id}</button>)}</>
  ),
}));
vi.mock("./components/SettingsPanel", () => ({ default: () => null }));
vi.mock("./components/PipelineView", () => ({ default: () => <div>Pipeline view</div> }));
vi.mock("./components/KanbanBoard", () => ({ default: () => <div>Kanban view</div> }));
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

test("keeps the active chat mounted while Kanban is open", () => {
  render(<App />);

  fireEvent.click(screen.getByRole("button", { name: "Kanban" }));

  expect(screen.getByText("Kanban view")).toBeInTheDocument();
  expect(screen.getByText("Chat view")).not.toBeVisible();
  expect(unmounted).not.toHaveBeenCalled();
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
