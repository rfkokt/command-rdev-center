// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import api, { redact } from "./api-test";
import { lookup } from "node:dns/promises";
import type { Contract } from "./openapi-catalog";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

const SECRET = "s3cr3t-cookie-value-0123456789";
const folders: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  folders
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

async function harness(responder?: (url: URL, init: any) => Response) {
  vi.mocked(lookup).mockResolvedValue([
    { address: "93.184.216.34", family: 4 },
  ] as any);
  const cwd = mkdtempSync(join(tmpdir(), "kern-api-cookie-"));
  folders.push(cwd);
  const contract: Contract = {
    id: "a",
    origin: "https://api.example.com",
    base_url: "https://api.example.com/v1",
    source_url: "https://api.example.com/openapi.json",
    document: {
      openapi: "3.0.3",
      paths: {
        "/me": {
          get: { operationId: "me", responses: { 200: { description: "ok" } } },
        },
        "/cookie-secured": {
          get: {
            operationId: "cookieSecured",
            security: [{ session: [] }],
            responses: { 200: { description: "ok" } },
          },
        },
      },
      components: {
        securitySchemes: {
          session: { type: "apiKey", in: "cookie", name: "AUTH_TOKEN" },
        },
      },
    },
  } as any;
  const path = join(cwd, "contracts.json");
  writeFileSync(path, JSON.stringify([contract]));
  vi.stubEnv("CRC_API_CONTRACTS_PATH", path);
  vi.stubEnv("CRC_API_CONTRACT_CACHE_PATH", join(cwd, "cache.json"));
  const tools = new Map<string, any>(),
    hooks = new Map<string, any>();
  await api({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, hook: any) => hooks.set(name, hook),
  } as any);
  hooks.get("session_start")();
  const ctx = {
    ui: { confirm: vi.fn(async () => true), input: vi.fn(async () => SECRET) },
  };
  const fetch = vi.fn(
    async (url: URL, init: any) =>
      responder?.(url, init) ??
      new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const call = (name: string, input: any) =>
    tools.get(name).execute("test", input, undefined, undefined, ctx);
  const sent = (index: number) => (fetch.mock.calls[index][1] as any).headers;
  return { call, ctx, fetch, sent };
}

