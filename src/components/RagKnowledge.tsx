import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Source = { id: string; name: string; chars: number; modified_ms: number };
const EXTENSIONS = ["pdf", "docx", "txt", "md", "csv", "json"];

export default function RagKnowledge({ onToast }: { onToast: (message: string) => void }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadingName, setUploadingName] = useState("");
  const [dragging, setDragging] = useState(false);
  const reload = useCallback(() => invoke<Source[]>("list_rag_sources").then(setSources).catch((e) => setError(String(e))), []);
  const uploadPath = useCallback(async (file: string) => {
    if (busy) return;
    const extension = file.split(".").pop()?.toLowerCase();
    if (!extension || !EXTENSIONS.includes(extension)) return setError(`Unsupported document type. Use ${EXTENSIONS.join(", ").toUpperCase()}.`);
    setBusy(true); setUploadingName(file.split(/[\\/]/).pop() ?? "document"); setError("");
    try { await invoke("ingest_rag_document", { filePath: file }); await reload(); onToast("Document extracted and stored locally."); }
    catch (e) {
      const message = String(e);
      setError(message);
    } finally { setBusy(false); setUploadingName(""); }
  }, [busy, onToast, reload]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const unlisten = getCurrentWindow().onDragDropEvent(({ payload }) => {
      if (payload.type === "enter" || payload.type === "over") setDragging(true);
      else if (payload.type === "leave") setDragging(false);
      else if (payload.type === "drop") { setDragging(false); const file = payload.paths[0]; if (file) void uploadPath(file); }
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, [uploadPath]);
  async function upload() {
    const file = await open({ multiple: false, title: "Add knowledge source", filters: [{ name: "Supported documents", extensions: EXTENSIONS }] });
    if (file && !Array.isArray(file)) await uploadPath(file);
  }
  async function remove(source: Source) {
    if (!window.confirm(`Delete extracted source “${source.name}”? This cannot be undone.`)) return;
    setBusy(true); setError("");
    try { await invoke("delete_rag_source", { id: source.id }); await reload(); onToast(`Deleted ${source.name}.`); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <section className="pipeline-view" aria-label="RAG knowledge sources" aria-busy={Boolean(uploadingName)}>
    {uploadingName && <div className="settings-backdrop"><div className="session-loading" role="status" aria-live="polite"><span className="agent-working-mark" aria-hidden="true"><i /><i /><i /></span><div><strong>UPLOADING & EXTRACTING</strong><small>{uploadingName}</small></div></div></div>}
    {dragging && <div className="settings-backdrop"><div className="session-loading" role="status"><div><strong>DROP DOCUMENT HERE</strong><small>PDF · DOCX · TXT · MD · CSV · JSON</small></div></div></div>}
    <header className="pipeline-header"><div><small>GLOBAL CHAT / RAG</small><h1>KNOWLEDGE SOURCES</h1><p>Extracted text stored locally. Original uploads are not retained.</p></div><button className="save-settings" onClick={() => void upload()} disabled={busy}>{busy ? "WORKING…" : "ADD DOCUMENT"}</button></header>
    <button className="settings-notice" style={{ width: "100%", minHeight: 90, borderStyle: "dashed" }} onClick={() => void upload()} disabled={busy}>DROP A DOCUMENT ANYWHERE ON THIS PAGE · OR CLICK TO BROWSE</button>
    {error && <div className="settings-error" role="alert">{error}</div>}
    {sources.length === 0 ? <div className="pipeline-project-empty"><strong>NO UPLOADED SOURCES</strong><span>Add PDF, DOCX, TXT, MD, CSV, or JSON knowledge.</span></div> : <div className="pipeline-table-wrap"><table className="pipeline-table"><thead><tr><th>Source</th><th>Extracted text</th><th>Added</th><th /></tr></thead><tbody>{sources.map((source) => <tr key={source.id}><td>{source.name}</td><td>{source.chars.toLocaleString()} chars</td><td>{new Date(source.modified_ms).toLocaleString()}</td><td><button onClick={() => void remove(source)} disabled={busy}>DELETE</button></td></tr>)}</tbody></table></div>}
  </section>;
}
