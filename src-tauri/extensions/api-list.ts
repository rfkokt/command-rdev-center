// The project's "API List" worksheet (the planned endpoints, numbered) checked
// against the saved Swagger contracts (what the backend actually exposes).
// Tasks refer to its rows ("sheet list api nomor 28-32", "endpoint nomor 66").
// Column layouts differ per project, so columns are found by header name.
import {
  operations,
  operationSummary,
  type Contract,
  type Operation,
} from "./openapi-catalog";

export type ApiListRow = {
  no: string;
  method: string;
  path: string;
  endpoint: string;
  description: string;
  status: string;
  fields: Record<string, string>;
};

export type ApiListCheck = ApiListRow & {
  /** exact: method and path documented; path_differs: only a similar path is
   * documented; method_differs: the path is documented with other methods. */
  result:
    | "exact"
    | "path_differs"
    | "method_differs"
    | "missing"
    | "no_endpoint"
    | "unchecked";
  operations: ReturnType<typeof operationSummary>[];
};

/** RFC 4180 CSV, as exported by Google Sheets. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

const HEADERS = {
  no: ["no", "nomor", "id", "#", "noapi"],
  endpoint: ["endpoint", "path", "url", "api", "route", "uri", "endpointapi"],
  method: ["method", "httpmethod", "metode", "verb"],
  description: ["deskripsi", "description", "keterangan", "summary", "nama"],
  status: ["status"],
};
const METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/i;
const key = (value: string) =>
  value.toLowerCase().replace(/[^\p{L}\p{N}#]/gu, "");

/** Reads API List rows; the header is the first row naming an endpoint column. */
export function apiListRows(csv: string): ApiListRow[] {
  const table = parseCsv(csv);
  const headerIndex = table
    .slice(0, 10)
    .findIndex((row) =>
      row.some((cell) => HEADERS.endpoint.includes(key(cell))),
    );
  if (headerIndex < 0)
    throw new Error(
      "The API List worksheet has no Endpoint/Path/URL column header in its first 10 rows.",
    );
  const headers = table[headerIndex].map(key);
  const column = (names: string[]) =>
    headers.findIndex((name) => names.includes(name));
  const columns = {
    no: column(HEADERS.no),
    endpoint: column(HEADERS.endpoint),
    method: column(HEADERS.method),
    description: column(HEADERS.description),
    status: column(HEADERS.status),
  };
  const names = table[headerIndex].map((name) => name.trim());
  return table
    .slice(headerIndex + 1)
    .map((cells, index) => {
      const cell = (at: number) =>
        at < 0 ? "" : String(cells[at] ?? "").trim();
      const endpoint = cell(columns.endpoint);
      const inline = endpoint.match(METHOD)?.[1];
      const fields = Object.fromEntries(
        names
          .map((name, at) => [name, cell(at)])
          .filter(
            ([name, value], at) =>
              name && value && !Object.values(columns).includes(at),
          ),
      );
      return {
        no: cell(columns.no) || String(index + 1),
        method: (cell(columns.method) || inline || "").toUpperCase(),
        path: pathOf(endpoint.replace(METHOD, "").trim()),
        endpoint,
        description: cell(columns.description),
        status: cell(columns.status),
        fields,
      };
    })
    .filter((row) => row.endpoint || row.description);
}

/** Path part of an endpoint or URL, without query or fragment. */
export function pathOf(endpoint: string) {
  let path = endpoint.trim().split(/\s+/)[0] ?? "";
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    // Not a URL; treated as a path.
  }
  return path.replace(/[?#].*$/, "");
}

/** Comparable path: lower-case, no trailing slash, any parameter as `{}`. */
export function normalizePath(path: string) {
  return (
    pathOf(path)
      .toLowerCase()
      .replace(/\/{2,}/g, "/")
      .replace(/\{[^}]*\}|:[\w-]+|<[^>]*>|\[[^\]]*\]/g, "{}")
      .replace(/\/+$/, "") || "/"
  );
}

/** Swagger paths with and without the server's base path (e.g. /gateway/x). */
function pathKeys(item: Operation) {
  let base = "";
  try {
    base = new URL(item.contract.base_url || "").pathname.replace(/\/+$/, "");
  } catch {
    // Contracts without an absolute base URL match on their own paths.
  }
  return [normalizePath(item.path), normalizePath(`${base}${item.path}`)];
}

function editDistance(a: string, b: string) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length];
}

/** Segment-level distance: a missing/extra segment costs 1, a misspelled
 * segment its relative spelling difference (sikesa → sikeska ≈ 0.14); an
 * unrelated segment (files → jenis-premi) costs 2, so it never looks close. */
export function pathDistance(a: string, b: string) {
  const left = a.split("/").filter(Boolean);
  const right = b.split("/").filter(Boolean);
  const cost = (x: string, y: string) => {
    if (x === y) return 0;
    if (x === "{}" || y === "{}") return 1;
    const spelling = editDistance(x, y) / Math.max(x.length, y.length);
    return spelling <= 0.5 ? spelling : 2;
  };
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++)
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost(left[i - 1], right[j - 1]),
      );
    previous = current;
  }
  return previous[right.length];
}

