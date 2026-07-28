import { describe, expect, test } from "vitest";
import { formatTokens, insertSteerMessage, preserveStreamedContent, shouldSubmitCommand } from "./ChatView";
import type { ChatMessage } from "../lib/rpc";

describe("formatTokens", () => {
  test("formats footer token counts compactly", () => {
    expect(formatTokens(1_250)).toBe("1.3K");
    expect(formatTokens(128_000)).toBe("128K");
  });
});

describe("preserveStreamedContent", () => {
  test("keeps earlier streamed assistant messages when completion only contains the last message", () => {
    expect(preserveStreamedContent("First answer", "Second answer")).toBe("First answer\n\nSecond answer");
  });

  test("does not duplicate a completion already present in the stream", () => {
    expect(preserveStreamedContent("First answer\n\nSecond answer", "Second answer")).toBe("First answer\n\nSecond answer");
  });
});

describe("shouldSubmitCommand", () => {
  test("submits an already completed slash command", () => {
    expect(shouldSubmitCommand("/new", { name: "new" })).toBe(true);
    expect(shouldSubmitCommand("/ne", { name: "new" })).toBe(false);
  });
});

describe("insertSteerMessage", () => {
  test("places a steer before the active assistant response", () => {
    const assistant = { id: "a", role: "assistant", text: "Working", toolCalls: [], isStreaming: true } as ChatMessage;
    const steer = { id: "u", role: "user", text: "Skip sonar", toolCalls: [] } as ChatMessage;

    expect(insertSteerMessage([assistant], steer).map((message) => message.id)).toEqual(["u", "a"]);
  });
});
