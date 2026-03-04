import { DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { buildDecorations } from "./decorationBuilder";

export const markdownDecoratorPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    pendingUpdate = false;
    rafId: number | null = null;
    timeoutId: number | null = null;
    lastView: EditorView | null = null;
    initialRafId: number | null = null;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
      this.lastView = view;

      if (view.visibleRanges.length === 0) {
        this.initialRafId = window.requestAnimationFrame(() => {
          this.decorations = buildDecorations(view);
          this.initialRafId = null;
        });
      }
    }

    update(update: ViewUpdate): void {
      const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);

      if (update.viewportChanged || update.selectionSet || treeChanged) {
        this.decorations = buildDecorations(update.view);
        return;
      }

      if (update.docChanged) {
        this.decorations = this.decorations.map(update.changes);
      }

      this.lastView = update.view;

      if (this.pendingUpdate) {
        return;
      }

      this.pendingUpdate = true;
      this.rafId = window.requestAnimationFrame(() => {
        this.timeoutId = window.setTimeout(() => {
          const view = this.lastView;
          if (view) {
            this.decorations = buildDecorations(view);
          }
          this.pendingUpdate = false;
          this.rafId = null;
          this.timeoutId = null;
        }, 50);
      });
    }

    destroy(): void {
      if (this.initialRafId !== null) {
        window.cancelAnimationFrame(this.initialRafId);
        this.initialRafId = null;
      }
      if (this.rafId !== null) {
        window.cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      if (this.timeoutId !== null) {
        window.clearTimeout(this.timeoutId);
        this.timeoutId = null;
      }
      this.pendingUpdate = false;
      this.lastView = null;
    }
  },
  {
    decorations: (value) => value.decorations,
  }
);

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
  ".md-checkbox": {
    cursor: "pointer",
    verticalAlign: "middle",
    margin: 0,
    padding: 0,
    accentColor: "#528bff",
  },
});
