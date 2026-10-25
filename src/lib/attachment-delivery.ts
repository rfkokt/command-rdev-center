import type { ChatImage } from "./rpc";
import { toChatImage, type ComposerImage } from "./attachments";
import type { ImageSupport } from "./model-capabilities";

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
  const note =
    support === false
      ? "\nThe current model cannot see images. Use the saved files if needed; do not assume their visual contents."
      : "";
  return {
    message: `${text}\n\nAttached image files (JSON records):\n${paths.join("\n")}${note}${support === null ? "\n[kern:image-support-unknown]" : ""}`,
    images: support === false ? [] : images.map(toChatImage),
  };
}
