import { useEffect, useImperativeHandle, useState, type Ref } from "react";
import { invoke } from "@tauri-apps/api/core";
import { filePickerKey } from "./chat-utils";

type FileEntry = { name: string; path: string; relative: string };

export type FilePickerHandle = { onKeyDown: (key: string) => boolean };

export default function FilePicker({
  projectPath,
  query,
  onPick,
  onClose,
  pickerRef,
}: {
  projectPath: string;
  query: string;
  onPick: (f: FileEntry) => void;
  onClose: () => void;
  pickerRef: Ref<FilePickerHandle>;
}) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [error, setError] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function search() {
      try {
        const res = await invoke<FileEntry[]>("search_files", { projectPath, query });
        if (!cancelled) { setFiles(res); setError(""); setSelectedIdx(0); }
      } catch (e) {
        if (!cancelled) { setFiles([]); setError(String(e)); }
      }
    }
    search();
    return () => { cancelled = true; };
  }, [projectPath, query]);

  useImperativeHandle(pickerRef, () => ({
    onKeyDown(key) {
      const action = filePickerKey(key, selectedIdx, files.length);
      if (!action) return false;
      if (typeof action.select === "number") setSelectedIdx(action.select);
      else if (typeof action.pick === "number") { const file = files[action.pick]; if (file) onPick(file); }
      else onClose();
      return true;
    },
  }), [files, onClose, onPick, selectedIdx]);

  if (files.length === 0 && !error) return null;

  return (
    <div className="file-picker glass-surface">
      <div className="file-picker-header caption-uppercase">
        <span>@ FILE PICKER — {files.length} RESULTS</span>
        <button className="small-icon-button" onClick={onClose} aria-label="Close file picker">✕</button>
      </div>
      {error && <div className="file-picker-error body-sm" role="alert">{error}</div>}
      {files.map((f, idx) => (
        <button
          key={f.path}
          onClick={() => onPick(f)}
          onMouseEnter={() => setSelectedIdx(idx)}
          className={`file-picker-row ${idx === selectedIdx ? "active" : ""}`}
        >
          {f.relative}
        </button>
      ))}
    </div>
  );
}
