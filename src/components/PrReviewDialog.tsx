import { useEffect, useState } from "react";
import { useModalFocus } from "./useModalFocus";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_REVIEW_TEMPLATE,
  REVIEW_TEMPLATE_KEY,
  type PreparedReview,
} from "../lib/pr-review";

export default function PrReviewDialog({
  request,
  onStart,
  onClose,
  onToast,
}: {
  request: { path: string; repositoryPath: string; account: string };
  onStart: (
    review: PreparedReview,
    id: string,
    harness: string,
    model: string,
  ) => void;
  onClose: () => void;
  onToast: (message: string) => void;
}) {
  const dialogRef = useModalFocus<HTMLElement>(() => {
    if (!busy) onClose();
  });
  const key = `kern:pr-review-choice:${request.repositoryPath}`;
  const [choice, setChoice] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(key) || "null") as {
        harness: string;
        model: string;
      } | null;
    } catch {
      return null;
    }
  });
  const [harnesses, setHarnesses] = useState<
    Array<{ id: string; name: string; installed: boolean }>
  >([]);
  const [model, setModel] = useState(choice?.model ?? "");
  const [harness, setHarness] = useState(choice?.harness ?? "claude-code");
  const [models, setModels] = useState<string[]>([]);
  const [account, setAccount] = useState(request.account);
  const [fix, setFix] = useState(true);
  const [postComment, setPostComment] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void invoke<typeof harnesses>("list_harnesses")
      .then(setHarnesses)
      .catch((e) => setError(String(e)));
    void invoke<string[]>("list_available_models")
      .then(setModels)
      .catch((e) => onToast(`Reviewer models: ${String(e)}`));
  }, []);
  async function start() {
    setBusy(true);
    setError("");
    try {
      let template = DEFAULT_REVIEW_TEMPLATE;
      try {
        template = localStorage.getItem(REVIEW_TEMPLATE_KEY) || template;
      } catch {
        /* Use the built-in template when storage is disabled. */
      }
      const id = `review-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const review = await invoke<PreparedReview>("prepare_pr_review", {
        repositoryPath: request.path,
        account,
        slug: id,
        fix,
        postComment,
        template,
      });
      const next = { harness, model };
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        onToast("Reviewer choice could not be remembered.");
      }
      setChoice(next);
      onStart(review, id, harness, model);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="model-picker-backdrop">
      <section
        ref={dialogRef}
        className="model-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Review PR"
      >
        <h3>Review PR</h3>
        <label>
          GitHub account
          <input value={account} onChange={(e) => setAccount(e.target.value)} />
        </label>
        <label>
          Reviewer agent
          <select value={harness} onChange={(e) => setHarness(e.target.value)}>
            {harnesses.map((h) => (
              <option key={h.id} value={h.id} disabled={!h.installed}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reviewer model
          <input
            list="pr-review-models"
            placeholder="Agent default"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          <datalist id="pr-review-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <label>
          Mode
          <select
            value={fix ? "fix" : "report"}
            onChange={(e) => setFix(e.target.value === "fix")}
          >
            <option value="fix">Fix &amp; push</option>
            <option value="report">Report only</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={postComment}
            onChange={(e) => setPostComment(e.target.checked)}
          />
          Post summary as PR comment
        </label>
        <p>
          One new chat, isolated worktree, PR evidence only. Never pushes to
          main or force-pushes.
        </p>
        {error && <pre role="alert">{error}</pre>}
        <button disabled={busy} onClick={onClose}>
          Cancel
        </button>
        <button
          disabled={
            busy ||
            !account.trim() ||
            !harnesses.some((h) => h.id === harness && h.installed)
          }
          onClick={() => void start()}
        >
          {busy
            ? "Preparing…"
            : `Review with ${harnesses.find((h) => h.id === harness)?.name ?? harness}`}
        </button>
      </section>
    </div>
  );
}
