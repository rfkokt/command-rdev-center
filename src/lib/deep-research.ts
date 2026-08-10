export type ResearchState = "creating" | "running" | "cancelling" | "interrupted" | "completed" | "cancelled" | "failed";
export type ResearchSource = { url: string; canonical_url: string; title: string; cited: boolean };
export type ResearchProgress = { phase: string; activity: string; searches: number; reads: number; checks: number; active_calls: string[] };
export type ResearchRun = { version: number; id: string; query: string; state: ResearchState; generation: number; created_at: number; updated_at: number; session_id: string; session_file?: string | null; recovery_mode?: string | null; progress: ResearchProgress; partial_report: string; final_report?: string | null; sources: ResearchSource[]; cancellation_requested: boolean; resume_count: number; error?: string | null; origin_chat_id?: string | null; origin_session_id?: string | null; documentary_package_id?: string | null; handoff_delivered?: boolean; handoff_state?: "pending" | "delivering" | "delivered" };
export type ResearchData = { runs: ResearchRun[]; warnings: string[] };
export const isActiveResearch = (run: ResearchRun) => ["creating", "running", "cancelling"].includes(run.state);
export const canResumeResearch = (run: ResearchRun) => ["interrupted", "cancelled", "failed"].includes(run.state);
export function sortResearchRuns(runs: ResearchRun[]) { return [...runs].sort((a, b) => Number(isActiveResearch(b)) - Number(isActiveResearch(a)) || b.updated_at - a.updated_at || b.id.localeCompare(a.id)); }
export function elapsedResearch(started: number, now = Date.now()) { const seconds = Math.max(0, Math.floor(now / 1000) - started); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }

export type TocEntry = { id: string; text: string; level: 2 | 3 };

export function slugifyHeading(text: string) {
  return text.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "section";
}

export function extractToc(markdown: string): TocEntry[] {
  const lines = markdown.split("\n");
  const out: TocEntry[] = [];
  const seen: Record<string, number> = {};
  for (const line of lines) {
    const m = line.match(/^\s{0,3}(#{2,3})\s+(.+?)\s*(?:#+\s*)?$/);
    if (!m) continue;
    const level = m[1].length as 2 | 3;
    const raw = m[2].trim().replace(/\s+#+\s*$/, "").trim();
    if (!raw) continue;
    const base = slugifyHeading(raw);
    const count = seen[base] ?? 0;
    seen[base] = count + 1;
    const id = count === 0 ? base : `${base}-${count}`;
    out.push({ id, text: raw, level });
  }
  return out;
}
