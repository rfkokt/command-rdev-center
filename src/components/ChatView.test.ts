import { describe, expect, test } from "vitest";
import { agentNotification, appendAgentLog, appendBoundedText, appendStreamingText, clearRestartErrors, ensureAssistantTurn, filePickerKey, formatAgentError, formatTokens, insertSteerMessage, preserveStreamedContent, projectTaskIntent, recentItems, settleAgentMessages, settleWithError, shouldOfferRestart, shouldShowChanges, shouldSubmitCommand, shouldToastPiStderr, tsvToMarkdown } from "./chat-utils";
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

describe("inactive session memory bounds", () => {
  test("keeps only the newest restored messages", () => {
    expect(recentItems([1, 2, 3, 4], 2)).toEqual([3, 4]);
  });

  test("caps streamed thinking while preserving the newest content", () => {
    expect(appendBoundedText("1234", "567", 5)).toBe("34567");
  });
});

describe("appendStreamingText", () => {
  test("appends genuine deltas", () => {
    expect(appendStreamingText("Test ", "received ✅")).toBe("Test received ✅");
  });

  test("deduplicates cumulative and repeated stream chunks", () => {
    expect(appendStreamingText("Test", "Test received")).toBe("Test received");
    expect(appendStreamingText("Test received", "received ✅")).toBe("Test received ✅");
    expect(appendStreamingText("Test received ✅", "received ✅")).toBe("Test received ✅");
  });
});

describe("preserveStreamedContent", () => {
  test("keeps earlier streamed assistant messages when completion only contains the last message", () => {
    expect(preserveStreamedContent("First answer", "Second answer")).toBe("First answer\n\nSecond answer");
  });

  test("does not duplicate a completion already present in the stream", () => {
    expect(preserveStreamedContent("First answer\n\nSecond answer", "Second answer")).toBe("First answer\n\nSecond answer");
  });

  test("replaces a semantically duplicated final snapshot", () => {
    const streamed = "Task Task Yang Yang Bisa Dikerjakan\n\n| No | Task |\n| 64 | Integrasikan endpoint |";
    const completed = "Task Yang Bisa Dikerjakan\n\n| No | Task |\n| 64 | Integrasikan endpoint |";
    expect(preserveStreamedContent(streamed, completed)).toBe(completed);
  });
});

describe("shouldShowChanges", () => {
  test("keeps changes attached to the latest assistant message after streaming ends", () => {
    expect(shouldShowChanges({ id: "latest", role: "assistant" }, "latest", 1)).toBe(true);
    expect(shouldShowChanges({ id: "older", role: "assistant" }, "latest", 1)).toBe(false);
    expect(shouldShowChanges({ id: "latest", role: "assistant" }, "latest", 0)).toBe(false);
  });
});

describe("projectTaskIntent", () => {
  test("routes task lists and numbered details", () => {
    expect(projectTaskIntent("ada task di project ini ga?")).toEqual({ kind: "list" });
    expect(projectTaskIntent("lu bisa lihat point nomor 4?")).toEqual({ kind: "detail", taskNo: "4" });
    expect(projectTaskIntent("show task #6")).toEqual({ kind: "detail", taskNo: "6" });
  });

  test("does not hijack unrelated test or Sonar requests", () => {
    expect(projectTaskIntent("test")).toBeNull();
    expect(projectTaskIntent("jalankan task runner npm")).toBeNull();
  });
});

describe("shouldSubmitCommand", () => {
  test("submits an already completed slash command", () => {
    expect(shouldSubmitCommand("/new", { name: "new" })).toBe(true);
    expect(shouldSubmitCommand("/ne", { name: "new" })).toBe(false);
  });
});

describe("filePickerKey", () => {
  test("navigates and picks a visible file result", () => {
    expect(filePickerKey("ArrowDown", 0, 3)).toEqual({ select: 1 });
    expect(filePickerKey("ArrowUp", 0, 3)).toEqual({ select: 2 });
    expect(filePickerKey("Enter", 1, 3)).toEqual({ pick: 1 });
    expect(filePickerKey("Tab", 1, 3)).toEqual({ pick: 1 });
    expect(filePickerKey("Escape", 0, 0)).toEqual({ close: true });
  });
});

