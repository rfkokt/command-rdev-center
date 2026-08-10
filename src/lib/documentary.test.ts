import { describe, expect, it } from "vitest";
import { canGenerateDocumentary, validateBrief, validateDocumentary, type DocumentaryPackage } from "./documentary";
const base: DocumentaryPackage = { version: 1, id: "one", topic: "Topic", language: "English", audience: "Creators", durationSeconds: 30, state: "editing", sources: [], scenes: [] };
describe("documentary view model", () => {
  it("requires a complete brief and fixed duration", () => {
    expect(validateBrief({ topic: "", language: "", audience: "", durationSeconds: 15 })).toHaveLength(4);
  });
  it("blocks generation until a source is approved", () => {
    expect(canGenerateDocumentary({ ...base, sources: [{ id: "s", url: "", canonicalUrl: "", title: "", cited: true, approved: false }] })).toBe(false);
    expect(canGenerateDocumentary({ ...base, sources: [{ id: "s", url: "", canonicalUrl: "", title: "", cited: true, approved: true }] })).toBe(true);
  });
  it("requires verified claims to retain approved provenance", () => {
    expect(validateDocumentary({ ...base, script: { title: "", hook: "", narration: "", claims: [{ id: "c", text: "Fact", sourceIds: [], status: "verified" }] } })).toContain('Verified claim "Fact" needs an approved source.');
  });
});
