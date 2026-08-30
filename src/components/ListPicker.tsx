import { useEffect, useRef, useState } from "react";

type Props = {
  label: string;
  value: string;
  options: string[];
  allLabel?: string;
  includeAll?: boolean;
  formatOption?: (value: string) => string;
  onChange: (value: string) => void;
};

export default function ListPicker({
  label,
  value,
  options,
  allLabel = "All",
  includeAll = true,
  formatOption = (option) => option,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLLabelElement>(null);
  const items = includeAll ? ["", ...options] : options;

  useEffect(() => {
    function close(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  function choose(next: string) {
    onChange(next);
    setOpen(false);
  }

  return (
    <label className="list-picker-field" ref={rootRef}>
      {label}
      <button
        type="button"
        className="list-picker-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {value ? formatOption(value) : allLabel}
        <span>{open ? "⌃" : "⌄"}</span>
      </button>
      {open && (
        <div className="list-picker-menu" role="listbox">
          {items.map((option) => (
            <button
              type="button"
              key={option || "__all"}
              className={option === value ? "active" : ""}
              onClick={() => choose(option)}
              role="option"
              aria-selected={option === value}
            >
              <span>{option ? formatOption(option) : allLabel}</span>
              {option === value && <b>✓</b>}
            </button>
          ))}
        </div>
      )}
    </label>
  );
}
