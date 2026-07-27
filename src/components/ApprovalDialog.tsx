import { useState } from "react";
import type { ApprovalRequest } from "../lib/rpc";

export default function ApprovalDialog({
  req,
  onRespond,
}: {
  req: ApprovalRequest;
  onRespond: (payload: Record<string, unknown>) => void;
}) {
  const [inputVal, setInputVal] = useState(req.prefill ?? "");

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}>
      <div className="surface-card" style={{ padding: "var(--spacing-xl)", minWidth: 400, maxWidth: 600 }}>
        <h3 className="display-sm">{req.title ? req.title.toUpperCase() : "APPROVAL REQUIRED"}</h3>
        {req.message && <p className="body-md" style={{ marginTop: "var(--spacing-md)" }}>{req.message}</p>}

        {req.method === "select" && req.options && (
          <div style={{ display: "flex", gap: "var(--spacing-md)", marginTop: "var(--spacing-xl)", flexWrap: "wrap" }}>
            {req.options.map((opt) => (
              <button
                key={opt}
                onClick={() => onRespond({ type: "extension_ui_response", id: req.id, value: opt })}
                className="button-primary"
              >
                {opt.toUpperCase()}
              </button>
            ))}
            <button onClick={() => onRespond({ type: "extension_ui_response", id: req.id, cancelled: true })} className="button-primary" style={{ marginLeft: "auto" }}>CANCEL</button>
          </div>
        )}

        {req.method === "confirm" && (
          <div style={{ display: "flex", gap: "var(--spacing-md)", marginTop: "var(--spacing-xl)" }}>
            <button onClick={() => onRespond({ type: "extension_ui_response", id: req.id, confirmed: false })} className="button-primary">BLOCK</button>
            <button onClick={() => onRespond({ type: "extension_ui_response", id: req.id, confirmed: true })} className="button-primary">ALLOW</button>
            <button onClick={() => onRespond({ type: "extension_ui_response", id: req.id, cancelled: true })} className="button-primary" style={{ marginLeft: "auto" }}>CANCEL</button>
          </div>
        )}

        {(req.method === "input" || req.method === "editor") && (
          <div style={{ marginTop: "var(--spacing-xl)", display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
            {req.method === "input" ? (
              <input value={inputVal} placeholder={req.placeholder} onChange={(e) => setInputVal(e.target.value)} className="text-input body-md" style={{ padding: "var(--spacing-xs) 0" }} autoFocus />
            ) : (
              <textarea value={inputVal} onChange={(e) => setInputVal(e.target.value)} rows={8} className="text-input body-md" style={{ padding: "var(--spacing-xs) 0", fontFamily: "var(--font-mono)" }} autoFocus />
            )}
            <div style={{ display: "flex", gap: "var(--spacing-md)" }}>
              <button onClick={() => onRespond({ type: "extension_ui_response", id: req.id, value: inputVal })} className="button-primary">SUBMIT</button>
              <button onClick={() => onRespond({ type: "extension_ui_response", id: req.id, cancelled: true })} className="button-primary">CANCEL</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
