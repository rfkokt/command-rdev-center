import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * kern.yaml worktree setup (docs/tasks/orca-essentials O2-03), modelled on
 * Orca's orca.yaml setup hook: when a chat's worktree is ready and the project
 * declares setup, Kern copies the listed files and runs the commands in the
 * chat terminal so output streams live. Project files never authorise
 * execution on their own: the first run of a given config needs the user's
 * approval; after that the same config runs automatically for new worktrees.
 * A failing setup only shows in the terminal; the chat keeps working.
 */
export type WorktreeSetupConfig = { copy: string[]; commands: string[] };

const trustKey = (project: string) => `kern:setup-trust:${project}`;
const doneKey = (worktree: string) => `kern:setup-done:${worktree}`;

function read(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Without storage the banner simply asks again next time. */
  }
}

export function setupFingerprint(setup: WorktreeSetupConfig) {
  // Must match the Rust side's serde_json::to_string(&Setup).
  return JSON.stringify({ copy: setup.copy, commands: setup.commands });
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export default function WorktreeSetup({
  project,
  worktree,
  onToast,
  runInTerminal,
}: {
  project: string;
  worktree: string;
  onToast: (text: string) => void;
  /** Types a command into the chat terminal (opening it if needed). */
  runInTerminal: (command: string) => Promise<void>;
}) {
  const [setup, setSetup] = useState<WorktreeSetupConfig | null>(null);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");
  const toast = useRef(onToast);
  toast.current = onToast;
  const runner = useRef(runInTerminal);
  runner.current = runInTerminal;

  async function run(config: WorktreeSetupConfig) {
    const fingerprint = setupFingerprint(config);
    setBusy(true);
    try {
      const prepared = await invoke<{
        copied: string;
        script: string | null;
      }>("prepare_worktree_setup", {
        project,
        worktree,
        approvedSetup: fingerprint,
      });
      write(trustKey(project), fingerprint);
      write(doneKey(worktree), fingerprint);
      setPending(false);
      setLog(prepared.copied.trim());
      if (prepared.script)
        await runner.current(
          `sh ${shellQuote(prepared.script)} || echo "[kern] worktree setup failed (exit $?). The chat is still available."`,
        );
      else toast.current("Worktree setup: files copied.");
    } catch (error) {
      toast.current(`Worktree setup: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    let active = true;
    setSetup(null);
    setPending(false);
    setLog("");
    void invoke<WorktreeSetupConfig>("inspect_worktree_setup", {
      project,
      worktree,
    })
      .then((value) => {
        if (
          !active ||
          !Array.isArray(value?.copy) ||
          !Array.isArray(value?.commands) ||
          (!value.copy.length && !value.commands.length)
        )
          return;
        setSetup(value);
        const fingerprint = setupFingerprint(value);
        if (read(doneKey(worktree)) === fingerprint) return;
        // Same config the user already approved for this project: run it.
        if (read(trustKey(project)) === fingerprint) void runRef.current(value);
        else setPending(true);
      })
      .catch((error) => {
        if (active) toast.current(`Worktree setup: ${String(error)}`);
      });
    return () => {
      active = false;
    };
  }, [project, worktree]);

  if (!setup) return null;
  if (pending)
    return (
      <section
        className="terminal-command-approval worktree-setup"
        role="alert"
        aria-label="Worktree setup"
      >
        <small>kern.yaml · worktree setup</small>
        <p>
          This project wants to set up the new worktree. Commands run in the
          chat terminal and may change files or execute programs. Review before
          running; this exact setup will then run automatically for new chats.
        </p>
        <pre>
          {[
            ...setup.copy.map((file) => `copy ${file}`),
            ...setup.commands.map((command) => `$ ${command}`),
          ].join("\n")}
        </pre>
        <div>
          <button
            className="approval-primary"
            disabled={busy}
            onClick={() => void run(setup)}
          >
            {busy ? "Starting…" : "Run setup"}
          </button>
          <button
            disabled={busy}
            onClick={() => {
              write(doneKey(worktree), setupFingerprint(setup));
              setPending(false);
            }}
          >
            Skip
          </button>
        </div>
      </section>
    );
  return (
    <details className="worktree-setup-rerun">
      <summary>Worktree setup (kern.yaml)</summary>
      {log && <pre role="status">{log}</pre>}
      <button
        disabled={busy}
        onClick={() => {
          if (read(trustKey(project)) === setupFingerprint(setup))
            void run(setup);
          else setPending(true);
        }}
      >
        {busy ? "Starting…" : "Run setup again"}
      </button>
    </details>
  );
}
