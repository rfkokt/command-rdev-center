import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import MarkdownMessage from "./MarkdownMessage";
import { useModalFocus } from "./useModalFocus";
import { ChevronDownIcon, ChevronLeftIcon, CloseIcon, CopyIcon, FileIcon, FolderIcon, FolderOpenIcon, RefreshIcon, SettingsIcon } from "./Icons";

type ProjectFile = { name: string; path: string; relative: string; chars: number; modified_ms: number };

export function isPreviewableImage(name: string) {
  return /\.(?:png|jpe?g|gif|webp|bmp|ico)$/i.test(name);
}

type Preview = { name: string; content: string; imageSrc?: string };

function imageMime(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  return ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
}

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
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewPos, setPreviewPos] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; initX: number; initY: number; headerTop: number } | null>(null);
  const closePreview = useCallback(() => { setPreview(null); setPreviewPos({ x: 0, y: 0 }); }, []);
  const previewRef = useModalFocus<HTMLDivElement>(closePreview, previewLoading || preview !== null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [recentPaths, setRecentPaths] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("crc-recent-files") ?? "[]");
    } catch {
      return [];
    }
  });

  useEffect(() => () => {
    if (preview?.imageSrc) URL.revokeObjectURL(preview.imageSrc);
  }, [preview?.imageSrc]);

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
        if (isPreviewableImage(file.name)) {
          const bytes = await invoke<number[]>("get_project_image_content", {
            projectPath,
            fileName: file.relative,
          });
          setPreview({ name: file.relative, content: "", imageSrc: URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: imageMime(file.name) })) });
          pushRecent(file.relative);
          return;
        }
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
          aria-label="Filter project files"
          placeholder="FILTER FILES…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="pfs-filter"
        />
        <span className="pfs-count">{loading ? "…" : q ? `${filteredFiles?.length ?? 0}` : `${files.length}`}</span>
        <button onClick={reload} disabled={loading} className="pfs-refresh" title="Refresh files" aria-label="Refresh files">
          <RefreshIcon />
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
        <ul className="pfs-tree">
          <TreeFolder folder={tree} depth={0} expanded={expanded} toggleFolder={toggleFolder} openFile={openFile} previewName={preview?.name ?? null} />
        </ul>
      )}

      {(previewLoading || preview) && (
        <div className="file-preview-backdrop">
          <div ref={previewRef} className="diff-panel file-preview-dialog" role="dialog" aria-modal="true" aria-label={preview ? `Preview ${preview.name}` : "Loading file preview"} tabIndex={-1} style={{ transform: `translate(${previewPos.x}px, ${previewPos.y}px)`, transition: dragRef.current ? "none" : "transform 0.1s ease-out" }}>
            <div 
              className="file-preview-header"
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
              <div className="file-preview-title">
                <small>FILE PREVIEW (READONLY)</small>
                <strong>{preview?.name ?? "Loading…"}</strong>
              </div>
              <div className="file-preview-actions">
                {!preview?.imageSrc && <button onClick={() => navigator.clipboard.writeText(preview?.content ?? "")} title="Copy content" aria-label="Copy content" onPointerDown={(e) => e.stopPropagation()}>
                  <CopyIcon /><span>Copy</span>
                </button>}
                <button className="file-preview-close" onClick={closePreview} title="Close preview" aria-label="Close preview" onPointerDown={(e) => e.stopPropagation()}>
                  <CloseIcon /><span>Close</span>
                </button>
              </div>
            </div>
            <style>{`.clickable-import:hover { color: var(--accent) !important; background: #2a2b27; border-radius: 2px; cursor: pointer; }`}</style>
            {previewLoading ? <div style={{ margin: "auto", color: "var(--colors-muted)" }}>LOADING FILE…</div> : preview && (
              preview.imageSrc ? (
                <div className="file-preview-content pfs-image-preview">
                  <img src={preview.imageSrc} alt={preview.name} />
                </div>
              ) : preview.name.endsWith(".md") || preview.name.endsWith(".mdx") ? (
                <div className="file-preview-content markdown-preview">
                  <MarkdownMessage>{preview.content}</MarkdownMessage>
                </div>
              ) : (
                (() => {
                  const lines = splitLines(preview.content);
                  return (
                    <div className="pfs-code-wrap" onClick={(e) => {
                      if (!(e.metaKey || e.ctrlKey)) return;
                      const target = e.target as HTMLElement;
                      if (!target.dataset.path || !preview) return;
                      const currentPath = preview.name.split('/');
                      currentPath.pop();
                      for (const part of target.dataset.path.split('/')) {
                        if (part === '.') continue;
                        if (part === '..') currentPath.pop();
                        else currentPath.push(part);
                      }
                      const resolved = currentPath.join('/');
                      const possible = [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`, `${resolved}/index.ts`, `${resolved}/index.tsx`, target.dataset.path, target.dataset.path.slice(1)];
                      const found = files.find((file) => possible.includes(file.relative));
                      if (found) void openFile(found);
                    }}>
                      {lines.map((line, index) => <div className="pfs-code-line" key={index}>
                        <span className="pfs-code-line-number" aria-hidden>{index + 1}</span>
                        <code dangerouslySetInnerHTML={{ __html: highlightCode(line) || "&nbsp;" }} />
                      </div>)}
                    </div>
                  );
                })()
              )
            )}
            <footer className="file-preview-footer">
              <span>{preview ? preview.imageSrc ? "Image preview" : `${splitLines(preview.content).length.toLocaleString()} lines · ${preview.content.length.toLocaleString()} chars` : ""} · Edit via chat to make changes.</span>
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

  const children = (depth === 0 || isExpanded) && <>
    {sortedFolders.map((sub) => (
      <TreeFolder key={sub.rel} folder={sub} depth={depth + 1} expanded={expanded} toggleFolder={toggleFolder} openFile={openFile} previewName={previewName} />
    ))}
    {sortedFiles.map((f) => (
      <li key={f.path}>
        <button
          className={`pfs-file${previewName === f.relative ? " active" : ""}`}
          style={{ paddingLeft: 8 + depth * 12 + (depth > 0 ? 16 : 0) }}
          onClick={() => openFile(f)}
          title={`${f.relative} · ${f.chars} chars`}
        >
          <span className="pfs-file-icon" aria-hidden>{iconFor(f.name)}</span>
          <span className="pfs-file-name">{f.name}</span>
          <small className="pfs-file-meta">{f.chars ? shortChars(f.chars) : "bin"}</small>
        </button>
      </li>
    ))}
  </>;

  if (depth === 0) return children;
  return <li>
    <button className="pfs-folder" style={{ paddingLeft: 8 + (depth - 1) * 12 }} onClick={() => toggleFolder(folder.rel)} aria-expanded={isExpanded}>
      <span className="pfs-folder-chevron" aria-hidden>{isExpanded ? <ChevronDownIcon /> : <ChevronLeftIcon />}</span>
      <span className="pfs-folder-icon" aria-hidden>{isExpanded ? <FolderOpenIcon /> : <FolderIcon />}</span>
      <span className="pfs-folder-name">{folder.name}</span>
      <small className="pfs-folder-count">{folder.folders.size + folder.files.length}</small>
    </button>
    {isExpanded && <ul>{children}</ul>}
  </li>;
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
      return <SettingsIcon />;
    case "svg":
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "bmp":
    case "ico":
      return "◫";
    default:
      return <FileIcon />;
  }
}

function highlightCode(code: string) {
  let html = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return html.replace(/(\/\/.*|\/\*[\s\S]*?\*\/)|(["'])(.*?)\2|\b(import|export|from|const|let|var|function|async|await|class|interface|type|if|else|return|for|while|switch|case|default|break|continue|try|catch|finally|true|false|null|undefined|string|number|boolean)\b/g, 
  (match, comment, quote, innerString, keyword) => {
    if (comment) return `<span class="syntax-comment">${comment}</span>`;
    if (quote) {
      const isPath = innerString.startsWith(".") || innerString.startsWith("/") || innerString.startsWith("@");
      const dataAttr = isPath ? ` class="clickable-import" data-path="${innerString}" style="text-decoration: underline;" title="Cmd+Click to go"` : "";
      return `<span class="syntax-string"${dataAttr}>${quote}${innerString}${quote}</span>`;
    }
    if (keyword) return `<span class="syntax-keyword">${keyword}</span>`;
    return match;
  });
}

function splitLines(code: string): string[] {
  return code.split("\n");
}
