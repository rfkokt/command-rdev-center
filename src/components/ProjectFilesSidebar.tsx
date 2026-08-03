import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

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
        <div className="pfs-preview">
          <header>
            <div>
              <small>READONLY</small>
              <strong title={preview?.name}>{preview?.name ?? "Loading…"}</strong>
            </div>
            <div className="pfs-preview-actions">
              <button onClick={() => navigator.clipboard.writeText(preview?.content ?? "")} title="Copy content">
                ⧉
              </button>
              <button onClick={() => setPreview(null)} title="Close preview">
                ✕
              </button>
            </div>
          </header>
          {previewLoading ? <div className="pfs-loading">LOADING…</div> : preview && <pre className="rag-readonly-pre pfs-pre">{preview.content}</pre>}
          <footer>
            <span>Readonly · {preview ? `${preview.content.length.toLocaleString()} chars` : ""} · Edit via chat</span>
          </footer>
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
