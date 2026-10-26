import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";

const exec = promisify(execFile);
const ENTRY = "kern-task-ledger";
export type CheckEvidence = {
  id: string;
  name: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  snapshot: string | null;
  stable: boolean;
  at: number;
};
export type TaskLedger = {
  version: 1;
  goal: string;
  criteria: string[];
  constraints: string[];
  checks: CheckEvidence[];
  required: boolean;
  guided?: boolean;
  outcome:
    | "pending"
    | "checks_passed"
    | "complete_with_limitations"
    | "incomplete";
  acceptance: string[];
  limitations: string[];
  reportedSnapshot: string | null;
};

// Store only hashes and command metadata, never source contents or command output.
export async function workspaceFingerprint(
  cwd: string,
  repositories: string[] = [],
  signal?: AbortSignal,
): Promise<string | null> {
  const hash = createHash("sha256");
  let found = false;
  for (const repository of [...new Set([cwd, ...repositories])].sort()) {
    try {
      await exec("git", ["-C", repository, "rev-parse", "--show-toplevel"], {
        signal,
        timeout: 5_000,
      });
      const { stdout: diff } = await exec(
        "git",
        ["-C", repository, "diff", "--binary", "HEAD", "--", "."],
        {
          signal,
          timeout: 5_000,
          maxBuffer: 4_000_000,
        },
      );
      const { stdout: untracked } = await exec(
        "git",
        ["-C", repository, "ls-files", "--others", "--exclude-standard", "-z"],
        { signal, timeout: 5_000, maxBuffer: 1_000_000 },
      );
      const { stdout: head } = await exec(
        "git",
        ["-C", repository, "rev-parse", "HEAD"],
        { signal, timeout: 5_000 },
      );
      hash.update(repository).update("\0").update(head).update(diff);
      for (const file of untracked.split("\0").filter(Boolean).sort()) {
        const path = join(repository, file);
        if ((await stat(path)).size > 16_000_000) return null;
        hash
          .update(file)
          .update("\0")
          .update(await readFile(path));
      }
      found = true;
    } catch {
      // An expected repository failing to snapshot invalidates all evidence.
      if (repository !== cwd || !repositories.length) return null;
    }
  }
  return found ? hash.digest("hex") : null;
}

export function evidenceProblem(
  ledger: TaskLedger,
  snapshot: string | null,
): string | undefined {
  if (!ledger.criteria.length) return "Acceptance criteria are missing.";
  if (
    ledger.acceptance.length !== ledger.criteria.length ||
    ledger.acceptance.some((item) => !item.trim())
  )
    return "Every acceptance criterion needs an explicit result.";
  if (!snapshot) return "The current source snapshot is unavailable.";
  if (ledger.reportedSnapshot !== snapshot)
    return "Source changed after the task report.";
  // Every named check's latest attempt must cover the final snapshot. A failed
  // or interrupted rerun cannot silently fall back to an earlier success.
  const latest = new Map(ledger.checks.map((check) => [check.name, check]));
  const current = [...latest.values()];
  if (
    !current.length ||
    current.some((check) => check.snapshot !== snapshot || !check.stable)
  )
    return "No recorded check covers the current source snapshot.";
  if (current.some((check) => check.exitCode !== 0))
    return "A check for the current source snapshot failed or was interrupted.";
}

// Deliberately narrow: ordinary coding requests must not opt into bookkeeping.
export function requestsVerification(prompt: string): boolean {
  return (
    /\b(?:verif(?:y|ication|ikasi)|run (?:the )?(?:checks|tests|pipeline)|jalankan (?:tes|test|checks|pipeline))\b/i.test(
      prompt,
    ) &&
    !/\b(?:no|without|skip|jangan|tanpa)\s+(?:\w+\s+)?(?:verif\w*|checks|tests|pipeline)\b/i.test(
      prompt,
    )
  );
}

