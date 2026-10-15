// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshContracts } from "./openapi-refresh";
import { operations, type Contract } from "./openapi-catalog";

afterEach(() => vi.unstubAllGlobals());
const document = (name: string) => ({
  openapi: "3.0.3",
  paths: {
    [`/${name}`]: { get: { operationId: name, responses: { 200: {} } } },
  },
});
const root: Contract = {
  id: "ui",
  origin: "",
  source_url: "https://api.example.com/docs/index.html?configUrl=../config",
  document: {},
  load_error: "failed",
};

describe("Swagger refresh sources", () => {
  it("reloads a Swagger UI dropdown and replaces removed documents on the next refresh", async () => {
    let names = ["one", "two"];
    const fetch = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith("index.html"))
        return new Response('<script src="swagger-initializer.js"></script>');
      if (url.pathname === "/config")
        return new Response(
          JSON.stringify({
            urls: names.map((name) => ({ url: `/${name}.json` })),
          }),
        );
      return new Response(JSON.stringify(document(url.pathname.slice(1, -5))));
    });
    vi.stubGlobal("fetch", fetch);
    const loaded = await refreshContracts([root], {});
    expect(
      operations(loaded).items.map((item) => item.operation.operationId),
    ).toEqual(["one", "two"]);
    expect(
      loaded.every(
        (contract) => contract.configured_source === root.source_url,
      ),
    ).toBe(true);
    names = ["one", "three"];
    const updated = await refreshContracts(loaded, {
      contractId: loaded[0].id,
    });
    expect(
      operations(updated).items.map((item) => item.operation.operationId),
    ).toEqual(["one", "three"]);
    expect(
      updated.find((contract) => contract.source_url?.endsWith("one.json"))
        ?.refresh_status,
    ).toBe("unchanged");
    expect(
      fetch.mock.calls.filter(([url]) => url.pathname.endsWith("index.html")),
    ).toHaveLength(2);
  });
  it("reads inline Swagger initializer config without executing JavaScript", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('<script src="/assets/swagger-ui-init.js"></script>'),
      )
      .mockResolvedValueOnce(
        new Response(
          'throw new Error("do not execute"); SwaggerUIBundle({ url: "../spec.json" });',
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(document("latest"))));
    vi.stubGlobal("fetch", fetch);
    const loaded = await refreshContracts(
      [{ ...root, source_url: "https://api.example.com/docs/" }],
      {},
    );
    expect(loaded[0].source_url).toBe("https://api.example.com/spec.json");
    expect(loaded[0].document.paths["/latest"]).toBeTruthy();
  });
  it("resolves safe redirects but rejects credential-bearing or non-HTTP destinations", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "/fresh.json" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(document("fresh"))))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "file:///secret" },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const loaded = await refreshContracts(
      [{ ...root, source_url: "https://api.example.com/spec" }],
      {},
    );
    expect(loaded[0].source_url).toBe("https://api.example.com/fresh.json");
    const failed = await refreshContracts(loaded, {});
    expect(failed[0].refresh_status).toBe("failed");
    expect(failed[0].load_error).toContain("document_url_blocked");
    expect(failed[0].document).toEqual(loaded[0].document);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("retains the last valid document when fetched data is malformed or oversized", async () => {
    const previous: Contract = {
      ...root,
      source_url: "https://api.example.com/spec",
      document: document("old"),
      fetched_at: 123,
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("not JSON"))
      .mockResolvedValueOnce(
        new Response("too big", {
          headers: { "content-length": String(9 * 1024 * 1024) },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    // The malformed page's initializer request also fails.
    const malformed = await refreshContracts([previous], {});
    expect(malformed[0].stale).toBe(true);
    expect(malformed[0].document).toEqual(previous.document);
    expect(malformed[0].fetched_at).toBe(123);
    fetch.mockResolvedValueOnce(
      new Response("too big", {
        headers: { "content-length": String(9 * 1024 * 1024) },
      }),
    );
    const oversized = await refreshContracts([previous], {});
    expect(oversized[0].load_error).toContain("document_exceeds_8_MB");
    expect(oversized[0].document).toEqual(previous.document);
  });
});