/** Compares API List rows with the Swagger operations of all contracts. */
export function checkApiList(
  rows: ApiListRow[],
  contracts: Contract[],
): ApiListCheck[] {
  const items = operations(contracts).items.map((item) => ({
    item,
    keys: pathKeys(item),
  }));
  return rows.map((row) => {
    const check = (
      result: ApiListCheck["result"],
      found: Operation[] = [],
    ) => ({
      ...row,
      result,
      operations: found.map(operationSummary),
    });
    if (!row.path.startsWith("/")) return check("no_endpoint");
    if (!contracts.length) return check("unchecked");
    const path = normalizePath(row.path);
    const samePath = items.filter(({ keys }) => keys.includes(path));
    const exact = samePath.filter(
      ({ item }) => !row.method || item.method === row.method,
    );
    if (exact.length)
      return check(
        "exact",
        exact.map(({ item }) => item),
      );
    if (samePath.length)
      return check(
        "method_differs",
        samePath.map(({ item }) => item),
      );
    const segments = path.split("/").filter(Boolean);
    const near = items
      .filter(({ item }) => !row.method || item.method === row.method)
      .map(({ item, keys }) => ({
        item,
        distance: Math.min(...keys.map((other) => pathDistance(path, other))),
      }))
      .filter(({ distance }) => distance <= 1)
      // A path that keeps every planned segment (presensi/non-roster →
      // presensi/roster/non-roster) beats a shorter respelling.
      .map((near) => ({
        ...near,
        keepsAll: segments.every((segment) =>
          pathKeys(near.item).some((other) =>
            other.split("/").includes(segment),
          ),
        ),
      }))
      .sort(
        (a, b) =>
          Number(b.keepsAll) - Number(a.keepsAll) || a.distance - b.distance,
      );
    return near.length
      ? check(
          "path_differs",
          near.slice(0, 3).map(({ item }) => item),
        )
      : check("missing");
  });
}

/** Selects rows by number ("71"), range ("68-70") or list ("1-4, 49"). */
export function selectRows(rows: ApiListRow[], selector: string) {
  const wanted = new Set<string>();
  for (const part of selector.split(/[,\s]+/).filter(Boolean)) {
    const [from, to] = part.split(/[-–]/).map((value) => Number(value));
    if (Number.isInteger(from) && Number.isInteger(to) && to >= from)
      for (let no = from; no <= Math.min(to, from + 200); no++)
        wanted.add(String(no));
    else wanted.add(part.replace(/^#/, ""));
  }
  return rows.filter((row) => wanted.has(row.no));
}

/** API List numbers and endpoint paths a task's text refers to. Numbers
 * count only in API context ("list api nomor 1-4", "endpoint nomor 66"), never
 * task references such as "poin nomor 3". */
export function taskApiReferences(text: string) {
  const numbers = new Set<string>();
  const paths: Array<{ method: string; path: string }> = [];
  if (/\b(?:api|endpoint)\b/i.test(text))
    for (const match of text.matchAll(
      /(?<!\b(?:poin|point|task|tugas|backlog)\s+)\b(?:nomor|no\.?|nomer)\s*(\d+)(?:\s*[-–]\s*(\d+))?/gi,
    )) {
      const from = Number(match[1]);
      const to = Number(match[2] ?? match[1]);
      for (let no = from; no <= Math.min(to, from + 50); no++)
        numbers.add(String(no));
    }
  for (const match of text.matchAll(
    /(?:\b(GET|POST|PUT|PATCH|DELETE)\b['"]?\s+(?:\\\s*)?['"]?|-X\s*['"]?(GET|POST|PUT|PATCH|DELETE)['"]?[\s\\]+['"]?)?((?:https?:\/\/[^\s'"]+)?\/api\/[^\s'"),]+)/gi,
  ))
    paths.push({
      method: (match[1] || match[2] || "").toUpperCase(),
      path: pathOf(match[3]),
    });
  return { numbers: [...numbers], paths };
}

const cell = (value: string, max = 70) => {
  const text = value.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const RESULT = {
  exact: "✓ documented",
  path_differs: "⚠ path differs",
  method_differs: "⚠ method differs",
  missing: "✗ not in Swagger",
  no_endpoint: "— no endpoint",
  unchecked: "? Swagger not loaded",
};

/** Markdown table of checks; Swagger column shows the matched or nearest
 * documented operation with its contract. */
export function checksMarkdown(checks: ApiListCheck[]) {
  if (!checks.length) return "_No API List rows matched._";
  return [
    "| No | API List | Swagger | Result | Status |",
    "|---:|---|---|---|---|",
    ...checks.map((check) => {
      const swagger =
        check.operations
          .map(
            (operation) =>
              `\`${operation.method} ${operation.path}\` (${operation.contractId}${operation.operationId ? ` · ${operation.operationId}` : ""})`,
          )
          .join("<br>") || "—";
      return `| ${cell(check.no, 10)} | \`${check.method || "?"} ${cell(check.path || check.endpoint, 80)}\`<br>${cell(check.description)} | ${swagger} | ${RESULT[check.result]} | ${cell(check.status, 20) || "—"} |`;
    }),
  ].join("\n");
}

export function checkCounts(checks: ApiListCheck[]) {
  const counts = Object.fromEntries(
    Object.keys(RESULT).map((result) => [result, 0]),
  ) as Record<ApiListCheck["result"], number>;
  for (const check of checks) counts[check.result]++;
  return counts;
}
