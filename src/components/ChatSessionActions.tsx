import { useState } from "react";

export type ChatMetadata = {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
};
export default function ChatSessionActions({
  chat,
  onChange,
}: {
  chat: ChatMetadata;
  onChange: (patch: ChatMetadata) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  return (
    <details className="project-row-actions">
      <summary
        aria-label={`Session actions for ${chat.title ?? "Untitled session"}`}
      >
        ⋯
      </summary>
      <div className="project-row-menu">
        {renaming ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim()) return;
              onChange({ title: name.trim().slice(0, 120) });
              setRenaming(false);
            }}
          >
            <input
              aria-label="Session name"
              value={name}
              maxLength={120}
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
            <button type="submit" disabled={!name.trim()}>
              Save name
            </button>
            <button type="button" onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button
            onClick={() => {
              setName(chat.title ?? "");
              setRenaming(true);
            }}
          >
            Rename
          </button>
        )}
        <button onClick={() => onChange({ pinned: !chat.pinned })}>
          {chat.pinned ? "Unpin" : "Pin"}
        </button>
        <button onClick={() => onChange({ archived: !chat.archived })}>
          {chat.archived ? "Unarchive" : "Archive"}
        </button>
      </div>
    </details>
  );
}
