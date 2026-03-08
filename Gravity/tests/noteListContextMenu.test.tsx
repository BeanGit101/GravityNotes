// @vitest-environment jsdom

import { act } from "react";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteList } from "../src/components/NoteList";
import type { FileSystemItem, TrashEntry } from "../src/types/notes";

const notes: FileSystemItem[] = [
  {
    type: "file",
    id: "/vault/one.md",
    title: "one",
    path: "/vault/one.md",
  },
];

const trashEntries: TrashEntry[] = [];
const malformedTrashEntries = [
  {
    id: "trash-1",
    name: "orphan.md",
    originalPath: undefined,
    type: "file",
    deletedAt: Date.now(),
  },
] as unknown as TrashEntry[];

describe("NoteList context menu", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders trash entries with missing original paths without crashing", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <NoteList
          directoryPath="/vault"
          notes={notes}
          trashEntries={malformedTrashEntries}
          selectedNoteId={null}
          selectedFolderPath={null}
          onOpenVault={() => {}}
          onCreateNote={() => {}}
          onRenameNote={() => {}}
          onMoveNote={() => {}}
          onCreateFolder={() => {}}
          onRenameFolder={() => {}}
          onMoveFolder={() => {}}
          onDeleteFolder={() => {}}
          onSelectFolder={() => {}}
          onSelectNote={() => {}}
          onOpenInNewPane={() => {}}
          onDeleteNote={() => {}}
          onRestoreTrashEntry={() => {}}
          onPermanentlyDeleteTrashEntry={() => {}}
          errorMessage={null}
        />
      );
    });

    expect(container.textContent).toContain("orphan.md");
    expect(container.textContent).toContain("Original path unavailable");
  });

  it("closes the menu and runs the split action", async () => {
    const onOpenInNewPane = vi.fn();

    await act(async () => {
      root = createRoot(container);
      root.render(
        <NoteList
          directoryPath="/vault"
          notes={notes}
          trashEntries={trashEntries}
          selectedNoteId={null}
          selectedFolderPath={null}
          onOpenVault={() => {}}
          onCreateNote={() => {}}
          onRenameNote={() => {}}
          onMoveNote={() => {}}
          onCreateFolder={() => {}}
          onRenameFolder={() => {}}
          onMoveFolder={() => {}}
          onDeleteFolder={() => {}}
          onSelectFolder={() => {}}
          onSelectNote={() => {}}
          onOpenInNewPane={onOpenInNewPane}
          onDeleteNote={() => {}}
          onRestoreTrashEntry={() => {}}
          onPermanentlyDeleteTrashEntry={() => {}}
          errorMessage={null}
        />
      );
    });

    const menuButton = container.querySelector(
      'button[aria-label="Open actions for one"]'
    ) as HTMLButtonElement | null;
    expect(menuButton).not.toBeNull();

    await act(async () => {
      menuButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const menuItem = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Open in split pane"
    );
    expect(menuItem).toBeDefined();

    await act(async () => {
      menuItem?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(onOpenInNewPane).toHaveBeenCalledWith(notes[0]);
    expect(container.textContent).not.toContain("Open in split pane");
  });

  it("always removes window listeners when the menu closes", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    await act(async () => {
      root = createRoot(container);
      root.render(
        <NoteList
          directoryPath="/vault"
          notes={notes}
          trashEntries={trashEntries}
          selectedNoteId={null}
          selectedFolderPath={null}
          onOpenVault={() => {}}
          onCreateNote={() => {}}
          onRenameNote={() => {}}
          onMoveNote={() => {}}
          onCreateFolder={() => {}}
          onRenameFolder={() => {}}
          onMoveFolder={() => {}}
          onDeleteFolder={() => {}}
          onSelectFolder={() => {}}
          onSelectNote={() => {}}
          onOpenInNewPane={() => {}}
          onDeleteNote={() => {}}
          onRestoreTrashEntry={() => {}}
          onPermanentlyDeleteTrashEntry={() => {}}
          errorMessage={null}
        />
      );
    });

    const menuButton = container.querySelector(
      'button[aria-label="Open actions for one"]'
    ) as HTMLButtonElement | null;

    await act(async () => {
      menuButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const clickHandler = addSpy.mock.calls.find((call) => call[0] === "click")?.[1];
    const keydownHandler = addSpy.mock.calls.find((call) => call[0] === "keydown")?.[1];

    expect(clickHandler).toBeDefined();
    expect(keydownHandler).toBeDefined();

    await act(async () => {
      window.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(
      removeSpy.mock.calls.some((call) => call[0] === "click" && call[1] === clickHandler)
    ).toBe(true);
    expect(
      removeSpy.mock.calls.some((call) => call[0] === "keydown" && call[1] === keydownHandler)
    ).toBe(true);
  });

  it("removes window listeners when the list unmounts with the menu open", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    await act(async () => {
      root = createRoot(container);
      root.render(
        <NoteList
          directoryPath="/vault"
          notes={notes}
          trashEntries={trashEntries}
          selectedNoteId={null}
          selectedFolderPath={null}
          onOpenVault={() => {}}
          onCreateNote={() => {}}
          onRenameNote={() => {}}
          onMoveNote={() => {}}
          onCreateFolder={() => {}}
          onRenameFolder={() => {}}
          onMoveFolder={() => {}}
          onDeleteFolder={() => {}}
          onSelectFolder={() => {}}
          onSelectNote={() => {}}
          onOpenInNewPane={() => {}}
          onDeleteNote={() => {}}
          onRestoreTrashEntry={() => {}}
          onPermanentlyDeleteTrashEntry={() => {}}
          errorMessage={null}
        />
      );
    });

    const menuButton = container.querySelector(
      'button[aria-label="Open actions for one"]'
    ) as HTMLButtonElement | null;

    await act(async () => {
      menuButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const clickHandler = addSpy.mock.calls.find((call) => call[0] === "click")?.[1];
    const keydownHandler = addSpy.mock.calls.find((call) => call[0] === "keydown")?.[1];

    expect(clickHandler).toBeDefined();
    expect(keydownHandler).toBeDefined();

    await act(async () => {
      root.unmount();
    });

    root = createRoot(container);

    expect(
      removeSpy.mock.calls.some((call) => call[0] === "click" && call[1] === clickHandler)
    ).toBe(true);
    expect(
      removeSpy.mock.calls.some((call) => call[0] === "keydown" && call[1] === keydownHandler)
    ).toBe(true);
  });
});
