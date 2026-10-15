// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import api from "./api-test";

const source = process.env.CRC_LIVE_SWAGGER_URL;
const folders: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    folders.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it.skipIf(!source)(
  "replaces a deliberately stale local inventory from the live Swagger and persists the exact response",
  async () => {
    const folder = await mkdtemp(join(tmpdir(), "kern-swagger-live-"));
    folders.push(folder);
    const path = join(folder, "session.json"),
      cache = join(folder, "cache.json");
    await writeFile(
      path,
      JSON.stringify([
        {
          id: "live",
          origin: new URL(source!).origin,
          source_url: source,
          document: {
            paths: {
              "/__outdated_local_fixture__": {
                get: { operationId: "outdated" },
              },
            },
          },
        },
      ]),
    );
    vi.stubEnv("CRC_API_CONTRACTS_PATH", path);
    vi.stubEnv("CRC_API_CONTRACT_CACHE_PATH", cache);
    const tools = new Map<string, any>();
    await api({
      on: () => {},
      registerTool: (tool: any) => tools.set(tool.name, tool),
    } as any);
    const call = (name: string, input: any) =>
      tools.get(name).execute("live", input, undefined, undefined, {});
    const refreshed = await call("api_find_operations", {
      refresh: true,
      limit: 100,
    });
    expect(refreshed.details.refresh.failed).toBe(0);
    expect(refreshed.details.refresh.persisted).toEqual({
      session: true,
      sharedCache: true,
    });
    expect(refreshed.details.totalOperations).toBeGreaterThan(0);
    const saved = JSON.parse(await readFile(cache, "utf8"));
    expect(
      saved[0].document.paths["/__outdated_local_fixture__"],
    ).toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(saved);
    const independent = await fetch(source!, {
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
    });
    expect(independent.ok).toBe(true);
    expect(saved[0].document).toEqual(await independent.json());
    const operation = refreshed.details.operations[0];
    const detail = await call("api_operation_detail", {
      contractId: operation.contractId,
      method: operation.method,
      path: operation.path,
    });
    expect(detail.details.contentHash).toBe(saved[0].content_hash);
    const again = await call("api_find_operations", { refresh: true });
    expect(again.details.refresh.unchanged).toBe(1);
    tools.clear();
    await api({
      on: () => {},
      registerTool: (tool: any) => tools.set(tool.name, tool),
    } as any);
    const resumed = await call("api_find_operations", {});
    expect(resumed.details.totalOperations).toBe(
      refreshed.details.totalOperations,
    );
    expect(resumed.details.contracts[0].contentHash).toBe(
      saved[0].content_hash,
    );
    const report = {
      source,
      checkedAt: new Date(saved[0].checked_at).toISOString(),
      title: saved[0].document.info?.title,
      version: saved[0].document.info?.version,
      openapi: saved[0].document.openapi,
      paths: Object.keys(saved[0].document.paths).length,
      operations: refreshed.details.totalOperations,
      contentHash: saved[0].content_hash,
      staleFixtureReplaced: true,
      independentResponseMatched: true,
      sessionAndSharedSnapshotsMatched: true,
      resumedInventoryMatched: true,
      secondFetch: "unchanged",
    };
    if (process.env.CRC_SWAGGER_REPORT_PATH)
      await writeFile(
        process.env.CRC_SWAGGER_REPORT_PATH,
        JSON.stringify(report, null, 2),
      );
    console.log(JSON.stringify(report));
  },
  60_000,
);
