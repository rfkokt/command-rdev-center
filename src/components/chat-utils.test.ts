import { describe, expect, test } from "vitest";
import { appendStreamingText, mergeAssistantMessage } from "./chat-utils";
import type { ChatMessage } from "../lib/rpc";

describe("assistant message boundaries", () => {
  const previous: ChatMessage = {
    id: "visible-turn",
    role: "assistant",
    text: "Cek datanya:",
    thinking: "First investigation",
    toolCalls: [],
    isStreaming: true,
    assistantMessageStart: { text: 12, thinking: 19 },
  };

  test("separates messages while keeping chunks and cumulative snapshots inside one paragraph", () => {
    const first = mergeAssistantMessage(previous, { text: "Data tersedia" });
    const second = mergeAssistantMessage(first, {
      text: "Data tersedia di API.",
    });
    const final = mergeAssistantMessage(
      second,
      { text: "Data tersedia di API." },
      true,
    );
    expect(final.text).toBe("Cek datanya:\n\nData tersedia di API.");
    expect(final.thinking).toBe(previous.thinking);
  });

  test("keeps final-only content and separate thinking after earlier progress", () => {
    const final = mergeAssistantMessage(
      previous,
      {
        text: "## Temuan\n\n- Token berbeda.\n- API tersedia.",
        thinking: "Second investigation",
      },
      true,
    );
    expect(final.text).toBe(
      "Cek datanya:\n\n## Temuan\n\n- Token berbeda.\n- API tersedia.",
    );
    expect(final.thinking).toBe("First investigation\n\nSecond investigation");
  });

  test("does not insert paragraph gaps between code chunks", () => {
    const first = mergeAssistantMessage(previous, { text: '```json\n{"ok":' });
    const last = mergeAssistantMessage(first, { text: "true}\n```" });
    expect(last.text).toBe('Cek datanya:\n\n```json\n{"ok":true}\n```');
  });

  test("keeps the current message offset valid after bounded history truncation", () => {
    const prefix = "x".repeat(199_995);
    const first = mergeAssistantMessage(
      {
        ...previous,
        text: prefix,
        assistantMessageStart: { text: prefix.length, thinking: 19 },
      },
      { text: "new paragraph" },
    );
    const last = mergeAssistantMessage(first, {
      text: "new paragraph continues",
    });
    expect(last.text.length).toBe(200_000);
    expect(last.text.endsWith("\n\nnew paragraph continues")).toBe(true);
  });
});

// Reference copy of the pre-fix implementation (O(n·m) suffix-overlap scan),
// used for differential testing of the KMP-based replacement.
function legacyAppendStreamingText(
  current: string,
  incoming: string,
  maxLength = 200_000,
) {
  if (!incoming || current.endsWith(incoming)) return current;
  if (!current || incoming.startsWith(current))
    return incoming.slice(-maxLength);
  const limit = Math.min(current.length, incoming.length);
  let overlap = limit;
  while (overlap > 0 && !current.endsWith(incoming.slice(0, overlap)))
    overlap--;
  return (current + incoming.slice(overlap)).slice(-maxLength);
}

describe("appendStreamingText", () => {
  test("appends pure deltas", () => {
    expect(appendStreamingText("", "hello")).toBe("hello");
    expect(appendStreamingText("hello", " world")).toBe("hello world");
    expect(appendStreamingText("hello", "")).toBe("hello");
  });

  test("deduplicates cumulative and repeated stream chunks", () => {
    expect(appendStreamingText("Test", "Test received")).toBe("Test received");
    expect(appendStreamingText("Test received", "received ✅")).toBe(
      "Test received ✅",
    );
    expect(appendStreamingText("Test received ✅", "received ✅")).toBe(
      "Test received ✅",
    );
  });

  test("handles partial overlaps without duplicating text", () => {
    expect(appendStreamingText("abcab", "abcabc")).toBe("abcabc");
    expect(appendStreamingText("aaaa", "aaab")).toBe("aaaab");
    expect(appendStreamingText("abcdef", "defghi")).toBe("abcdefghi");
  });

  test("respects maxLength", () => {
    expect(appendStreamingText("abcdef", "gh", 5)).toBe("defgh");
    expect(appendStreamingText("", "abcdef", 4)).toBe("cdef");
  });

  test("matches the legacy implementation on randomized inputs", () => {
    // Deterministic PRNG so the test is reproducible.
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = "ab ✅\n";
    const randomString = (length: number) => {
      let out = "";
      for (let k = 0; k < length; k++)
        out += alphabet[Math.floor(rand() * alphabet.length)];
      return out;
    };
    for (let i = 0; i < 500; i++) {
      const current = randomString(Math.floor(rand() * 40));
      const mode = i % 4;
      let incoming: string;
      if (mode === 0) {
        incoming = randomString(Math.floor(rand() * 40)); // unrelated
      } else if (mode === 1) {
        incoming = current + randomString(Math.floor(rand() * 10)); // cumulative
      } else if (mode === 2) {
        // partial resend: suffix of current + fresh text
        const cut = Math.floor(rand() * (current.length + 1));
        incoming = current.slice(cut) + randomString(Math.floor(rand() * 10));
      } else {
        incoming = current; // duplicate
      }
      expect(
        appendStreamingText(current, incoming),
        `current=${JSON.stringify(current)} incoming=${JSON.stringify(incoming)}`,
      ).toBe(legacyAppendStreamingText(current, incoming));
    }
  });

  test("perf: appends 200K chars in chunks well under a second", () => {
    // Distinct chunks: identical repeats are (correctly) deduplicated, so
    // vary each chunk to exercise the pure-append path.
    const chunk = (i: number) =>
      i.toString(36).padStart(4, "0") + "x".repeat(996);
    let text = "";
    const start = performance.now();
    for (let i = 0; i < 200; i++) text = appendStreamingText(text, chunk(i));
    const elapsed = performance.now() - start;
    expect(text.length).toBe(200_000);
    expect(text.startsWith("0000")).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });

  test("perf: worst-case zero-overlap scan stays linear", () => {
    // The legacy scan degrades to ~1.25e9 char comparisons here; the KMP
    // version must handle it in linear time.
    const current = "a".repeat(50_000);
    const incoming = "b".repeat(50_000);
    const start = performance.now();
    const result = appendStreamingText(current, incoming);
    const elapsed = performance.now() - start;
    expect(result).toBe(current + incoming);
    expect(elapsed).toBeLessThan(1000);
  });
});
