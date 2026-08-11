import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import MarkdownMessage from "./MarkdownMessage";
import { confirm } from "./ConfirmDialog";
import { useModalFocus } from "./useModalFocus";

type Source = { id: string; name: string; kind: string; chars: number; modified_ms: number };
type SourceDetail = { id: string; name: string; kind: string; chars: number; modified_ms: number; text: string };

const EXTENSIONS = ["pdf", "docx", "txt", "md", "csv", "json"];

export default function RagKnowledge({ onToast }: { onToast: (message: string) => void }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<SourceDetail | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const previewRef = useModalFocus<HTMLElement>(() => setPreview(null), previewLoading || Boolean(preview));

  const reload = useCallback(() => invoke<Source[]>("list_rag_sources").then((items) => { setSources(items); setError(""); }).catch((e) => setError(String(e))).finally(() => setLoaded(true)), []);

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
    if (!await confirm({ title: "Delete source", message: `Delete extracted source “${source.name}”? This cannot be undone.`, confirmLabel: "Delete", cancelLabel: "Keep", danger: true })) return;
    setError("");
    try { await invoke("delete_rag_source", { id: source.id }); await reload(); onToast(`Deleted ${source.name}.`); if (preview?.id === source.id) setPreview(null); }
    catch (e) { setError(String(e)); }
  }

  async function openPreview(source: Source) {
    setPreviewLoading(true);
    try { const detail = await invoke<SourceDetail>("get_rag_source", { id: source.id }); setPreview(detail); }
    catch (e) { setError(String(e)); } finally { setPreviewLoading(false); }
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
      <div><small>GLOBAL WORKSPACE</small><h1>Knowledge</h1><p>Local sources available to Global Chat. Extracted text stays on this device; original uploads are not retained.</p></div>
      <button className="save-settings" onClick={() => void upload()}>Add source</button>
    </header>

    <button className="settings-notice" style={{ width: "100%", minHeight: 90, borderStyle: "dashed" }} onClick={() => void upload()}>Drop a PDF, DOCX, TXT, MD, CSV, or JSON file here — or browse</button>

    {!loaded ? <div className="pipeline-project-empty" role="status"><strong>Loading knowledge</strong><span>Reading locally extracted sources…</span></div> : error ? <div className="settings-error" role="alert">{error}</div> : sources.length === 0 ? <div className="pipeline-project-empty"><strong>No sources yet</strong><span>Add a supported document to make it available to Global Chat.</span></div> : <div className="pipeline-table-wrap"><table className="pipeline-table"><thead><tr><th>Source</th><th>Type</th><th>Extracted text</th><th>Added</th><th /></tr></thead><tbody>{sources.map((source) => <tr key={source.id}><td><button className="rag-preview-link" onClick={() => void openPreview(source)} title="Preview extracted text">{source.name}</button></td><td>{source.kind.toUpperCase()}</td><td>{source.chars.toLocaleString()} chars</td><td>{new Date(source.modified_ms).toLocaleString()}</td><td style={{ display: "flex", gap: 6 }}><button onClick={() => void openPreview(source)}>PREVIEW</button><button onClick={() => void remove(source)}>DELETE</button></td></tr>)}</tbody></table></div>}

    {/* Source preview modal */}
    {(previewLoading || preview) && <div className="settings-backdrop" onClick={() => setPreview(null)}><section ref={previewRef} className="rag-preview-panel" role="dialog" aria-modal="true" aria-label={preview ? `Preview ${preview.name}` : "Loading source preview"} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
      <header><div><small>EXTRACTED TEXT · READONLY</small><strong>{preview?.name ?? "Loading…"}</strong><span>{preview ? `${preview.chars.toLocaleString()} chars · ${preview.kind}` : ""}</span></div><button onClick={() => setPreview(null)} aria-label="Close source preview">✕</button></header>
      {previewLoading ? <div className="settings-loading">LOADING…</div> : preview && <main><MarkdownMessage>{preview.text.slice(0, 100000)}</MarkdownMessage></main>}
      <footer><span>{preview ? "Readonly preview · original file not retained" : ""}</span><button className="save-settings" onClick={() => setPreview(null)}>CLOSE</button></footer>
    </section></div>}
  </section>;
}
