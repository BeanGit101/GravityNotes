// @vitest-environment jsdom

import { act, useState } from "react";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteEditor } from "../src/components/NoteEditor";
import type { Note, NoteDocument, NoteMetadata } from "../src/types/notes";

const firstNote: Note = {
  id: "/vault/one.md",
  title: "one",
  path: "/vault/one.md",
  tags: [],
};

const secondNote: Note = {
  id: "/vault/two.md",
  title: "two",
  path: "/vault/two.md",
  tags: [],
};

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

interface FrontmatterHarnessProps {
  initialMetadata?: NoteMetadata;
  onAutoSave?: (value: NoteDocument) => Promise<void>;
}

function FrontmatterHarness({ initialMetadata, onAutoSave = async () => {} }: FrontmatterHarnessProps) {
  const [value, setValue] = useState("Body copy");
  const [metadata, setMetadata] = useState<NoteMetadata>(initialMetadata ?? { tags: [] });

  return (
    <>
      <output data-testid="subject-value">{metadata.subject ?? ""}</output>
      <button
        type="button"
        onClick={() => {
          setMetadata((current) => ({
            ...current,
            subject: "Project alpha",
          }));
        }}
      >
        Apply subject
      </button>
      <NoteEditor
        note={firstNote}
        metadata={metadata}
        value={value}
        onChange={setValue}
        onMetadataChange={setMetadata}
        onAutoSave={onAutoSave}
        isLoading={false}
        viewMode="edit"
      />
    </>
  );
}

function NoteSwitchHarness() {
  const [activeNote, setActiveNote] = useState(firstNote);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setActiveNote((current) => (current.id === firstNote.id ? secondNote : firstNote));
        }}
      >
        Switch note
      </button>
      <NoteEditor
        note={activeNote}
        metadata={{
          subject: activeNote.id === firstNote.id ? "First note" : "Second note",
          tags: [],
        }}
        value="Body copy"
        onChange={() => {}}
        onMetadataChange={() => {}}
        onAutoSave={async () => {}}
        isLoading={false}
        viewMode="edit"
      />
    </>
  );
}

describe("NoteEditor frontmatter", () => {
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
    vi.useRealTimers();
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container.remove();
  });

  it("starts collapsed and shows existing frontmatter as a summary", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <FrontmatterHarness
          initialMetadata={{
            subject: "Project alpha",
            tags: ["planning"],
          }}
        />
      );
      await Promise.resolve();
    });

    const toggleButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Edit details"
    );

    expect(toggleButton?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("Project alpha");
    expect(container.textContent).toContain("#planning");
    expect(container.querySelector('input[placeholder="Optional subject"]')).toBeNull();
  });

  it("can expand and collapse the optional frontmatter section", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<FrontmatterHarness />);
      await Promise.resolve();
    });

    const toggleButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Add details"
    );

    await act(async () => {
      toggleButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(toggleButton?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('input[placeholder="Optional subject"]')).not.toBeNull();

    const hideButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Hide details"
    );

    await act(async () => {
      hideButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(hideButton?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('input[placeholder="Optional subject"]')).toBeNull();
  });

  it("stays expanded while metadata changes", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<FrontmatterHarness />);
      await Promise.resolve();
    });

    const toggleButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Add details"
    );

    await act(async () => {
      toggleButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const subjectInput = container.querySelector(
      'input[placeholder="Optional subject"]'
    ) as HTMLInputElement | null;

    await act(async () => {
      if (subjectInput) {
        subjectInput.value = "Project alpha";
        subjectInput.dispatchEvent(new Event("input", { bubbles: true }));
        subjectInput.dispatchEvent(new Event("change", { bubbles: true }));
      }
      await Promise.resolve();
    });

    expect(subjectInput?.value).toBe("Project alpha");
    expect(toggleButton?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('input[placeholder="Optional subject"]')).not.toBeNull();
  });

  it("resets to collapsed when a different note opens in the pane", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<NoteSwitchHarness />);
      await Promise.resolve();
    });

    const editButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Edit details"
    );

    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector('input[placeholder="Optional subject"]')).not.toBeNull();

    const switchButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Switch note"
    );

    await act(async () => {
      switchButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const collapsedButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Edit details"
    );

    expect(collapsedButton?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('input[placeholder="Optional subject"]')).toBeNull();
    expect(container.textContent).toContain("Second note");
  });
});





