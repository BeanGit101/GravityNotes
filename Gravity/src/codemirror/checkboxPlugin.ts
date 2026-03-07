import { Facet, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { parseCheckboxes } from "../editor/checkboxParser";

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

function selectionIntersectsCheckbox(view: EditorView, from: number, to: number): boolean {
  return view.state.selection.ranges.some((range) => {
    if (range.empty) {
      return range.from >= from && range.from <= to;
    }

    return range.from < to && range.to > from;
  });
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

function buildCheckboxDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const checkboxes = parseCheckboxes(view.state.doc.toString());

  for (const { from, to } of view.visibleRanges) {
    checkboxes.forEach((checkbox) => {
      if (checkbox.to < from || checkbox.from > to) {
        return;
      }

      if (selectionIntersectsCheckbox(view, checkbox.from, checkbox.to)) {
        return;
      }

      builder.add(
        checkbox.from,
        checkbox.to,
        Decoration.replace({
          widget: new CheckboxWidget(checkbox.checked, checkbox.from, view),
        })
      );
    });
  }

  return builder.finish();
}

export const checkboxPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildCheckboxDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        this.decorations = buildCheckboxDecorations(update.view);
      }
    }
  },
  {
    decorations: (value) => value.decorations,
  }
);
