export type ResearchState = "creating" | "running" | "cancelling" | "interrupted" | "completed" | "cancelled" | "failed";
export type ResearchSource = { url: string; canonical_url: string; title: string; cited: boolean };
export type ResearchProgress = { phase: string; activity: string; searches: number; reads: number; checks: number; active_calls: string[] };
export type ResearchRun = { version: number; id: string; query: string; state: ResearchState; generation: number; created_at: number; updated_at: number; session_id: string; session_file?: string | null; recovery_mode?: string | null; progress: ResearchProgress; partial_report: string; final_report?: string | null; sources: ResearchSource[]; cancellation_requested: boolean; resume_count: number; error?: string | null; origin_chat_id?: string | null; origin_session_id?: string | null; handoff_delivered?: boolean; handoff_state?: "pending" | "delivering" | "delivered" };
export type ResearchData = { runs: ResearchRun[]; warnings: string[] };
export const isActiveResearch = (run: ResearchRun) => ["creating", "running", "cancelling"].includes(run.state);
export const canResumeResearch = (run: ResearchRun) => ["interrupted", "cancelled", "failed"].includes(run.state);
export function sortResearchRuns(runs: ResearchRun[]) { return [...runs].sort((a, b) => Number(isActiveResearch(b)) - Number(isActiveResearch(a)) || b.updated_at - a.updated_at || b.id.localeCompare(a.id)); }
export function elapsedResearch(started: number, now = Date.now()) { const seconds = Math.max(0, Math.floor(now / 1000) - started); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }
