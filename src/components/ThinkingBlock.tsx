import { memo } from "react";

function formatThinking(value: string) {
  const jsonStart = Math.min(
    ...[value.indexOf("{"), value.indexOf("[")].filter((index) => index >= 0),
  );
  if (!Number.isFinite(jsonStart)) return value;
  const prefix = value.slice(0, jsonStart).trim();
  try {
    const formatted = JSON.stringify(
      JSON.parse(value.slice(jsonStart)),
      null,
      2,
    );
    return prefix ? `${prefix}\n\n${formatted}` : formatted;
  } catch {
    return value;
  }
}

type ThinkingBlockProps = {
  children: string;
  isStreaming?: boolean;
};

function ThinkingBlock({ children, isStreaming = false }: ThinkingBlockProps) {
  return (
    <details className="thinking-block" open={isStreaming}>
      <summary>
        <span>THINKING</span>
        <small className="thinking-show">SHOW</small>
        <small className="thinking-hide">HIDE</small>
      </summary>
      <pre>{formatThinking(children)}</pre>
    </details>
  );
}

// Same rationale as MarkdownMessage: skip re-renders while a sibling message
// streams, unless the thinking text or streaming flag changed.
export function areThinkingBlockPropsEqual(
  prev: ThinkingBlockProps,
  next: ThinkingBlockProps,
): boolean {
  return (
    prev.children === next.children &&
    (prev.isStreaming ?? false) === (next.isStreaming ?? false)
  );
}

export default memo(ThinkingBlock, areThinkingBlockPropsEqual);
