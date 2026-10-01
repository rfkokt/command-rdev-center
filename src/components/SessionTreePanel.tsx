import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type SessionTreeNode = {
  id: string;
  /** entry.type, e.g. "message" */
  kind: string;
  /** entry.message.role, e.g. "user" | "assistant" */
  role?: string;
  /** node label, e.g. "checkpoint" */
  label?: string;
  /** truncated text preview */
  preview: string;
  depth: number;
  isLeaf: boolean;
};

export type SessionTreePanelProps = {
  sessionId: string;
  agentRunning: boolean;
  onToast: (message: string) => void;
  /** After a successful fork: refresh state/messages from the forked session. */
  onForked: () => void;
  onClose: () => void;
};

type RawEntry = {
  type?: unknown;
  id?: unknown;
  message?: { role?: unknown; content?: unknown };
  text?: unknown;
};

type RawNode = {
  entry?: RawEntry;
  children?: RawNode[];
  label?: unknown;
};

/**
 * Best-effort text preview for a session tree entry. pi entries look like
 * `{ type: "message", id, parentId, message: { role, content } }` where content
 * is a string or an array of content parts; older shapes may carry `text`.
 */
export function entryPreview(entry: RawEntry | undefined): string {
  if (!entry) return "";
  const content = entry.message?.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter(
        (part): part is { type: string; text?: string } =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "text",
      )
      .map((part) => part.text ?? "")
      .join("\n");
  } else if (typeof entry.text === "string") {
    text = entry.text;
  }
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine;
}

/** Depth-first flatten of pi's recursive `{ entry, children }` tree nodes. */
export function flattenTree(tree: RawNode[], depth = 0): SessionTreeNode[] {
  const out: SessionTreeNode[] = [];
  for (const node of tree) {
    const entry = node.entry;
    const id = typeof entry?.id === "string" ? entry.id : "";
    const children = Array.isArray(node.children) ? node.children : [];
    out.push({
      id,
      kind: typeof entry?.type === "string" ? entry.type : "entry",
      role:
        typeof entry?.message?.role === "string"
          ? entry.message.role
          : undefined,
      label: typeof node.label === "string" ? node.label : undefined,
      preview: entryPreview(entry),
      depth,
      isLeaf: children.length === 0,
    });
    out.push(...flattenTree(children, depth + 1));
  }
  return out;
}

export default function SessionTreePanel({
  sessionId,
  agentRunning,
  onToast,
  onForked,
  onClose,
}: SessionTreePanelProps) {
  const [nodes, setNodes] = useState<SessionTreeNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [forking, setForking] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await invoke<{ tree?: RawNode[]; leafId?: string }>(
        "get_session_tree",
        { sessionId },
      );
      setNodes(flattenTree(data.tree ?? []));
    } catch (error) {
      onToast(`Session tree: ${String(error)}`);
    } finally {
      setLoading(false);
    }
  }, [sessionId, onToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleFork = async (node: SessionTreeNode) => {
    if (!node.id) return;
    setForking(node.id);
    try {
      const data = await invoke<{ text?: string; cancelled?: boolean }>(
        "fork_session",
        { sessionId, nodeId: node.id },
      );
      if (data.cancelled) {
        onToast("Fork cancelled");
        return;
      }
      const text = (data.text ?? "").replace(/\s+/g, " ").slice(0, 80);
      onToast(
        text
          ? `Forked from "${text}" — this chat now continues the fork`
          : "Forked — this chat now continues the fork",
      );
      onForked();
    } catch (error) {
      onToast(`Fork failed: ${String(error)}`);
    } finally {
      setForking(null);
    }
  };

  return (
    <div
      className="model-picker-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="model-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Session tree"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header>
          <span>SESSION TREE</span>
          <button onClick={onClose} aria-label="Close session tree">
            ESC
          </button>
        </header>
        <div className="model-list" role="listbox" aria-label="Session nodes">
          {loading && nodes.length === 0 ? (
            <small style={{ padding: 12, color: "var(--text-secondary)" }}>
              Loading tree…
            </small>
          ) : nodes.length === 0 ? (
            <small style={{ padding: 12, color: "var(--text-secondary)" }}>
              No session entries yet.
            </small>
          ) : (
            nodes.map((node) => (
              <div
                key={node.id || `${node.depth}-${node.preview}`}
                role="option"
                aria-selected={false}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 12px",
                  paddingLeft: 12 + node.depth * 16,
                }}
              >
                <span
                  className="caption-uppercase"
                  style={{ color: "var(--accent)", flexShrink: 0 }}
                >
                  {node.role ?? node.kind}
                </span>
                {node.label && (
                  <span
                    className="caption-uppercase"
                    style={{
                      flexShrink: 0,
                      border: "1px solid var(--separator)",
                      borderRadius: 4,
                      padding: "0 4px",
                    }}
                  >
                    {node.label}
                  </span>
                )}
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "var(--text-secondary)",
                  }}
                  title={node.preview || node.id}
                >
                  {node.preview || node.id || "(empty)"}
                  {node.isLeaf ? " ●" : ""}
                </span>
                <button
                  className="composer-chip"
                  style={{ minHeight: 24, fontSize: 11, flexShrink: 0 }}
                  disabled={agentRunning || forking !== null}
                  title={
                    agentRunning
                      ? "Wait for the agent to finish before forking"
                      : `Fork a new branch from ${node.id.slice(0, 8)}`
                  }
                  onClick={() => void handleFork(node)}
                >
                  {forking === node.id ? "FORKING…" : "FORK"}
                </button>
              </div>
            ))
          )}
        </div>
        <footer>
          <span>{nodes.length} NODES</span>
          <span>FORK FROM HERE</span>
        </footer>
      </section>
    </div>
  );
}
