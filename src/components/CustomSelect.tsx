import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export type SelectOption = {
  value: string;
  label: string;
  description?: string;
  badge?: string;
};

export function CustomSelect({
  value,
  options,
  onChange,
  disabled = false,
  ariaLabel,
  className = "",
  icon,
  placement = "auto",
}: {
  value: string;
  options: Array<SelectOption | [string, string]>;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  icon?: React.ReactNode;
  placement?: "auto" | "top" | "bottom";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const normalizedOptions: SelectOption[] = options.map((opt) =>
    Array.isArray(opt) ? { value: opt[0], label: opt[1] } : opt,
  );

  const selectedOption =
    normalizedOptions.find((opt) => opt.value === value) ?? normalizedOptions[0];

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setOpen((prev) => !prev);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const currentIndex = normalizedOptions.findIndex((opt) => opt.value === value);
      const nextIndex =
        event.key === "ArrowDown"
          ? (currentIndex + 1) % normalizedOptions.length
          : (currentIndex - 1 + normalizedOptions.length) % normalizedOptions.length;
      onChange(normalizedOptions[nextIndex].value);
    }
  };

  return (
    <div
      ref={rootRef}
      className={`opendots-select ${className} ${open ? "is-open" : ""} ${
        disabled ? "is-disabled" : ""
      } placement-${placement}`}
    >
      <button
        type="button"
        className="opendots-select-trigger"
        onClick={() => !disabled && setOpen((prev) => !prev)}
        onKeyDown={handleKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
      >
        {icon && <span className="opendots-select-icon">{icon}</span>}
        <span className="opendots-select-value">
          {selectedOption ? selectedOption.label : value}
        </span>
        <span className="opendots-select-chevron" aria-hidden="true">
          <svg
            width="10"
            height="6"
            viewBox="0 0 10 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m1 1 4 4 4-4" />
          </svg>
        </span>
      </button>

      {open && (
        <div
          ref={menuRef}
          className="opendots-select-menu"
          role="listbox"
          aria-label={ariaLabel}
        >
          {normalizedOptions.map((option) => {
            const isSelected = option.value === value;
            return (
              <button
                type="button"
                key={option.value}
                className={`opendots-select-option ${isSelected ? "active" : ""}`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                role="option"
                aria-selected={isSelected}
              >
                <div className="opendots-select-option-text">
                  <span className="opendots-select-option-label">{option.label}</span>
                  {option.description && (
                    <small className="opendots-select-option-desc">
                      {option.description}
                    </small>
                  )}
                </div>
                {isSelected && (
                  <span className="opendots-select-check" aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default CustomSelect;
