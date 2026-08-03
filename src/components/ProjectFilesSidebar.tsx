import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import MarkdownMessage from "./MarkdownMessage";

type ProjectFile = { name: string; path: string; relative: string; chars: number; modified_ms: number };

type Folder = {
  name: string;
  rel: string; // relative folder path
  folders: Map<string, Folder>;
  files: ProjectFile[];
};

function buildTree(files: ProjectFile[]): Folder {
  const root: Folder = { name: "", rel: "", folders: new Map(), files: [] };
  for (const f of files) {
    const parts = f.relative.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let cur = root;
    let curRel = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      curRel = curRel ? `${curRel}/${part}` : part;
      let next = cur.folders.get(part);
      if (!next) {
        next = { name: part, rel: curRel, folders: new Map(), files: [] };
        cur.folders.set(part, next);
      }
      cur = next;
    }
    cur.files.push(f);
  }
  return root;
}

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
  const [previewPos, setPreviewPos] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; initX: number; initY: number; headerTop: number } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [recentPaths, setRecentPaths] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("crc-recent-files") ?? "[]");
    } catch {
      return [];
    }
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
      .then((list) => {
        setFiles(list);
        // auto-expand first level folders
        setExpanded((prev) => {
          const next = new Set(prev);
          next.add("");
          for (const f of list) {
            const dir = f.relative.includes("/") ? f.relative.split("/").slice(0, -1).join("/") : "";
            if (dir && dir.split("/").length === 1) next.add(dir);
          }
          return next;
        });
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [projectPath]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const openFile = useCallback(
    async (file: ProjectFile) => {
      setPreviewLoading(true);
      try {
        const content = await invoke<string>("get_project_file_content", {
          projectPath,
          fileName: file.relative,
        });
        const limited = content.slice(0, 100_000);
        setPreview({ name: file.relative, content: limited });
        pushRecent(file.relative);
        onOpenAt?.(file.relative, limited);
      } catch (e) {
        setError(String(e));
      } finally {
        setPreviewLoading(false);
      }
    },
    [projectPath, pushRecent, onOpenAt],
  );

  const toggleFolder = useCallback((rel: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }, []);

  if (!projectPath || projectPath === "global") return null;

  const q = filter.trim().toLowerCase();
  const filteredFiles = q ? files.filter((f) => f.relative.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)) : null;

  const tree = useMemo(() => (filteredFiles ? null : buildTree(files)), [files, filteredFiles]);

  return (
    <section className="project-files-sidebar" aria-label={`Files in ${projectName}`}>
      <div className="pfs-toolbar">
        <input
          placeholder="FILTER FILES…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="pfs-filter"
        />
        <span className="pfs-count">{loading ? "…" : q ? `${filteredFiles?.length ?? 0}` : `${files.length}`}</span>
        <button onClick={reload} disabled={loading} className="pfs-refresh" title="Refresh files" aria-label="Refresh files">
          ↻
        </button>
      </div>

      {recentPaths.length > 0 && !q && (
        <div className="pfs-recent">
          <small>RECENT</small>
          {recentPaths.map((p) => (
            <button
              key={p}
              className="pfs-recent-item"
              onClick={() => {
                const f = files.find((x) => x.relative === p);
                if (f) void openFile(f);
              }}
              title={p}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="pfs-error" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div className="pfs-loading">LOADING FILES…</div>
      ) : filteredFiles ? (
        filteredFiles.length === 0 ? (
          <div className="pfs-empty">
            <span>NO MATCH</span>
          </div>
        ) : (
          <ul className="pfs-list pfs-flat" role="list">
            {filteredFiles.map((f) => (
              <li key={f.path} role="listitem">
                <button
                  className={`pfs-file${preview?.name === f.relative ? " active" : ""}`}
                  onClick={() => void openFile(f)}
                  title={`${f.relative} · ${f.chars} chars`}
                >
                  <span className="pfs-file-icon" aria-hidden>
                    {iconFor(f.name)}
                  </span>
                  <span className="pfs-file-name" style={{ whiteSpace: "normal", wordBreak: "break-all" }}>
                    {f.relative}
                  </span>
                  <small className="pfs-file-meta">{shortChars(f.chars)}</small>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : !tree || (tree.files.length === 0 && tree.folders.size === 0) ? (
        <div className="pfs-empty">
          <span>NO FILES</span>
          <small>1MB max · ignored: node_modules, target, dist, etc</small>
        </div>
      ) : (
        <div className="pfs-tree" role="tree">
          <TreeFolder folder={tree} depth={0} expanded={expanded} toggleFolder={toggleFolder} openFile={openFile} previewName={preview?.name ?? null} />
        </div>
      )}

      {(previewLoading || preview) && (
        <div style={{ position: "fixed", top: 62, left: 0, bottom: 0, right: 432, zIndex: 80, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none", padding: 20 }}>
          <div className="diff-panel" style={{ width: 900, maxWidth: "calc(100vw - 480px)", height: 700, maxHeight: "85vh", pointerEvents: "auto", boxShadow: "0 24px 60px #000c", border: "1px solid var(--accent)", transform: `translate(${previewPos.x}px, ${previewPos.y}px)`, transition: dragRef.current ? "none" : "transform 0.1s ease-out", resize: "both", overflow: "hidden" }}>
            <div 
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderBottom: "1px solid var(--colors-hairline)", background: "#1a1b18", cursor: "grab", userSelect: "none" }}
              onPointerDown={(e) => {
                e.preventDefault(); // Prevent text selection
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                dragRef.current = { 
                  startX: e.clientX, 
                  startY: e.clientY, 
                  initX: previewPos.x, 
                  initY: previewPos.y,
                  headerTop: rect.top - previewPos.y
                };
                e.currentTarget.setPointerCapture(e.pointerId);
                e.currentTarget.style.cursor = "grabbing";
              }}
              onPointerMove={(e) => {
                if (!dragRef.current) return;
                const { startX, startY, initX, initY, headerTop } = dragRef.current;
                let newY = initY + e.clientY - startY;
                if (headerTop + newY < 62) {
                  newY = 62 - headerTop;
                }
                setPreviewPos({ x: initX + e.clientX - startX, y: newY });
              }}
              onPointerUp={(e) => {
                dragRef.current = null;
                e.currentTarget.releasePointerCapture(e.pointerId);
                e.currentTarget.style.cursor = "grab";
              }}
              onPointerCancel={(e) => {
                dragRef.current = null;
                e.currentTarget.releasePointerCapture(e.pointerId);
                e.currentTarget.style.cursor = "grab";
              }}
            >
              <div style={{ display: "grid", gap: 4 }}>
                <small style={{ color: "var(--accent)", fontSize: 10, letterSpacing: "0.1em" }}>FILE PREVIEW (READONLY)</small>
                <strong style={{ fontSize: 14 }}>{preview?.name ?? "Loading…"}</strong>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => navigator.clipboard.writeText(preview?.content ?? "")} title="Copy content" style={{ padding: "6px 12px", border: "1px solid var(--colors-hairline-strong)", fontSize: 10, letterSpacing: "0.1em", borderRadius: 4, cursor: "pointer", background: "transparent", color: "var(--colors-body)" }} onPointerDown={(e) => e.stopPropagation()}>
                  ⧉ COPY
                </button>
                <button onClick={() => { setPreview(null); setPreviewPos({ x: 0, y: 0 }); }} title="Close preview" style={{ padding: "6px 12px", border: "1px solid #ff7069", color: "#ff9b96", fontSize: 10, letterSpacing: "0.1em", borderRadius: 4, cursor: "pointer", background: "transparent" }} onPointerDown={(e) => e.stopPropagation()}>
                  ✕ CLOSE
                </button>
              </div>
            </div>
            <style>{`.clickable-import:hover { color: var(--accent) !important; background: #2a2b27; border-radius: 2px; cursor: pointer; }`}</style>
            {previewLoading ? <div style={{ margin: "auto", color: "var(--colors-muted)" }}>LOADING FILE…</div> : preview && (
              preview.name.endsWith(".md") || preview.name.endsWith(".mdx") ? (
                <div style={{ margin: 0, padding: "20px 30px", flex: 1, overflow: "auto", background: "#0e0f0c", color: "#dcded2" }}>
                  <MarkdownMessage>{preview.content}</MarkdownMessage>
                </div>
              ) : (
                <pre className="rag-readonly-pre" style={{ margin: 0, padding: 20, flex: 1, overflow: "auto", background: "#0e0f0c", font: "12px/1.55 var(--font-mono)", color: "#dcded2", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }} onClick={(e) => {
                  if (e.metaKey || e.ctrlKey) {
                    const target = e.target as HTMLElement;
                    if (target.dataset.path && preview) {
                      const currentPath = preview.name.split('/');
                      currentPath.pop();
                      const targetParts = target.dataset.path.split('/');
                      for (const p of targetParts) {
                        if (p === '.') continue;
                        if (p === '..') currentPath.pop();
                        else currentPath.push(p);
                      }
                      const resolved = currentPath.join('/');
                      const possible = [resolved, resolved + '.ts', resolved + '.tsx', resolved + '.js', resolved + '/index.ts', resolved + '/index.tsx', target.dataset.path, target.dataset.path.slice(1)];
                      const found = files.find(f => possible.includes(f.relative));
                      if (found) void openFile(found);
                    }
                  }
                }} dangerouslySetInnerHTML={{ __html: highlightCode(preview.content) }} />
              )
            )}
            <footer style={{ padding: "8px 20px", borderTop: "1px solid var(--colors-hairline)", fontSize: 10, color: "var(--colors-muted-soft)", background: "#1a1b18" }}>
              <span>{preview ? `${preview.content.length.toLocaleString()} chars` : ""} · Edit via chat to make changes.</span>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}

function TreeFolder({
  folder,
  depth,
  expanded,
  toggleFolder,
  openFile,
  previewName,
}: {
  folder: Folder;
  depth: number;
  expanded: Set<string>;
  toggleFolder: (rel: string) => void;
  openFile: (f: ProjectFile) => void;
  previewName: string | null;
}) {
  const isExpanded = expanded.has(folder.rel);
  const sortedFolders = [...folder.folders.values()].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  const sortedFiles = [...folder.files].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  return (
    <>
      {depth > 0 && (
        <button className="pfs-folder" style={{ paddingLeft: 8 + (depth - 1) * 12 }} onClick={() => toggleFolder(folder.rel)} aria-expanded={isExpanded}>
          <span className="pfs-folder-chevron">{isExpanded ? "⌄" : "›"}</span>
          <span className="pfs-folder-icon">{isExpanded ? "📂" : "📁"}</span>
          <span className="pfs-folder-name">{folder.name}</span>
          <small className="pfs-folder-count">
            {folder.folders.size + folder.files.length}
          </small>
        </button>
      )}
      {(depth === 0 || isExpanded) && (
        <>
          {sortedFolders.map((sub) => (
            <TreeFolder key={sub.rel} folder={sub} depth={depth + 1} expanded={expanded} toggleFolder={toggleFolder} openFile={openFile} previewName={previewName} />
          ))}
          {sortedFiles.map((f) => (
            <button
              key={f.path}
              className={`pfs-file${previewName === f.relative ? " active" : ""}`}
              style={{ paddingLeft: 8 + depth * 12 + (depth > 0 ? 16 : 0) }}
              onClick={() => openFile(f)}
              title={`${f.relative} · ${f.chars} chars`}
            >
              <span className="pfs-file-icon" aria-hidden>
                {iconFor(f.name)}
              </span>
              <span className="pfs-file-name">{f.name}</span>
              <small className="pfs-file-meta">{f.chars ? shortChars(f.chars) : "bin"}</small>
            </button>
          ))}
        </>
      )}
    </>
  );
}

function shortChars(n: number) {
  if (n === 0) return "—";
  if (n < 1000) return `${n}`;
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

function iconFor(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "md":
    case "mdx":
      return "◫";
    case "json":
      return "{}";
    case "csv":
      return "▤";
    case "txt":
      return "≡";
    case "ts":
    case "tsx":
      return "TS";
    case "js":
    case "jsx":
      return "JS";
    case "rs":
      return "RS";
    case "css":
    case "scss":
      return "#";
    case "html":
      return "<>";
    case "toml":
    case "yaml":
    case "yml":
      return "⚙";
    case "svg":
    case "png":
    case "jpg":
    case "ico":
      return "◫";
    default:
      return "—";
  }
}

function highlightCode(code: string) {
  let html = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return html.replace(/(\/\/.*|\/\*[\s\S]*?\*\/)|(["'])(.*?)\2|\b(import|export|from|const|let|var|function|async|await|class|interface|type|if|else|return|for|while|switch|case|default|break|continue|try|catch|finally|true|false|null|undefined|string|number|boolean)\b/g, 
  (match, comment, quote, innerString, keyword) => {
    if (comment) return `<span style="color: #67685f;">${comment}</span>`;
    if (quote) {
      const isPath = innerString.startsWith(".") || innerString.startsWith("/") || innerString.startsWith("@");
      const dataAttr = isPath ? ` class="clickable-import" data-path="${innerString}" style="text-decoration: underline;" title="Cmd+Click to go"` : "";
      return `<span style="color: #a8d976;"${dataAttr}>${quote}${innerString}${quote}</span>`;
    }
    if (keyword) return `<span style="color: #e27b72;">${keyword}</span>`;
    return match;
  });
}
