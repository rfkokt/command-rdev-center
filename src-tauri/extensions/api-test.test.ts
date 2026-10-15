// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import api from "./api-test";
import { lookup } from "node:dns/promises";
import type { Contract } from "./openapi-catalog";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));
const folders: string[] = [];
async function harness(contracts?: Contract[]) {
  vi.mocked(lookup).mockResolvedValue([
    { address: "93.184.216.34", family: 4 },
  ] as any);
  const cwd = mkdtempSync(join(tmpdir(), "kern-api-"));
  folders.push(cwd);
  const a: Contract = {
    id: "a",
    origin: "https://api.example.com",
    base_url: "https://api.example.com/v1",
    source_url: "https://api.example.com/openapi.json",
    document: {
      openapi: "3.0.3",
      paths: {
        "/employees/{id}": {
          get: {
            operationId: "getEmployee",
            responses: { 200: { description: "ok" } },
          },
        },
        "/employees": {
          post: {
            operationId: "createEmployee",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CreateEmployee" },
                },
              },
            },
            responses: {
              "2XX": { description: "created" },
              400: { description: "invalid" },
            },
          },
        },
        "/secure": {
          get: {
            operationId: "secure",
            security: [{ bearer: [] }],
            responses: { 200: { description: "ok" } },
          },
        },
        "/api-key": {
          get: {
            security: [{ apiKey: [] }],
            responses: { 200: { description: "ok" } },
          },
        },
      },
      components: {
        schemas: { CreateEmployee: { type: "object", required: ["name"] } },
        securitySchemes: {
          bearer: { type: "http", scheme: "bearer" },
          apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
        },
      },
    },
  };
  const path = join(cwd, "contracts.json");
  writeFileSync(path, JSON.stringify(contracts || [a]));
  vi.stubEnv("CRC_API_CONTRACTS_PATH", path);
  const sharedPath = join(cwd, "cache", "contracts.json");
  vi.stubEnv("CRC_API_CONTRACT_CACHE_PATH", sharedPath);
  const tools = new Map<string, any>(),
    hooks = new Map<string, any>();
  await api({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, hook: any) => hooks.set(name, hook),
  } as any);
  hooks.get("session_start")();
  const ctx = {
    ui: {
      confirm: vi.fn(async () => true),
      input: vi.fn(async () => "private-token"),
    },
  };
  const fetch = vi.fn(
    async () =>
      new Response('{"id":1}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const call = (name: string, input: any) =>
    tools.get(name).execute("test", input, undefined, undefined, ctx);
  return { call, ctx, fetch, hooks, a, path, sharedPath, cwd };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  folders
    .splice(0)
    .forEach((folder) => rmSync(folder, { recursive: true, force: true }));
});
describe("Swagger tool execution", () => {
  it("refreshes the actual searchable operation details and persists the new inventory", async () => {
    const h = await harness();
    const document = {
      openapi: "3.0.3",
      info: { title: "Updated", version: "2" },
      servers: [{ url: "/v2" }],
      paths: {
        "/fresh": {
          get: {
            operationId: "fresh",
            summary: "New endpoint",
            responses: { 200: {} },
          },
        },
      },
    };
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify(document)));
    const refreshed = await h.call("api_find_operations", { refresh: true });
    expect(refreshed.details.totalOperations).toBe(1);
    expect(refreshed.details.refresh).toMatchObject({
      updated: 1,
      failed: 0,
      persisted: { session: true, sharedCache: true },
    });
    const metadata = refreshed.details.contracts[0];
    expect(metadata.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(metadata.fetchedAt).toBeGreaterThan(0);
    expect((h.fetch.mock.calls[0][1] as any).cache).toBe("no-store");
    expect((h.fetch.mock.calls[0][1] as any).headers["cache-control"]).toBe(
      "no-cache",
    );
    const detail = await h.call("api_operation_detail", {
      operationId: "fresh",
    });
    expect(detail.details.summary).toBe("New endpoint");
    expect(detail.details.contentHash).toBe(metadata.contentHash);
    expect(
      (await h.call("api_operation_detail", { operationId: "getEmployee" }))
        .details.code,
    ).toBe("operation_not_found");
    for (const path of [h.path, h.sharedPath]) {
      const saved = JSON.parse(readFileSync(path, "utf8"));
      expect(saved[0].document).toEqual(document);
      expect(saved[0].content_hash).toBe(metadata.contentHash);
    }
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify(document)));
    const unchanged = await h.call("api_find_operations", { refresh: true });
    expect(unchanged.details.refresh.unchanged).toBe(1);
    expect(unchanged.details.contracts[0].contentHash).toBe(
      metadata.contentHash,
    );
    h.fetch.mockRejectedValueOnce(new Error("network offline"));
    const failed = await h.call("api_find_operations", { refresh: true });
    expect(failed.details.status).toBe("partial");
    expect(failed.details.contracts[0]).toMatchObject({
      stale: true,
      refreshStatus: "failed",
      contentHash: metadata.contentHash,
    });
    expect(failed.details.refresh.failed).toBe(1);
    expect(failed.details.totalOperations).toBe(1);
    expect(JSON.parse(readFileSync(h.sharedPath, "utf8"))[0].document).toEqual(
      document,
    );
  });
  it("discloses failed durable writes while still using the freshly fetched document", async () => {
    const h = await harness();
    const blocker = join(h.cwd, "blocker");
    writeFileSync(blocker, "file");
    vi.stubEnv("CRC_API_CONTRACT_CACHE_PATH", join(blocker, "contracts.json"));
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify(h.a.document)));
    const refreshed = await h.call("api_find_operations", { refresh: true });
    expect(refreshed.details.status).toBe("partial");
    expect(refreshed.details.contracts[0].persistenceError).toContain(
      "shared_cache_write_failed",
    );
    expect(refreshed.details.refresh.persisted).toEqual({
      session: true,
      sharedCache: false,
    });
    expect(refreshed.details.totalOperations).toBe(4);
  });
  it("opens authentication even when a saved Swagger source is unavailable", async () => {
    const h = await harness([
      {
        id: "failed",
        origin: "",
        source_url: "https://api.example.com/swagger-ui/index.html",
        document: {},
        load_error: "Swagger UI document URL was not found",
      },
    ]);
    const blocked = await h.call("api_request", {
      method: "GET",
      path: "/secure",
      authenticated: true,
    });
    expect(blocked.details.code).toBe("contract_required");
    expect(blocked.details.guidance).toContain("api_authenticate");
    const auth = await h.call("api_authenticate", { action: "set" });
    expect(auth.details.status).toBe("ok");
    expect(auth.details.origin).toBe("https://api.example.com");
    expect(h.ctx.ui.input).toHaveBeenCalledTimes(1);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(auth)).not.toContain("private-token");
  });
  it("replaces a valid cached token without sending a request and uses the new identity", async () => {
    const h = await harness();
    await h.call("api_contract_test", { operationId: "secure" });
    h.ctx.ui.input.mockResolvedValueOnce(" Bearer replacement-token ");
    const auth = await h.call("api_authenticate", {
      action: "set",
      contractId: "a",
    });
    expect(auth.details.replaced).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.ctx.ui.input.mock.calls[1][0]).toContain("Replace API token");
    await h.call("api_contract_test", { operationId: "secure" });
    expect((h.fetch.mock.calls[1][1] as any).headers.authorization).toBe(
      "Bearer replacement-token",
    );
    expect(h.ctx.ui.input).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(auth)).not.toContain("replacement-token");
  });
  it("replaces documented header API keys using the same scheme as execution", async () => {
    const h = await harness();
    await h.call("api_contract_test", { method: "GET", path: "/api-key" });
    h.ctx.ui.input.mockResolvedValueOnce("new-api-key");
    await h.call("api_authenticate", {
      action: "set",
      method: "GET",
      path: "/api-key",
    });
    await h.call("api_contract_test", { method: "GET", path: "/api-key" });
    expect((h.fetch.mock.calls[1][1] as any).headers["x-api-key"]).toBe(
      "new-api-key",
    );
    expect(
      (h.fetch.mock.calls[1][1] as any).headers.authorization,
    ).toBeUndefined();
  });
  it("clears all token schemes for the selected origin", async () => {
    const h = await harness();
    await h.call("api_contract_test", { operationId: "secure" });
    await h.call("api_contract_test", { method: "GET", path: "/api-key" });
    const cleared = await h.call("api_authenticate", { action: "clear" });
    expect(cleared.details.status).toBe("ok");
    expect(h.ctx.ui.input).toHaveBeenCalledTimes(2);
    await h.call("api_contract_test", { operationId: "secure" });
    await h.call("api_contract_test", { method: "GET", path: "/api-key" });
    expect(h.ctx.ui.input).toHaveBeenCalledTimes(4);
  });
  it("does not clear another API's token on a different port of the same host", async () => {
    const h = await harness([
      { id: "default", origin: "https://api.example.com", document: {} },
      {
        id: "other-port",
        origin: "https://api.example.com:8443",
        document: {},
      },
    ]);
    await h.call("api_authenticate", { action: "set", contractId: "default" });
    h.ctx.ui.input.mockResolvedValueOnce("other-port-token");
    await h.call("api_authenticate", {
      action: "set",
      contractId: "other-port",
    });
    await h.call("api_authenticate", {
      action: "clear",
      contractId: "default",
    });
    await h.call("api_request", {
      method: "GET",
      path: "/secure",
      contractId: "other-port",
    });
    expect(h.ctx.ui.input).toHaveBeenCalledTimes(2);
    expect((h.fetch.mock.calls[0][1] as any).headers.authorization).toBe(
      "Bearer other-port-token",
    );
  });
  it("can explicitly replace authentication when Swagger omits its security declaration", async () => {
    const h = await harness();
    await h.call("api_authenticate", { action: "set" });
    h.ctx.ui.input.mockResolvedValueOnce("new-token");
    const result = await h.call("api_contract_test", {
      operationId: "getEmployee",
      pathParams: { id: "1" },
      refreshAuthentication: true,
    });
    expect(result.details.contractStatus).toBe("pass");
    expect(h.ctx.ui.input).toHaveBeenCalledTimes(2);
    expect((h.fetch.mock.calls[0][1] as any).headers.authorization).toBe(
      "Bearer new-token",
    );
  });
  it("stores operation tokens against the operation's server override", async () => {
    const h = await harness([
      {
        id: "override",
        origin: "https://api.example.com",
        source_url: "https://api.example.com/openapi.json",
        document: {
          paths: {
            "/secure": {
              get: {
                operationId: "secure",
                servers: [{ url: "https://other.example.com/v2" }],
                security: [{ bearer: [] }],
                responses: { 200: {} },
              },
            },
          },
          components: {
            securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
          },
        },
      },
    ]);
    const auth = await h.call("api_authenticate", {
      action: "set",
      operationId: "secure",
    });
    expect(auth.details.origin).toBe("https://other.example.com");
    await h.call("api_contract_test", { operationId: "secure" });
    expect(h.ctx.ui.input).toHaveBeenCalledTimes(1);
    expect((h.fetch.mock.calls[0][1] as any).headers.authorization).toBe(
      "Bearer private-token",
    );
  });
  it("does not reuse the old identity after a canceled token replacement", async () => {
    const h = await harness();
    await h.call("api_contract_test", { operationId: "secure" });
    h.ctx.ui.input.mockResolvedValueOnce("");
    expect(
      (await h.call("api_authenticate", { action: "set" })).details.code,
    ).toBe("authentication_required");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.ctx.ui.input.mockResolvedValueOnce("fresh-token");
    await h.call("api_contract_test", { operationId: "secure" });
    expect((h.fetch.mock.calls[1][1] as any).headers.authorization).toBe(
      "Bearer fresh-token",
    );
    expect(h.ctx.ui.input).toHaveBeenCalledTimes(3);
  });
  it.each(["api_request", "api_contract_test"])(
    "forces replacement before %s and stops execution if canceled",
    async (tool) => {
      const h = await harness();
      const input = { method: "GET", path: "/secure" };
      await h.call(tool, input);
      h.ctx.ui.input.mockResolvedValueOnce("new-token");
      await h.call(tool, { ...input, refreshAuthentication: true });
      expect((h.fetch.mock.calls[1][1] as any).headers.authorization).toBe(
        "Bearer new-token",
      );
      h.ctx.ui.input.mockResolvedValueOnce("");
      const canceled = await h.call(tool, {
        ...input,
        refreshAuthentication: true,
      });
      expect(canceled.details.code).toBe("authentication_required");
      expect(h.fetch).toHaveBeenCalledTimes(2);
      const conflict = await h.call(tool, {
        ...input,
        refreshAuthentication: true,
        expectedStatus: 401,
      });
      expect(conflict.details.code).toBe(
        "authentication_refresh_conflicts_with_anonymous_test",
      );
      expect(h.ctx.ui.input).toHaveBeenCalledTimes(3);
      expect(h.fetch).toHaveBeenCalledTimes(2);
    },
  );
  it("requires an explicit origin when authentication spans different servers", async () => {
    const h = await harness([
      { id: "one", origin: "https://one.example.com", document: {} },
      { id: "two", origin: "https://two.example.com", document: {} },
    ]);
    expect(
      (await h.call("api_authenticate", { action: "set" })).details.code,
    ).toBe("authentication_origin_required");
    expect(
      (
        await h.call("api_authenticate", {
          action: "set",
          origin: "https://other.example.com",
        })
      ).details.code,
    ).toBe("authentication_origin_required");
    expect(h.ctx.ui.input).not.toHaveBeenCalled();
    expect(
      (await h.call("api_authenticate", { action: "set", contractId: "two" }))
        .details.origin,
    ).toBe("https://two.example.com");
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("does not require a contract selector for duplicate sources with the same API base URL", async () => {
    const h = await harness([
      {
        id: "one",
        origin: "https://api.example.com",
        base_url: "https://api.example.com/v1",
        document: {},
      },
      {
        id: "two",
        origin: "https://api.example.com",
        base_url: "https://api.example.com/v1",
        document: {},
      },
    ]);
    expect(
      (
        await h.call("api_request", {
          method: "GET",
          path: "/health",
          authenticated: false,
        })
      ).details.httpStatus,
    ).toBe(200);
    expect(String(h.fetch.mock.calls[0][0])).toBe(
      "https://api.example.com/v1/health",
    );
  });
  it("prompts privately after an unexpected 401 when Swagger omitted security, and reuses that token only after a challenge", async () => {
    const h = await harness();
    h.fetch
      .mockResolvedValueOnce(
        new Response('{"error":"unauthorized"}', { status: 401 }),
      )
      .mockResolvedValueOnce(new Response('{"id":1}', { status: 200 }));
    const result = await h.call("api_contract_test", {
      operationId: "getEmployee",
      pathParams: { id: "1" },
    });
    expect(result.details.contractStatus).toBe("pass");
    expect(h.ctx.ui.input).toHaveBeenCalledTimes(1);
    expect(
      (h.fetch.mock.calls[0][1] as any).headers.authorization,
    ).toBeUndefined();
    expect((h.fetch.mock.calls[1][1] as any).headers.authorization).toBe(
      "Bearer private-token",
    );
    expect(JSON.stringify(result)).not.toContain("private-token");
    h.fetch
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await h.call("api_contract_test", {
      operationId: "getEmployee",
      pathParams: { id: "2" },
    });
    expect(h.ctx.ui.input).toHaveBeenCalledTimes(1);
    expect(
      (h.fetch.mock.calls[2][1] as any).headers.authorization,
    ).toBeUndefined();
    expect((h.fetch.mock.calls[3][1] as any).headers.authorization).toBe(
      "Bearer private-token",
    );
  });
  it("preserves intentional unauthorized tests without requesting a token", async () => {
    const h = await harness();
    h.a.document.paths["/employees/{id}"].get.responses[401] = {};
    // Refresh uses the saved document source to expose the added response.
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify(h.a.document)));
    await h.call("api_find_operations", { refresh: true });
    h.fetch.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    expect(
      (
        await h.call("api_contract_test", {
          operationId: "getEmployee",
          pathParams: { id: "1" },
          expectedStatus: 401,
        })
      ).details.contractStatus,
    ).toBe("pass");
    h.fetch.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    expect(
      (
        await h.call("api_contract_test", {
          operationId: "getEmployee",
          pathParams: { id: "1" },
          authenticated: false,
        })
      ).details.httpStatus,
    ).toBe(401);
    expect(h.ctx.ui.input).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalledTimes(3);
    h.fetch.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await h.call("api_contract_test", {
      operationId: "secure",
      expectedStatus: 401,
    });
    h.fetch.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await h.call("api_request", {
      method: "GET",
      path: "/secure",
      expectedStatus: 401,
    });
    expect(h.ctx.ui.input).not.toHaveBeenCalled();
    expect(
      (h.fetch.mock.calls[3][1] as any).headers.authorization,
    ).toBeUndefined();
    expect(
      (h.fetch.mock.calls[4][1] as any).headers.authorization,
    ).toBeUndefined();
  });
  it("reports canceled authentication and limits invalid-token retries", async () => {
    const h = await harness();
    h.ctx.ui.input.mockResolvedValueOnce("");
    h.fetch.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    const canceled = await h.call("api_contract_test", {
      operationId: "getEmployee",
      pathParams: { id: "1" },
    });
    expect(canceled.details.code).toBe("authentication_required");
    expect(canceled.details.contractStatus).toBe("blocked");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.fetch.mockResolvedValue(new Response("{}", { status: 401 }));
    // Each fetch needs an independent body stream.
    h.fetch.mockImplementation(async () => new Response("{}", { status: 401 }));
    const rejected = await h.call("api_contract_test", {
      operationId: "getEmployee",
      pathParams: { id: "1" },
    });
    expect(rejected.details.code).toBe("authentication_failed");
    expect(rejected.details.contractStatus).toBe("fail");
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(h.ctx.ui.input).toHaveBeenCalledTimes(2);
  });
  it("keeps direct API tasks out of browser login while allowing explicitly requested UI verification", async () => {
    const h = await harness();
    const start = h.hooks.get("before_agent_start"),
      gate = h.hooks.get("tool_call");
    const guidance = start({
      prompt: "Coba testing API swagger, tanpa browser",
      systemPrompt: "original",
    });
    expect(guidance.systemPrompt).toContain("Never search .env files");
    expect(guidance.systemPrompt).toContain("browser_host_closing");
    expect(gate({ toolName: "browser_open" }).block).toBe(true);
    expect(gate({ toolName: "api_contract_test" })).toBeUndefined();
    expect(gate({ toolName: "browser_close" })).toBeUndefined();
    start({ prompt: "lanjutin", systemPrompt: "original" });
    expect(gate({ toolName: "browser_snapshot" }).block).toBe(true);
    start({
      prompt: "Sekarang cek UI login di browser",
      systemPrompt: "original",
    });
    expect(gate({ toolName: "browser_open" })).toBeUndefined();
    start({ prompt: "Test API JWT", systemPrompt: "original" });
    h.hooks.get("session_tree")();
    expect(gate({ toolName: "browser_open" })).toBeUndefined();
    start({ prompt: "Test API JWT", systemPrompt: "original" });
    start({ prompt: "Refactor component navbar", systemPrompt: "original" });
    expect(gate({ toolName: "browser_open" })).toBeUndefined();
  });
  it("uses documented JSON media types and query array serialization across Swagger versions", async () => {
    const h = await harness([
      {
        id: "oas",
        origin: "https://api.example.com",
        base_url: "https://api.example.com/v1",
        document: {
          openapi: "3.0.3",
          paths: {
            "/search": {
              post: {
                operationId: "search",
                parameters: [
                  {
                    name: "ids",
                    in: "query",
                    style: "pipeDelimited",
                    schema: { type: "array" },
                  },
                  { name: "tags", in: "query", schema: { type: "array" } },
                ],
                requestBody: {
                  content: {
                    "application/vnd.example+json": {
                      schema: { type: "object" },
                    },
                  },
                },
                responses: { 200: {} },
              },
            },
          },
        },
      },
      {
        id: "v2",
        origin: "https://api.example.com",
        base_url: "https://api.example.com/v2",
        document: {
          swagger: "2.0",
          paths: {
            "/search": {
              get: {
                operationId: "searchV2",
                parameters: [
                  {
                    name: "ids",
                    in: "query",
                    type: "array",
                    items: { type: "string" },
                  },
                ],
                responses: { 200: {} },
              },
            },
          },
        },
      },
    ]);
    const result = await h.call("api_contract_test", {
      operationId: "search",
      body: {},
      query: { ids: [1, 2], tags: ["a", "b"] },
    });
    expect(result.details.contractStatus).toBe("pass");
    const url = new URL(String(h.fetch.mock.calls[0][0]));
    expect(url.searchParams.get("ids")).toBe("1|2");
    expect(url.searchParams.getAll("tags")).toEqual(["a", "b"]);
    expect((h.fetch.mock.calls[0][1] as any).headers["content-type"]).toBe(
      "application/vnd.example+json",
    );
    expect(
      (
        await h.call("api_contract_test", {
          operationId: "searchV2",
          query: { ids: [1, 2] },
        })
      ).details.contractStatus,
    ).toBe("pass");
    expect(
      new URL(String(h.fetch.mock.calls[1][0])).searchParams.getAll("ids"),
    ).toEqual(["1,2"]);
  });
  it("allows a configured local development API and rejects non-loopback resolution for localhost", async () => {
    const h = await harness([
      {
        id: "local",
        origin: "http://localhost:8100",
        base_url: "http://localhost:8100/api",
        document: { paths: { "/health": { get: { responses: { 200: {} } } } } },
      },
    ]);
    vi.mocked(lookup).mockResolvedValue([
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ] as any);
    expect(
      (await h.call("api_contract_test", { method: "GET", path: "/health" }))
        .details.contractStatus,
    ).toBe("pass");
    expect(String(h.fetch.mock.calls[0][0])).toBe(
      "http://localhost:8100/api/health",
    );
    vi.mocked(lookup).mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ] as any);
    expect(
      (await h.call("api_contract_test", { method: "GET", path: "/health" }))
        .details.code,
    ).toContain("api_destination_blocked");
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it("registers discovery even when a configured contract cannot load", async () => {
    const h = await harness([
      {
        id: "failed",
        origin: "",
        document: {},
        source_url: "https://api.example.com/docs",
        load_error: "timeout",
      },
    ]);
    const result = await h.call("api_find_operations", { query: "employees" });
    expect(result.details.status).toBe("partial");
    expect(result.details.issues[0].code).toBe("timeout");
    expect(
      (await h.call("api_contract_test", { method: "GET", path: "/employees" }))
        .details.code,
    ).toBe("operation_not_found");
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("searches a refreshed source when a cached contract did not contain the endpoint", async () => {
    const h = await harness();
    h.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          openapi: "3.0.3",
          servers: [{ url: "/v2" }],
          paths: {
            "/new-endpoint": {
              get: { operationId: "newOperation", responses: { 200: {} } },
            },
          },
        }),
      ),
    );
    const result = await h.call("api_find_operations", {
      query: "new endpoint",
      refresh: true,
    });
    expect(result.details.operations[0].path).toBe("/new-endpoint");
    expect(result.details.contracts[0].stale).toBe(false);
  });
  it("keeps fresh endpoint discovery even when a server variable cannot be resolved", async () => {
    const h = await harness();
    h.fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          openapi: "3.0.3",
          servers: [{ url: "https://{environment}.example.com" }],
          paths: {
            "/new-endpoint": {
              get: { operationId: "newOperation", responses: { 200: {} } },
            },
          },
        }),
      ),
    );
    const result = await h.call("api_find_operations", {
      query: "new endpoint",
      refresh: true,
    });
    expect(result.details.operations[0].path).toBe("/new-endpoint");
    expect(result.details.status).toBe("partial");
    expect(result.details.issues[0].code).toContain("API server unavailable");
  });
  it("blocks missing path variables before encoding and before sending any request", async () => {
    const h = await harness();
    const result = await h.call("api_contract_test", {
      operationId: "getEmployee",
    });
    expect(result.details.code).toBe("path_parameter_required");
    expect(result.details.missing).toEqual(["id"]);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("checks referenced required request fields and runs public operations without an auth prompt", async () => {
    const h = await harness();
    expect(
      (
        await h.call("api_contract_test", {
          operationId: "createEmployee",
          body: {},
        })
      ).details.code,
    ).toBe("required_body_fields_missing");
    expect(h.fetch).not.toHaveBeenCalled();
    h.fetch.mockResolvedValueOnce(new Response('{"id":1}', { status: 201 }));
    const result = await h.call("api_contract_test", {
      operationId: "createEmployee",
      body: { name: "AI_TEST_Employee" },
    });
    expect(result.details.contractStatus).toBe("pass");
    expect(result.isError).toBe(false);
    expect(h.ctx.ui.input).not.toHaveBeenCalled();
    expect(String(h.fetch.mock.calls[0][0])).toBe(
      "https://api.example.com/v1/employees",
    );
    expect(result.details.responseSchemaValidation).toBe("not_performed");
  });
  it("marks undocumented status and a rejected mutation as errors", async () => {
    const h = await harness();
    h.fetch.mockResolvedValueOnce(new Response("{}", { status: 202 }));
    const result = await h.call("api_contract_test", {
      operationId: "getEmployee",
      pathParams: { id: "12" },
    });
    expect(result.details.contractStatus).toBe("fail");
    expect(result.isError).toBe(true);
    h.ctx.ui.confirm.mockResolvedValueOnce(false);
    const denied = await h.call("api_contract_test", {
      operationId: "createEmployee",
      body: { name: "AI_TEST_Employee" },
    });
    expect(denied.details.contractStatus).toBe("blocked");
    expect(denied.isError).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it("supports an explicit documented negative test", async () => {
    const h = await harness();
    h.fetch.mockResolvedValueOnce(
      new Response('{"error":"invalid"}', { status: 400 }),
    );
    const result = await h.call("api_contract_test", {
      operationId: "createEmployee",
      body: { name: "AI_TEST_Employee" },
      expectedStatus: 400,
    });
    expect(result.details.contractStatus).toBe("pass");
    expect(result.isError).toBe(false);
  });
  it("collects credentials privately and never sends a cached token on an anonymous request", async () => {
    const h = await harness();
    await h.call("api_contract_test", { operationId: "secure" });
    expect(h.ctx.ui.input).toHaveBeenCalledTimes(1);
    expect((h.fetch.mock.calls[0][1] as any).headers.authorization).toBe(
      "Bearer private-token",
    );
    await h.call("api_contract_test", {
      operationId: "getEmployee",
      pathParams: { id: "1" },
    });
    expect(
      (h.fetch.mock.calls[1][1] as any).headers.authorization,
    ).toBeUndefined();
    await h.call("api_contract_test", { method: "GET", path: "/api-key" });
    expect((h.fetch.mock.calls[2][1] as any).headers["x-api-key"]).toBe(
      "private-token",
    );
    expect(h.ctx.ui.input).toHaveBeenCalledTimes(2);
  });
  it("does not hide ambiguity or contradictory selectors behind the first matching contract", async () => {
    const h = await harness();
    expect(
      (
        await h.call("api_contract_test", {
          operationId: "getEmployee",
          path: "/wrong",
        })
      ).details.code,
    ).toBe("operation_not_found");
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
