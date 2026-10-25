import { useEffect, useState } from "react";
import { useModalFocus } from "./useModalFocus";
export type PaletteAction = { id: string; label: string; run: () => void };
export default function CommandPalette({
  actions,
  onClose,
  search,
}: {
  actions: PaletteAction[];
  onClose: () => void;
  search?: (query: string) => Promise<PaletteAction[]>;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [results, setResults] = useState<PaletteAction[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setResults([]);
    setError("");
    const timer = window.setTimeout(() => {
      if (!search || query.trim().length < 2) return;
      void search(query)
        .then((items) => {
          if (active) setResults(items);
        })
        .catch(() => {
          if (active) setError("Session search unavailable");
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query, search]);
  const root = useModalFocus<HTMLDivElement>(onClose);
  const matches = [
    ...actions.filter((action) =>
      action.label.toLowerCase().includes(query.toLowerCase()),
    ),
    ...results,
  ];
  useEffect(() => setIndex(0), [query]);
  const choose = (action?: PaletteAction) => {
    if (action) {
      onClose();
      action.run();
    }
  };
  return (
    <div
      className="model-picker-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="model-picker"
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <input
          autoFocus
          aria-label="Search commands and chats"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((current) =>
                matches.length
                  ? (current +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      matches.length) %
                    matches.length
                  : 0,
              );
            }
            if (event.key === "Enter") {
              event.preventDefault();
              choose(matches[index]);
            }
          }}
        />
        <div className="model-list" role="listbox" aria-label="Commands">
          {matches.map((action, i) => (
            <button
              key={action.id}
              className={`model-option ${i === index ? "selected" : ""}`}
              role="option"
              aria-selected={i === index}
              onClick={() => choose(action)}
            >
              {i === index ? "› " : ""}
              {action.label}
            </button>
          ))}
          {!matches.length && <p>No matching commands or chats</p>}
        </div>
        <small>
          Cmd/Ctrl+K: palette · Ctrl+L: model · Ctrl+P: cycle model · Shift+Tab:
          thinking · Escape: close
        </small>
        {error && <p role="alert">{error}</p>}
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
