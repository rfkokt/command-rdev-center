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
  width?: number;
  height?: number;
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

export function inlineImageSize(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error("Invalid image dimensions");
  const scale = Math.min(1, 1568 / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Claude-style area estimate only; providers may resize or tokenize differently. */
export function estimatedImageTokens(width: number, height: number) {
  return Math.ceil((width * height) / 750);
}

/**
 * Vision APIs cap one inline image at about 5 MB (Anthropic: 5 MB). Kept a
 * little under so the base64 body, not the decoded bytes, stays in bounds.
 */
export const MAX_INLINE_IMAGE_BASE64 = 4_900_000;

function encodeCanvas(
  canvas: HTMLCanvasElement,
  mime: string,
  quality?: number,
) {
  const encoded = canvas.toDataURL(mime, quality);
  const prefix = `data:${mime};base64,`;
  if (!encoded.startsWith(prefix))
    throw new Error("Couldn't encode resized image");
  return encoded.slice(prefix.length);
}

/** Prepare inline bytes only. The attachment store's original is never changed. */
export async function prepareComposerImage(
  stored: StoredAttachment,
): Promise<ComposerImage> {
  if (!stored.data) throw new Error("Stored image has no preview data");
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Couldn't decode attached image"));
    image.src = `data:${stored.mime};base64,${stored.data}`;
  });
  const size = inlineImageSize(image.naturalWidth, image.naturalHeight);
  let data = stored.data;
  let mimeType = stored.mime;
  const resized =
    size.width !== image.naturalWidth || size.height !== image.naturalHeight;
  if (resized || data.length > MAX_INLINE_IMAGE_BASE64) {
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image resizing is unavailable");
    context.drawImage(image, 0, 0, size.width, size.height);
    // Photos stay JPEG: a 1568px photo re-encoded as PNG is often several MB
    // and can exceed the provider's inline limit. Other formats become PNG to
    // keep transparency; animated input becomes a static inline frame.
    if (stored.mime === "image/jpeg") {
      data = encodeCanvas(canvas, "image/jpeg", 0.9);
      mimeType = "image/jpeg";
    } else {
      data = encodeCanvas(canvas, "image/png");
      mimeType = "image/png";
    }
    if (data.length > MAX_INLINE_IMAGE_BASE64) {
      // Last resort for huge PNG screenshots: flatten onto white as JPEG.
      context.globalCompositeOperation = "destination-over";
      context.fillStyle = "#fff";
      context.fillRect(0, 0, size.width, size.height);
      data = encodeCanvas(canvas, "image/jpeg", 0.85);
      mimeType = "image/jpeg";
    }
    if (data.length > MAX_INLINE_IMAGE_BASE64)
      throw new Error("Image is too large to send inline even after resizing");
  }
  return {
    type: "image",
    id: composerImageId(),
    name: stored.name,
    path: stored.path,
    data,
    mimeType,
    ...size,
  };
}

/** Re-open a file already in the attachment store (draft restore) without copying it. */
export function readStoredAttachment(path: string) {
  return invoke<StoredAttachment>("read_stored_attachment", { path });
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
