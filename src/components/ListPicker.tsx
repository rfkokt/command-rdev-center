import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Props = {
  label: string;
  value: string;
  options: string[];
  allLabel?: string;
  includeAll?: boolean;
  onChange: (value: string) => void;
  ariaLabel?: string;
};

export default function ListPicker({ label, value, options, allLabel = "All", includeAll = true, onChange, ariaLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const rootRef = useRef<HTMLLabelElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const items = includeAll ? ["", ...options] : options;

  useEffect(() => {
    function close(event: MouseEvent) {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const menuHeight = Math.min(items.length * 36 + 10, 260);
    const below = window.innerHeight - rect.bottom >= menuHeight;
    setMenuStyle({ position: "fixed", left: rect.left, top: below ? rect.bottom + 4 : Math.max(4, rect.top - menuHeight - 4), width: rect.width });
  }, [open, items.length]);

  function choose(next: string) {
    onChange(next);
    setOpen(false);
  }

  return <label className="list-picker-field" ref={rootRef}>{label}
    <button ref={triggerRef} type="button" className="list-picker-trigger" onClick={() => setOpen((current) => !current)} aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}>{value || allLabel}<span>{open ? "⌃" : "⌄"}</span></button>
    {open && createPortal(<div ref={menuRef} className="list-picker-menu list-picker-menu-portal" style={menuStyle} role="listbox">
      {items.map((option) => <button type="button" key={option || "__all"} className={option === value ? "active" : ""} onClick={() => choose(option)} role="option" aria-selected={option === value}><span>{option || allLabel}</span>{option === value && <b>✓</b>}</button>)}
    </div>, document.body)}
  </label>;
}
