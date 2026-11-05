import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { fileLinkRequest, type FileLink } from "../lib/markdown-links";
import { useModalFocus } from "./useModalFocus";

export default function ChatFilePreview({
  link,
  projectPath,
  onClose,
}: {
  link: FileLink;
  projectPath?: string;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const targetLine = useRef<HTMLDivElement>(null);
  const dialogRef = useModalFocus<HTMLDivElement>(onClose, true);
  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError("");
    async function load() {
      try {
        const text = await invoke<string>(
          "get_project_file_content",
          fileLinkRequest(link, projectPath),
        );
        if (!cancelled) setContent(text);
      } catch (cause) {
        if (!cancelled) setError(String(cause));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [link, projectPath]);
  useEffect(() => {
    if (content !== null)
      targetLine.current?.scrollIntoView?.({ block: "center" });
  }, [content]);

  return createPortal(
    <div className="file-preview-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="diff-panel file-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${link.path}`}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="file-preview-header" style={{ cursor: "default" }}>
          <div className="file-preview-title">
            <small>FILE PREVIEW (READONLY)</small>
            <strong title={link.path}>
              {link.path}
              {link.line ? `:${link.line}` : ""}
            </strong>
          </div>
          <div className="file-preview-actions">
            <button onClick={onClose} aria-label="Close file preview">
              Close
            </button>
          </div>
        </div>
        {error ? (
          <p role="alert">Unable to open file: {error}</p>
        ) : content === null ? (
          <p role="status">Loading file…</p>
        ) : (
          <div className="file-preview-content pfs-code-wrap">
            {content.split("\n").map((line, index) => (
              <div
                className="pfs-code-line"
                key={index}
                ref={index + 1 === link.line ? targetLine : undefined}
                style={
                  index + 1 === link.line
                    ? { background: "var(--surface-selected)" }
                    : undefined
                }
              >
                <span className="pfs-code-line-number" aria-hidden>
                  {index + 1}
                </span>
                <code style={{ whiteSpace: "pre" }}>{line || "\u00a0"}</code>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
