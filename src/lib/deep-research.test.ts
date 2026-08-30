import { describe, expect, it } from "vitest";
import {
  canResumeResearch,
  extractToc,
  slugifyHeading,
  sortResearchRuns,
  type ResearchRun,
} from "./deep-research";
const run = (
  id: string,
  state: ResearchRun["state"],
  updated_at: number,
): ResearchRun => ({
  version: 1,
  id,
  query: id,
  state,
  generation: 1,
  created_at: 1,
  updated_at,
  session_id: `research-${id}`,
  progress: {
    phase: "",
    activity: "",
    searches: 0,
    reads: 0,
    checks: 0,
    active_calls: [],
  },
  partial_report: "",
  sources: [],
  cancellation_requested: false,
  resume_count: 0,
});
describe("deep research view model", () => {
  it("keeps active work first and history newest first", () =>
    expect(
      sortResearchRuns([
        run("new", "completed", 3),
        run("active", "running", 1),
        run("old", "failed", 2),
      ]).map((r) => r.id),
    ).toEqual(["active", "new", "old"]));
  it("only resumes recoverable terminal states", () => {
    expect(canResumeResearch(run("x", "interrupted", 1))).toBe(true);
    expect(canResumeResearch(run("x", "completed", 1))).toBe(false);
  });
  it("slugifies headings and deduplicates via extractToc", () => {
    expect(slugifyHeading("Hello World!")).toBe("hello-world");
    const toc = extractToc("## Intro\n### Details\n## Intro\n## Closing");
    expect(
      toc.map((e) => ({ text: e.text, id: e.id, level: e.level })),
    ).toEqual([
      { text: "Intro", id: "intro", level: 2 },
      { text: "Details", id: "details", level: 3 },
      { text: "Intro", id: "intro-1", level: 2 },
      { text: "Closing", id: "closing", level: 2 },
    ]);
  });
  it("ignores h1 and empty headings in TOC", () => {
    const toc = extractToc("# Title\n\n## \n## Valid");
    expect(toc.length).toBe(1);
    expect(toc[0].text).toBe("Valid");
  });
});
