// @vitest-environment jsdom

import { act } from "react";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

describe("NoteEditor find input", () => {
  let container: HTMLDivElement;
  let root: Root;
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
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps focus in the find input while the query changes", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <NoteEditor
          note={note}
          value="hello world hello"
          onChange={() => {}}
          onAutoSave={async () => {}}
          isLoading={false}
          viewMode="edit"
        />
      );
      await Promise.resolve();
    });

    const findButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Find"
    );
    expect(findButton).toBeDefined();

    await act(async () => {
      findButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const findInput = container.querySelector('input[placeholder="Find"]') as HTMLInputElement | null;
    expect(findInput).not.toBeNull();
    expect(document.activeElement).toBe(findInput);

    await act(async () => {
      if (findInput) {
        findInput.value = "he";
        findInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(findInput?.value).toBe("he");
    expect(document.activeElement).toBe(findInput);
  });
});
