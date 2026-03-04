import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
    readonly view: EditorView
  ) {
    super();
  }

  override eq(other: CheckboxWidget): boolean {
    return this.checked === other.checked && this.from === other.from;
  }

  override toDOM(): HTMLElement {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "md-checkbox";
    checkbox.checked = this.checked;

    checkbox.addEventListener("mousedown", (event: MouseEvent) => {
      event.preventDefault();
      if (this.view.state.readOnly) {
        return;
      }

      this.view.dispatch({
        changes: {
          from: this.from,
          to: this.from + 3,
          insert: this.checked ? "[ ]" : "[x]",
        },
      });
    });

    return checkbox;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

const checkboxDecorator = new MatchDecorator({
  regexp: /\[([ x])]/g,
  // CM6 intentionally suppresses decorations at the cursor position.
  decoration: (match, view, pos) =>
    Decoration.replace({
      widget: new CheckboxWidget(match[1] === "x", pos, view),
    }),
});

export const checkboxPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = checkboxDecorator.createDeco(view);
    }

    update(update: ViewUpdate): void {
      this.decorations = checkboxDecorator.updateDeco(update, this.decorations);
    }
  },
  {
    decorations: (value) => value.decorations,
  }
);
