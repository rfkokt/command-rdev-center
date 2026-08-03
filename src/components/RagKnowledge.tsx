import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import MarkdownMessage from "./MarkdownMessage";

type Source = { id: string; name: string; kind: string; chars: number; modified_ms: number };
type SourceDetail = { id: string; name: string; kind: string; chars: number; modified_ms: number; text: string };
type Project = { name: string; path: string };
type ProjectFile = { name: string; path: string; chars: number; modified_ms: number };

const EXTENSIONS = ["pdf", "docx", "txt", "md", "csv", "json"];

export default function RagKnowledge({ onToast }: { onToast: (message: string) => void }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<SourceDetail | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [projectFiles, setProjectFiles] = useState<ProjectFile[]>([]);
  const [projectFilesError, setProjectFilesError] = useState("");
  const [projectFilesLoading, setProjectFilesLoading] = useState(false);
  const [filePreview, setFilePreview] = useState<{ name: string; content: string } | null>(null);
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);

  const reload = useCallback(() => invoke<Source[]>("list_rag_sources").then(setSources).catch((e) => setError(String(e))), []);

  const uploadPath = useCallback(async (file: string) => {
    const extension = file.split(".").pop()?.toLowerCase();
    if (!extension || !EXTENSIONS.includes(extension)) {
      setError(`Unsupported document type. Use ${EXTENSIONS.join(", ").toUpperCase()}.`);
      return;
    }
    const fileName = file.split(/[\\/]/).pop() ?? "document";
    setUploading((list) => [...list, fileName]);
    setError("");
    onToast(`Uploading ${fileName}… you can keep working.`);
    try {
      await invoke("ingest_rag_document", { filePath: file });
      await reload();
      onToast(`✓ ${fileName} extracted and stored locally.`);
    } catch (e) {
      const message = String(e);
      setError(message);
      onToast(`✗ ${fileName}: ${message.slice(0, 120)}`);
    } finally {
      setUploading((list) => list.filter((n) => n !== fileName));
    }
  }, [onToast, reload]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    invoke<Project[]>("list_projects").then((list) => {
      setProjects(list);
      if (list.length && !selectedProject) setSelectedProject(list[0].path);
    }).catch(() => {});
  }, [selectedProject]);

  useEffect(() => {
    if (!selectedProject) return;
    setProjectFilesLoading(true);
    setProjectFilesError("");
    invoke<ProjectFile[]>("list_project_files", { projectPath: selectedProject })
      .then(setProjectFiles)
      .catch((e) => setProjectFilesError(String(e)))
      .finally(() => setProjectFilesLoading(false));
  }, [selectedProject]);

  useEffect(() => {
    const unlisten = getCurrentWindow().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter" || payload.type === "over") setDragging(true);
      else if (payload.type === "leave") setDragging(false);
      else if (payload.type === "drop") {
        setDragging(false);
        const file = payload.paths[0];
        if (file) void uploadPath(file);
      }
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, [uploadPath]);

  async function upload() {
    const file = await open({ multiple: false, title: "Add knowledge source", filters: [{ name: "Supported documents", extensions: EXTENSIONS }] });
    if (file && !Array.isArray(file)) await uploadPath(file);
  }

  async function remove(source: Source) {
    if (!window.confirm(`Delete extracted source “${source.name}”? This cannot be undone.`)) return;
    setError("");
    try { await invoke("delete_rag_source", { id: source.id }); await reload(); onToast(`Deleted ${source.name}.`); if (preview?.id === source.id) setPreview(null); }
    catch (e) { setError(String(e)); }
  }

  async function openPreview(source: Source) {
    setPreviewLoading(true);
    try { const detail = await invoke<SourceDetail>("get_rag_source", { id: source.id }); setPreview(detail); }
    catch (e) { setError(String(e)); } finally { setPreviewLoading(false); }
  }

  async function openProjectFile(file: ProjectFile) {
    if (!selectedProject) return;
    setFilePreviewLoading(true);
    try {
      const content = await invoke<string>("get_project_file_content", { projectPath: selectedProject, fileName: file.name });
      setFilePreview({ name: file.name, content });
    } catch (e) { setProjectFilesError(String(e)); } finally { setFilePreviewLoading(false); }
  }

  return <section className="pipeline-view rag-knowledge" aria-label="RAG knowledge sources">
    {/* Non-blocking upload indicator */}
    {uploading.length > 0 && <div className="rag-upload-toast" role="status" aria-live="polite">
      <span className="agent-working-mark" aria-hidden="true"><i /><i /><i /></span>
      <span>{uploading.length === 1 ? `Extracting ${uploading[0]}…` : `Extracting ${uploading.length} documents…`}</span>
      <small>Non-blocking · keep working</small>
    </div>}
    {dragging && <div className="rag-drop-hint"><div><strong>DROP DOCUMENT HERE</strong><small>PDF · DOCX · TXT · MD · CSV · JSON</small></div></div>}

    <header className="pipeline-header">
      <div><small>GLOBAL CHAT / RAG</small><h1>KNOWLEDGE SOURCES</h1><p>Extracted text stored locally. Original uploads are not retained. Uploads are non-blocking.</p></div>
      <button className="save-settings" onClick={() => void upload()}>ADD DOCUMENT</button>
    </header>

    <button className="settings-notice" style={{ width: "100%", minHeight: 90, borderStyle: "dashed" }} onClick={() => void upload()}>DROP A DOCUMENT ANYWHERE ON THIS PAGE · OR CLICK TO BROWSE · {uploading.length ? `${uploading.length} extracting…` : "idle"}</button>

    {error && <div className="settings-error" role="alert">{error}</div>}

    {sources.length === 0 ? <div className="pipeline-project-empty"><strong>NO UPLOADED SOURCES</strong><span>Add PDF, DOCX, TXT, MD, CSV, or JSON knowledge. You can preview extracted text after upload.</span></div> : <div className="pipeline-table-wrap"><table className="pipeline-table"><thead><tr><th>Source</th><th>Type</th><th>Extracted text</th><th>Added</th><th /></tr></thead><tbody>{sources.map((source) => <tr key={source.id}><td><button className="rag-preview-link" onClick={() => void openPreview(source)} title="Preview extracted text">{source.name}</button></td><td>{source.kind.toUpperCase()}</td><td>{source.chars.toLocaleString()} chars</td><td>{new Date(source.modified_ms).toLocaleString()}</td><td style={{ display: "flex", gap: 6 }}><button onClick={() => void openPreview(source)}>PREVIEW</button><button onClick={() => void remove(source)}>DELETE</button></td></tr>)}</tbody></table></div>}

    {/* Project files preview section */}
    <div className="rag-project-section">
      <header><div><small>REGISTERED PROJECTS · READONLY PREVIEW</small><h2>PROJECT TOP-LEVEL FILES</h2><p>UTF-8 TXT, MD, CSV, JSON only · {MAX_PROJECT_NOTE()}</p></div>
        <select className="themed-select" value={selectedProject} onChange={(e) => setSelectedProject(e.target.value)}>
          {projects.map((p) => <option key={p.path} value={p.path}>{p.name} · {p.path}</option>)}
        </select>
      </header>
      {projectFilesError && <div className="settings-error" role="alert">{projectFilesError}</div>}
      {projectFilesLoading ? <div className="settings-loading">LOADING PROJECT FILES…</div> : projectFiles.length === 0 ? <div className="pipeline-project-empty"><strong>NO PREVIEWABLE FILES</strong><span>Top-level TXT/MD/CSV/JSON in selected project. Dotfiles hidden, 1 MB max per file.</span></div> : <div className="pipeline-table-wrap"><table className="pipeline-table"><thead><tr><th>File</th><th>Size</th><th>Modified</th><th /></tr></thead><tbody>{projectFiles.map((f) => <tr key={f.path}><td><button className="rag-preview-link" onClick={() => void openProjectFile(f)}>{f.name}</button></td><td>{f.chars.toLocaleString()} chars</td><td>{new Date(f.modified_ms).toLocaleString()}</td><td><button onClick={() => void openProjectFile(f)}>VIEW</button></td></tr>)}</tbody></table></div>}
    </div>

    {/* Source preview modal */}
    {(previewLoading || preview) && <div className="settings-backdrop" onClick={() => setPreview(null)}><section className="rag-preview-panel" onClick={(e) => e.stopPropagation()} aria-label="Preview extracted source">
      <header><div><small>EXTRACTED TEXT · READONLY</small><strong>{preview?.name ?? "Loading…"}</strong><span>{preview ? `${preview.chars.toLocaleString()} chars · ${preview.kind}` : ""}</span></div><button onClick={() => setPreview(null)}>✕</button></header>
      {previewLoading ? <div className="settings-loading">LOADING…</div> : preview && <main><MarkdownMessage>{preview.text.slice(0, 100000)}</MarkdownMessage></main>}
      <footer><span>{preview ? "Readonly preview · original file not retained" : ""}</span><button className="save-settings" onClick={() => setPreview(null)}>CLOSE</button></footer>
    </section></div>}

    {/* Project file preview modal */}
    {(filePreviewLoading || filePreview) && <div className="settings-backdrop" onClick={() => setFilePreview(null)}><section className="rag-preview-panel" onClick={(e) => e.stopPropagation()} aria-label="Preview project file">
      <header><div><small>PROJECT FILE · READONLY</small><strong>{filePreview?.name ?? "Loading…"}</strong><span>read-only · from selected registered project</span></div><button onClick={() => setFilePreview(null)}>✕</button></header>
      {filePreviewLoading ? <div className="settings-loading">LOADING…</div> : filePreview && <main><pre className="rag-readonly-pre">{filePreview.content.slice(0, 100000)}</pre></main>}
      <footer><span>Readonly · edits not allowed here, use project chat</span><button className="save-settings" onClick={() => setFilePreview(null)}>CLOSE</button></footer>
    </section></div>}
  </section>;
}

function MAX_PROJECT_NOTE() { return "Dotfiles hidden · Max 100 files · 1 MB per file"; }
