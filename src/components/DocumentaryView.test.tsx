// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
import DocumentaryView from "./DocumentaryView";
afterEach(() => { cleanup(); invoke.mockReset(); });
describe("DocumentaryView", () => {
  it("rejects an empty brief", async () => { invoke.mockResolvedValueOnce({ packages: [], warnings: [] }); render(<DocumentaryView />); await screen.findByText("No production packages yet"); fireEvent.click(screen.getByRole("button", { name: "Create package" })); expect(screen.getByRole("alert")).toHaveTextContent("Enter a topic."); expect(invoke).not.toHaveBeenCalledWith("create_documentary_package", expect.anything()); });
  it("renders source approval and warns for uncertain claims", async () => { invoke.mockResolvedValueOnce({ warnings: [], packages: [{ version: 1, id: "one", topic: "Story", language: "English", audience: "All", durationSeconds: 30, state: "editing", sources: [{ id: "s", url: "https://example.com", canonicalUrl: "https://example.com", title: "Evidence", cited: true, approved: true }], script: { title: "", hook: "", narration: "", claims: [{ id: "c", text: "Interpretation", sourceIds: [], status: "uncertain" }] }, scenes: [] }] }); render(<DocumentaryView />); expect(await screen.findByRole("link", { name: "Evidence" })).toHaveAttribute("target", "_blank"); expect(screen.getByText("Needs human verification.")).toBeInTheDocument(); });
});
