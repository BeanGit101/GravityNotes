import { DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { buildDecorations } from "./decorationBuilder";

export const markdownDecoratorPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (value) => value.decorations,
  }
);

export const markdownTheme = EditorView.baseTheme({
  // Headings
  ".md-h1": {
    fontSize: "1.8em",
    fontWeight: "600",
    lineHeight: "1.3",
    paddingTop: "0.6em",
    paddingBottom: "0.3em",
    borderBottom: "1px solid rgba(128, 128, 128, 0.4)",
  },
  ".md-h2": {
    fontSize: "1.5em",
    fontWeight: "600",
    lineHeight: "1.35",
    paddingTop: "0.5em",
    paddingBottom: "0.25em",
  },
  ".md-h3": {
    fontSize: "1.25em",
    fontWeight: "600",
    lineHeight: "1.4",
    paddingTop: "0.4em",
    paddingBottom: "0.2em",
  },

  // Inline
  ".md-italic": {
    fontStyle: "italic",
  },
  ".md-bold": {
    fontWeight: "700",
  },
  ".md-inline-code": {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
    fontSize: "0.95em",
    backgroundColor: "rgba(135, 131, 120, 0.15)",
    padding: "0.1em 0.3em",
    borderRadius: "4px",
  },
  ".md-strikethrough": {
    textDecoration: "line-through",
    textDecorationThickness: "0.1em",
  },

  // Blocks
  ".md-blockquote": {
    borderLeft: "3px solid rgba(128, 128, 128, 0.5)",
    marginLeft: "0",
    paddingLeft: "0.9em",
    color: "rgba(80, 80, 80, 0.95)",
    fontStyle: "italic",
  },
  ".md-code-block": {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
    fontSize: "0.9em",
    backgroundColor: "rgba(135, 131, 120, 0.15)",
    borderRadius: "6px",
    padding: "0.5em 0.75em",
    display: "inline-block",
  },

  // Links / images
  ".md-link": {
    color: "#528bff",
    textDecoration: "underline",
    textUnderlineOffset: "0.12em",
  },
  ".md-image": {
    opacity: 0.9,
  },
});
