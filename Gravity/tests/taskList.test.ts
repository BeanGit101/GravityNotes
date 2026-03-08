import { describe, expect, it } from "vitest";
import { toggleNthTaskMarker } from "../src/editor/taskList";

describe("toggleNthTaskMarker", () => {
  it("toggles only the targeted task and preserves surrounding markdown", () => {
    const doc = [
      "- [ ] first task",
      "- [x] second task",
      "* [ ] third task",
      "1. [ ] fourth task",
      "Regular paragraph",
    ].join("\n");

    const toggled = toggleNthTaskMarker(doc, 2);

    expect(toggled).toBe(
      [
        "- [ ] first task",
        "- [x] second task",
        "* [x] third task",
        "1. [ ] fourth task",
        "Regular paragraph",
      ].join("\n")
    );
  });

  it("counts quoted tasks with the same index model as preview rendering", () => {
    const doc = [
      "- [ ] plain task",
      "> - [ ] quoted task",
      "> 1. [x] quoted ordered task",
      "> > - [ ] nested quoted task",
      "1. [ ] trailing task",
    ].join("\n");

    expect(toggleNthTaskMarker(doc, 1)).toBe(
      [
        "- [ ] plain task",
        "> - [x] quoted task",
        "> 1. [x] quoted ordered task",
        "> > - [ ] nested quoted task",
        "1. [ ] trailing task",
      ].join("\n")
    );

    expect(toggleNthTaskMarker(doc, 2)).toBe(
      [
        "- [ ] plain task",
        "> - [ ] quoted task",
        "> 1. [ ] quoted ordered task",
        "> > - [ ] nested quoted task",
        "1. [ ] trailing task",
      ].join("\n")
    );
  });

  it("toggles inline checkbox markers by preview index", () => {
    const doc = ["Status: - [ ] understood", "- [x] shipped", "Follow-up: - [x] verify logs"].join(
      "\n"
    );

    expect(toggleNthTaskMarker(doc, 0)).toBe(
      ["Status: - [x] understood", "- [x] shipped", "Follow-up: - [x] verify logs"].join("\n")
    );

    expect(toggleNthTaskMarker(doc, 2)).toBe(
      ["Status: - [ ] understood", "- [x] shipped", "Follow-up: - [ ] verify logs"].join("\n")
    );
  });

  it("toggles inline markers inside formatted prose without changing formatting", () => {
    const doc = ["Status: **- [ ]** bold", "Follow-up: _- [x]_ italic"].join("\n");

    expect(toggleNthTaskMarker(doc, 0)).toBe(
      ["Status: **- [x]** bold", "Follow-up: _- [x]_ italic"].join("\n")
    );

    expect(toggleNthTaskMarker(doc, 1)).toBe(
      ["Status: **- [ ]** bold", "Follow-up: _- [ ]_ italic"].join("\n")
    );
  });

  it("ignores bare markers and checkbox-like text inside code", () => {
    const doc = [
      "[ ] standalone marker",
      "Inline code `Status: - [ ] ignored` stays literal",
      "Status: - [ ] interactive",
    ].join("\n");

    expect(toggleNthTaskMarker(doc, 0)).toBe(
      [
        "[ ] standalone marker",
        "Inline code `Status: - [ ] ignored` stays literal",
        "Status: - [x] interactive",
      ].join("\n")
    );
  });

  it("returns the original document when the index does not match any task", () => {
    const doc = ["- [ ] one", "- [x] two"].join("\n");
    expect(toggleNthTaskMarker(doc, 99)).toBe(doc);
  });
});
