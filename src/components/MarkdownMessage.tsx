import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function MarkdownMessage({ children }: { children: string }) {
  return <div className="markdown-body">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        input: ({ node: _node, ...props }) => <input {...props} disabled />,
        table: ({ children: tChildren, ...props }) => (
          <div className="md-table-wrapper">
            <table {...props}>{tChildren}</table>
          </div>
        ),
      }}
    >{children}</ReactMarkdown>
  </div>;
}
