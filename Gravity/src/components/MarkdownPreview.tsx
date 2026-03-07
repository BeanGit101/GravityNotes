import {
  Children,
  cloneElement,
  isValidElement,
  type ComponentPropsWithoutRef,
  type JSX,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  parseCheckboxes,
  type CheckboxDescriptor,
  type CheckboxKind,
} from "../editor/checkboxParser";

interface MarkdownPreviewProps {
  value: string;
  onToggleTask: (taskIndex: number) => void;
}

type MarkdownInputProps = ComponentPropsWithoutRef<"input"> & {
  node?: unknown;
  "data-task-index"?: number | string;
};

type MarkdownElementProps<Tag extends keyof JSX.IntrinsicElements> =
  ComponentPropsWithoutRef<Tag> & {
    node?: unknown;
  };

interface PreviewRenderState {
  checkboxes: CheckboxDescriptor[];
  nextIndex: number;
  onToggleTask: (taskIndex: number) => void;
}

const INLINE_TASK_RENDER_PATTERN = /-\s+\[(?: |x|X)\]/g;

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

function takeNextCheckbox(
  state: PreviewRenderState,
  expectedKind: CheckboxKind
): CheckboxDescriptor | null {
  const checkbox = state.checkboxes[state.nextIndex];
  if (!checkbox || checkbox.kind !== expectedKind) {
    return null;
  }

  state.nextIndex += 1;
  return checkbox;
}

function renderPreviewCheckbox(
  checkbox: CheckboxDescriptor,
  state: PreviewRenderState,
  key: string
): JSX.Element {
  return (
    <input
      key={key}
      type="checkbox"
      className="markdown-preview__task-checkbox"
      checked={checkbox.checked}
      data-task-index={checkbox.index}
      disabled={false}
      onChange={() => {
        state.onToggleTask(checkbox.index);
      }}
    />
  );
}

function replaceInlineCheckboxes(
  text: string,
  state: PreviewRenderState,
  keyPrefix: string
): ReactNode {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let matchCount = 0;

  for (const match of text.matchAll(INLINE_TASK_RENDER_PATTERN)) {
    const matchIndex = match.index;

    if (matchIndex > lastIndex) {
      nodes.push(text.slice(lastIndex, matchIndex));
    }

    const checkbox = takeNextCheckbox(state, "inline");
    if (!checkbox) {
      nodes.push(match[0]);
    } else {
      nodes.push(renderPreviewCheckbox(checkbox, state, `${keyPrefix}-${String(matchCount)}`));
    }

    lastIndex = matchIndex + match[0].length;
    matchCount += 1;
  }

  if (nodes.length === 0) {
    return text;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function transformPreviewChildren(
  children: ReactNode,
  state: PreviewRenderState,
  keyPrefix: string
): ReactNode {
  return Children.map(children, (child, index) => {
    const childKey = `${keyPrefix}-${String(index)}`;

    if (typeof child === "string") {
      return replaceInlineCheckboxes(child, state, childKey);
    }

    if (!isValidElement(child)) {
      return child;
    }

    const element = child as ReactElement<{
      children?: ReactNode;
      type?: string;
      checked?: boolean;
      "data-task-index"?: number | string;
    }>;

    if (element.props.type === "checkbox") {
      const checkbox = takeNextCheckbox(state, "list");
      if (!checkbox) {
        return child;
      }

      return cloneElement(element, {
        checked: checkbox.checked,
        "data-task-index": checkbox.index,
      });
    }

    if (element.props.children === undefined) {
      return child;
    }

    return cloneElement(
      element,
      undefined,
      transformPreviewChildren(element.props.children, state, childKey)
    );
  });
}

export function MarkdownPreview({ value, onToggleTask }: MarkdownPreviewProps) {
  const previewState: PreviewRenderState = {
    checkboxes: parseCheckboxes(value),
    nextIndex: 0,
    onToggleTask,
  };

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
      const { node, className, children, ...rest } = props;
      void node;
      return (
        <td {...rest} className={mergeClassNames(className, "markdown-preview__cell")}>
          {transformPreviewChildren(children, previewState, "td")}
        </td>
      );
    },
    th: (props: MarkdownElementProps<"th">) => {
      const { node, className, children, ...rest } = props;
      void node;
      return (
        <th {...rest} className={mergeClassNames(className, "markdown-preview__header-cell")}>
          {transformPreviewChildren(children, previewState, "th")}
        </th>
      );
    },
    p: (props: MarkdownElementProps<"p">) => {
      const { node, children, ...rest } = props;
      void node;
      return <p {...rest}>{transformPreviewChildren(children, previewState, "p")}</p>;
    },
    li: (props: MarkdownElementProps<"li">) => {
      const { node, className, children, ...rest } = props;
      void node;
      return (
        <li {...rest} className={mergeClassNames(className, "markdown-preview__list-item")}>
          {transformPreviewChildren(children, previewState, "li")}
        </li>
      );
    },
    h1: (props: MarkdownElementProps<"h1">) => {
      const { node, children, ...rest } = props;
      void node;
      return <h1 {...rest}>{transformPreviewChildren(children, previewState, "h1")}</h1>;
    },
    h2: (props: MarkdownElementProps<"h2">) => {
      const { node, children, ...rest } = props;
      void node;
      return <h2 {...rest}>{transformPreviewChildren(children, previewState, "h2")}</h2>;
    },
    h3: (props: MarkdownElementProps<"h3">) => {
      const { node, children, ...rest } = props;
      void node;
      return <h3 {...rest}>{transformPreviewChildren(children, previewState, "h3")}</h3>;
    },
    h4: (props: MarkdownElementProps<"h4">) => {
      const { node, children, ...rest } = props;
      void node;
      return <h4 {...rest}>{transformPreviewChildren(children, previewState, "h4")}</h4>;
    },
    h5: (props: MarkdownElementProps<"h5">) => {
      const { node, children, ...rest } = props;
      void node;
      return <h5 {...rest}>{transformPreviewChildren(children, previewState, "h5")}</h5>;
    },
    h6: (props: MarkdownElementProps<"h6">) => {
      const { node, children, ...rest } = props;
      void node;
      return <h6 {...rest}>{transformPreviewChildren(children, previewState, "h6")}</h6>;
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
    input: (props: MarkdownInputProps) => {
      const { node, className, ...rest } = props;
      void node;

      const taskIndex = parseTaskIndex(rest["data-task-index"]);
      if (rest.type !== "checkbox" || taskIndex === null) {
        return <input className={className} {...rest} />;
      }

      return (
        <input
          {...rest}
          data-task-index={taskIndex}
          className={mergeClassNames(className, "markdown-preview__task-checkbox")}
          checked={Boolean(rest.checked)}
          disabled={false}
          onChange={() => {
            onToggleTask(taskIndex);
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