describe("cookie authentication", () => {
  it("sends only the AUTH_TOKEN cookie after the private dialog, never a bearer token too", async () => {
    const h = await harness();
    const auth = await h.call("api_authenticate", {
      action: "set",
      mode: "cookie",
      cookieName: "AUTH_TOKEN",
    });
    expect(auth.details).toMatchObject({
      status: "ok",
      mode: "cookie",
      cookieName: "AUTH_TOKEN",
    });
    expect(h.ctx.ui.input.mock.calls[0][0]).toContain("AUTH_TOKEN");
    const response = await h.call("api_request", {
      method: "GET",
      path: "/me",
    });
    expect(response.details.status).toBe("ok");
    expect(response.details).toMatchObject({
      auth: "cookie",
      cookieName: "AUTH_TOKEN",
    });
    expect(h.sent(0).cookie).toBe(`AUTH_TOKEN=${SECRET}`);
    expect(h.sent(0).authorization).toBeUndefined();
    expect(h.ctx.ui.input).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([auth, response])).not.toContain(SECRET);
  });

  it("replaces and clears the cookie like a bearer token", async () => {
    const h = await harness();
    await h.call("api_authenticate", {
      action: "set",
      mode: "cookie",
      cookieName: "AUTH_TOKEN",
    });
    h.ctx.ui.input.mockResolvedValueOnce("AUTH_TOKEN=replaced-value-123456");
    const replaced = await h.call("api_authenticate", {
      action: "set",
      mode: "cookie",
      cookieName: "AUTH_TOKEN",
    });
    expect(replaced.details.replaced).toBe(true);
    expect(h.ctx.ui.input.mock.calls[1][0]).toContain("Replace API cookie");
    await h.call("api_request", { method: "GET", path: "/me" });
    expect(h.sent(0).cookie).toBe("AUTH_TOKEN=replaced-value-123456");
    const cleared = await h.call("api_authenticate", {
      action: "clear",
      mode: "cookie",
    });
    expect(cleared.details).toMatchObject({ status: "ok", cleared: 1 });
    // After clear, nothing is remembered: an explicit cookie request needs a name again.
    const after = await h.call("api_request", {
      method: "GET",
      path: "/me",
      auth: "cookie",
    });
    expect(after.details.code).toBe("cookie_name_required");
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("explicit auth picks exactly one credential", async () => {
    const h = await harness();
    await h.call("api_authenticate", {
      action: "set",
      mode: "cookie",
      cookieName: "AUTH_TOKEN",
    });
    h.ctx.ui.input.mockResolvedValueOnce("bearer-token-abcdefgh");
    await h.call("api_request", { method: "GET", path: "/me", auth: "bearer" });
    expect(h.sent(0).authorization).toBe("Bearer bearer-token-abcdefgh");
    expect(h.sent(0).cookie).toBeUndefined();
    await h.call("api_request", { method: "GET", path: "/me", auth: "none" });
    expect(h.sent(1).authorization).toBeUndefined();
    expect(h.sent(1).cookie).toBeUndefined();
  });

  it("reads an OpenAPI apiKey-in-cookie scheme for contract tests", async () => {
    const h = await harness();
    const response = await h.call("api_contract_test", {
      operationId: "cookieSecured",
    });
    expect(response.details.contractStatus).toBe("pass");
    expect(h.ctx.ui.input.mock.calls[0][0]).toContain("AUTH_TOKEN");
    expect(h.sent(0).cookie).toBe(`AUTH_TOKEN=${SECRET}`);
    expect(h.sent(0).authorization).toBeUndefined();
  });

  it("never follows redirects and reports only origin + path", async () => {
    const h = await harness(
      () =>
        new Response(null, {
          status: 302,
          headers: {
            location: `https://evil.example.net/steal?token=${SECRET}`,
          },
        }),
    );
    await h.call("api_authenticate", {
      action: "set",
      mode: "cookie",
      cookieName: "AUTH_TOKEN",
    });
    const response = await h.call("api_request", {
      method: "GET",
      path: "/me",
    });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect((h.fetch.mock.calls[0][1] as any).redirect).toBe("manual");
    expect(response.details).toMatchObject({
      httpStatus: 302,
      redirect: "https://evil.example.net/steal",
      redirectFollowed: false,
    });
    expect(JSON.stringify(response)).not.toContain(SECRET);
  });

  it("redacts credentials the backend echoes back", async () => {
    const h = await harness(
      () =>
        new Response(
          JSON.stringify({
            echo: `AUTH_TOKEN=${SECRET}`,
            headers: {
              Cookie: `AUTH_TOKEN=${SECRET}`,
              "Set-Cookie": "AUTH_TOKEN=other; Path=/",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await h.call("api_authenticate", {
      action: "set",
      mode: "cookie",
      cookieName: "AUTH_TOKEN",
    });
    const response = await h.call("api_request", {
      method: "GET",
      path: "/me",
    });
    const text = JSON.stringify(response);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("AUTH_TOKEN=other");
    expect(text).toContain("[REDACTED]");
  });

  it("rejects malformed cookie values without echoing them", async () => {
    const h = await harness();
    h.ctx.ui.input.mockResolvedValueOnce("abc; injected=1-secretish");
    const auth = await h.call("api_authenticate", {
      action: "set",
      mode: "cookie",
      cookieName: "AUTH_TOKEN",
    });
    expect(auth.details.code).toBe("cookie_value_invalid");
    expect(JSON.stringify(auth)).not.toContain("injected=1-secretish");
  });

  it("redact() covers Authorization, Cookie and Set-Cookie headers", () => {
    const text = redact(
      'Authorization: Bearer abcdefghijkl\n"cookie":"a=b" set-cookie=X=1',
      [],
    );
    expect(text).not.toContain("abcdefghijkl");
    expect(text).not.toContain("a=b");
    expect(text).not.toContain("X=1");
  });
});
