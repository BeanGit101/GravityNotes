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

  it("returns the original document when the index does not match any task", () => {
    const doc = ["- [ ] one", "- [x] two"].join("\n");
    expect(toggleNthTaskMarker(doc, 99)).toBe(doc);
  });
});
