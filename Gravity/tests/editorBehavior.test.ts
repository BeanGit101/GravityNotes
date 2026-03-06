import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { type DecorationSet } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { getCheckboxToggleInsert } from "../src/codemirror/checkboxPlugin";
import { buildDecorations } from "../src/codemirror/decorationBuilder";

function collectHiddenMarkerRanges(decorations: DecorationSet): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  decorations.between(0, Number.MAX_SAFE_INTEGER, (from, to, value) => {
    const spec = value.spec as { block?: boolean; class?: string; widget?: unknown };
    const isHiddenMarker = spec.block !== true && spec.class === undefined && spec.widget === undefined;
    if (isHiddenMarker) {
      ranges.push([from, to]);
    }
  });
  return ranges;
}

function collectDecorationClasses(decorations: DecorationSet): Set<string> {
  const classes = new Set<string>();
  decorations.between(0, Number.MAX_SAFE_INTEGER, (_from, _to, value) => {
    const spec = value.spec as { class?: string };
    if (spec.class) {
      classes.add(spec.class);
    }
  });
  return classes;
}

function hasOverlap(ranges: Array<[number, number]>, markerFrom: number, markerLength = 1): boolean {
  const markerTo = markerFrom + markerLength;
  return ranges.some(([from, to]) => from < markerTo && to > markerFrom);
}

describe("editor behavior", () => {
  it("respects read-only checkbox toggle rules", () => {
    expect(getCheckboxToggleInsert(true, false)).toBeNull();
    expect(getCheckboxToggleInsert(false, false)).toBeNull();
    expect(getCheckboxToggleInsert(true, true)).toBe("[ ]");
    expect(getCheckboxToggleInsert(false, true)).toBe("[x]");
  });

  it("decorates headings, bold text, and tables with GFM", () => {
    const doc = [
      "# Heading",
      "Setext Heading",
      "-----",
      "Some **bold** text.",
      "| col-a | col-b |",
      "| --- | --- |",
      "| one | two |",
    ].join("\n");

    const state = EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [markdown({ extensions: [GFM] })],
    });

    const classes = collectDecorationClasses(buildDecorations(state));
    expect(classes.has("md-h1")).toBe(true);
    expect(classes.has("md-h2")).toBe(true);
    expect(classes.has("md-h1-line")).toBe(true);
    expect(classes.has("md-h2-line")).toBe(true);
    expect(classes.has("md-bold")).toBe(true);
    expect(classes.has("md-table")).toBe(true);
    expect(classes.has("md-table-header")).toBe(true);
    expect(classes.has("md-table-cell")).toBe(true);
    expect(classes.has("md-table-delimiter")).toBe(true);
  });

  it("updates hidden marker decorations when cursor moves lines", () => {
    const doc = "*first*\n*second*";
    const firstLineOpenMarker = doc.indexOf("*");
    const firstLineCloseMarker = doc.indexOf("*", firstLineOpenMarker + 1);
    const secondLineOpenMarker = doc.indexOf("*", firstLineCloseMarker + 1);
    const secondLineCloseMarker = doc.lastIndexOf("*");

    const firstState = EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [markdown({ extensions: [GFM] })],
    });

    const firstRanges = collectHiddenMarkerRanges(buildDecorations(firstState));
    expect(hasOverlap(firstRanges, firstLineOpenMarker)).toBe(false);
    expect(hasOverlap(firstRanges, firstLineCloseMarker)).toBe(false);
    expect(hasOverlap(firstRanges, secondLineOpenMarker)).toBe(true);
    expect(hasOverlap(firstRanges, secondLineCloseMarker)).toBe(true);

    const secondState = firstState.update({
      selection: { anchor: doc.indexOf("second") },
    }).state;

    const secondRanges = collectHiddenMarkerRanges(buildDecorations(secondState));
    expect(hasOverlap(secondRanges, firstLineOpenMarker)).toBe(true);
    expect(hasOverlap(secondRanges, firstLineCloseMarker)).toBe(true);
    expect(hasOverlap(secondRanges, secondLineOpenMarker)).toBe(false);
    expect(hasOverlap(secondRanges, secondLineCloseMarker)).toBe(false);
  });
});
