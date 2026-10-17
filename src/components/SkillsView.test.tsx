// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SkillsView from "./SkillsView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const catalog = {
  sources: [
    {
      id: "pi-global",
      label: "~/.pi/agent/skills",
      path: "/home/me/.pi/agent/skills",
      readable: true,
    },
  ],
  skills: [
    {
      name: "valid",
      description: "A usable skill",
      location: "/home/me/.pi/agent/skills/valid/SKILL.md",
      source_id: "pi-global",
      valid: true,
      manual_only: false,
      license: "MIT",
      frontmatter: "name: valid",
      content: "# Valid",
      supporting_files: [],
    },
    {
      name: "Invalid skill",
      description: "",
      location: "/home/me/.pi/agent/skills/bad/SKILL.md",
      source_id: "pi-global",
      valid: false,
      invalid_reason: "missing name",
      manual_only: true,
      frontmatter: "",
      content: "bad",
      supporting_files: [],
    },
  ],
};

describe("SkillsView", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue(catalog);
  });
  it("shows counts, filters, and skill details", async () => {
    render(<SkillsView />);
    expect(await screen.findByText(/1 valid · 1 invalid/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "invalid" },
    });
    expect(screen.getByText("missing name")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByRole("dialog").textContent).toContain(
      "/skill:Invalid skill",
    );
  });

  it("starts a selected valid skill in chat", async () => {
    const onUse = vi.fn();
    window.addEventListener("crc-use-skill", onUse);
    render(<SkillsView />);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "View" }))[0],
    );
    fireEvent.click(screen.getByRole("button", { name: /Use in Chat/ }));
    expect(onUse).toHaveBeenCalledWith(
      expect.objectContaining({ detail: "valid" }),
    );
    window.removeEventListener("crc-use-skill", onUse);
  });

  it("wraps preview and installation form values in the backend request argument", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "preview_git_skills") {
        return {
          repository: "https://github.com/rfkokt/motion-web-design.git",
          reference: "main",
          skills: [catalog.skills[0]],
        };
      }
      if (command === "install_git_skills") {
        return {
          installed: ["valid"],
          target: "/home/me/.pi/agent/skills",
          log: [],
        };
      }
      return catalog;
    });
    render(<SkillsView />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Install Skill" }),
    );
    fireEvent.change(
      screen.getByLabelText("Repository URL or owner/repository"),
      {
        target: { value: "rfkokt/motion-web-design" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview & validate" }));
    await screen.findByText("Review the selected SKILL.md before installing.");
    expect(invoke).toHaveBeenCalledWith("preview_git_skills", {
      request: {
        url: "rfkokt/motion-web-design",
        reference: null,
        path: null,
        selectedPaths: [],
        replace: false,
        sourceType: "git",
      },
    });

    fireEvent.click(
      screen.getByLabelText(/Replace an existing same-name skill/),
    );
    fireEvent.click(screen.getByRole("button", { name: "Install selected" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("install_git_skills", {
        request: {
          url: "rfkokt/motion-web-design",
          reference: null,
          path: null,
          selectedPaths: ["valid"],
          replace: true,
          sourceType: "git",
        },
      }),
    );
    await waitFor(() =>
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(([command]) => command === "list_pi_skills")
          .length,
      ).toBe(2),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
