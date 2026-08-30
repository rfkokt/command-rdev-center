import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";

export default function SyntaxCodeBlock({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  return (
    <SyntaxHighlighter
      language={language || "text"}
      style={vscDarkPlus}
      showLineNumbers
      customStyle={{ margin: 0, border: 0, borderRadius: 0 }}
    >
      {code}
    </SyntaxHighlighter>
  );
}
