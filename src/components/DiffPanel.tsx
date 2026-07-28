import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type DiffFile = { path: string; status: string; added: number; removed: number; patch: string };
type WorktreeDiff = { merge_base: string; files: DiffFile[] };
type Side = { number?: number; text: string; kind: "same" | "removed" | "added" | "empty" };
type Row = { before: Side; after: Side };

function sideBySide(patch: string): Row[] {
  const rows: Row[] = [];
  let oldLine = 0, newLine = 0;
  const removed: Side[] = [], added: Side[] = [];
  const flush = () => {
    const count = Math.max(removed.length, added.length);
    for (let i = 0; i < count; i++) rows.push({
      before: removed[i] ?? { text: "", kind: "empty" },
      after: added[i] ?? { text: "", kind: "empty" },
    });
    removed.length = added.length = 0;
  };
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) { flush(); oldLine = Number(hunk[1]); newLine = Number(hunk[2]); continue; }
    if (/^(diff --git|index |--- |\+\+\+ )/.test(line) || (!oldLine && !newLine)) continue;
    if (line.startsWith("-")) removed.push({ number: oldLine++, text: line.slice(1), kind: "removed" });
    else if (line.startsWith("+")) added.push({ number: newLine++, text: line.slice(1), kind: "added" });
    else {
      flush();
      const text = line.startsWith(" ") ? line.slice(1) : line;
      rows.push({ before: { number: oldLine++, text, kind: "same" }, after: { number: newLine++, text, kind: "same" } });
    }
  }
  flush();
  return rows;
}

export default function DiffPanel({ worktreePath, parentRef, editingFile, open, onClose, onHandoff, onToast }: {
  worktreePath: string;
  parentRef: string;
  editingFile: string | null;
  open: boolean;
  onClose: () => void;
  onHandoff: () => void;
  onToast: (message: string) => void;
}) {
  const [diff, setDiff] = useState<WorktreeDiff | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setDiff(await invoke<WorktreeDiff>("get_worktree_diff", { worktreePath, parentRef })); }
    catch (error) { onToast(String(error)); }
    finally { setLoading(false); }
  }, [worktreePath, parentRef, onToast]);

  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  return <aside className="diff-panel">
    <header>
      <strong>CHANGES</strong>
      <span>{editingFile ? `EDITING ${editingFile}` : diff ? `${diff.files.length} FILES` : "VIEW DIFF"}</span>
      <button onClick={refresh} disabled={loading}>{loading ? "LOADING" : "↻"}</button>
      <button onClick={onClose} aria-label="Close changes" title="Close changes">×</button>
    </header>
    <div className="diff-files">
      {!loading && diff?.files.length === 0 && <p>WORKTREE CLEAN</p>}
      {diff?.files.map((file) => <details key={file.path}>
        <summary><span>{file.status}</span><strong>{file.path}</strong><i>+{file.added}</i><b>-{file.removed}</b></summary>
        {file.patch ? <div className="split-diff">
          <header><span>BEFORE</span><span>AFTER</span></header>
          {sideBySide(file.patch).map((row, index) => <div className="split-row" key={index}>
            {[row.before, row.after].map((side, sideIndex) => <div className={`diff-line ${side.kind}`} key={sideIndex}>
              <span>{side.number ?? ""}</span><code>{side.text || " "}</code>
            </div>)}
          </div>)}
        </div> : <p>Binary or untracked file — no textual diff.</p>}
      </details>)}
    </div>
    <button className="ship-changes" onClick={onHandoff} disabled={!diff?.files.length}>SHIP CHANGES</button>
  </aside>;
}
