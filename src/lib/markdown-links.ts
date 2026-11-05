export type FileLink = { path: string; line?: number };

export function parseFileLink(href: string): FileLink | null {
  if (!href || href.startsWith("#") || href.startsWith("//")) return null;
  let path = href;
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return null;
      path = url.pathname + url.hash;
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(path)) {
    return null;
  }
  const location = path.match(
    /(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?(?:-L?\d+)?)$/i,
  );
  const line = location ? Number(location[1] || location[2]) : undefined;
  if (location) path = path.slice(0, location.index);
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (!path || /[\x00-\x1f\\?#]/.test(path) || path.startsWith("//"))
    return null;
  return { path, ...(line && line > 0 ? { line } : {}) };
}

export function fileLinkRequest(link: FileLink, cwd?: string) {
  if (!link.path.startsWith("/") && (!cwd || !cwd.startsWith("/")))
    throw new Error(
      "A project folder is required to open this relative file link.",
    );
  const parts: string[] = [];
  const absolute = link.path.startsWith("/")
    ? link.path
    : `${cwd}/${link.path}`;
  for (const part of absolute.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  const fileName = parts.pop();
  if (!fileName) throw new Error("The link does not point to a file.");
  // The existing backend still verifies registration, canonical paths and size.
  return { projectPath: `/${parts.join("/")}`, fileName };
}
