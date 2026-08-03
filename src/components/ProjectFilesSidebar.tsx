import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type ProjectFile = { name: string; path: string; chars: number; modified_ms: number };

export default function ProjectFilesSidebar({
  projectPath,
  projectName,
  refreshKey,
  onOpenAt,
}: {
  projectPath: string;
  projectName: string;
  refreshKey?: number;
  onOpenAt?: (fileName: string, content: string) => void;
}) {
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [recentPaths, setRecentPaths] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("crc-recent-files") ?? "[]"); } catch { return []; }
  });

  const pushRecent = useCallback((path: string) => {
    setRecentPaths((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, 8);
      localStorage.setItem("crc-recent-files", JSON.stringify(next));
      return next;
    });
  }, []);

  const reload = useCallback(() => {
    if (!projectPath || projectPath === "global") return;
    setLoading(true);
    setError("");
    invoke<ProjectFile[]>("list_project_files", { projectPath })
      .then(setFiles)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [projectPath]);

  useEffect(() => { void reload(); }, [reload, refreshKey]);
  // refresh on mount + when project changes

  const openFile = useCallback(async (file: ProjectFile) => {
    setPreviewLoading(true);
    try {
      const content = await invoke<string>("get_project_file_content", { projectPath, fileName: file.name });
      const limited = content.slice(0, 100_000);
      setPreview({ name: file.name, content: limited });
      pushRecent(file.name);
      onOpenAt?.(file.name, limited);
    } catch (e) {
      setError(String(e));
    } finally {
      setPreviewLoading(false);
    }
  }, [projectPath, pushRecent, onOpenAt]);

  if (!projectPath || projectPath === "global") return null;

  const q = filter.trim().toLowerCase();
  const filtered = q ? files.filter((f) => f.name.toLowerCase().includes(q)) : files;

  return (
    <section className="project-files-sidebar" aria-label={`Files in ${projectName}`}>
      <header>
        <button className="pfs-toggle" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed} title={collapsed ? "Expand files" : "Collapse files"}>
          <span className="chevron" style={{ display: "inline-block" }}>{collapsed ? "›" : "⌄"}</span>
          <small>EXPLORER</small>
          <strong>{projectName.toUpperCase()}</strong>
        </button>
        <span className="pfs-count">{loading ? "…" : `${filtered.length}`}</span>
      </header>
      {!collapsed && (
        <>
          <div className="pfs-toolbar">
            <input
              placeholder="FILTER FILES…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="pfs-filter"
            />
            <button onClick={reload} disabled={loading} className="pfs-refresh" title="Refresh files" aria-label="Refresh files">↻</button>
          </div>
          {recentPaths.length > 0 && (
            <div className="pfs-recent">
              <small>RECENT</small>
              {recentPaths.map((p) => (
                <button key={p} className="pfs-recent-item" onClick={() => { const f = files.find((x) => x.name === p); if (f) void openFile(f); }} title={p}>{p}</button>
              ))}
            </div>
          )}
          {error && <div className="pfs-error" role="alert">{error}</div>}
          {loading ? <div className="pfs-loading">LOADING FILES…</div> : filtered.length === 0 ? (
            <div className="pfs-empty"><span>{q ? "NO MATCH" : "NO PREVIEWABLE FILES"}</span><small>TXT · MD · CSV · JSON · top-level only · dotfiles hidden · 1MB max</small></div>
          ) : (
            <ul className="pfs-list" role="list">
              {filtered.map((f) => (
                <li key={f.path} role="listitem">
                  <button
                    className={`pfs-file${preview?.name === f.name ? " active" : ""}`}
                    onClick={() => void openFile(f)}
                    title={`${f.name} · ${f.chars} chars · ${new Date(f.modified_ms).toLocaleString()}`}
                  >
                    <span className="pfs-file-icon" aria-hidden>{iconFor(f.name)}</span>
                    <span className="pfs-file-name">{f.name}</span>
                    <small className="pfs-file-meta">{shortChars(f.chars)}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {(previewLoading || preview) && (
        <div className="pfs-preview">
          <header>
            <div><small>READONLY</small><strong>{preview?.name ?? "Loading…"}</strong></div>
            <div className="pfs-preview-actions">
              <button onClick={() => navigator.clipboard.writeText(preview?.content ?? "")} title="Copy content">⧉</button>
              <button onClick={() => setPreview(null)} title="Close preview">✕</button>
            </div>
          </header>
          {previewLoading ? <div className="pfs-loading">LOADING…</div> : preview && <pre className="rag-readonly-pre pfs-pre">{preview.content}</pre>}
          <footer><span>Readonly · {preview ? `${preview.content.length.toLocaleString()} chars shown` : ""} · Edit via chat</span></footer>
        </div>
      )}
    </section>
  );
}

function shortChars(n: number) {
  if (n < 1000) return `${n}`;
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function iconFor(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "md": return "◫";
    case "json": return "{}";
    case "csv": return "▤";
    case "txt": return "≡";
    default: return "—";
  }
}
