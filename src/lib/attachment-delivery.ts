import type { ChatImage } from "./rpc";
import { toChatImage, type ComposerImage } from "./attachments";
import type { ImageSupport } from "./model-capabilities";

const ENVELOPE_HEADER = "\n\nAttached image files (JSON records):\n";
const TEXT_ONLY_NOTE =
  "\nThe current model cannot see images. Use the saved files if needed; do not assume their visual contents.";
const UNKNOWN_MARKER = "\n[kern:image-support-unknown]";

/**
 * Remove the agent-facing image envelope from a stored user message, so a
 * reloaded chat (and prompt-history recall) shows what the user typed rather
 * than JSON records and the fallback marker.
 */
export function stripDeliveryEnvelope(text: string): string {
  const start = text.indexOf(ENVELOPE_HEADER);
  if (start < 0) return text;
  let end = start + ENVELOPE_HEADER.length;
  // One JSON record per line.
  while (end < text.length && text[end] === "{") {
    const newline = text.indexOf("\n", end);
    const line = text.slice(end, newline < 0 ? text.length : newline);
    try {
      JSON.parse(line);
    } catch {
      break;
    }
    end = newline < 0 ? text.length : newline + 1;
  }
  let rest = text.slice(end);
  if (end > 0 && text[end - 1] === "\n") rest = `\n${rest}`;
  if (rest.startsWith(TEXT_ONLY_NOTE)) rest = rest.slice(TEXT_ONLY_NOTE.length);
  if (rest.startsWith(UNKNOWN_MARKER)) rest = rest.slice(UNKNOWN_MARKER.length);
  return (text.slice(0, start) + (rest === "\n" ? "" : rest)).trimEnd();
}

/** Saved files always reach the agent by path, even without vision input. */
export function planImageDelivery(
  text: string,
  images: readonly ComposerImage[],
  support: ImageSupport,
): { message: string; images: ChatImage[] } {
  if (!images.length) return { message: text, images: [] };
  if (images.some((image) => !image.path))
    throw new Error(
      "An image is not saved yet. Wait for the upload or attach it again.",
    );
  const paths = images.map((image) =>
    JSON.stringify({
      name: image.name ?? "image",
      path: image.path,
      mime: image.mimeType,
    }),
  );
  const note = support === false ? TEXT_ONLY_NOTE : "";
  return {
    message: `${text}${ENVELOPE_HEADER}${paths.join("\n")}${note}${support === null ? UNKNOWN_MARKER : ""}`,
    images: support === false ? [] : images.map(toChatImage),
  };
}
