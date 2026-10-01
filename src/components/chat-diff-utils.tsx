export type DiffSide = {
  number?: number;
  text: string;
  kind: "same" | "removed" | "added" | "empty";
};
export type DiffRow = { before: DiffSide; after: DiffSide };

export function sideBySide(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0,
    newLine = 0;
  const removed: DiffSide[] = [],
    added: DiffSide[] = [];
  const flush = () => {
    const count = Math.max(removed.length, added.length);
    for (let i = 0; i < count; i++)
      rows.push({
        before: removed[i] ?? { text: "", kind: "empty" },
        after: added[i] ?? { text: "", kind: "empty" },
      });
    removed.length = added.length = 0;
  };
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      flush();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (
      /^(diff --git|index |--- |\+\+\+ )/.test(line) ||
      (!oldLine && !newLine)
    )
      continue;
    if (line.startsWith("-"))
      removed.push({ number: oldLine++, text: line.slice(1), kind: "removed" });
    else if (line.startsWith("+"))
      added.push({ number: newLine++, text: line.slice(1), kind: "added" });
    else {
      flush();
      const text = line.startsWith(" ") ? line.slice(1) : line;
      rows.push({
        before: { number: oldLine++, text, kind: "same" },
        after: { number: newLine++, text, kind: "same" },
      });
    }
  }
  flush();
  return rows;
}

export function splitPatch(patch: string) {
  const rows = sideBySide(patch);
  return rows.map((row, index) => (
    <div className="split-row" key={index}>
      {[row.before, row.after].map((side, si) => (
        <div className={`diff-line ${side.kind}`} key={si}>
          <span>{side.number ?? ""}</span>
          <code>{side.text || " "}</code>
        </div>
      ))}
    </div>
  ));
}
