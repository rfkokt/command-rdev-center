import { invoke } from "@tauri-apps/api/core";
import type { ChatImage } from "./rpc";

/**
 * Composer attachments (docs/tasks/orca-essentials O1-02). Images keep their
 * inline bytes for preview and sending, plus the path of their copy in the
 * per-chat attachment store (src-tauri/src/attachments.rs) once stored.
 */
export type ComposerImage = ChatImage & {
  /** Local key; stable while the image sits in the composer. */
  id: string;
  name?: string;
  /** Copy in the attachment store; absent until storing finishes. */
  path?: string;
};

/** Mirrors `attachments::StoredAttachment`. */
export type StoredAttachment = {
  id: string;
  name: string;
  path: string;
  mime: string;
  size: number;
  data?: string;
};

const INLINE_IMAGE_EXTENSIONS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Image formats vision APIs take inline (the rest travel as files). */
export function inlineImageMime(path: string): string | null {
  const ext = path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
  return (ext && INLINE_IMAGE_EXTENSIONS[ext]) || null;
}

export function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

let nextImageId = 0;
export function composerImageId() {
  nextImageId += 1;
  return `img-${Date.now().toString(36)}-${nextImageId}`;
}

/** What the agent protocol takes: the extra composer fields stay behind. */
export function toChatImage(image: ChatImage): ChatImage {
  return { type: "image", data: image.data, mimeType: image.mimeType };
}

/** Copy a dropped or picked file into the chat's store (images come back with data). */
export function storeAttachmentFile(chatId: string, path: string) {
  return invoke<StoredAttachment>("store_attachment_file", { chatId, path });
}

/** Store pasted bytes; sent as a raw IPC body so nothing is base64-inflated. */
export async function storePastedFile(chatId: string, file: File) {
  const extension = file.type.split("/")[1]?.replace("jpeg", "jpg") || "bin";
  const name = file.name || `pasted-${Date.now()}.${extension}`;
  return invoke<StoredAttachment>(
    "save_attachment_bytes",
    new Uint8Array(await file.arrayBuffer()),
    {
      headers: {
        "x-chat-id": encodeURIComponent(chatId),
        "x-file-name": encodeURIComponent(name),
        "x-mime": encodeURIComponent(file.type || "application/octet-stream"),
      },
    },
  );
}

/**
 * Whether a native drag position (physical pixels, from Tauri's drag-drop
 * event) falls inside an element.
 */
export function dropLandsOn(
  element: Element | null | undefined,
  position: { x: number; y: number },
  scale = window.devicePixelRatio || 1,
) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const x = position.x / scale;
  const y = position.y / scale;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}
