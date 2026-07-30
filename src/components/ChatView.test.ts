import { describe, expect, test } from "vitest";
import { agentNotification, appendAgentLog, formatTokens, insertSteerMessage, preserveStreamedContent, settleAgentMessages, settleWithError, shouldShowChanges, shouldSubmitCommand, shouldToastPiStderr, tsvToMarkdown } from "./chat-utils";
import type { ChatMessage } from "../lib/rpc";

describe("agentNotification", () => {
  test("uses a distinct sound for follow-up requests", () => {
    expect(agentNotification("finished", "Command").sound).toBe("Glass");
    expect(agentNotification("follow-up", "Command")).toEqual({
      title: "Agent perlu jawaban",
      body: "Command menunggu respons.",
      sound: "Ping",
    });
  });
});

describe("tsvToMarkdown", () => {
  test("preserves quoted spreadsheet cell newlines", () => {
    expect(tsvToMarkdown('No\tDeskripsi\n997\t"Baris satu\nBaris dua"')).toContain("Baris satu\u2028Baris dua");
  });
});

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

describe("shouldShowChanges", () => {
  test("keeps changes attached to the latest assistant message after streaming ends", () => {
    expect(shouldShowChanges({ id: "latest", role: "assistant" }, "latest", 1)).toBe(true);
    expect(shouldShowChanges({ id: "older", role: "assistant" }, "latest", 1)).toBe(false);
    expect(shouldShowChanges({ id: "latest", role: "assistant" }, "latest", 0)).toBe(false);
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

describe("shouldToastPiStderr", () => {
  test("hides normal startup diagnostics but keeps real stderr", () => {
    expect(shouldToastPiStderr("[crc-isolation v3] root=/repo")).toBe(false);
    expect(shouldToastPiStderr("Ponytail loaded: full")).toBe(false);
    expect(shouldToastPiStderr("provider authentication failed")).toBe(true);
  });
});

describe("appendAgentLog", () => {
  test("keeps pi stderr visible in chat", () => {
    expect(appendAgentLog([], "provider authentication failed")[0]).toMatchObject({
      role: "system",
      text: "pi stderr: provider authentication failed",
    });
  });
});

describe("settleAgentMessages", () => {
  test("removes an empty assistant placeholder without inventing an error", () => {
    const user = { id: "u", role: "user", text: "test", toolCalls: [] } as ChatMessage;
    const assistant = { id: "a", role: "assistant", text: "", thinking: "", toolCalls: [], isStreaming: true } as ChatMessage;

    expect(settleAgentMessages([user, assistant])).toEqual([user]);
  });
});

describe("settleWithError", () => {
  test("replaces an empty streaming response with a persistent error", () => {
    const assistant = { id: "a", role: "assistant", text: "", toolCalls: [], isStreaming: true } as ChatMessage;

    expect(settleWithError([assistant], "provider failed")).toEqual([
      { ...assistant, text: "Agent error: provider failed", isStreaming: false },
    ]);
  });

  test("keeps partial output and appends the error", () => {
    const assistant = { id: "a", role: "assistant", text: "Partial answer", toolCalls: [], isStreaming: true } as ChatMessage;

    expect(settleWithError([assistant], "connection lost")[0].text).toBe(
      "Partial answer\n\nAgent error: connection lost",
    );
  });
});
