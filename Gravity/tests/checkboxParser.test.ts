import { describe, expect, it } from "vitest";
import { parseCheckboxes } from "../src/editor/checkboxParser";

describe("parseCheckboxes", () => {
  it("parses list, quoted, ordered, and inline checkboxes in source order", () => {
    const markdown = [
      "- [ ] plain task",
      "Status: - [x] inline task",
      "> 1. [ ] quoted ordered task",
      "Summary: - [ ] follow-up",
    ].join("\n");

    expect(parseCheckboxes(markdown)).toMatchObject([
      { index: 0, kind: "list", checked: false },
      { index: 1, kind: "inline", checked: true },
      { index: 2, kind: "list", checked: false },
      { index: 3, kind: "inline", checked: false },
    ]);
  });

  it("ignores bare markers and checkbox-like syntax inside code", () => {
    const markdown = [
      "[ ] standalone marker",
      "Inline code `Status: - [ ] ignored` stays literal",
      "```md",
      "- [x] fenced task stays literal",
      "```",
      "Status: - [ ] interactive",
    ].join("\n");

    expect(parseCheckboxes(markdown)).toMatchObject([{ index: 0, kind: "inline", checked: false }]);
  });

  it("captures multiple inline checkboxes on the same line", () => {
    const markdown = "Checklist: - [ ] first and - [x] second";

    expect(parseCheckboxes(markdown)).toMatchObject([
      { index: 0, kind: "inline", checked: false },
      { index: 1, kind: "inline", checked: true },
    ]);
  });

  it("keeps inline markers interactive inside formatted prose", () => {
    const markdown = ["Status: **- [x]** bold", "Follow-up: _- [ ]_ italic"].join("\n");

    expect(parseCheckboxes(markdown)).toMatchObject([
      { index: 0, kind: "inline", checked: true },
      { index: 1, kind: "inline", checked: false },
    ]);
  });
});
