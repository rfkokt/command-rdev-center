import { describe, expect, it, vi } from "vitest";
import {
  evaluateJev,
  parseJevResponse,
  validEndpoint,
  isBillingExhausted,
  type JevConfig,
  type JevQuestion,
} from "./jev-client";

const config: JevConfig = {
  endpoint: "https://api.typesafe.ai/v1/systemone",
  apiKey: "test-secret",
  model: "jev-1.13.0",
  timeoutMs: 100,
};
const questions: Record<string, JevQuestion> = {
  tool: {
    type: "choice",
    instructions: "Select a tool",
    criteria: { none: "No tool", read: "Read source" },
  },
  useful: { type: "noul", instructions: "Is this useful?" },
  risk: {
    type: "score",
    instructions: "Risk level",
    criteria: ["Low", "High"],
  },
};
const response = () => ({
  model: "jev-1.13.0",
  answers: {
    tool: {
      type: "choice",
      choice: "read",
      confidence: 0.8,
      probabilities: { none: 0.1, read: 0.9 },
    },
    useful: { type: "noul", noul: 0.9 },
    risk: {
      type: "score",
      score: 0.2,
      confidence: 0.5,
      probabilities: { "0": 0.8, "1": 0.2 },
      legend: { "0": "Low", "1": "High" },
    },
  },
  usage: { input_tokens: 100, output_tokens: 10 },
});

