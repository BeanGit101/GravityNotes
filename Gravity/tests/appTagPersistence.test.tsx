// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileSystemItem, NoteMetadata } from "../src/types/notes";

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
    tags: [] as string[],
  };

  const reset = () => {
    state.notes = [
      makeNote("note-a", "Alpha", "/vault/alpha.md"),
      makeNote("note-b", "Beta", "/vault/beta.md"),
    ];
    state.tags = [];
  };

  reset();

  return {
    state,
    reset,
    listNotesWithFolders: vi.fn(async () => state.notes.map((note) => ({ ...note }))),
    listTemplates: vi.fn(async () => []),
    listTrashEntries: vi.fn(async () => []),
    listAvailableTags: vi.fn(async () => [...state.tags]),
    readNote: vi.fn(async () => "Body copy"),
    writeNoteMetadata: vi.fn(async (path: string, metadata: NoteMetadata) => {
      state.notes = state.notes.map((entry) => {
        if (entry.type !== "file" || entry.path !== path) {
          return entry;
        }
        return { ...entry, tags: metadata.tags };
      });
      state.tags = Array.from(new Set([...state.tags, ...metadata.tags]));
      return metadata;
    }),
    deleteNote: vi.fn(async (path: string) => {
      state.notes = state.notes.filter((entry) => entry.type !== "file" || entry.path !== path);
    }),
  };
});

vi.mock("../src/services/notesService", () => ({
  buildFilenameSearchResults: () => [],
  createFolder: vi.fn(),
  createNote: vi.fn(),
  createTemplate: vi.fn(),
  createTemplateFromNote: vi.fn(),
  deleteFolder: vi.fn(),
  deleteNote: services.deleteNote,
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
  writeNoteMetadata: services.writeNoteMetadata,
}));

vi.mock("../src/components/NoteEditor", () => ({
  NoteEditor: () => <div data-testid="mock-note-editor" />,
}));

vi.mock("../src/components/NoteList", () => ({
  NoteList: (props: {
    notes: FileSystemItem[];
    availableTags: string[];
    onDeleteNote: (note: Extract<FileSystemItem, { type: "file" }>) => void;
    onOpenVault: () => void;
    onSelectNote: (note: Extract<FileSystemItem, { type: "file" }>) => void;
  }) => {
    const noteA = props.notes.find(
      (entry): entry is Extract<FileSystemItem, { type: "file" }> =>
        entry.type === "file" && entry.id === "note-a"
    );
    const noteB = props.notes.find(
      (entry): entry is Extract<FileSystemItem, { type: "file" }> =>
        entry.type === "file" && entry.id === "note-b"
    );

    return (
      <div>
        <div data-testid="available-tags">{props.availableTags.join("|")}</div>
        <div data-testid="note-a-tags">{noteA?.tags.join("|") ?? ""}</div>
        <button
          type="button"
          data-testid="select-note-a"
          onClick={() => {
            if (noteA) {
              props.onSelectNote(noteA);
            }
          }}
        >
          select-a
        </button>
        <button
          type="button"
          data-testid="delete-note-b"
          onClick={() => {
            if (noteB) {
              props.onDeleteNote(noteB);
            }
          }}
        >
          delete-b
        </button>
      </div>
    );
  },
}));

vi.mock("../src/components/PaneContainer", () => ({
  PaneContainer: (props: {
    panes: Array<{ noteId: string }>;
    getNoteById: (noteId: string) => Extract<FileSystemItem, { type: "file" }> | null;
    onChangeNoteMetadata: (noteId: string, metadata: NoteMetadata) => void;
  }) => {
    const activeNote = props.panes[0] ? props.getNoteById(props.panes[0].noteId) : null;

    return (
      <div>
        <div data-testid="pane-note-tags">{activeNote?.tags.join("|") ?? ""}</div>
        <button
          type="button"
          data-testid="add-custom-tag"
          onClick={() => {
            if (props.panes[0]) {
              props.onChangeNoteMetadata(props.panes[0].noteId, { tags: ["custom-tag"] });
            }
          }}
        >
          add-custom-tag
        </button>
      </div>
    );
  },
}));

import App from "../src/App";

describe("App tag persistence", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  const originalConfirm = window.confirm;
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;

  beforeEach(() => {
    services.reset();
    services.listNotesWithFolders.mockClear();
    services.listTemplates.mockClear();
    services.listTrashEntries.mockClear();
    services.listAvailableTags.mockClear();
    services.readNote.mockClear();
    services.writeNoteMetadata.mockClear();
    services.deleteNote.mockClear();
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    window.confirm = vi.fn(() => true);
    window.requestAnimationFrame = (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0);
    window.cancelAnimationFrame = (handle: number) => {
      window.clearTimeout(handle);
    };
  });

  afterEach(() => {
    window.confirm = originalConfirm;
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container.remove();
  });

  it("keeps note A tags and available tags when note B is deleted", async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<App />);
      await Promise.resolve();
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    const selectNoteButton = container.querySelector('[data-testid="select-note-a"]');
    await act(async () => {
      selectNoteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const addTagButton = container.querySelector('[data-testid="add-custom-tag"]');
    await act(async () => {
      addTagButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const deleteButton = container.querySelector('[data-testid="delete-note-b"]');
    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(services.writeNoteMetadata).toHaveBeenCalledWith("/vault/alpha.md", { tags: ["custom-tag"] });
    expect(container.querySelector('[data-testid="note-a-tags"]')?.textContent).toContain("custom-tag");
    expect(container.querySelector('[data-testid="available-tags"]')?.textContent).toContain("custom-tag");
  });
});
