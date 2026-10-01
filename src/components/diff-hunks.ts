/**
 * Pure helpers for hunk-level diff review.
 *
 * The worktree diff patches produced by the backend can contain several
 * concatenated `git diff` outputs for the same file (committed + staged +
 * unstaged are joined with "\n"), so parsing is done per `diff --git`
 * section: each section keeps its own file header plus its hunks.
 */

export type DiffHunk = {
  /** Stable id: `s<section>h<hunk>`, e.g. "s0h1". */
  id: string;
  /** The `@@ -a,b +c,d @@` header line (with any trailing section text). */
  header: string;
  /** Hunk body lines: ` `/`+`/`-`/`\` lines. */
  lines: string[];
};

export type DiffSection = {
  /** `diff --git` / `index` / `---` / `+++` lines for this section. */
  fileHeader: string[];
  hunks: DiffHunk[];
};

const HEADER_PREFIXES = ["diff --git ", "index ", "--- ", "+++ "];

function isFileHeader(line: string): boolean {
  return HEADER_PREFIXES.some((prefix) => line.startsWith(prefix));
}

/**
 * Split a (possibly concatenated) unified diff patch into sections, each
 * with its file header and hunks. Returns an empty array for empty patches.
 */
export function parseDiffSections(patch: string): DiffSection[] {
  const sections: DiffSection[] = [];
  let current: DiffSection | null = null;
  let currentHunk: DiffHunk | null = null;

  const pushHunk = () => {
    if (currentHunk && current) {
      current.hunks.push(currentHunk);
      currentHunk = null;
    }
  };

  for (const rawLine of patch.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.startsWith("diff --git ")) {
      pushHunk();
      current = { fileHeader: [line], hunks: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    if (isFileHeader(line)) {
      pushHunk();
      current.fileHeader.push(line);
      continue;
    }
    if (line.startsWith("@@")) {
      pushHunk();
      const sectionIndex = sections.length - 1;
      currentHunk = {
        id: `s${sectionIndex}h${current.hunks.length}`,
        header: line,
        lines: [],
      };
      continue;
    }
    if (currentHunk) {
      currentHunk.lines.push(rawLine);
    }
    // Lines before the first @@ of a section (shouldn't happen in git
    // output) are ignored.
  }
  pushHunk();
  // Drop trailing empty body lines (e.g. from a final newline) so the
  // rebuilt patch round-trips cleanly through `git apply`.
  for (const section of sections) {
    for (const hunk of section.hunks) {
      while (
        hunk.lines.length > 0 &&
        hunk.lines[hunk.lines.length - 1] === ""
      ) {
        hunk.lines.pop();
      }
    }
  }
  return sections.filter(
    (section) => section.hunks.length > 0 || section.fileHeader.length > 0,
  );
}

/**
 * Build a standalone unified-diff patch containing exactly one hunk, ready
 * to be sent to the `reject_hunks` / `apply_hunks` commands.
 */
export function buildHunkPatch(fileHeader: string[], hunk: DiffHunk): string {
  return [...fileHeader, hunk.header, ...hunk.lines].join("\n") + "\n";
}

/** Flatten sections into a single hunk list for rendering. */
export function flattenHunks(sections: DiffSection[]): Array<{
  section: number;
  fileHeader: string[];
  hunk: DiffHunk;
}> {
  return sections.flatMap((section, index) =>
    section.hunks.map((hunk) => ({
      section: index,
      fileHeader: section.fileHeader,
      hunk,
    })),
  );
}