describe("Jev decision contract", () => {
  it("distinguishes exhausted billing from ordinary rate limits and auth errors", () => {
    expect(isBillingExhausted(402)).toBe(true);
    expect(
      isBillingExhausted(429, { error: { code: "insufficient_quota" } }),
    ).toBe(true);
    expect(
      isBillingExhausted(403, { error: { type: "credits_exhausted" } }),
    ).toBe(true);
    expect(
      isBillingExhausted(429, { error: { code: "rate_limit_exceeded" } }),
    ).toBe(false);
    expect(
      isBillingExhausted(401, { error: { code: "invalid_api_key" } }),
    ).toBe(false);
    expect(
      isBillingExhausted(500, { error: { code: "insufficient_credits" } }),
    ).toBe(false);
    expect(
      isBillingExhausted(429, {
        message: "Credits are fine; temporarily rate limited",
      }),
    ).toBe(false);
  });
  it("returns only safe billing metadata for payment-required and explicit quota codes", async () => {
    for (const [status, body] of [
      [402, "test-secret"],
      [
        429,
        JSON.stringify({
          error: { code: "insufficient_quota", message: "test-secret" },
        }),
      ],
    ] as const) {
      const result = await evaluateJev(
        config,
        "x",
        questions,
        undefined,
        async () => new Response(body, { status }),
      );
      expect(result).toEqual({
        status: "unavailable",
        reason: "billing_exhausted",
        httpStatus: status,
      });
      expect(JSON.stringify(result)).not.toContain("test-secret");
    }
  });
  it("parses all three primitives without inventing Noul confidence", () => {
    const result = parseJevResponse(response(), questions);
    expect(result?.status).toBe("ok");
    expect(result?.answers.useful).toEqual({ type: "noul", noul: 0.9 });
  });
  it("rejects unknown choices, mismatched primitives, and invalid distributions", () => {
    const unknown = response();
    unknown.answers.tool.choice = "shell";
    expect(parseJevResponse(unknown, questions)).toBeUndefined();
    const mismatch = response();
    mismatch.answers.tool.type = "score";
    expect(parseJevResponse(mismatch, questions)).toBeUndefined();
    const invalid = response();
    invalid.answers.tool.probabilities.read = 1.2;
    expect(parseJevResponse(invalid, questions)).toBeUndefined();
    const wrongChoice = response();
    wrongChoice.answers.tool.choice = "none";
    expect(parseJevResponse(wrongChoice, questions)).toBeUndefined();
  });
  it("requires complete answers, matching score legend, and valid usage", () => {
    const missing = response();
    delete (missing.answers as Record<string, unknown>).useful;
    expect(parseJevResponse(missing, questions)).toBeUndefined();
    const wrongLegend = response();
    wrongLegend.answers.risk.legend["1"] = "Other";
    expect(parseJevResponse(wrongLegend, questions)).toBeUndefined();
    const wrongScore = response();
    wrongScore.answers.risk.score = 0.8;
    expect(parseJevResponse(wrongScore, questions)).toBeUndefined();
    const wrongUsage = response();
    wrongUsage.usage.input_tokens = -1;
    expect(parseJevResponse(wrongUsage, questions)).toBeUndefined();
  });
  it.each([
    "http://localhost.evil.test/v1/systemone",
    "http://127.0.0.1.evil.test",
    "https://secret@example.com",
    "https://example.com?q=secret",
    "https://example.com/#secret",
    "file:///tmp/key",
  ])("rejects unsafe endpoint %s", (url) =>
    expect(validEndpoint(url)).toBe(false),
  );
  it.each([
    "https://api.typesafe.ai/v1/systemone",
    "http://localhost:1234/v1/systemone",
    "http://127.0.0.1:1234/v1/systemone",
    "http://[::1]:1234/v1/systemone",
  ])("accepts supported endpoint %s", (url) =>
    expect(validEndpoint(url)).toBe(true),
  );
  it("uses the decision wire contract and does not follow credential redirects", async () => {
    const fetcher = vi.fn(async () => Response.json(response()));
    const result = await evaluateJev(
      config,
      { request: "Read source" },
      questions,
      undefined,
      fetcher,
    );
    expect(result.status).toBe("ok");
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(config.endpoint);
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body as string)).toEqual({
      model: config.model,
      state: { request: "Read source" },
      questions,
    });
  });
  it("makes no request without configuration, after cancellation, or above input bounds", async () => {
    const fetcher = vi.fn();
    expect(
      await evaluateJev(
        { ...config, apiKey: "" },
        "x",
        questions,
        undefined,
        fetcher,
      ),
    ).toMatchObject({ reason: "unconfigured" });
    const controller = new AbortController();
    controller.abort();
    expect(
      await evaluateJev(config, "x", questions, controller.signal, fetcher),
    ).toMatchObject({ reason: "cancelled" });
    expect(
      await evaluateJev(
        config,
        "x".repeat(65000),
        questions,
        undefined,
        fetcher,
      ),
    ).toMatchObject({ reason: "input_limit" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds slow requests and propagates caller cancellation", async () => {
    const waitForAbort: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("test-secret")),
          { once: true },
        );
      });
    expect(
      await evaluateJev(config, "x", questions, undefined, waitForAbort),
    ).toEqual({ status: "unavailable", reason: "timeout" });
    const controller = new AbortController();
    const pending = evaluateJev(
      config,
      "x",
      questions,
      controller.signal,
      waitForAbort,
    );
    controller.abort();
    expect(await pending).toEqual({
      status: "unavailable",
      reason: "cancelled",
    });
  });
  it("does not expose provider body or raw network errors and never retries a rate limit", async () => {
    const fetcher = vi.fn(
      async () => new Response("test-secret", { status: 429 }),
    );
    expect(
      await evaluateJev(config, "x", questions, undefined, fetcher),
    ).toEqual({ status: "unavailable", reason: "http_error", httpStatus: 429 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      await evaluateJev(config, "x", questions, undefined, async () => {
        throw new Error("test-secret");
      }),
    ).toEqual({ status: "unavailable", reason: "network_error" });
  });
  it("rejects malformed and oversized responses", async () => {
    expect(
      await evaluateJev(
        config,
        "x",
        questions,
        undefined,
        async () => new Response("bad json"),
      ),
    ).toMatchObject({ reason: "invalid_response" });
    expect(
      await evaluateJev(
        config,
        "x",
        questions,
        undefined,
        async () => new Response("x".repeat(65000)),
      ),
    ).toMatchObject({ reason: "invalid_response" });
  });
});
