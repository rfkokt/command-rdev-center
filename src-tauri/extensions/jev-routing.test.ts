import { afterEach, describe, expect, it, vi } from "vitest";
import routing from "./jev-routing";

function harness() {
  let handler: (event: any, ctx: any) => Promise<any>;
  const appendEntry = vi.fn();
  const pi = {
    registerCommand: vi.fn(),
    sendMessage: vi.fn(),
    on: (_event: string, callback: typeof handler) => {
      handler = callback;
    },
    appendEntry,
    getActiveTools: () => ["read"],
    getAllTools: () => [
      { name: "read", description: "Read files", exposure: "direct" },
      {
        name: "forbidden",
        description: "Excluded by host",
        exposure: "deferred",
      },
    ],
    setActiveTools: vi.fn(),
  };
  routing(pi as any);
  const event = {
    prompt: "Inspect auth",
    systemPromptOptions: {
      skills: [
        {
          name: "auth",
          description: "Auth patterns",
          disableModelInvocation: false,
        },
        {
          name: "manual",
          description: "Manual only",
          disableModelInvocation: true,
        },
      ],
    },
  };
  const notify = vi.fn();
  return {
    pi,
    notify,
    run: () => handler(event, { signal: undefined, ui: { notify } }),
  };
}
function setup(mode: string) {
  vi.stubEnv("CRC_JEV_MODE", mode);
  vi.stubEnv("CRC_JEV_API_KEY", "test-secret");
  const fetcher = vi.fn(async () =>
    Response.json({
      model: "jev-1.13.0",
      answers: {
        tool: {
          type: "choice",
          choice: "tool_0",
          probabilities: { none: 0.1, tool_0: 0.9 },
          confidence: 0.8,
        },
        skill: {
          type: "choice",
          choice: "skill_0",
          probabilities: { none: 0.1, skill_0: 0.9 },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 100, output_tokens: 10 },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Jev project routing lifecycle", () => {
  it("does nothing in off mode", async () => {
    const fetcher = setup("off");
    const h = harness();
    expect(await h.run()).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(h.pi.appendEntry).not.toHaveBeenCalled();
  });
  it("shadow records metadata without changing context, permissions, or tools", async () => {
    const fetcher = setup("shadow");
    const h = harness();
    expect(await h.run()).toBeUndefined();
    const body = JSON.parse(
      (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(Object.keys(body.questions.tool.criteria)).toEqual([
      "none",
      "tool_0",
    ]);
    expect(Object.keys(body.questions.skill.criteria)).toEqual([
      "none",
      "skill_0",
    ]);
    const trace = JSON.stringify(h.pi.appendEntry.mock.calls);
    expect(trace).toContain('"name":"auth"');
    for (const secret of [
      "test-secret",
      "Inspect auth",
      "Read files",
      "Auth patterns",
      "forbidden",
      "manual",
    ])
      expect(trace).not.toContain(secret);
    expect(h.pi.setActiveTools).not.toHaveBeenCalled();
    expect(h.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "kern-jev-status", display: true }),
    );
  });
  it("advisory shares validated names, but never activates a tool or loads a skill", async () => {
    setup("advisory");
    const h = harness();
    const result = await h.run();
    expect(result.message.content).toContain('skill: "auth"');
    expect(result.message.content).toContain(
      "No permission or execution is implied",
    );
    expect(h.pi.setActiveTools).not.toHaveBeenCalled();
  });
  it("no match leaves the ordinary workflow untouched", async () => {
    const fetcher = setup("advisory");
    fetcher.mockImplementation(async () =>
      Response.json({
        model: "jev",
        answers: {
          tool: {
            type: "choice",
            choice: "none",
            probabilities: { none: 1, tool_0: 0 },
            confidence: 1,
          },
          skill: {
            type: "choice",
            choice: "none",
            probabilities: { none: 1, skill_0: 0 },
            confidence: 1,
          },
        },
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    );
    const h = harness();
    expect(await h.run()).toBeUndefined();
  });
  it("failure records a safe reason and adds no advice", async () => {
    const fetcher = setup("advisory");
    fetcher.mockImplementation(async () => {
      throw new Error("test-secret");
    });
    const h = harness();
    expect(await h.run()).toBeUndefined();
    expect(h.pi.appendEntry).toHaveBeenCalledWith(
      "kern-jev-routing",
      expect.objectContaining({
        status: "unavailable",
        reason: "network_error",
      }),
    );
  });

  it("billing exhaustion switches the current chat Off immediately and signals the host once", async () => {
    const fetcher = setup("shadow");
    fetcher.mockImplementation(
      async () => new Response("test-secret", { status: 402 }),
    );
    const marker = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const h = harness();
      expect(await h.run()).toBeUndefined();
      expect(await h.run()).toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(marker).toHaveBeenCalledExactlyOnceWith(
        "CRC_JEV_BILLING_EXHAUSTED",
      );
      expect(h.notify).toHaveBeenCalledTimes(1);
      expect(h.pi.appendEntry).toHaveBeenCalledWith(
        "kern-jev-routing",
        expect.objectContaining({ reason: "billing_exhausted" }),
      );
    } finally {
      marker.mockRestore();
    }
  });

  it("ordinary 429 does not automatically turn routing Off", async () => {
    const fetcher = setup("shadow");
    fetcher.mockImplementation(async () =>
      Response.json(
        { error: { code: "rate_limit_exceeded" } },
        { status: 429 },
      ),
    );
    const h = harness();
    await h.run();
    await h.run();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(h.notify).not.toHaveBeenCalled();
  });
});