describe("ensureAssistantTurn", () => {
  test("reuses one streaming assistant across repeated tool rounds", () => {
    const create = () => ({ id: "new", role: "assistant", text: "", toolCalls: [], isStreaming: true } as ChatMessage);
    const first = ensureAssistantTurn([], create);
    expect(ensureAssistantTurn(first, create)).toBe(first);
    expect(first).toHaveLength(1);
  });

  test("creates a new turn after the previous assistant settled", () => {
    const settled = [{ id: "old", role: "assistant", text: "done", toolCalls: [], isStreaming: false } as ChatMessage];
    expect(ensureAssistantTurn(settled, () => ({ id: "new", role: "assistant", text: "", toolCalls: [], isStreaming: true } as ChatMessage))).toHaveLength(2);
  });

  test("places the next assistant after a queued user message", () => {
    const active = { id: "old", role: "assistant", text: "done", toolCalls: [], isStreaming: true } as ChatMessage;
    const queued = { id: "queued", role: "user", text: "next", toolCalls: [] } as ChatMessage;

    expect(ensureAssistantTurn([active, queued], () => ({ id: "new", role: "assistant", text: "", toolCalls: [], isStreaming: true } as ChatMessage)).map((message) => message.id)).toEqual(["old", "queued", "new"]);
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

describe("shouldOfferRestart", () => {
  test("offers chat restart for a missing Pi session", () => {
    expect(shouldOfferRestart("Agent error: unknown session chat-acms-fe")).toBe(true);
    expect(shouldOfferRestart("Agent process stopped unexpectedly — use Restart.")).toBe(true);
    expect(shouldOfferRestart("Agent error: provider authentication failed")).toBe(false);
  });
});

describe("settleWithError", () => {
  test("does not append duplicate persistent errors", () => {
    const once = settleWithError([], "Agent process stopped unexpectedly — use Restart.");
    expect(settleWithError(once, "Agent process stopped unexpectedly — use Restart.")).toBe(once);
  });

  test("clears restart errors after recovery", () => {
    const restart = { id: "r", role: "system", text: "Agent error: Agent process stopped unexpectedly — use Restart.", toolCalls: [] } as ChatMessage;
    const useful = { id: "u", role: "user", text: "continue", toolCalls: [] } as ChatMessage;
    expect(clearRestartErrors([restart, useful])).toEqual([useful]);
  });

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

describe("formatAgentError", () => {
  test("parses nested provider billing JSON into a readable summary", () => {
    // Real runtime shape from pi: the outer "message" value is a loose string whose inner
    // JSON quotes are no longer escaped (as rendered in the app), so it is NOT strict JSON.
    const raw =
      '402: {"message": "[openai-compatible-chat-5475b8dc-a07c-4129-8ca9-56b60f090486/muse-spark-1.1] [402]: {"error":{"code":"billing_not_configured", "message":"Billing verification failed. Please check your payment method.", "param":null, "type":"billing_error"}} (reset after 1m 40s)"}';
    const out = formatAgentError(raw);
    expect(out).toContain("Billing verification failed. Please check your payment method.");
    expect(out).toContain("HTTP 402");
    expect(out).toContain("billing_not_configured");
    expect(out).toContain("muse-spark-1.1");
    expect(out).toContain("Retry available in 1m 40s.");
    expect(out).not.toContain("{\"");
  });

  test("returns plain text unchanged when there is no JSON to unwrap", () => {
    expect(formatAgentError("connection reset")).toBe("connection reset");
  });

  test("handles empty input", () => {
    expect(formatAgentError("")).toBe("Unknown agent error");
    expect(formatAgentError("   ")).toBe("Unknown agent error");
  });
});
