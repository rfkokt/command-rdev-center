import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "./ConfirmDialog";
export default function WorktreeSetup({
  project,
  worktree,
  onToast,
}: {
  project: string;
  worktree: string;
  onToast: (text: string) => void;
}) {
  const [setup, setSetup] = useState<{
    copy: string[];
    commands: string[];
  } | null>(null);
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void invoke<{ copy: string[]; commands: string[] }>(
      "inspect_worktree_setup",
      { project, worktree },
    )
      .then((value) => {
        if (
          active &&
          Array.isArray(value?.copy) &&
          Array.isArray(value?.commands)
        )
          setSetup(value);
      })
      .catch((error) => {
        if (active) onToast(`Worktree setup: ${String(error)}`);
      });
    return () => {
      active = false;
    };
  }, [project, worktree, onToast]);
  if (!setup || (!setup.copy.length && !setup.commands.length)) return null;
  return (
    <details>
      <summary>Worktree setup (kern.yaml)</summary>
      <pre>{JSON.stringify(setup, null, 2)}</pre>
      <p>
        Project commands may modify files or execute programs. Review them
        before running.
      </p>
      <button
        disabled={busy}
        onClick={async () => {
          if (
            !(await confirm({
              title: "Run worktree setup?",
              message: JSON.stringify(setup, null, 2),
              confirmLabel: "Run setup",
              cancelLabel: "Cancel",
              danger: true,
            }))
          )
            return;
          setBusy(true);
          try {
            setOutput(
              await invoke<string>("run_worktree_setup", {
                project,
                worktree,
                approvedSetup: JSON.stringify(setup),
              }),
            );
          } catch (error) {
            onToast(`Worktree setup failed: ${String(error)}`);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Setup running…" : "Run setup"}
      </button>
      {output && <pre role="status">{output}</pre>}
    </details>
  );
}
