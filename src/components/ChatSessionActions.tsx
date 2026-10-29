import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    function position() {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;
      const anchor = trigger.getBoundingClientRect();
      const { width, height } = menu.getBoundingClientRect();
      const left = Math.max(
        8,
        Math.min(anchor.right - width, window.innerWidth - width - 8),
      );
      const top = Math.max(
        8,
        Math.min(
          anchor.bottom + height + 4 <= window.innerHeight - 8
            ? anchor.bottom + 4
            : anchor.top - height - 4,
          window.innerHeight - height - 8,
        ),
      );
      menu.style.setProperty("--session-menu-left", `${left}px`);
      menu.style.setProperty("--session-menu-top", `${top}px`);
    }
    position();
    if (!renaming) menuRef.current?.querySelector("button")?.focus();
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(position);
    if (menuRef.current) observer?.observe(menuRef.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, renaming]);

  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      const target = event.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      )
        return;
      setOpen(false);
      setRenaming(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      setRenaming(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <details className="project-row-actions" open={open}>
      <summary
        ref={triggerRef}
        aria-label={`Session actions for ${chat.title ?? "Untitled session"}`}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => {
          event.preventDefault();
          setOpen(!open);
          setRenaming(false);
        }}
      >
        ⋯
      </summary>
      {open &&
        createPortal(
          <div
            className="project-row-menu session-actions-menu"
            ref={menuRef}
            id={menuId}
          >
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
          </div>,
          document.body,
        )}
    </details>
  );
}
