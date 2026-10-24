// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: (...args: any[]) => {
    const callback = args.pop();
    query(...args).then(
      (stdout: string) => callback(null, { stdout, stderr: "" }),
      (error: Error) => callback(error),
    );
  },
}));
import graphify from "./graphify-context";
import { isFollowUp } from "./follow-up";

const folders: string[] = [];
function harness(count = 1) {
  const cwd = mkdtempSync(join(tmpdir(), "kern-graph-"));
  folders.push(cwd);
  const graphs = Array.from({ length: count }, (_, index) => {
    const folder = join(cwd, `repo-${index}`, "graphify-out");
    mkdirSync(folder, { recursive: true });
    const graph = join(folder, "graph.json");
    writeFileSync(graph, "{}");
    return graph;
  });
  vi.stubEnv("CRC_GRAPH_JSONS", graphs.join("\n"));
  vi.stubEnv("CRC_PROJECT_CWD", cwd);
  const hooks = new Map<string, any>();
  graphify({ on: (name: string, hook: any) => hooks.set(name, hook) } as any);
  const ctx = { ui: { notify: vi.fn() }, signal: undefined };
  return {
    graphs,
    ctx,
    hooks,
    start: (prompt: string) => hooks.get("before_agent_start")({ prompt }, ctx),
  };
}
afterEach(() => {
  vi.unstubAllEnvs();
  query.mockReset();
  folders
    .splice(0)
    .forEach((folder) => rmSync(folder, { recursive: true, force: true }));
});

describe("graph context reuse", () => {
  it("reuses continuation context and invalidates cache for updated graphs or a new short task", async () => {
    query.mockResolvedValue("source symbols");
    const h = harness();
    expect((await h.start("Fix checkout lifecycle")).message.content).toContain(
      "source symbols",
    );
    expect(await h.start("lanjut")).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    h.hooks.get("session_compact")();
    expect((await h.start("continue")).message).toBeTruthy();
    expect(query).toHaveBeenCalledTimes(1);
    const now = new Date(Date.now() + 2000);
    utimesSync(h.graphs[0], now, now);
    expect((await h.start("continue")).message).toBeTruthy();
    expect(query).toHaveBeenCalledTimes(2);
    query.mockResolvedValueOnce("css symbols");
    expect((await h.start("Fix CSS")).message).toBeTruthy();
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2][1][1]).toBe("Fix CSS");
    h.hooks.get("session_tree")();
    await h.start("Fix CSS");
    expect(query).toHaveBeenCalledTimes(4);
  });
  it("treats short replies as follow-ups and skips repeated results", async () => {
    query.mockResolvedValue("checkout symbols");
    const h = harness();
    expect((await h.start("Fix checkout lifecycle")).message).toBeTruthy();
    // Replies to the agent neither re-query nor re-inject.
    expect(await h.start("iya push aja")).toBeUndefined();
    expect(await h.start("ok commit")).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    // A new wording that returns the same symbols is not injected twice.
    expect(await h.start("Fix the checkout lifecycle bug")).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("recognises follow-ups without swallowing short tasks", () => {
    for (const prompt of [
      "lanjut",
      "iya push aja",
      "Oke, gas",
      "sip",
      "yes please do it",
    ])
      expect(isFollowUp(prompt)).toBe(true);
    for (const prompt of [
      "Fix CSS",
      "iya tapi ganti juga warna tombol login di halaman checkout",
      "yarn build fails",
      "okta login broken",
    ])
      expect(isFollowUp(prompt)).toBe(false);
  });
  it("keeps context from working repositories when another query fails, then recovers", async () => {
    query
      .mockResolvedValueOnce("good symbols")
      .mockRejectedValueOnce(new Error("timeout"));
    const h = harness(2);
    expect((await h.start("Fix workspace")).message.content).toContain(
      "good symbols",
    );
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("1 graph query unavailable"),
      "warning",
    );
    query.mockResolvedValueOnce("recovered symbols");
    expect((await h.start("continue")).message.content).toContain(
      "recovered symbols",
    );
    expect(query).toHaveBeenCalledTimes(3);
  });
});
