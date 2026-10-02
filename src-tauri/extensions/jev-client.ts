/** TypeSafe System One wire contract: https://docs.typesafe.ai/api */
export type JevQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: "score";
      score: number;
      probabilities: Record<string, number>;
      legend: Record<string, string>;
      confidence: number;
    };

export type JevConfig = {
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
};
export type JevResult =
  | {
      status: "ok";
      model: string;
      answers: Record<string, JevAnswer>;
      usage: { input_tokens: number; output_tokens: number };
    }
  | {
      status: "unavailable";
      reason:
        | "unconfigured"
        | "invalid_request"
        | "input_limit"
        | "cancelled"
        | "timeout"
        | "http_error"
        | "billing_exhausted"
        | "invalid_response"
        | "network_error";
      httpStatus?: number;
    };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function probability(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}
function sameKeys(a: object, b: object) {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key))
  );
}

export function validEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

function distribution(
  value: unknown,
  keys: object,
): value is Record<string, number> {
  return (
    record(value) &&
    sameKeys(value, keys) &&
    Object.values(value).every(probability) &&
    Math.abs(
      Object.values(value).reduce<number>((sum, p) => sum + (p as number), 0) -
        1,
    ) <= 0.01
  );
}

// TypeSafe does not currently publish a dedicated exhausted-credit error schema.
// Match payment-required or explicit structured provider codes, never incidental prose.
export function isBillingExhausted(status: number, body?: unknown): boolean {
  if (status === 402) return true;
  if (![400, 403, 429].includes(status) || !record(body)) return false;
  const error = record(body.error) ? body.error : body;
  const codes = [error.code, error.type, body.code];
  return codes.some(
    (code) =>
      typeof code === "string" &&
      [
        "insufficient_credits",
        "credits_exhausted",
        "credit_balance_exhausted",
        "insufficient_balance",
        "billing_quota_exceeded",
        "insufficient_quota",
        "payment_required",
      ].includes(code.toLowerCase()),
  );
}

async function readBoundedBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 64_000) {
      await reader.cancel();
      throw new Error("Response limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function parseJevResponse(
  value: unknown,
  questions: Record<string, JevQuestion>,
): Extract<JevResult, { status: "ok" }> | undefined {
  if (
    !record(value) ||
    typeof value.model !== "string" ||
    !value.model.trim() ||
    !record(value.answers) ||
    !sameKeys(value.answers, questions) ||
    !record(value.usage)
  )
    return;
  for (const count of [value.usage.input_tokens, value.usage.output_tokens]) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      return;
  }
  for (const [id, question] of Object.entries(questions)) {
    const answer = value.answers[id];
    if (!record(answer) || answer.type !== question.type) return;
    if (question.type === "noul") {
      if (!probability(answer.noul)) return;
    } else {
      if (!probability(answer.confidence)) return;
      if (question.type === "choice") {
        if (
          typeof answer.choice !== "string" ||
          !Object.hasOwn(question.criteria, answer.choice) ||
          !distribution(answer.probabilities, question.criteria)
        )
          return;
        const chosenProbability = answer.probabilities[answer.choice];
        if (
          Object.values(answer.probabilities).some(
            (p) => p > chosenProbability + 1e-6,
          )
        )
          return;
      } else {
        const legend = Object.fromEntries(
          question.criteria.map((entry, index) => [String(index), entry]),
        );
        if (
          !record(answer.legend) ||
          !sameKeys(answer.legend, legend) ||
          Object.entries(legend).some(
            ([key, entry]) =>
              answer.legend &&
              (answer.legend as Record<string, unknown>)[key] !== entry,
          ) ||
          !distribution(answer.probabilities, legend)
        )
          return;
        if (
          typeof answer.score !== "number" ||
          !Number.isFinite(answer.score) ||
          answer.score < 0 ||
          answer.score > question.criteria.length - 1
        )
          return;
        const weighted = Object.entries(answer.probabilities).reduce(
          (sum, [level, p]) => sum + Number(level) * p,
          0,
        );
        if (Math.abs(weighted - answer.score) > 0.02) return;
      }
    }
  }
  return {
    status: "ok",
    model: value.model,
    answers: value.answers as Record<string, JevAnswer>,
    usage: value.usage as { input_tokens: number; output_tokens: number },
  };
}

export async function evaluateJev(
  config: JevConfig,
  state: unknown,
  questions: Record<string, JevQuestion>,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<JevResult> {
  if (!config.apiKey.trim() || !config.model.trim())
    return { status: "unavailable", reason: "unconfigured" };
  if (
    !validEndpoint(config.endpoint) ||
    /[\r\n]/.test(config.apiKey) ||
    !Number.isInteger(config.timeoutMs) ||
    config.timeoutMs < 100 ||
    config.timeoutMs > 30_000 ||
    !Object.keys(questions).length ||
    Object.keys(questions).length > 16
  )
    return { status: "unavailable", reason: "invalid_request" };
  for (const question of Object.values(questions)) {
    if (!question.instructions.trim())
      return { status: "unavailable", reason: "invalid_request" };
    if (
      question.type === "choice" &&
      (!Object.keys(question.criteria).length ||
        Object.keys(question.criteria).length > 255)
    )
      return { status: "unavailable", reason: "invalid_request" };
    if (
      question.type === "score" &&
      (question.criteria.length < 2 || question.criteria.length > 10)
    )
      return { status: "unavailable", reason: "invalid_request" };
  }
  let body: string;
  try {
    body = JSON.stringify({ model: config.model, state, questions });
  } catch {
    return { status: "unavailable", reason: "invalid_request" };
  }
  if (state === undefined)
    return { status: "unavailable", reason: "invalid_request" };
  if (new TextEncoder().encode(body).length > 64_000)
    return { status: "unavailable", reason: "input_limit" };
  if (signal?.aborted) return { status: "unavailable", reason: "cancelled" };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  try {
    const response = await fetcher(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      if (isBillingExhausted(response.status)) {
        await response.body?.cancel();
        return {
          status: "unavailable",
          reason: "billing_exhausted",
          httpStatus: response.status,
        };
      }
      if ([400, 403, 429].includes(response.status)) {
        try {
          if (
            isBillingExhausted(response.status, await readBoundedBody(response))
          ) {
            return {
              status: "unavailable",
              reason: "billing_exhausted",
              httpStatus: response.status,
            };
          }
        } catch {
          /* Unrecognized errors remain ordinary fallback, without raw bodies. */
        }
      } else {
        await response.body?.cancel();
      }
      return {
        status: "unavailable",
        reason: "http_error",
        httpStatus: response.status,
      };
    }
    // Limit streamed responses before parsing; never log provider bodies/errors.
    try {
      return (
        parseJevResponse(await readBoundedBody(response), questions) ?? {
          status: "unavailable",
          reason: "invalid_response",
        }
      );
    } catch {
      if (signal?.aborted)
        return { status: "unavailable", reason: "cancelled" };
      if (timedOut) return { status: "unavailable", reason: "timeout" };
      return { status: "unavailable", reason: "invalid_response" };
    }
  } catch {
    return {
      status: "unavailable",
      reason: signal?.aborted
        ? "cancelled"
        : timedOut
          ? "timeout"
          : "network_error",
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
