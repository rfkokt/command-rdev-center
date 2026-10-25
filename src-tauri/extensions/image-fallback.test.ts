// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import fallback, { isImageRejection } from "./image-fallback";

function harness() {
  // The production event API is heterogeneous; this mock dispatches its hooks directly.
  const hooks = new Map<string, (...args: any[]) => any>();
  fallback({
    on: (name: string, fn: (...args: any[]) => any) => hooks.set(name, fn),
  } as any);
  const image = { type: "image", data: "AAAA", mimeType: "image/png" };
  const user = {
    role: "user",
    content: [{ type: "text", text: "plan + RAG + /store/shot.png" }, image],
  };
  const error = {
    role: "assistant",
    stopReason: "error",
    errorMessage: "This model does not support image input",
    content: [],
  };
  const event = {
    outcome: "error",
    continue: false,
    entries: [],
    context: {
      canContinue: false,
      contextMessages: [user, error],
      contextEntries: [
        { sourceEntry: { type: "message", id: "user" }, messages: [user] },
        { sourceEntry: { type: "message", id: "error" }, messages: [error] },
      ],
    },
  };
  const ctx = {
    signal: new AbortController().signal,
    hasPendingMessages: () => false,
    ui: { notify: vi.fn() },
  };
  const start = () =>
    hooks.get("message_start")!({
      message: {
        role: "user",
        content: [
          { type: "text", text: "look [kern:image-support-unknown]" },
          image,
        ],
      },
    });
  const settle = () => hooks.get("agent_before_settle")!(event, ctx);
  start();
  return { hooks, event, ctx, user, error, settle, start };
}

describe("image fallback lifecycle", () => {
  it("projects a path-only retry without mutating history, then refuses a second retry", () => {
    const h = harness();
    const result = h.settle();
    expect(result.continue).toBe(true);
    const edit = result.entries.find(
      (entry: any) => entry.type === "context_edit",
    );
    expect(edit.targetId).toBe("user");
    expect(edit.replacement.content).toEqual([
      { type: "text", text: "plan + RAG + /store/shot.png" },
    ]);
    const projected = h.event.context.contextEntries.map(
      ({ sourceEntry, messages }) =>
        sourceEntry.id === edit.targetId
          ? { ...messages[0], content: edit.replacement.content }
          : messages[0],
    );
    expect(
      projected
        .flatMap((message) => message.content)
        .some((block) => block.type === "image"),
    ).toBe(false);
    expect(h.user.content.some((block) => block.type === "image")).toBe(true);
    expect(h.settle()).toBeUndefined();
    expect(h.ctx.ui.notify).toHaveBeenCalledTimes(1);
  });

  it.each([
    "rate limit for image model",
    "image service unavailable",
    "invalid image data",
    "context length exceeded",
  ])("does not retry unrelated error: %s", (error) => {
    const h = harness();
    h.error.errorMessage = error;
    expect(h.settle()).toBeUndefined();
  });
  it.each(["aborted", "completed"])("does not retry outcome %s", (outcome) => {
    const h = harness();
    h.event.outcome = outcome;
    expect(h.settle()).toBeUndefined();
  });
  it("does not retry cancelled or queued work", () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    h.ctx.signal = controller.signal;
    expect(h.settle()).toBeUndefined();
    const queued = harness();
    queued.ctx.hasPendingMessages = () => true;
    expect(queued.settle()).toBeUndefined();
  });
  it("does not retry known-support prompts, and resets for a new prompt", () => {
    const h = harness();
    h.hooks.get("message_start")!({
      message: {
        role: "user",
        content: [
          { type: "text", text: "vision" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      },
    });
    expect(h.settle()).toBeUndefined();
    h.start();
    expect(h.settle()?.continue).toBe(true);
  });
  it.each([
    "image_url is not supported",
    "Unsupported image input",
    "This model only supports text-only input, not images",
  ])("recognizes explicit modality rejection: %s", (error) => {
    expect(isImageRejection(error)).toBe(true);
  });
});
