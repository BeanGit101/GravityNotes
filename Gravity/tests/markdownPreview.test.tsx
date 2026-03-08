// @vitest-environment jsdom

import { act } from "react";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownPreview } from "../src/components/MarkdownPreview";

describe("MarkdownPreview rendering", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container.remove();
  });

  async function renderPreview(value: string, onToggleTask = vi.fn()) {
    await act(async () => {
      root = createRoot(container);
      root.render(<MarkdownPreview value={value} onToggleTask={onToggleTask} />);
      await Promise.resolve();
    });

    return onToggleTask;
  }

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

  it("renders inline checkbox markers as interactive preview checkboxes", async () => {
    const onToggleTask = await renderPreview("Status: - [ ] Working?", vi.fn());
    const checkbox = container.querySelector(
      'input.markdown-preview__task-checkbox[data-task-index="0"]'
    ) as HTMLInputElement | null;

    expect(checkbox).not.toBeNull();
    expect(container.textContent).toContain("Status: - ");
    expect(container.textContent).toContain("Working?");

    await act(async () => {
      checkbox?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(onToggleTask).toHaveBeenCalledWith(0);
  });

  it("keeps mixed inline and list checkboxes in parser order when toggled", async () => {
    const onToggleTask = await renderPreview(
      ["Status: - [ ] Understood", "- [x] Shipped", "Follow-up: - [ ] Verify logs"].join("\n"),
      vi.fn()
    );
    const checkboxes = Array.from(
      container.querySelectorAll("input.markdown-preview__task-checkbox")
    ) as HTMLInputElement[];

    expect(checkboxes).toHaveLength(3);

    await act(async () => {
      checkboxes.forEach((checkbox) => {
        checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await Promise.resolve();
    });

    expect(onToggleTask.mock.calls).toEqual([[0], [1], [2]]);
  });

  it("does not render interactive checkboxes for inline code or fenced code", async () => {
    await renderPreview(
      [
        "Inline code `Status: - [ ] ignored` stays literal",
        "```md",
        "Status: - [x] ignored",
        "```",
        "Bare [ ] marker stays text",
      ].join("\n")
    );

    expect(container.querySelector("input.markdown-preview__task-checkbox")).toBeNull();
    expect(container.textContent).toContain("ignored");
    expect(container.textContent).toContain("Bare [ ] marker stays text");
  });
});
