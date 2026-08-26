// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SkillsView from "./SkillsView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const catalog = { sources: [{ id: "pi-global", label: "~/.pi/agent/skills", path: "/home/me/.pi/agent/skills", readable: true }], skills: [
  { name: "valid", description: "A usable skill", location: "/home/me/.pi/agent/skills/valid/SKILL.md", source_id: "pi-global", valid: true, manual_only: false, license: "MIT", frontmatter: "name: valid", content: "# Valid", supporting_files: [] },
  { name: "Invalid skill", description: "", location: "/home/me/.pi/agent/skills/bad/SKILL.md", source_id: "pi-global", valid: false, invalid_reason: "missing name", manual_only: true, frontmatter: "", content: "bad", supporting_files: [] },
] };

describe("SkillsView", () => {
  beforeEach(() => { vi.mocked(invoke).mockResolvedValue(catalog); });
  it("shows counts, filters, and skill details", async () => {
    render(<SkillsView />);
    expect(await screen.findByText(/1 valid · 1 invalid/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "invalid" } });
    expect(screen.getByText("missing name")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByRole("dialog").textContent).toContain("/skill:Invalid skill");
  });
});
