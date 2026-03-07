// @vitest-environment jsdom

import { act, useState } from "react";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteEditor } from "../src/components/NoteEditor";
import type { Note } from "../src/types/notes";

const note: Note = {
  id: "/vault/one.md",
  title: "one",
  path: "/vault/one.md",
};

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

interface CheckboxHarnessProps {
  initialValue: string;
  viewMode: "edit" | "preview";
  onAutoSave: (value: string) => Promise<void>;
}

function CheckboxHarness({ initialValue, viewMode, onAutoSave }: CheckboxHarnessProps) {
  const [value, setValue] = useState(initialValue);

  return (
    <>
      <output data-testid="note-value">{value}</output>
      <NoteEditor
        note={note}
        value={value}
        onChange={setValue}
        onAutoSave={onAutoSave}
        isLoading={false}
        viewMode={viewMode}
      />
    </>
  );
}

describe("NoteEditor checkbox interactions", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;
  const originalScrollIntoView = Element.prototype.scrollIntoView;

  beforeAll(() => {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverMock,
    });
    window.requestAnimationFrame = (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0);
    window.cancelAnimationFrame = (handle: number) => {
      window.clearTimeout(handle);
    };
    Element.prototype.scrollIntoView = () => {};
  });

  afterAll(() => {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: originalResizeObserver,
    });
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

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

  it("toggles inline checkboxes in preview mode and persists immediately", async () => {
    const onAutoSave = vi.fn(async () => {});

    await act(async () => {
      root = createRoot(container);
      root.render(
        <CheckboxHarness
          initialValue="Status: - [ ] Working?"
          viewMode="preview"
          onAutoSave={onAutoSave}
        />
      );
      await Promise.resolve();
    });

    const checkbox = container.querySelector(
      'input.markdown-preview__task-checkbox[data-task-index="0"]'
    ) as HTMLInputElement | null;
    const valueOutput = container.querySelector('[data-testid="note-value"]');

    expect(checkbox).not.toBeNull();
    expect(valueOutput?.textContent).toBe("Status: - [ ] Working?");

    await act(async () => {
      checkbox?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(valueOutput?.textContent).toBe("Status: - [x] Working?");
    expect(onAutoSave).toHaveBeenCalledWith("Status: - [x] Working?");
  });

  it("toggles inline checkboxes from the editor widget in edit mode", async () => {
    const onAutoSave = vi.fn(async () => {});

    await act(async () => {
      root = createRoot(container);
      root.render(
        <CheckboxHarness
          initialValue="Status: - [ ] Working?"
          viewMode="edit"
          onAutoSave={onAutoSave}
        />
      );
      await Promise.resolve();
    });

    const checkbox = container.querySelector("input.md-checkbox") as HTMLInputElement | null;
    const valueOutput = container.querySelector('[data-testid="note-value"]');

    expect(checkbox).not.toBeNull();
    expect(valueOutput?.textContent).toBe("Status: - [ ] Working?");

    await act(async () => {
      checkbox?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await Promise.resolve();
    });

    expect(valueOutput?.textContent).toBe("Status: - [x] Working?");
  });
});
