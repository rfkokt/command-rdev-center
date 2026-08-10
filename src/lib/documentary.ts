export type DocumentaryState = "brief" | "researching" | "reviewing_sources" | "generating" | "editing" | "ready" | "failed";
export type SourceSnapshot = { id: string; url: string; canonicalUrl: string; title: string; cited: boolean; approved: boolean };
export type Claim = { id: string; text: string; sourceIds: string[]; status: "verified" | "uncertain" };
export type AssetKind = "background" | "subject" | "prop" | "overlay" | "narration" | "music" | "sfx";
export type AssetNeed = { id: string; kind: AssetKind; description: string; orientation: "portrait" | "landscape" | "square" | "transparent" | "audio"; minimumResolution?: string; required: boolean; purpose: string; rightsReminder: string };
export type Scene = { id: string; order: number; voiceover: string; claimIds: string[]; onScreenText: string[]; emotionalBeat: string; visualConcept: string; motionSuggestion: "paper_entrance" | "drift" | "parallax" | "hard_cut"; assetNeeds: AssetNeed[] };
export type DocumentaryPackage = { version: 1; id: string; topic: string; language: string; audience: string; durationSeconds: 30 | 45 | 60; state: DocumentaryState; researchRunId?: string; sources: SourceSnapshot[]; script?: { title: string; hook: string; narration: string; claims: Claim[] }; scenes: Scene[]; error?: string };
export type DocumentaryData = { packages: DocumentaryPackage[]; warnings: string[] };
export type DocumentaryBrief = Omit<Pick<DocumentaryPackage, "topic" | "language" | "audience" | "durationSeconds">, "durationSeconds"> & { durationSeconds: number };

export function validateBrief(brief: Partial<DocumentaryBrief>): string[] {
  const errors: string[] = [];
  if (!brief.topic?.trim()) errors.push("Enter a topic.");
  if (!brief.language?.trim()) errors.push("Enter a language.");
  if (!brief.audience?.trim()) errors.push("Enter an audience.");
  if (![30, 45, 60].includes(Number(brief.durationSeconds))) errors.push("Choose a duration of 30, 45, or 60 seconds.");
  return errors;
}

export function approvedSources(pkg: DocumentaryPackage) { return pkg.sources.filter((source) => source.approved); }
export function canGenerateDocumentary(pkg: DocumentaryPackage) { return approvedSources(pkg).length > 0; }
export function assetChecklist(pkg: DocumentaryPackage) { return pkg.scenes.map((scene) => ({ scene, assets: scene.assetNeeds })); }

export function validateDocumentary(pkg: DocumentaryPackage): string[] {
  const errors = validateBrief(pkg);
  const claims = new Map(pkg.script?.claims.map((claim) => [claim.id, claim]) ?? []);
  const approved = new Set(approvedSources(pkg).map((source) => source.id));
  if (pkg.script && (pkg.scenes.length < 5 || pkg.scenes.length > 8)) errors.push("A script needs 5–8 scenes.");
  for (const claim of claims.values()) if (claim.status === "verified" && !claim.sourceIds.some((id) => approved.has(id))) errors.push(`Verified claim "${claim.text}" needs an approved source.`);
  for (const scene of pkg.scenes) {
    if (!scene.voiceover.trim()) errors.push(`Scene ${scene.order} needs voice-over.`);
    if (scene.claimIds.some((id) => !claims.has(id))) errors.push(`Scene ${scene.order} references an unknown claim.`);
    if (!scene.assetNeeds.some((asset) => asset.required && asset.kind !== "narration")) errors.push(`Scene ${scene.order} needs a required visual asset.`);
  }
  return errors;
}
