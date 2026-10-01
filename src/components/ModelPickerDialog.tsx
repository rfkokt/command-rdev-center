import { useEffect, useRef, useState, type Ref } from "react";

export default function ModelPickerDialog({
  models,
  currentModel,
  dialogRef,
  onClose,
  onSelect,
}: {
  models: string[];
  currentModel: string;
  dialogRef: Ref<HTMLElement>;
  onClose: () => void;
  onSelect: (model: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(() =>
    Math.max(0, models.indexOf(currentModel)),
  );
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
  const filteredModels = models.filter((model) =>
    model.toLowerCase().includes(query.trim().toLowerCase()),
  );
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
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setIndex(
                  (current) =>
                    (current +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      filteredModels.length) %
                    filteredModels.length,
                );
              } else if (event.key === "Enter" && filteredModels[index]) {
                event.preventDefault();
                onSelect(filteredModels[index]);
              }
            }}
            placeholder="FILTER PROVIDER OR MODEL…"
          />
        </div>
        <div className="model-list" role="listbox">
          {filteredModels.map((model, itemIndex) => {
            const slash = model.indexOf("/");
            const provider = slash === -1 ? "default" : model.slice(0, slash);
            const name = slash === -1 ? model : model.slice(slash + 1);
            return (
              <button
                key={model}
                className={itemIndex === index ? "active" : ""}
                onMouseEnter={() => setIndex(itemIndex)}
                onClick={() => onSelect(model)}
                role="option"
                aria-selected={model === currentModel}
              >
                <span className="model-arrow">
                  {itemIndex === index ? "→" : ""}
                </span>
                <strong>{name}</strong>
                <small>[{provider}]</small>
                <b>{model === currentModel ? "✓" : ""}</b>
              </button>
            );
          })}
          {filteredModels.length === 0 && (
            <div className="model-empty">NO MATCHING MODELS</div>
          )}
        </div>
        <footer>
          <span>
            {filteredModels.length
              ? `${index + 1}/${filteredModels.length}`
              : "0/0"}
          </span>
          <span>↑↓ NAVIGATE · ENTER SELECT</span>
        </footer>
      </section>
    </div>
  );
}
