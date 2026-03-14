// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileSystemItem } from "../src/types/notes";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const services = vi.hoisted(() => {
  const makeNote = (id: string, title: string, path: string, tags: string[] = []): FileSystemItem => ({
    id,
    title,
    path,
    tags,
    type: "file",
    updatedAt: 0,
    updatedAtSource: "filesystem",
  });

  const state = {
    notes: [] as FileSystemItem[],
    noteLoadError: null as Error | null,
    tagLoadError: null as Error | null,
  };

  const reset = () => {
    state.notes = [makeNote("note-a", "Alpha", "/vault/alpha.md", ["custom-tag"])];
    state.noteLoadError = null;
    state.tagLoadError = null;
  };

  reset();

  return {
    state,
    reset,
    listNotesWithFolders: vi.fn(async () => {
      if (state.noteLoadError) {
        throw state.noteLoadError;
      }
      return state.notes.map((note) => ({ ...note }));
    }),
    listTemplates: vi.fn(async () => []),
    listTrashEntries: vi.fn(async () => []),
    listAvailableTags: vi.fn(async () => {
      if (state.tagLoadError) {
        throw state.tagLoadError;
      }
      return [];
    }),
    readNote: vi.fn(async () => "Body copy"),
  };
});

vi.mock("../src/services/notesService", () => ({
  buildFilenameSearchResults: () => [],
  createFolder: vi.fn(),
  createNote: vi.fn(),
  createTemplate: vi.fn(),
  createTemplateFromNote: vi.fn(),
  deleteFolder: vi.fn(),
  deleteNote: vi.fn(),
  deleteTemplate: vi.fn(),
  getNotesDirectory: () => "/vault",
  listAvailableTags: services.listAvailableTags,
  listNotesWithFolders: services.listNotesWithFolders,
  listTemplates: services.listTemplates,
  listTrashEntries: services.listTrashEntries,
  moveFolder: vi.fn(),
  moveNote: vi.fn(),
  permanentlyDeleteTrashEntry: vi.fn(),
  readNote: services.readNote,
  readTemplate: vi.fn(),
  renameFolder: vi.fn(),
  renameNote: vi.fn(),
  renameTemplate: vi.fn(),
  restoreTrashEntry: vi.fn(),
  selectNotesDirectory: vi.fn(),
  updateNote: vi.fn(),
  writeNoteMetadata: vi.fn(),
}));

vi.mock("../src/components/NoteEditor", () => ({
  NoteEditor: () => <div data-testid="mock-note-editor" />,
}));

vi.mock("../src/components/PaneContainer", () => ({
  PaneContainer: () => <div data-testid="mock-pane-container" />,
}));

vi.mock("../src/components/NoteList", () => ({
  NoteList: (props: {
    notes: FileSystemItem[];
    availableTags: string[];
    errorMessage: string | null;
  }) => {
    const noteCount = props.notes.reduce((count, entry) => {
      if (entry.type === "file") {
        return count + 1;
      }
      return count + entry.children.filter((child) => child.type === "file").length;
    }, 0);

    return (
      <div>
        <div data-testid="note-count">{String(noteCount)}</div>
        <div data-testid="available-tags">{props.availableTags.join("|")}</div>
        <div data-testid="error-message">{props.errorMessage ?? ""}</div>
      </div>
    );
  },
}));

import App from "../src/App";

describe("App refresh fallback", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;

  beforeEach(() => {
    services.reset();
    services.listNotesWithFolders.mockClear();
    services.listTemplates.mockClear();
    services.listTrashEntries.mockClear();
    services.listAvailableTags.mockClear();
    services.readNote.mockClear();
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    window.requestAnimationFrame = (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0);
    window.cancelAnimationFrame = (handle: number) => {
      window.clearTimeout(handle);
    };
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container.remove();
  });

  async function renderApp() {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
      await Promise.resolve();
      await Promise.resolve();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
  }

  it("loads notes and falls back to note tags when the tag catalog load fails", async () => {
    services.state.tagLoadError = new Error("unknown command: list_available_tags");

    await renderApp();

    expect(container.querySelector('[data-testid="note-count"]')?.textContent).toBe("1");
    expect(container.querySelector('[data-testid="available-tags"]')?.textContent).toContain("custom-tag");
    expect(container.querySelector('[data-testid="error-message"]')?.textContent).toContain(
      "Tags could not be fully loaded"
    );
    expect(container.querySelector('[data-testid="error-message"]')?.textContent).not.toContain(
      "Check folder permissions"
    );
  });

  it("shows the permissions message only for actual note load permission failures", async () => {
    services.state.noteLoadError = new Error("Permission denied while reading vault");

    await renderApp();

    expect(container.querySelector('[data-testid="error-message"]')?.textContent).toContain(
      "Unable to load notes. Check folder permissions."
    );
    expect(container.querySelector('[data-testid="error-message"]')?.textContent).not.toContain(
      "Tags could not be fully loaded"
    );
  });
});
