import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const MARKER = "[kern:image-support-unknown]";

export function isImageRejection(error: string) {
  return /(?:does not support|doesn't support|not support|unsupported|not supported|cannot accept|only supports)[^\n.]{0,100}(?:image|vision|multimodal)|(?:image|vision|multimodal|image_url)[^\n.]{0,100}(?:not supported|unsupported|not allowed|text.only)/i.test(
    error,
  );
}

/** Append-only context edits retain original attachments in session history. */
export default function imageFallback(pi: ExtensionAPI) {
  let eligible = false;
  let attempted = false;
  const reset = () => {
    eligible = false;
    attempted = false;
  };
  pi.on("session_start", reset);
  pi.on("message_start", ({ message }) => {
    if (message.role !== "user") return;
    attempted = false;
    eligible =
      Array.isArray(message.content) &&
      message.content.some(
        (block) => block.type === "text" && block.text.includes(MARKER),
      ) &&
      message.content.some((block) => block.type === "image");
  });
  pi.on("agent_before_settle", (event, ctx) => {
    if (
      !eligible ||
      attempted ||
      event.outcome !== "error" ||
      event.continue ||
      ctx.signal?.aborted ||
      ctx.hasPendingMessages()
    )
      return;
    const last = event.context.contextMessages.at(-1);
    if (
      last?.role !== "assistant" ||
      last.stopReason !== "error" ||
      !isImageRejection(last.errorMessage ?? "")
    )
      return;
    const entries = event.context.contextEntries.flatMap(
      ({ sourceEntry, messages }) => {
        if (
          sourceEntry.type !== "message" &&
          sourceEntry.type !== "custom_message"
        )
          return [];
        const message = messages[0];
        if (
          !message ||
          !Array.isArray(message.content) ||
          !message.content.some((block) => block.type === "image")
        )
          return [];
        return [
          {
            type: "context_edit" as const,
            targetId: sourceEntry.id,
            replacement: {
              content: message.content.filter(
                (block) => block.type !== "image",
              ),
            },
          },
        ];
      },
    );
    if (!entries.length) return;
    attempted = true;
    ctx.ui.notify(
      "The model rejected images. Retrying once using saved file paths only.",
      "warning",
    );
    return {
      entries: [
        ...entries,
        {
          type: "custom_message" as const,
          customType: "kern-image-fallback",
          display: true,
          content:
            "The model rejected image input. Inline images were removed from model context; retrying once using the saved file paths. Do not assume the visual contents of these files.",
        },
      ],
      continue: true,
    };
  });
}
