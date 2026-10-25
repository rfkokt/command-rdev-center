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

/** Unsent review comments survive closing the diff and restarting the app. */
const storageKey = (chatId: string) => `kern:diff-comments:${chatId}`;
export function loadDiffComments(chatId: string): DiffComment[] {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(chatId)) ?? "[]");
    return Array.isArray(value)
      ? value.filter(
          (comment): comment is DiffComment =>
            !!comment &&
            ["id", "path", "line", "text"].every(
              (field) => typeof comment[field] === "string",
            ),
        )
      : [];
  } catch {
    return [];
  }
}
export function saveDiffComments(chatId: string, comments: DiffComment[]) {
  try {
    if (comments.length)
      localStorage.setItem(storageKey(chatId), JSON.stringify(comments));
    else localStorage.removeItem(storageKey(chatId));
  } catch {
    /* Comments still live in memory for this session. */
  }
}
