import { EditorState, StateField } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { DecorationSet, EditorView } from "@codemirror/view";
import { buildDecorations } from "./decorationBuilder";

function cursorLineNumber(viewState: EditorState): number {
  return viewState.doc.lineAt(viewState.selection.main.head).number;
}

export const markdownDecoratorPlugin = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state);
  },
  update(value, tr) {
    if (tr.docChanged) {
      return buildDecorations(tr.state);
    }

    if (syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      return buildDecorations(tr.state);
    }

    if (tr.selection) {
      const startLine = cursorLineNumber(tr.startState);
      const nextLine = cursorLineNumber(tr.state);
      if (startLine !== nextLine) {
        return buildDecorations(tr.state);
      }
    }

    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const markdownTheme = EditorView.baseTheme({
  // Line decorations
  ".md-h1-line": {
    backgroundColor: "rgba(82, 139, 255, 0.08)",
    borderRadius: "6px",
  },
  ".md-h2-line": {
    backgroundColor: "rgba(82, 139, 255, 0.06)",
    borderRadius: "6px",
  },
  ".md-h3-line": {
    backgroundColor: "rgba(82, 139, 255, 0.04)",
    borderRadius: "6px",
  },
  ".md-blockquote-line": {
    borderLeft: "3px solid rgba(128, 128, 128, 0.5)",
    paddingLeft: "0.9em",
  },

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
  ".md-codeblock": {
    position: "relative",
    backgroundColor: "#1e1e2e",
    borderRadius: "6px",
    margin: "8px 0",
    overflow: "hidden",
  },
  ".md-codeblock pre": {
    margin: "0",
    padding: "16px",
    overflowX: "auto",
    fontFamily: '"JetBrains Mono", "Fira Code", monospace',
    fontSize: "13px",
    lineHeight: "1.6",
  },
  ".md-codeblock code": {
    backgroundColor: "transparent",
    padding: "0",
    color: "#cdd6f4",
  },
  ".md-codeblock-lang-badge": {
    position: "absolute",
    top: "6px",
    right: "48px",
    fontSize: "11px",
    color: "#6c7086",
    fontFamily: "sans-serif",
    pointerEvents: "none",
    textTransform: "lowercase",
  },
  ".md-codeblock-copy": {
    position: "absolute",
    top: "4px",
    right: "8px",
    backgroundColor: "transparent",
    border: "none",
    color: "#6c7086",
    fontSize: "11px",
    cursor: "pointer",
    padding: "2px 6px",
    borderRadius: "4px",
    fontFamily: "sans-serif",
    opacity: "0",
    transition: "opacity 0.15s",
  },
  ".md-codeblock:hover .md-codeblock-copy": {
    opacity: "1",
  },
  ".md-codeblock-copy:hover": {
    color: "#cdd6f4",
    backgroundColor: "#313244",
  },

  // Table decorations
  ".md-table": {
    backgroundColor: "rgba(82, 139, 255, 0.04)",
    borderRadius: "4px",
  },
  ".md-table-header": {
    fontWeight: "700",
    color: "#2f415f",
  },
  ".md-table-cell": {
    color: "#1f2937",
  },
  ".md-table-delimiter": {
    opacity: 0.6,
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
  ".md-checkbox": {
    cursor: "pointer",
    verticalAlign: "middle",
    margin: 0,
    padding: 0,
    accentColor: "#528bff",
  },
});