export default function (pi: ExtensionAPI) {
  const cwd = process.env.CRC_PROJECT_CWD;
  if (!cwd) return;
  let repositories: string[] = [];
  try {
    const configured: unknown = JSON.parse(
      process.env.CRC_WORKSPACE_REPOSITORIES || "[]",
    );
    if (Array.isArray(configured))
      repositories = configured.flatMap((repo) =>
        typeof repo?.name === "string" && existsSync(join(cwd, repo.name))
          ? [join(cwd, repo.name)]
          : [],
      );
  } catch (error) {
    console.error("Kern verification repository metadata unavailable:", error);
  }
  // Bookkeeping tools are only offered to the model while verification is on:
  // a declared tool invites calls, and each call is one more full-context request.
  const VERIFY_TOOLS = ["set_task_contract", "run_check", "report_task"];
  let offered: string[] | null = null;
  const applyTools = () => {
    try {
      const active = new Set(pi.getActiveTools());
      // Respect an explicit --tools allowlist: only manage tools it allowed.
      offered ??= VERIFY_TOOLS.filter((name) => active.has(name));
      const before = active.size;
      let changed = false;
      for (const name of offered) {
        if (enabled && !active.has(name)) {
          active.add(name);
          changed = true;
        } else if (!enabled && active.has(name)) {
          active.delete(name);
          changed = true;
        }
      }
      if (changed || active.size !== before) pi.setActiveTools([...active]);
    } catch (error) {
      console.error("Kern verification tool loadout unchanged:", error);
    }
  };
  let mode: "on" | "off" | "auto" = "auto";
  let enabled = process.env.CRC_TASK_VERIFICATION === "true";
  let guidanceSent = false;
  let ledger: TaskLedger | undefined;
  let baseline: string | null = null;
  let recoveryRequested = false;
  const snapshot = (signal?: AbortSignal) =>
    workspaceFingerprint(cwd, repositories, signal);
  const persist = () => {
    if (ledger) pi.appendEntry(ENTRY, structuredClone(ledger));
  };
  const fresh = (goal: string): TaskLedger => ({
    version: 1,
    goal: goal.slice(0, 4000),
    criteria: [],
    constraints: [],
    checks: [],
    required: false,
    outcome: "pending",
    acceptance: [],
    limitations: [],
    reportedSnapshot: null,
  });
  const restore = (_event: unknown, ctx: ExtensionContext) => {
    const entry = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find((entry) => entry.type === "custom" && entry.customType === ENTRY);
    ledger =
      entry?.type === "custom" && (entry.data as TaskLedger)?.version === 1
        ? structuredClone(entry.data as TaskLedger)
        : undefined;
    const modeEntry = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find(
        (item) =>
          item.type === "custom" &&
          item.customType === "kern-verification-mode",
      );
    const saved = modeEntry?.type === "custom" ? modeEntry.data : undefined;
    mode = saved === "on" || saved === "off" ? saved : "auto";
    enabled =
      mode === "on" ||
      (mode === "auto" &&
        (process.env.CRC_TASK_VERIFICATION === "true" || !!ledger?.required));
    baseline = null;
    recoveryRequested = false;
    guidanceSent = ledger?.guided === true;
    applyTools();
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.registerCommand("kern-task", {
    description:
      "Show the current task contract, recorded checks, and limitations without a model request",
    handler: async (_args, ctx) =>
      ctx.ui.notify(
        JSON.stringify(ledger ?? { status: "no_active_task" }),
        "info",
      ),
  });
  pi.registerCommand("kern-verification", {
    description:
      "Task verification for this chat: on, off, or auto (Settings / explicit requests / Pipeline)",
    handler: async (args, ctx) => {
      const next = args.trim();
      if (!["on", "off", "auto"].includes(next)) {
        ctx.ui.notify(
          `Verification: ${mode}. Use /kern-verification on|off|auto`,
          "info",
        );
        return;
      }
      mode = next as typeof mode;
      enabled =
        mode === "on" ||
        (mode === "auto" && process.env.CRC_TASK_VERIFICATION === "true");
      guidanceSent = false;
      applyTools();
      pi.appendEntry("kern-verification-mode", mode);
      ctx.ui.notify(`Task verification: ${mode}`, "info");
    },
  });
  pi.on("before_agent_start", async (event, ctx) => {
    // Never consume/transform input. Optional bookkeeping must fail open.
    if (typeof event.prompt !== "string") return;
    recoveryRequested = false;
    const newTask =
      !ledger ||
      ["checks_passed", "complete_with_limitations"].includes(ledger.outcome);
    if (newTask) {
      guidanceSent = false;
      enabled =
        mode === "on" ||
        (mode === "auto" && process.env.CRC_TASK_VERIFICATION === "true");
    }
    if (mode === "auto" && requestsVerification(event.prompt)) enabled = true;
    applyTools();
    if (!enabled) return;
    if (newTask) ledger = fresh(event.prompt);
    if (!ledger) return;
    baseline = await snapshot(ctx.signal);
    if (guidanceSent) return;
    guidanceSent = true;
    ledger.guided = true;
    persist();
    return {
      message: {
        customType: "kern-task-guidance",
        display: false,
        content: `For coding changes, call set_task_contract with the user's goal, acceptance criteria, and constraints. Use run_check for the appropriate focused tests/build/inspection; it records real exit codes and the source snapshot. Before claiming completion call report_task. Passing commands are evidence, not proof of semantic correctness. If checks cannot run, report complete_with_limitations or incomplete and explain why. Do not add unrelated tests or run a delivery pipeline without the user's request. Active task: ${JSON.stringify({ goal: ledger.goal, criteria: ledger.criteria, constraints: ledger.constraints, outcome: ledger.outcome, limitations: ledger.limitations, recentChecks: ledger.checks.slice(-6).map(({ name, exitCode, stable }) => ({ name, exitCode, stable })) })}`,
      },
    };
  });
  pi.on("tool_result", (event) => {
    if (mode !== "off" && event.toolName === "run_pipeline" && !event.isError) {
      enabled = true;
      ledger ??= fresh("Verify the active Pipeline task");
      guidanceSent = false;
      applyTools();
    }
    if (
      enabled &&
      ledger &&
      !event.isError &&
      ["write", "edit"].includes(event.toolName)
    ) {
      if (
        typeof event.input.path === "string" &&
        resolve(cwd, event.input.path) === join(cwd, "memory.md")
      )
        return;
      // Pending writes do not change the ledger again. Persist the transition,
      // rather than duplicating all check metadata for every edit in a batch.
      if (
        ledger.required &&
        ledger.outcome === "pending" &&
        ledger.reportedSnapshot === null
      )
        return;
      ledger.required = true;
      ledger.outcome = "pending";
      ledger.reportedSnapshot = null;
      persist();
    }
  });
  pi.registerTool({
    name: "set_task_contract",
    label: "Set task acceptance criteria",
    description:
      "Record the current coding task goal, acceptance criteria, and constraints. Preserve user instructions; this does not grant permissions.",
    parameters: Type.Object({
      goal: Type.String({ minLength: 1, maxLength: 4000 }),
      criteria: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
        minItems: 1,
        maxItems: 20,
      }),
      constraints: Type.Array(Type.String({ maxLength: 1000 }), {
        maxItems: 20,
      }),
    }),
    async execute(_id, input) {
      ledger = {
        ...fresh(input.goal),
        guided: guidanceSent,
        criteria: input.criteria,
        constraints: input.constraints,
        required: true,
      };
      persist();
      return {
        content: [
          {
            type: "text",
            text: "Task contract recorded. Run appropriate checks, then report each criterion and any limitations.",
          },
        ],
        details: ledger,
      };
    },
  });
  pi.registerTool({
    name: "run_check",
    label: "Run and record a task check",
    description:
      "Run a validation command through the normal bash tool and its permission hooks. Record its real exit code and source fingerprint. Use the same check name when rerunning a failed check.",
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 100 }),
      command: Type.String({ minLength: 1, maxLength: 8000 }),
      timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 600 })),
    }),
    async execute(_id, input, signal, onUpdate, ctx) {
      if (!ledger) throw new Error("Set a task contract first.");
      if (ctx.tools.some((tool) => tool.name === "format_changed_files")) {
        const format = await ctx.executeTool(
          "format_changed_files",
          {},
          { signal },
        );
        if (format.isError)
          throw new Error(
            `Formatting failed: ${format.result.content
              .filter((item) => item.type === "text")
              .map((item) => (item.type === "text" ? item.text : ""))
              .join("\n")
              .slice(
                0,
                2000,
              )}. Resolve it or disclose a limitation before reporting completion.`,
          );
      }
      const before = await snapshot(signal);
      const result = await ctx.executeTool(
        "bash",
        { command: input.command, timeout: input.timeout ?? 120 },
        { signal, onUpdate },
      );
      const after = await snapshot(signal);
      const output = result.result.structuredContent as
        | { exit_code?: number }
        | undefined;
      const exitCode =
        typeof output?.exit_code === "number" &&
        !(result.isError && output.exit_code === 0)
          ? output.exit_code
          : null;
      const check: CheckEvidence = {
        id: randomUUID(),
        name: input.name,
        command: input.command,
        cwd,
        exitCode,
        snapshot: after,
        stable: !!before && before === after && !signal?.aborted,
        at: Date.now(),
      };
      ledger.checks = [...ledger.checks, check].slice(-40);
      ledger.required = true;
      ledger.outcome = "pending";
      ledger.reportedSnapshot = null;
      persist();
      return {
        ...result.result,
        content: [
          ...result.result.content,
          { type: "text", text: `Recorded check: ${JSON.stringify(check)}` },
        ],
        details: check,
        isError: result.isError,
      };
    },
  });
  pi.registerTool({
    name: "report_task",
    label: "Report task outcome with evidence",
    description:
      "Report one result per acceptance criterion. checks_passed requires current, successful recorded checks and no limitations. Acceptance results are the agent's assessment; the host validates check evidence only.",
    parameters: Type.Object({
      outcome: Type.Union([
        Type.Literal("checks_passed"),
        Type.Literal("complete_with_limitations"),
        Type.Literal("incomplete"),
      ]),
      acceptance: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
        maxItems: 20,
      }),
      limitations: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
        maxItems: 20,
      }),
    }),
    async execute(_id, input, signal) {
      if (!ledger) throw new Error("Set a task contract first.");
      const current = await snapshot(signal);
      const proposal = { ...ledger, ...input, reportedSnapshot: current };
      const problem =
        input.outcome === "checks_passed"
          ? evidenceProblem(proposal, current)
          : undefined;
      if (
        problem ||
        (input.outcome === "checks_passed" && input.limitations.length)
      )
        throw new Error(
          problem ?? "Use complete_with_limitations when limitations remain.",
        );
      if (input.outcome !== "checks_passed" && !input.limitations.length)
        throw new Error(
          "Explain the incomplete work or verification limitation.",
        );
      ledger = proposal;
      persist();
      const text =
        input.outcome === "checks_passed"
          ? "Recorded checks passed for this source snapshot. Acceptance results are reported by the agent."
          : `Task ${input.outcome}: ${input.limitations.join("; ")}`;
      return { content: [{ type: "text", text }], details: ledger };
    },
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (!enabled || !ledger || event.continue || ctx.hasPendingMessages())
      return;
    const current = await snapshot(ctx.signal);
    const changed = !!baseline && !!current && baseline !== current;
    if (!ledger.required && !changed) return;
    ledger.required = true;
    const problem =
      ledger.outcome === "checks_passed"
        ? evidenceProblem(ledger, current)
        : ledger.outcome === "pending"
          ? "The coding task has no recorded outcome."
          : ledger.reportedSnapshot !== current
            ? "Source changed after the task report."
            : undefined;
    if (
      problem &&
      event.outcome === "completed" &&
      !ctx.signal?.aborted &&
      !recoveryRequested &&
      event.context.canContinue
    ) {
      recoveryRequested = true;
      return {
        entries: [
          {
            type: "custom_message",
            customType: "kern-verification",
            display: true,
            content: `Verification needed: ${problem} Use the task tools to record appropriate checks and report_task; disclose limitations if verification is unavailable. Do not claim verified completion without current evidence.`,
          },
        ],
        continue: true,
      };
    }
    if (problem || event.outcome !== "completed") {
      ledger.outcome = "incomplete";
      ledger.limitations = [problem ?? `Runtime outcome: ${event.outcome}`];
    }
    persist();
    return {
      entries: [
        {
          type: "custom_message",
          customType: "kern-verification",
          display: true,
          content:
            ledger.outcome === "checks_passed"
              ? "Checks passed for the final source snapshot. Acceptance criteria were assessed by the agent; review the diff."
              : `Task ${ledger.outcome}: ${ledger.limitations.join("; ")}`,
        },
      ],
    };
  });
}
