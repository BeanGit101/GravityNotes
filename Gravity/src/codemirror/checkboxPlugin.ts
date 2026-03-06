import { Facet } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  MatchDecorator,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

export const checkboxToggleFacet = Facet.define<boolean, boolean>({
  combine(values) {
    return values.some(Boolean);
  },
});

export function getCheckboxToggleInsert(checked: boolean, canToggle: boolean): string | null {
  if (!canToggle) {
    return null;
  }
  return checked ? "[ ]" : "[x]";
}

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
      const replacement = getCheckboxToggleInsert(
        this.checked,
        this.view.state.facet(checkboxToggleFacet)
      );
      if (!replacement) {
        return;
      }

      this.view.dispatch({
        changes: {
          from: this.from,
          to: this.from + 3,
          insert: replacement,
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
  regexp: /\[([ xX])]/g,
  // CM6 intentionally suppresses decorations at the cursor position.
  decoration: (match, view, pos) => {
    const marker = match[1] ?? " ";
    return Decoration.replace({
      widget: new CheckboxWidget(marker.toLowerCase() === "x", pos, view),
    });
  },
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
