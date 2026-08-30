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

export default function ThinkingBlock({ children }: { children: string }) {
  return (
    <details className="thinking-block">
      <summary>
        <span>THINKING</span>
        <small className="thinking-show">SHOW</small>
        <small className="thinking-hide">HIDE</small>
      </summary>
      <pre>{formatThinking(children)}</pre>
    </details>
  );
}
