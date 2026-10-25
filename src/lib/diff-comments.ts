export type DiffComment = {
  id: string;
  path: string;
  line: string;
  text: string;
};
export function formatDiffComments(comments: DiffComment[]) {
  return `Please address these diff review comments:\n\n${comments.map((comment) => `${JSON.stringify({ path: comment.path, line: comment.line })}\n${comment.text}`).join("\n\n")}`;
}
export function diffLineLocations(header: string, lines: string[]) {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(header);
  let oldLine = Number(match?.[1] ?? 1),
    newLine = Number(match?.[2] ?? 1);
  return lines.map((text) => {
    if (text.startsWith("\\")) return "metadata";
    if (text.startsWith("-")) return `old:${oldLine++}`;
    if (text.startsWith("+")) return `new:${newLine++}`;
    const location = `new:${newLine++}`;
    oldLine++;
    return location;
  });
}
