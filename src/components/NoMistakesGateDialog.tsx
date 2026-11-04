import { useState } from "react";
import {
  askUserFindings,
  type NoMistakesDecision,
  type NoMistakesGate,
} from "../lib/no-mistakes-gate";
import { useModalFocus } from "./useModalFocus";

export default function NoMistakesGateDialog({
  gate,
  onDecide,
  onDismiss,
}: {
  gate: NoMistakesGate;
  onDecide: (decision: NoMistakesDecision) => void;
  onDismiss: () => void;
}) {
  const findings = askUserFindings(gate);
  const [selected, setSelected] = useState(
    () => new Set(findings.map((finding) => finding.id)),
  );
  const [instructions, setInstructions] = useState("");
  const dialogRef = useModalFocus<HTMLElement>(onDismiss);
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const fixIds = findings
    .map((finding) => finding.id)
    .filter((id) => selected.has(id));

  return (
    <div className="approval-backdrop">
      <section
        ref={dialogRef}
        className="approval-dialog no-mistakes-gate"
        role="dialog"
        aria-modal="true"
        aria-labelledby="no-mistakes-gate-title"
        tabIndex={-1}
      >
        <header>
          <small>NO-MISTAKES · {gate.step.toUpperCase()} GATE</small>
          <h2 id="no-mistakes-gate-title">
            {findings.length === 1
              ? "1 finding needs your decision"
              : `${findings.length} findings need your decision`}
          </h2>
        </header>
        <p className="approval-message">
          The reviewer flagged changes that touch product behavior or your
          stated intent. Select the findings to fix, or approve them as
          intended.
        </p>
        <ul className="no-mistakes-findings">
          {findings.map((finding) => (
            <li key={finding.id}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.has(finding.id)}
                  onChange={() => toggle(finding.id)}
                />
                <span className="no-mistakes-finding-meta">
                  <code>{finding.id}</code>
                  {finding.severity && <em>{finding.severity}</em>}
                  {finding.file && (
                    <span>
                      {finding.file}
                      {finding.line ? `:${finding.line}` : ""}
                    </span>
                  )}
                </span>
              </label>
              <p>{finding.description}</p>
            </li>
          ))}
        </ul>
        <label className="approval-input">
          <span>FIX GUIDANCE (OPTIONAL)</span>
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={3}
            placeholder="How should the selected findings be fixed?"
          />
        </label>
        <footer>
          <button className="approval-cancel" onClick={onDismiss}>
            Later
          </button>
          <button
            className="approval-cancel"
            onClick={() => onDecide({ action: "skip" })}
          >
            Skip step
          </button>
          <button
            className="approval-cancel"
            onClick={() => onDecide({ action: "approve" })}
          >
            Approve as is
          </button>
          <button
            className="approval-submit"
            disabled={!fixIds.length}
            onClick={() =>
              onDecide({ action: "fix", findingIds: fixIds, instructions })
            }
          >
            Fix selected →
          </button>
        </footer>
      </section>
    </div>
  );
}
