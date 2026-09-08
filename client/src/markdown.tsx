import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isSafeUrl } from "../../src/shared/protocol.ts";

export function SafeMarkdown({ text }: { text: string }): React.ReactElement {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => {
            const h = href ?? "#";
            if (!isSafeUrl(h)) {
              return <span className="unsafe-link">{children}</span>;
            }
            const external = /^https?:/.test(h);
            return (
              <a href={h} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                {children}
              </a>
            );
          },
          img: () => <span className="img-disabled">[image disabled]</span>,
          table: ({ children }) => (
            <div className="table-scroll">
              <table>{children}</table>
            </div>
          ),
          pre: ({ children }) => (
            <div className="code-scroll">
              <pre>{children}</pre>
            </div>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function EscapedPre({ text }: { text: string }): React.ReactElement {
  return <div className="escaped-pre">{text}</div>;
}
