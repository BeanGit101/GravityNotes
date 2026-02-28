import { EditorView, Decoration, DecorationSet } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
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

const MARKER_NODE_NAMES = new Set(["EmphasisMark", "StrongEmphasisMark", "StrikethroughMark"]);

export function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const ranges: Array<{ from: number; to: number; deco: Decoration }> = [];
  const tree = syntaxTree(view.state);
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head);
  const cursorLineFrom = cursorLine.from;
  const cursorLineTo = cursorLine.to;

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        const deco = NODE_DECORATORS[node.name];
        if (deco) {
          ranges.push({ from: node.from, to: node.to, deco });
        }

        if (MARKER_NODE_NAMES.has(node.name)) {
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
      builder.add(from, to, deco);
    });

  return builder.finish();
}
