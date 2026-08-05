import { describe, expect, it } from "vitest";
import { canResumeResearch, sortResearchRuns, type ResearchRun } from "./deep-research";
const run = (id: string, state: ResearchRun["state"], updated_at: number): ResearchRun => ({ version: 1, id, query: id, state, generation: 1, created_at: 1, updated_at, session_id: `research-${id}`, progress: { phase: "", activity: "", searches: 0, reads: 0, checks: 0, active_calls: [] }, partial_report: "", sources: [], cancellation_requested: false, resume_count: 0 });
describe("deep research view model", () => {
  it("keeps active work first and history newest first", () => expect(sortResearchRuns([run("new", "completed", 3), run("active", "running", 1), run("old", "failed", 2)]).map((r) => r.id)).toEqual(["active", "new", "old"]));
  it("only resumes recoverable terminal states", () => { expect(canResumeResearch(run("x", "interrupted", 1))).toBe(true); expect(canResumeResearch(run("x", "completed", 1))).toBe(false); });
});
