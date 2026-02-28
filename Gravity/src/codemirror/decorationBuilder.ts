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

export function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        const deco = NODE_DECORATORS[node.name];
        if (deco) {
          builder.add(node.from, node.to, deco);
        }
      },
    });
  }

  return builder.finish();
}
