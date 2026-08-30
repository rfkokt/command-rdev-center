import { useMemo, useRef, useState } from "react";
import { useModalFocus } from "./useModalFocus";

export default function ModelPicker({
  value,
  models,
  onChange,
  onClose,
}: {
  value: string;
  models: string[];
  onChange: (model: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () =>
      models.filter((model) =>
        model.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [models, query],
  );
  const [index, setIndex] = useState(Math.max(0, models.indexOf(value)));
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useModalFocus<HTMLElement>(onClose);

  function choose(model: string) {
    onChange(model);
    onClose();
  }

  return (
    <div className="model-picker-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="model-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Select model"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <span>MODEL CATALOG</span>
          <button onClick={onClose} aria-label="Close model picker">
            ESC
          </button>
        </header>
        <div className="model-search">
          <span>›</span>
          <input
            ref={searchRef}
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              else if (
                (event.key === "ArrowDown" || event.key === "ArrowUp") &&
                filtered.length
              ) {
                event.preventDefault();
                setIndex(
                  (current) =>
                    (current +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      filtered.length) %
                    filtered.length,
                );
              } else if (event.key === "Enter" && filtered[index]) {
                event.preventDefault();
                choose(filtered[index]);
              }
            }}
            placeholder="FILTER PROVIDER OR MODEL…"
          />
        </div>
        <div className="model-list" role="listbox">
          <button
            className={!value ? "active" : ""}
            onClick={() => choose("")}
            role="option"
            aria-selected={!value}
          >
            <span className="model-arrow">{!value ? "→" : ""}</span>
            <strong>App default</strong>
            <small>[default]</small>
            <b>{!value ? "✓" : ""}</b>
          </button>
          {filtered.map((model, itemIndex) => {
            const slash = model.indexOf("/");
            const provider = slash === -1 ? "default" : model.slice(0, slash);
            const name = slash === -1 ? model : model.slice(slash + 1);
            return (
              <button
                key={model}
                className={itemIndex === index ? "active" : ""}
                onMouseEnter={() => setIndex(itemIndex)}
                onClick={() => choose(model)}
                role="option"
                aria-selected={model === value}
              >
                <span className="model-arrow">
                  {itemIndex === index ? "→" : ""}
                </span>
                <strong>{name}</strong>
                <small>[{provider}]</small>
                <b>{model === value ? "✓" : ""}</b>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <div className="model-empty">NO MATCHING MODELS</div>
          )}
        </div>
        <footer>
          <span>
            {filtered.length
              ? `${Math.min(index + 1, filtered.length)}/${filtered.length}`
              : "0/0"}
          </span>
          <span>↑↓ NAVIGATE · ENTER SELECT</span>
        </footer>
      </section>
    </div>
  );
}
