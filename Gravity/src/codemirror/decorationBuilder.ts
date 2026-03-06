import { Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import { RangeSet, EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNodeRef } from "@lezer/common";

const NODE_DECORATORS: Record<string, Decoration> = {
  // Headings
  ATXHeading1: Decoration.mark({ class: "md-h1" }),
  ATXHeading2: Decoration.mark({ class: "md-h2" }),
  ATXHeading3: Decoration.mark({ class: "md-h3" }),

  // Inline
  Emphasis: Decoration.mark({ class: "md-italic" }),
  StrongEmphasis: Decoration.mark({ class: "md-bold" }),
  InlineCode: Decoration.mark({ class: "md-inline-code" }),
  Strikethrough: Decoration.mark({ class: "md-strikethrough" }),

  // Block
  Blockquote: Decoration.mark({ class: "md-blockquote" }),
  Link: Decoration.mark({ class: "md-link" }),
  Image: Decoration.mark({ class: "md-image" }),
};

const HIDDEN_MARKER_DECORATION = Decoration.replace({});

const SIMPLE_MARKER_NODE_NAMES = new Set([
  "EmphasisMark",
  "StrongEmphasisMark",
  "StrikethroughMark",
  "HeaderMark",
  "QuoteMark",
  "ListMark",
  "CodeMark",
  "TaskMarker",
]);

const LINK_DESTINATION_NODE_NAMES = new Set(["URL", "LinkTitle"]);
const LINK_MARKER_TEXT_TO_HIDE = new Set(["(", ")"]);
class CodeBlockWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly language: string
  ) {
    super();
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "md-codeblock";

    const pre = document.createElement("pre");
    const codeEl = document.createElement("code");
    codeEl.className = `language-${this.language}`;
    codeEl.textContent = this.code;
    pre.appendChild(codeEl);

    const langBadge = document.createElement("span");
    langBadge.className = "md-codeblock-lang-badge";
    langBadge.textContent = this.language || "text";

    const copyBtn = document.createElement("button");
    copyBtn.className = "md-codeblock-copy";
    copyBtn.textContent = "Copy";

    copyBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      void navigator.clipboard.writeText(this.code).then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => (copyBtn.textContent = "Copy"), 2000);
      });
    });

    wrapper.appendChild(langBadge);
    wrapper.appendChild(copyBtn);
    wrapper.appendChild(pre);

    return wrapper;
  }

  override eq(other: CodeBlockWidget): boolean {
    return other.code === this.code && other.language === this.language;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function isInsideFencedCode(node: SyntaxNodeRef): boolean {
  let current = node.node.parent;
  while (current) {
    if (current.name === "FencedCode") {
      return true;
    }
    current = current.parent;
  }
  return false;
}

export function buildDecorations(state: EditorState): DecorationSet {
  const ranges: Array<{ from: number; to: number; deco: Decoration }> = [];
  const tree = syntaxTree(state);
  const cursorLine = state.doc.lineAt(state.selection.main.head);
  const cursorLineFrom = cursorLine.from;
  const cursorLineTo = cursorLine.to;

  tree.iterate({
    enter(node) {
      const deco = NODE_DECORATORS[node.name];
      if (deco) {
        ranges.push({ from: node.from, to: node.to, deco });
      }

      if (node.name === "FencedCode") {
        if (cursorLineFrom <= node.to && cursorLineTo >= node.from) {
          return;
        }

        const src = state.sliceDoc(node.from, node.to);
        const lines = src.split("\n");
        const lang = lines[0]?.replace(/^`+/, "").trim() || "";
        const code = lines.slice(1, -1).join("\n");

        ranges.push({
          from: node.from,
          to: node.to,
          deco: Decoration.replace({
            widget: new CodeBlockWidget(code, lang),
            block: true,
          }),
        });
      }

      if (node.name === "ATXHeading1") {
        const line = state.doc.lineAt(node.from);
        ranges.push({ from: line.from, to: line.from, deco: Decoration.line({ class: "md-h1-line" }) });
      }

      if (node.name === "ATXHeading2") {
        const line = state.doc.lineAt(node.from);
        ranges.push({ from: line.from, to: line.from, deco: Decoration.line({ class: "md-h2-line" }) });
      }

      if (node.name === "ATXHeading3") {
        const line = state.doc.lineAt(node.from);
        ranges.push({ from: line.from, to: line.from, deco: Decoration.line({ class: "md-h3-line" }) });
      }

      if (node.name === "Blockquote") {
        const line = state.doc.lineAt(node.from);
        ranges.push({ from: line.from, to: line.from, deco: Decoration.line({ class: "md-blockquote-line" }) });
      }

      if (SIMPLE_MARKER_NODE_NAMES.has(node.name)) {
        if (isInsideFencedCode(node)) {
          return;
        }
        const onCursorLine = node.from >= cursorLineFrom && node.from <= cursorLineTo;
        if (!onCursorLine) {
          ranges.push({ from: node.from, to: node.to, deco: HIDDEN_MARKER_DECORATION });
        }
      }

      if (node.name === "LinkMark") {
        if (isInsideFencedCode(node)) {
          return;
        }
        const onCursorLine = node.from >= cursorLineFrom && node.from <= cursorLineTo;
        if (!onCursorLine) {
          const markerText = state.doc.sliceString(node.from, node.to);
          if (LINK_MARKER_TEXT_TO_HIDE.has(markerText)) {
            ranges.push({ from: node.from, to: node.to, deco: HIDDEN_MARKER_DECORATION });
          }
        }
      }

      if (LINK_DESTINATION_NODE_NAMES.has(node.name)) {
        if (isInsideFencedCode(node)) {
          return;
        }
        const onCursorLine = node.from >= cursorLineFrom && node.from <= cursorLineTo;
        if (!onCursorLine) {
          ranges.push({ from: node.from, to: node.to, deco: HIDDEN_MARKER_DECORATION });
        }
      }
    },
  });

  const cmDecorations = ranges.map((d) => d.deco.range(d.from, d.to));
  cmDecorations.sort((a, b) => {
    const aSide = "startSide" in a.value ? a.value.startSide : 0;
    const bSide = "startSide" in b.value ? b.value.startSide : 0;
    return a.from - b.from || aSide - bSide;
  });

  return RangeSet.of(cmDecorations, true);
}
