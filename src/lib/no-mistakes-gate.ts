// no-mistakes prints token-efficient TOON from `no-mistakes axi run|respond|status`.
// A gate that carries `ask-user` findings needs a user decision, so Kern lifts
// it out of the agent's tool output into a dialog instead of relying on the
// agent to relay it in prose.

export type NoMistakesFinding = {
  id: string;
  severity: string;
  file: string;
  line: string;
  action: string;
  description: string;
};

export type NoMistakesGate = {
  step: string;
  findings: NoMistakesFinding[];
};

export type NoMistakesDecision =
  | { action: "fix"; findingIds: string[]; instructions: string }
  | { action: "approve" }
  | { action: "skip" };

function unquote(value: string) {
  const text = value.trim();
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"'))
    return text;
  return text
    .slice(1, -1)
    .replace(/\\(["\\nrt])/g, (_, char: string) =>
      char === "n" ? "\n" : char === "r" ? "\r" : char === "t" ? "\t" : char,
    );
}

// Splits one TOON tabular row on commas outside quoted values.
function splitRow(row: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (quoted && char === "\\" && i + 1 < row.length) {
      current += char + row[++i];
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === "," && !quoted) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

export function parseNoMistakesGate(output: string): NoMistakesGate | null {
  const lines = output.replace(/\r\n?/g, "\n").split("\n");
  let gateIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^outcome:/.test(lines[i])) return null;
    if (/^gate:\s*\S/.test(lines[i])) {
      gateIndex = i;
      break;
    }
  }
  if (gateIndex < 0) return null;
  const step = unquote(lines[gateIndex].replace(/^gate:/, ""));
  for (let i = gateIndex + 1; i < lines.length; i++) {
    const header = lines[i].match(/^findings\[(\d+)\]\{([^}]*)\}:\s*$/);
    if (!header) continue;
    const fields = header[2].split(",").map((field) => field.trim());
    const count = Number(header[1]);
    const findings: NoMistakesFinding[] = [];
    for (const row of lines.slice(i + 1, i + 1 + count)) {
      if (!/^\s+\S/.test(row)) break;
      const cells = splitRow(row.trim());
      // An unquoted trailing description may still contain commas.
      if (cells.length > fields.length)
        cells.splice(
          fields.length - 1,
          cells.length,
          cells.slice(fields.length - 1).join(","),
        );
      const value = (name: string) => {
        const index = fields.indexOf(name);
        return index < 0 ? "" : unquote(cells[index] ?? "");
      };
      const id = value("id");
      if (id)
        findings.push({
          id,
          severity: value("severity"),
          file: value("file"),
          line: value("line"),
          action: value("action"),
          description: value("description"),
        });
    }
    return { step, findings };
  }
  return null;
}

// Tool results arrive as plain strings or `{ content: [{ text }] }` blocks.
export function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const value = result as { content?: unknown; output?: unknown };
  if (Array.isArray(value.content))
    return value.content
      .map((item) =>
        item && typeof item === "object" && "text" in item
          ? String((item as { text: unknown }).text ?? "")
          : "",
      )
      .join("\n");
  return typeof value.output === "string" ? value.output : "";
}

export function askUserFindings(gate: NoMistakesGate) {
  return gate.findings.filter((finding) => finding.action === "ask-user");
}

export function noMistakesGateKey(gate: NoMistakesGate) {
  return `${gate.step}:${gate.findings
    .map((finding) => finding.id)
    .sort()
    .join(",")}`;
}

export function noMistakesDecisionPrompt(
  gate: NoMistakesGate,
  decision: NoMistakesDecision,
) {
  const askUserIds = askUserFindings(gate).map((finding) => finding.id);
  const others = gate.findings
    .filter((finding) => finding.action !== "ask-user")
    .map((finding) => `${finding.id} (${finding.action})`);
  const lines = [
    `My decision for the no-mistakes \`${gate.step}\` gate (ask-user findings: ${askUserIds.join(", ")}):`,
  ];
  if (decision.action === "fix") {
    const skipped = askUserIds.filter(
      (id) => !decision.findingIds.includes(id),
    );
    lines.push(`- Fix: ${decision.findingIds.join(", ")}`);
    if (skipped.length)
      lines.push(`- Leave as is (intended): ${skipped.join(", ")}`);
    if (decision.instructions.trim())
      lines.push(`- Guidance for the fix: ${decision.instructions.trim()}`);
    lines.push(
      "",
      "Respond with `no-mistakes axi respond --action fix --findings <ids>` and pass my guidance through `--instructions`.",
    );
  } else if (decision.action === "approve") {
    lines.push(
      "- Approve: the flagged behavior is intended; accept these findings as is.",
      "",
      "Respond with `no-mistakes axi respond --action approve`, unless you fix auto-fix findings in the same call.",
    );
  } else {
    lines.push(
      "- Skip this step.",
      "",
      "Respond with `no-mistakes axi respond --action skip`.",
    );
  }
  if (others.length)
    lines.push(
      `Other findings in this gate (${others.join(", ")}) are yours to decide per the no-mistakes skill; you may include auto-fix ones in the same respond call.`,
    );
  lines.push("Then keep driving the run until it reaches an outcome.");
  return lines.join("\n");
}
