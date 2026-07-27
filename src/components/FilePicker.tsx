import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type FileEntry = { name: string; path: string; relative: string };

export default function FilePicker({
  projectPath,
  query,
  onPick,
  onClose,
}: {
  projectPath: string;
  query: string;
  onPick: (f: FileEntry) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function search() {
      try {
        const res = await invoke<FileEntry[]>("search_files", { projectPath, query });
        if (!cancelled) { setFiles(res); setSelectedIdx(0); }
      } catch {}
    }
    search();
    return () => { cancelled = true; };
  }, [projectPath, query]);

  if (files.length === 0) return null;

  return (
    <div className="surface-elevated" style={{ position: "absolute", bottom: "100%", left: 0, maxHeight: 300, overflow: "auto", width: 400, zIndex: 20 }}>
      <div className="caption-uppercase" style={{ padding: "var(--spacing-sm)", borderBottom: "1px solid var(--colors-hairline)", display: "flex", justifyContent: "space-between" }}>
        <span>@ FILE PICKER — {files.length} RESULTS</span>
        <button onClick={onClose} aria-label="Close file picker">✕</button>
      </div>
      {files.map((f, idx) => (
        <button
          key={f.path}
          onClick={() => onPick(f)}
          onMouseEnter={() => setSelectedIdx(idx)}
          className="button"
          style={{ display: "block", width: "100%", textAlign: "left", padding: "var(--spacing-sm)", background: idx === selectedIdx ? "var(--colors-surface-soft)" : "transparent", border: "none", borderBottom: "1px solid var(--colors-hairline)", textTransform: "none" }}
        >
          {f.relative}
        </button>
      ))}
    </div>
  );
}
