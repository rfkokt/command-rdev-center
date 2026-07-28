// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

const unmounted = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock("./components/ProjectList", () => ({ default: () => null }));
vi.mock("./components/SettingsPanel", () => ({ default: () => null }));
vi.mock("./components/PipelineView", () => ({ default: () => <div>Pipeline view</div> }));
vi.mock("./components/KanbanBoard", () => ({ default: () => <div>Kanban view</div> }));
vi.mock("./components/ChatView", async () => {
  const { useEffect } = await import("react");
  return {
    default: () => {
      useEffect(() => () => unmounted(), []);
      return <div>Chat view</div>;
    },
  };
});

import App from "./App";

beforeEach(() => {
  unmounted.mockClear();
  localStorage.setItem("crc-chat-tabs", JSON.stringify([{
    id: "chat-1",
    project: { name: "demo", path: "/tmp/demo", kinds: [], mtime_ms: 0, is_git: false },
  }]));
});

test("keeps the active chat mounted while Kanban is open", () => {
  render(<App />);

  fireEvent.click(screen.getByRole("button", { name: "Kanban" }));

  expect(screen.getByText("Kanban view")).toBeInTheDocument();
  expect(screen.getByText("Chat view")).not.toBeVisible();
  expect(unmounted).not.toHaveBeenCalled();
});
