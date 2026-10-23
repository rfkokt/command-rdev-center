import { invoke } from "@tauri-apps/api/core";

/** Mirrors `agent_updates::AgentUpdate`. */
export type AgentUpdate = {
  id: string;
  label: string;
  installed: string | null;
  latest: string | null;
  available: boolean;
  /** Installed package is deprecated or superseded. */
  notice: string | null;
  detail: string | null;
};

export function describeVersion(item: AgentUpdate): string {
  if (!item.installed) return item.latest ?? "";
  if (item.available && item.latest)
    return `${item.installed} → ${item.latest}`;
  return item.installed;
}

/**
 * Startup check: notify about outdated agents, or install them when the
 * user turned on "Auto-install updates". Failures stay silent except for
 * an update that was actually attempted.
 */
export async function checkAgentUpdatesOnStartup(
  toast: (message: string) => void,
): Promise<void> {
  let pending: AgentUpdate[];
  try {
    const list = await invoke<AgentUpdate[]>("check_agent_updates");
    pending = list.filter((item) => item.available);
  } catch {
    return;
  }
  if (pending.length === 0) return;

  const auto = await invoke<boolean>("get_auto_update").catch(() => false);
  if (!auto) {
    const names = pending.map((item) => item.label).join(", ");
    toast(
      `${pending.length === 1 ? "Agent update" : `${pending.length} agent updates`} available: ${names}. Settings → Agent harness to update.`,
    );
    return;
  }
  // One at a time: several of these share npm's global prefix.
  for (const item of pending) {
    try {
      await invoke("apply_agent_update", { id: item.id });
      toast(`Updated ${item.label}${item.latest ? ` to ${item.latest}` : ""}`);
    } catch (e) {
      toast(`Couldn't update ${item.label}: ${String(e)}`);
    }
  }
}
