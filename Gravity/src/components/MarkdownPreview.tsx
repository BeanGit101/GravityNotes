import { type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownPreviewProps {
  value: string;
  onToggleTask: (taskIndex: number) => void;
}

type MarkdownInputProps = ComponentPropsWithoutRef<"input"> & {
  node?: unknown;
};

export function MarkdownPreview({ value, onToggleTask }: MarkdownPreviewProps) {
  const components: Components = {
    table: (props) => {
      const { node, ...rest } = props;
      void node;
      return <table className="markdown-preview__table" {...rest} />;
    },
    thead: (props) => {
      const { node, ...rest } = props;
      void node;
      return <thead className="markdown-preview__thead" {...rest} />;
    },
    td: (props) => {
      const { node, ...rest } = props;
      void node;
      return <td className="markdown-preview__cell" {...rest} />;
    },
    th: (props) => {
      const { node, ...rest } = props;
      void node;
      return <th className="markdown-preview__header-cell" {...rest} />;
    },
    blockquote: (props) => {
      const { node, ...rest } = props;
      void node;
      return <blockquote className="markdown-preview__blockquote" {...rest} />;
    },
    pre: (props) => {
      const { node, ...rest } = props;
      void node;
      return <pre className="markdown-preview__pre" {...rest} />;
    },
    code: (props) => {
      const { node, ...rest } = props;
      void node;
      return <code className="markdown-preview__code" {...rest} />;
    },
    ul: (props) => {
      const { node, ...rest } = props;
      void node;
      return <ul className="markdown-preview__list" {...rest} />;
    },
    ol: (props) => {
      const { node, ...rest } = props;
      void node;
      return <ol className="markdown-preview__list" {...rest} />;
    },
    li: (props) => {
      const { node, ...rest } = props;
      void node;
      return <li className="markdown-preview__list-item" {...rest} />;
    },
    input: (props: MarkdownInputProps) => {
      const { node, className, ...rest } = props;
      void node;

      if (rest.type !== "checkbox") {
        return <input className={className} {...rest} />;
      }

      const mergedClassName = [className, "markdown-preview__task-checkbox"]
        .filter(Boolean)
        .join(" ");

      return (
        <input
          {...rest}
          className={mergedClassName}
          checked={Boolean(rest.checked)}
          disabled={false}
          onChange={(event) => {
            const root = event.currentTarget.closest(".markdown-preview");
            if (!root) {
              return;
            }

            const checkboxes = Array.from(
              root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
            );
            const taskIndex = checkboxes.indexOf(event.currentTarget);
            if (taskIndex >= 0) {
              onToggleTask(taskIndex);
            }
          }}
        />
      );
    },
  };

  return (
    <div className="markdown-preview">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {value}
      </ReactMarkdown>
    </div>
  );
}
