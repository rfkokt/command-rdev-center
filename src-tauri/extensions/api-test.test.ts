// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  return { call, ctx, fetch, hooks, a };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  folders
    .splice(0)
    .forEach((folder) => rmSync(folder, { recursive: true, force: true }));
});
describe("Swagger tool execution", () => {
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
