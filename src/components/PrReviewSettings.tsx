import { useState } from "react";
import { DEFAULT_REVIEW_TEMPLATE, REVIEW_TEMPLATE_KEY } from "../lib/pr-review";
export default function PrReviewSettings() {
  const [template, setTemplate] = useState(
    () => localStorage.getItem(REVIEW_TEMPLATE_KEY) || DEFAULT_REVIEW_TEMPLATE,
  );
  const [error, setError] = useState("");
  return (
    <section className="kset-group">
      <h3>PR reviewer</h3>
      <label htmlFor="pr-review-template">Review instructions</label>
      <textarea
        id="pr-review-template"
        value={template}
        maxLength={32000}
        rows={10}
        onChange={(e) => setTemplate(e.target.value)}
      />
      <button
        onClick={() => {
          try {
            localStorage.setItem(REVIEW_TEMPLATE_KEY, template);
            setError("Saved");
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        Save review template
      </button>
      <p role="status">{error}</p>
    </section>
  );
}
