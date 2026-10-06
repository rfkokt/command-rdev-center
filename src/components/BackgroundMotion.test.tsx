// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { createScene, scene } = vi.hoisted(() => {
  const scene = {
    setActivity: vi.fn(),
    setWorking: vi.fn(),
    setTheme: vi.fn(),
    setReducedMotion: vi.fn(),
    setVisible: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
  };
  return { scene, createScene: vi.fn(() => scene) };
});
vi.mock("./office/office-scene", () => ({ createOfficeScene: createScene }));
import BackgroundMotion from "./BackgroundMotion";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("WebGL2RenderingContext", class {});
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function dispatch(name: string, detail: Record<string, unknown>) {
  act(() => {
    window.dispatchEvent(new CustomEvent(name, { detail }));
  });
}
it("only forwards active-tab events and resets the scene when switching tabs", async () => {
  const { rerender } = render(<BackgroundMotion activeTabId="first" />);
  await waitFor(() => expect(createScene).toHaveBeenCalledOnce());
  scene.setActivity.mockClear();
  dispatch("crc-agent-activity", { tabId: "second", type: "thinking" });
  expect(scene.setActivity).not.toHaveBeenCalled();
  dispatch("crc-agent-activity", {
    tabId: "first",
    type: "tool",
    toolName: "bash",
    args: { command: "pnpm test" },
  });
  expect(scene.setActivity).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "bob", working: true }),
  );
  dispatch("crc-agent-prompt", { tabId: "first", text: "Build the interface" });
  expect(scene.setActivity).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "kern", working: true, discussion: true }),
  );
  dispatch("crc-session-loading", { tabId: "first", loading: true });
  expect(scene.setActivity).toHaveBeenLastCalledWith(
    expect.objectContaining({
      id: "kern",
      working: true,
      text: "Restoring chat history…",
    }),
  );
  rerender(<BackgroundMotion activeTabId="second" />);
  expect(scene.setActivity).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "kern", working: false }),
  );
});
it("keeps status updates live with reduced motion and disposes its subscriptions", async () => {
  vi.mocked(window.matchMedia).mockImplementation(
    (query) =>
      ({
        matches: query.includes("reduced-motion"),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList,
  );
  const { unmount } = render(
    <BackgroundMotion activeTabId="first" isWorking />,
  );
  await waitFor(() =>
    expect(scene.setReducedMotion).toHaveBeenCalledWith(true),
  );
  dispatch("crc-agent-activity", { tabId: "first", type: "agent_settled" });
  expect(scene.setActivity).toHaveBeenLastCalledWith(
    expect.objectContaining({ working: false }),
  );
  unmount();
  expect(scene.dispose).toHaveBeenCalledOnce();
  scene.setActivity.mockClear();
  dispatch("crc-agent-prompt", { tabId: "first", text: "hello" });
  expect(scene.setActivity).not.toHaveBeenCalled();
});
it("shows the static fallback when WebGL is unavailable", () => {
  vi.stubGlobal("WebGL2RenderingContext", undefined);
  const { container } = render(<BackgroundMotion />);
  expect(
    container.querySelector(".office-scene")?.getAttribute("data-renderer"),
  ).toBe("fallback");
  expect(createScene).not.toHaveBeenCalled();
});
