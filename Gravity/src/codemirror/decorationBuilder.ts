import { EditorView, Decoration, DecorationSet } from "@codemirror/view";
import { RangeSet, RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

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
  FencedCode: Decoration.mark({ class: "md-code-block" }),
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

export function buildDecorations(view: EditorView): DecorationSet {
  const markBuilder = new RangeSetBuilder<Decoration>();
  const lineBuilder = new RangeSetBuilder<Decoration>();
  const ranges: Array<{ from: number; to: number; deco: Decoration }> = [];
  const tree = syntaxTree(view.state);
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head);
  const cursorLineFrom = cursorLine.from;
  const cursorLineTo = cursorLine.to;
  const hasUsableRanges = view.visibleRanges.some((range) => range.to > range.from);
  const rangesToScan = hasUsableRanges
    ? view.visibleRanges
    : [{ from: 0, to: view.state.doc.length }];

  for (const { from, to } of rangesToScan) {
    tree.iterate({
      from,
      to,
      enter(node) {
        const deco = NODE_DECORATORS[node.name];
        if (deco) {
          ranges.push({ from: node.from, to: node.to, deco });
        }

        if (node.name === "ATXHeading1") {
          const line = view.state.doc.lineAt(node.from);
          lineBuilder.add(line.from, line.from, Decoration.line({ class: "md-h1-line" }));
        }

        if (node.name === "ATXHeading2") {
          const line = view.state.doc.lineAt(node.from);
          lineBuilder.add(line.from, line.from, Decoration.line({ class: "md-h2-line" }));
        }

        if (node.name === "ATXHeading3") {
          const line = view.state.doc.lineAt(node.from);
          lineBuilder.add(line.from, line.from, Decoration.line({ class: "md-h3-line" }));
        }

        if (node.name === "Blockquote") {
          const line = view.state.doc.lineAt(node.from);
          lineBuilder.add(line.from, line.from, Decoration.line({ class: "md-blockquote-line" }));
        }

        if (SIMPLE_MARKER_NODE_NAMES.has(node.name)) {
          const onCursorLine = node.from >= cursorLineFrom && node.from <= cursorLineTo;
          if (!onCursorLine) {
            ranges.push({ from: node.from, to: node.to, deco: HIDDEN_MARKER_DECORATION });
          }
        }

        if (node.name === "LinkMark") {
          const onCursorLine = node.from >= cursorLineFrom && node.from <= cursorLineTo;
          if (!onCursorLine) {
            const markerText = view.state.doc.sliceString(node.from, node.to);
            if (LINK_MARKER_TEXT_TO_HIDE.has(markerText)) {
              ranges.push({ from: node.from, to: node.to, deco: HIDDEN_MARKER_DECORATION });
            }
          }
        }

        if (LINK_DESTINATION_NODE_NAMES.has(node.name)) {
          const onCursorLine = node.from >= cursorLineFrom && node.from <= cursorLineTo;
          if (!onCursorLine) {
            ranges.push({ from: node.from, to: node.to, deco: HIDDEN_MARKER_DECORATION });
          }
        }
      },
    });
  }

  ranges
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .forEach(({ from, to, deco }) => {
      markBuilder.add(from, to, deco);
    });

  return RangeSet.join([markBuilder.finish(), lineBuilder.finish()]);
}
