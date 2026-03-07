import {
  type ComponentPropsWithoutRef,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { createCheckboxPreviewPlugin } from "./markdownPreviewCheckboxes";

interface MarkdownPreviewProps {
  value: string;
  onToggleTask: (taskIndex: number) => void;
}

type MarkdownInputProps = ComponentPropsWithoutRef<"input"> & {
  node?: unknown;
  "data-task-index"?: number | string;
  dataTaskIndex?: number | string;
};

type MarkdownElementProps<Tag extends keyof JSX.IntrinsicElements> =
  ComponentPropsWithoutRef<Tag> & {
    node?: unknown;
  };

function mergeClassNames(...classNames: Array<string | undefined>): string | undefined {
  const mergedClassName = classNames.filter(Boolean).join(" ");
  return mergedClassName || undefined;
}

function parseTaskIndex(value: number | string | undefined): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : null;
  }

  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

export function MarkdownPreview({ value, onToggleTask }: MarkdownPreviewProps) {
  const checkboxPreviewPlugin = createCheckboxPreviewPlugin(value);

  const components: Components = {
    table: (props) => {
      const { node, className, ...rest } = props;
      void node;
      return <table {...rest} className={mergeClassNames(className, "markdown-preview__table")} />;
    },
    thead: (props) => {
      const { node, className, ...rest } = props;
      void node;
      return <thead {...rest} className={mergeClassNames(className, "markdown-preview__thead")} />;
    },
    tbody: (props) => {
      const { node, className, ...rest } = props;
      void node;
      return <tbody {...rest} className={mergeClassNames(className, "markdown-preview__tbody")} />;
    },
    tr: (props) => {
      const { node, className, ...rest } = props;
      void node;
      return <tr {...rest} className={mergeClassNames(className, "markdown-preview__row")} />;
    },
    td: (props: MarkdownElementProps<"td">) => {
      const { node, className, ...rest } = props;
      void node;
      return <td {...rest} className={mergeClassNames(className, "markdown-preview__cell")} />;
    },
    th: (props: MarkdownElementProps<"th">) => {
      const { node, className, ...rest } = props;
      void node;
      return (
        <th {...rest} className={mergeClassNames(className, "markdown-preview__header-cell")} />
      );
    },
    blockquote: (props) => {
      const { node, className, ...rest } = props;
      void node;
      return (
        <blockquote
          {...rest}
          className={mergeClassNames(className, "markdown-preview__blockquote")}
        />
      );
    },
    pre: (props) => {
      const { node, className, ...rest } = props;
      void node;
      return <pre {...rest} className={mergeClassNames(className, "markdown-preview__pre")} />;
    },
    code: (props) => {
      const { node, className, ...rest } = props;
      void node;
      return <code {...rest} className={mergeClassNames(className, "markdown-preview__code")} />;
    },
    ul: (props) => {
      const { node, className, ...rest } = props;
      void node;
      return <ul {...rest} className={mergeClassNames(className, "markdown-preview__list")} />;
    },
    ol: (props) => {
      const { node, className, ...rest } = props;
      void node;
      return <ol {...rest} className={mergeClassNames(className, "markdown-preview__list")} />;
    },
    li: (props: MarkdownElementProps<"li">) => {
      const { node, className, ...rest } = props;
      void node;
      return <li {...rest} className={mergeClassNames(className, "markdown-preview__list-item")} />;
    },
    input: (props: MarkdownInputProps) => {
      const { node, className, dataTaskIndex, ...rest } = props;
      void node;

      const taskIndex = parseTaskIndex(rest["data-task-index"] ?? dataTaskIndex);
      if (rest.type !== "checkbox" || taskIndex === null) {
        return <input className={className} {...rest} />;
      }

      const handleToggle = (
        event: ReactMouseEvent<HTMLInputElement> | ReactKeyboardEvent<HTMLInputElement>
      ) => {
        event.preventDefault();
        event.stopPropagation();
        onToggleTask(taskIndex);
      };

      return (
        <input
          {...rest}
          data-task-index={taskIndex}
          className={mergeClassNames(className, "markdown-preview__task-checkbox")}
          checked={Boolean(rest.checked)}
          disabled={false}
          readOnly
          onClick={handleToggle}
          onKeyDown={(event) => {
            if (event.key === " " || event.key === "Enter") {
              handleToggle(event);
            }
          }}
        />
      );
    },
  };

  return (
    <div className="markdown-preview">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[checkboxPreviewPlugin]}
        components={components}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}
