import { afterEach, expect, test, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
import {
  checkAgentUpdatesOnStartup,
  describeVersion,
  type AgentUpdate,
} from "./agent-updates";

afterEach(() => invoke.mockReset());

const item = (overrides: Partial<AgentUpdate>): AgentUpdate => ({
  id: "codex",
  label: "Codex",
  installed: "1.0.0",
  latest: "1.0.0",
  available: false,
  notice: null,
  detail: null,
  ...overrides,
});

function backend(list: AgentUpdate[], auto: boolean, failing?: string) {
  invoke.mockImplementation((command: string, args?: { id: string }) => {
    if (command === "check_agent_updates") return Promise.resolve(list);
    if (command === "get_auto_update") return Promise.resolve(auto);
    if (command === "apply_agent_update")
      return args?.id === failing
        ? Promise.reject("npm failed")
        : Promise.resolve([]);
    return Promise.resolve(undefined);
  });
}

test("notifies once about outdated agents when auto-install is off", async () => {
  backend(
    [
      item({ available: true, latest: "2.0.0" }),
      item({ id: "hermes", label: "Hermes Agent", available: true }),
      item({ id: "pi", label: "pi" }),
    ],
    false,
  );
  const toast = vi.fn();
  await checkAgentUpdatesOnStartup(toast);
  expect(toast).toHaveBeenCalledTimes(1);
  expect(toast.mock.calls[0][0]).toMatch(
    /^2 agent updates available: Codex, Hermes Agent\./,
  );
  expect(invoke).not.toHaveBeenCalledWith(
    "apply_agent_update",
    expect.anything(),
  );
});

test("installs each outdated agent when auto-install is on", async () => {
  backend(
    [
      item({ available: true, latest: "2.0.0" }),
      item({ id: "opencode", label: "OpenCode", available: true }),
    ],
    true,
    "opencode",
  );
  const toast = vi.fn();
  await checkAgentUpdatesOnStartup(toast);
  expect(invoke).toHaveBeenCalledWith("apply_agent_update", { id: "codex" });
  expect(invoke).toHaveBeenCalledWith("apply_agent_update", {
    id: "opencode",
  });
  expect(toast.mock.calls.map(([message]) => message)).toEqual([
    "Updated Codex to 2.0.0",
    "Couldn't update OpenCode: npm failed",
  ]);
});

test("stays quiet when everything is current or the check fails", async () => {
  const toast = vi.fn();
  backend([item({})], true);
  await checkAgentUpdatesOnStartup(toast);
  invoke.mockRejectedValue("offline");
  await checkAgentUpdatesOnStartup(toast);
  expect(toast).not.toHaveBeenCalled();
});

test("describeVersion shows the upgrade path only when one exists", () => {
  expect(describeVersion(item({ available: true, latest: "2.0.0" }))).toBe(
    "1.0.0 → 2.0.0",
  );
  expect(describeVersion(item({}))).toBe("1.0.0");
});
