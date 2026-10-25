// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
vi.mock("./attachments", () => ({
  readStoredAttachment: vi.fn(async (path: string) => ({
    path,
    name: "shot.png",
  })),
  prepareComposerImage: vi.fn(async (stored) => ({
    ...stored,
    type: "image",
    id: "restored",
    data: "AAAA",
    mimeType: "image/png",
  })),
}));
import { readDraft, writeDraft, useChatDraft } from "./use-chat-draft";
import { readStoredAttachment } from "./attachments";
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

test("restores text and attachment references across remount without crossing chats", async () => {
  const toast = vi.fn();
  const first = renderHook(() => useChatDraft("a", toast));
  await waitFor(() => expect(first.result.current.restoring).toBe(false));
  act(() => {
    first.result.current.setInput("draft A");
    first.result.current.setFiles([{ name: "note.txt", path: "/note.txt" }]);
    first.result.current.setImages([
      {
        type: "image",
        id: "a",
        data: "LARGE_BASE64",
        mimeType: "image/png",
        path: "/store/shot.png",
      },
    ]);
  });
  expect(localStorage.getItem("kern:composer-draft:a")).not.toContain(
    "LARGE_BASE64",
  );
  first.unmount();
  const restored = renderHook(() => useChatDraft("a", toast));
  await waitFor(() => expect(restored.result.current.images).toHaveLength(1));
  expect(restored.result.current.input).toBe("draft A");
  expect(restored.result.current.files[0].name).toBe("note.txt");
  const other = renderHook(() => useChatDraft("b", toast));
  expect(other.result.current.input).toBe("");
  expect(other.result.current.images).toHaveLength(0);
  act(() => {
    restored.result.current.setInput("");
    restored.result.current.setFiles([]);
    restored.result.current.setImages([]);
  });
  expect(localStorage.getItem("kern:composer-draft:a")).toBeNull();
});

test("corrupt or blocked storage never blocks typing", () => {
  localStorage.setItem("kern:composer-draft:a", '{"text":4}');
  expect(readDraft("a").text).toBe("");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  expect(writeDraft("a", { text: "draft", files: [], imagePaths: [] })).toBe(
    false,
  );
  const toast = vi.fn();
  const h = renderHook(() => useChatDraft("b", toast));
  act(() => h.result.current.setInput("still typing"));
  expect(h.result.current.input).toBe("still typing");
  expect(toast).toHaveBeenCalledTimes(1);
});

test("reports a missing image but keeps the text draft", async () => {
  writeDraft("a", { text: "keep me", files: [], imagePaths: ["/missing.png"] });
  vi.mocked(readStoredAttachment).mockRejectedValueOnce(new Error("missing"));
  const toast = vi.fn();
  const h = renderHook(() => useChatDraft("a", toast));
  await waitFor(() => expect(h.result.current.restoring).toBe(false));
  expect(h.result.current.input).toBe("keep me");
  expect(toast).toHaveBeenCalledWith(
    expect.stringContaining("Draft image unavailable"),
  );
});

test("restoring a draft re-reads the stored copy instead of storing it again", async () => {
  writeDraft("c", { text: "", files: [], imagePaths: ["/store/c/1/shot.png"] });
  vi.mocked(readStoredAttachment).mockClear();
  const h = renderHook(() => useChatDraft("c", vi.fn()));
  await waitFor(() => expect(h.result.current.restoring).toBe(false));
  expect(readStoredAttachment).toHaveBeenCalledWith("/store/c/1/shot.png");
  expect(h.result.current.images.map((image) => image.path)).toEqual([
    "/store/c/1/shot.png",
  ]);
});
