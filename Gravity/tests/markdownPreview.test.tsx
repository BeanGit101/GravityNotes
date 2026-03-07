import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownPreview } from "../src/components/MarkdownPreview";

describe("MarkdownPreview rendering", () => {
  it("renders GFM pipe tables with the preview table classes", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview
        value={["| Name | Status |", "| --- | --- |", "| Gravity | Ready |"].join("\n")}
        onToggleTask={() => {}}
      />
    );

    expect(html).toContain("<table");
    expect(html).toContain("markdown-preview__table");
    expect(html).toContain("markdown-preview__thead");
    expect(html).toContain("markdown-preview__row");
    expect(html).toContain("markdown-preview__header-cell");
    expect(html).toContain("markdown-preview__cell");
  });

  it("renders GFM task list checkboxes with explicit task indexes", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview value={["- [ ] first", "- [x] second"].join("\n")} onToggleTask={() => {}} />
    );

    expect(html).toContain('data-task-index="0"');
    expect(html).toContain('data-task-index="1"');
    expect(html).toContain("markdown-preview__task-checkbox");
  });

  it("renders inline checkbox markers as preview checkboxes", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview value="Status: - [ ] Understood" onToggleTask={() => {}} />
    );

    expect(html).toContain('data-task-index="0"');
    expect(html).toContain("Status:");
    expect(html).toContain("Understood");
    expect(html).toContain("markdown-preview__task-checkbox");
  });

  it("keeps mixed inline and list checkboxes in source order", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview
        value={["Status: - [ ] Understood", "- [x] Shipped", "Follow-up: - [ ] Verify logs"].join(
          "\n"
        )}
        onToggleTask={() => {}}
      />
    );

    expect(html.indexOf('data-task-index="0"')).toBeLessThan(html.indexOf('data-task-index="1"'));
    expect(html.indexOf('data-task-index="1"')).toBeLessThan(html.indexOf('data-task-index="2"'));
  });
});
