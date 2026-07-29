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
  const respond = (payload: Record<string, unknown>) => onRespond({ type: "extension_ui_response", id: req.id, ...payload });

  return (
    <div className="approval-backdrop" role="dialog" aria-modal="true" aria-labelledby="approval-title" aria-describedby={req.message ? "approval-message" : undefined}>
      <section className="approval-dialog">
        <header>
          <small>AGENT · FOLLOW-UP</small>
          <h2 id="approval-title">{req.title ?? "Input required"}</h2>
        </header>

        {req.message && <p id="approval-message" className="approval-message">{req.message}</p>}

        {req.method === "select" && req.options && (
          <div className="approval-options">
            {req.options.map((opt, index) => (
              <button key={opt} onClick={() => respond({ value: opt })}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                {opt}
              </button>
            ))}
          </div>
        )}

        {req.method === "confirm" && (
          <div className="approval-options approval-confirm">
            <button onClick={() => respond({ confirmed: false })}><span>×</span>Block</button>
            <button className="approval-primary" onClick={() => respond({ confirmed: true })}><span>✓</span>Allow</button>
          </div>
        )}

        {(req.method === "input" || req.method === "editor") && (
          <label className="approval-input">
            <span>YOUR RESPONSE</span>
            {req.method === "input" ? (
              <input
                value={inputVal}
                placeholder={req.placeholder}
                onChange={(e) => setInputVal(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && respond({ value: inputVal })}
                autoFocus
              />
            ) : (
              <textarea value={inputVal} placeholder={req.placeholder} onChange={(e) => setInputVal(e.target.value)} rows={8} autoFocus />
            )}
          </label>
        )}

        <footer>
          {(req.method === "input" || req.method === "editor") && (
            <button className="approval-submit" onClick={() => respond({ value: inputVal })}>Submit response →</button>
          )}
          <button className="approval-cancel" onClick={() => respond({ cancelled: true })}>Cancel</button>
        </footer>
      </section>
    </div>
  );
}
