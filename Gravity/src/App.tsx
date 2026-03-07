import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "./App.css";
import { NoteEditor } from "./components/NoteEditor";
import { NoteList } from "./components/NoteList";
import { NoteListErrorBoundary } from "./components/NoteListErrorBoundary";
import { PaneContainer } from "./components/PaneContainer";
import {
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  getNotesDirectory,
  listNotesWithFolders,
  listTrashEntries,
  moveFolder,
  moveNote,
  permanentlyDeleteTrashEntry,
  readNote,
  renameFolder,
  renameNote,
  restoreTrashEntry,
  selectNotesDirectory,
  updateNote,
} from "./services/notesService";
import { initialPaneSessionState, paneSessionReducer, type OpenMode } from "./state/paneReducer";
import { markStartupError, markStartupReady, recordStartupEvent } from "./state/startupDiagnostics";
import type { NoteViewMode } from "./types/editor";
import type { FileSystemItem, Note, TrashEntry } from "./types/notes";

function folderExists(items: FileSystemItem[], path: string): boolean {
  for (const item of items) {
    if (item.type === "folder") {
      if (item.path === path) {
        return true;
      }
      if (folderExists(item.children, path)) {
        return true;
      }
    }
  }
  return false;
}

function collectNoteIds(items: FileSystemItem[]): Set<string> {
  const ids = new Set<string>();

  const visit = (entries: FileSystemItem[]) => {
    entries.forEach((entry) => {
      if (entry.type === "file") {
        ids.add(entry.id);
      } else {
        visit(entry.children);
      }
    });
  };

  visit(items);
  return ids;
}

function collectNoteIdsInFolder(items: FileSystemItem[], folderPath: string): string[] {
  const result: string[] = [];

  const visit = (entries: FileSystemItem[]) => {
    entries.forEach((entry) => {
      if (entry.type === "file") {
        result.push(entry.id);
        return;
      }
      visit(entry.children);
    });
  };

  const findFolder = (entries: FileSystemItem[]): boolean => {
    for (const entry of entries) {
      if (entry.type !== "folder") {
        continue;
      }
      if (entry.path === folderPath) {
        visit(entry.children);
        return true;
      }
      if (findFolder(entry.children)) {
        return true;
      }
    }
    return false;
  };

  findFolder(items);
  return result;
}

function replacePathPrefix(path: string, fromPrefix: string, toPrefix: string): string {
  if (path === fromPrefix) {
    return toPrefix;
  }
  if (!path.startsWith(`${fromPrefix}\\`) && !path.startsWith(`${fromPrefix}/`)) {
    return path;
  }
  return `${toPrefix}${path.slice(fromPrefix.length)}`;
}

function buildFolderNoteIdMapping(
  items: FileSystemItem[],
  oldFolderPath: string,
  newFolderPath: string
): Record<string, string> {
  return Object.fromEntries(
    collectNoteIdsInFolder(items, oldFolderPath).map((noteId) => [
      noteId,
      replacePathPrefix(noteId, oldFolderPath, newFolderPath),
    ])
  );
}

function remapRecordValues<T>(
  current: Record<string, T>,
  mapping: Record<string, string>
): Record<string, T> {
  if (Object.keys(mapping).length === 0) {
    return current;
  }

  const hasRemappedKeys = Object.keys(current).some((key) => {
    const nextKey = mapping[key];
    return typeof nextKey === "string" && nextKey !== key;
  });

  if (!hasRemappedKeys) {
    return current;
  }

  return Object.fromEntries(
    Object.entries(current).map(([key, value]) => [mapping[key] ?? key, value])
  ) as Record<string, T>;
}

function removeRecordKeys<T>(current: Record<string, T>, noteIds: Set<string>): Record<string, T> {
  const hasRemovedKeys = Object.keys(current).some((key) => noteIds.has(key));
  if (!hasRemovedKeys) {
    return current;
  }

  return Object.fromEntries(Object.entries(current).filter(([key]) => !noteIds.has(key))) as Record<
    string,
    T
  >;
}

function remapSetValues(current: Set<string>, mapping: Record<string, string>): Set<string> {
  const hasRemappedValues = Array.from(current).some((value) => {
    const nextValue = mapping[value];
    return typeof nextValue === "string" && nextValue !== value;
  });

  if (!hasRemappedValues) {
    return current;
  }

  return new Set(Array.from(current, (value) => mapping[value] ?? value));
}

function removeSetValues(current: Set<string>, noteIds: Set<string>): Set<string> {
  const hasRemovedValues = Array.from(current).some((value) => noteIds.has(value));
  if (!hasRemovedValues) {
    return current;
  }

  return new Set(Array.from(current).filter((value) => !noteIds.has(value)));
}

function App() {
  const SIDEBAR_WIDTH_KEY = "gravity.sidebarWidth";
  const SIDEBAR_MIN_WIDTH = 200;
  const SIDEBAR_COLLAPSED_WIDTH = 64;
  const SIDEBAR_MAX_RATIO = 0.6;

  const [notesDirectory, setNotesDirectory] = useState(getNotesDirectory());
  const [notes, setNotes] = useState<FileSystemItem[]>([]);
  const [trashEntries, setTrashEntries] = useState<TrashEntry[]>([]);
  const [paneSession, dispatchPane] = useReducer(paneSessionReducer, initialPaneSessionState);
  const [noteContents, setNoteContents] = useState<Record<string, string>>({});
  const [noteViewModes, setNoteViewModes] = useState<Record<string, NoteViewMode>>({});
  const [loadingNoteIds, setLoadingNoteIds] = useState<Set<string>>(() => new Set());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === "undefined") {
      return 280;
    }
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    const parsed = stored ? Number.parseFloat(stored) : 280;
    const maxWidth = Math.floor(window.innerWidth * SIDEBAR_MAX_RATIO);
    if (!Number.isFinite(parsed)) {
      return Math.min(Math.max(280, SIDEBAR_MIN_WIDTH), maxWidth);
    }
    return Math.min(Math.max(parsed, SIDEBAR_MIN_WIDTH), maxWidth);
  });

  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const didRecordMountRef = useRef(false);
  const didMarkReadyRef = useRef(false);
  const loadingRef = useRef<Set<string>>(new Set());
  const cryptoRef = useRef((globalThis as { crypto?: Crypto }).crypto);

  const noteIndex = useMemo(() => {
    const map = new Map<string, Note>();
    const walk = (items: FileSystemItem[]) => {
      items.forEach((item) => {
        if (item.type === "file") {
          map.set(item.id, item);
        } else {
          walk(item.children);
        }
      });
    };

    walk(notes);
    return map;
  }, [notes]);

  const getNoteById = useCallback((noteId: string) => noteIndex.get(noteId) ?? null, [noteIndex]);

  const getNoteViewMode = useCallback(
    (noteId: string): NoteViewMode => noteViewModes[noteId] ?? "edit",
    [noteViewModes]
  );

  const toggleNoteViewMode = useCallback((noteId: string) => {
    setNoteViewModes((current) => {
      const nextMode = (current[noteId] ?? "edit") === "edit" ? "preview" : "edit";
      return { ...current, [noteId]: nextMode };
    });
  }, []);

  const remapNoteState = useCallback((mapping: Record<string, string>) => {
    if (Object.keys(mapping).length === 0) {
      return;
    }

    dispatchPane({ type: "remap-note-ids", noteIds: mapping });
    setNoteContents((current) => remapRecordValues(current, mapping));
    setNoteViewModes((current) => remapRecordValues(current, mapping));
    setLoadingNoteIds((current) => remapSetValues(current, mapping));
  }, []);

  const removeNotesFromState = useCallback((noteIds: string[]) => {
    if (noteIds.length === 0) {
      return;
    }

    const removed = new Set(noteIds);
    dispatchPane({ type: "remove-notes", noteIds });
    setNoteContents((current) => removeRecordKeys(current, removed));
    setNoteViewModes((current) => removeRecordKeys(current, removed));
    setLoadingNoteIds((current) => removeSetValues(current, removed));
  }, []);

  const refreshVaultState = useCallback(async () => {
    if (!notesDirectory) {
      recordStartupEvent("vault.unselected");
      setNotes([]);
      setTrashEntries([]);
      dispatchPane({ type: "reset" });
      setNoteContents({});
      setNoteViewModes({});
      setLoadingNoteIds(new Set());
      return;
    }

    recordStartupEvent("vault.refresh.started", { hasSelectedVault: true });
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const [entries, trash] = await Promise.all([listNotesWithFolders(), listTrashEntries()]);
      setNotes(entries);
      setTrashEntries(trash);
      setSelectedFolderPath((current) => {
        if (!current) return current;
        return folderExists(entries, current) ? current : null;
      });

      const existingIds = collectNoteIds(entries);
      setNoteContents((current) =>
        removeRecordKeys(
          current,
          new Set(Object.keys(current).filter((key) => !existingIds.has(key)))
        )
      );
      setNoteViewModes((current) =>
        removeRecordKeys(
          current,
          new Set(Object.keys(current).filter((key) => !existingIds.has(key)))
        )
      );
      setLoadingNoteIds((current) =>
        removeSetValues(
          current,
          new Set(Array.from(current).filter((key) => !existingIds.has(key)))
        )
      );
      recordStartupEvent("vault.refresh.succeeded", {
        noteCount: existingIds.size,
        trashCount: trash.length,
      });
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      markStartupError("vault.refresh.failed", { message });
      setErrorMessage("Unable to load notes. Check folder permissions.");
    } finally {
      setIsLoading(false);
    }
  }, [notesDirectory]);

  useEffect(() => {
    if (!didRecordMountRef.current) {
      didRecordMountRef.current = true;
      recordStartupEvent("app.mounted", { hasSelectedVault: Boolean(notesDirectory) });
    }
  }, [notesDirectory]);

  useEffect(() => {
    if (didMarkReadyRef.current) {
      return;
    }

    const handle = window.requestAnimationFrame(() => {
      didMarkReadyRef.current = true;
      markStartupReady({
        activePaneCount: paneSession.panes.length,
        hasSelectedVault: Boolean(notesDirectory),
        hasShell: Boolean(document.querySelector(".app-shell")),
      });
    });

    return () => {
      window.cancelAnimationFrame(handle);
    };
  }, [notesDirectory, paneSession.panes.length]);

  useEffect(() => {
    void refreshVaultState();
  }, [refreshVaultState]);

  useEffect(() => {
    const handleResize = () => {
      setSidebarWidth((current) => {
        const maxWidth = Math.floor(window.innerWidth * SIDEBAR_MAX_RATIO);
        return Math.min(Math.max(current, SIDEBAR_MIN_WIDTH), maxWidth);
      });
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    if (sidebarCollapsed) return;
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarCollapsed, sidebarWidth]);

  const handleOpenVault = async () => {
    setErrorMessage(null);
    try {
      const directory = await selectNotesDirectory();
      if (directory) {
        setNotesDirectory(directory);
        setSelectedFolderPath(null);
        dispatchPane({ type: "reset" });
        setNoteContents({});
        setNoteViewModes({});
        setLoadingNoteIds(new Set());
      }
    } catch (error) {
      console.error(error);
      setErrorMessage("Failed to open a folder. Try again.");
    }
  };

  const ensureNoteLoaded = useCallback(
    async (note: Note) => {
      const noteId = note.id;
      const notePath = note.path;
      const noteTitle = note.title;

      if (Object.prototype.hasOwnProperty.call(noteContents, noteId)) return;
      if (loadingRef.current.has(noteId)) return;

      loadingRef.current.add(noteId);
      setLoadingNoteIds((current) => new Set(current).add(noteId));

      try {
        const content = await readNote(notePath);
        setNoteContents((current) => ({ ...current, [noteId]: content }));
      } catch (error) {
        console.error(error);
        setErrorMessage(`Unable to read "${noteTitle}". The file may be inaccessible.`);
      } finally {
        loadingRef.current.delete(noteId);
        setLoadingNoteIds((current) => {
          const next = new Set(current);
          next.delete(noteId);
          return next;
        });
      }
    },
    [noteContents]
  );

  const openNoteInPane = useCallback(
    async (note: Note, mode: OpenMode) => {
      setErrorMessage(null);
      const newPaneId = cryptoRef.current?.randomUUID
        ? cryptoRef.current.randomUUID()
        : `${String(Date.now())}-${Math.random().toString(16).slice(2)}`;

      dispatchPane({
        type: "open-note",
        noteId: note.id,
        mode,
        newPaneId,
      });

      await ensureNoteLoaded(note);
    },
    [ensureNoteLoaded]
  );

  const handleCreateNote = async (title: string) => {
    setErrorMessage(null);
    try {
      const created = await createNote(title, selectedFolderPath);
      await refreshVaultState();
      setNoteContents((current) => ({ ...current, [created.id]: "" }));
      await openNoteInPane(created, "active");
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to create the note.");
    }
  };

  const handleRenameNote = async (note: Note, title: string) => {
    setErrorMessage(null);
    try {
      const updated = await renameNote(note.path, title);
      remapNoteState({ [note.id]: updated.id });
      await refreshVaultState();
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to rename the note.");
    }
  };

  const handleMoveNote = async (note: Note, folderPath: string | null) => {
    setErrorMessage(null);
    try {
      const updated = await moveNote(note.path, folderPath);
      remapNoteState({ [note.id]: updated.id });
      await refreshVaultState();
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to move the note.");
    }
  };

  const handleDeleteNote = async (note: Note) => {
    setErrorMessage(null);
    try {
      await deleteNote(note.path);
      removeNotesFromState([note.id]);
      await refreshVaultState();
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to move the note to trash.");
    }
  };

  const handleCreateFolder = async (name: string) => {
    setErrorMessage(null);
    try {
      const created = await createFolder(name, selectedFolderPath);
      await refreshVaultState();
      setSelectedFolderPath(created.path);
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to create the folder.");
    }
  };

  const handleRenameFolder = async (folderPath: string, name: string) => {
    setErrorMessage(null);
    try {
      const updated = await renameFolder(folderPath, name);
      remapNoteState(buildFolderNoteIdMapping(notes, folderPath, updated.path));
      setSelectedFolderPath((current) =>
        current ? replacePathPrefix(current, folderPath, updated.path) : current
      );
      await refreshVaultState();
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to rename the folder.");
    }
  };

  const handleMoveFolder = async (folderPath: string, nextFolderPath: string | null) => {
    setErrorMessage(null);
    try {
      const updated = await moveFolder(folderPath, nextFolderPath);
      remapNoteState(buildFolderNoteIdMapping(notes, folderPath, updated.path));
      setSelectedFolderPath((current) =>
        current ? replacePathPrefix(current, folderPath, updated.path) : current
      );
      await refreshVaultState();
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to move the folder.");
    }
  };

  const handleDeleteFolder = async (folderPath: string) => {
    setErrorMessage(null);
    try {
      const noteIds = collectNoteIdsInFolder(notes, folderPath);
      await deleteFolder(folderPath);
      removeNotesFromState(noteIds);
      setSelectedFolderPath((current) => {
        if (!current) {
          return current;
        }
        return replacePathPrefix(current, folderPath, "") === current ? current : null;
      });
      await refreshVaultState();
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to move the folder to trash.");
    }
  };

  const handleRestoreTrashEntry = async (entry: TrashEntry) => {
    setErrorMessage(null);
    try {
      await restoreTrashEntry(entry.id);
      await refreshVaultState();
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to restore the item from trash.");
    }
  };

  const handlePermanentDeleteTrashEntry = async (entry: TrashEntry) => {
    setErrorMessage(null);
    try {
      await permanentlyDeleteTrashEntry(entry.id);
      await refreshVaultState();
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to permanently delete the trash item.");
    }
  };

  const handleAutoSave = async (noteId: string, nextValue: string) => {
    const note = getNoteById(noteId);
    if (!note) return;

    try {
      await updateNote(note.path, nextValue);
    } catch (error) {
      console.error(error);
      setErrorMessage("Auto-save failed. Check disk access.");
    }
  };

  const handleChangeNoteContent = (noteId: string, nextValue: string) => {
    setNoteContents((current) => {
      if (current[noteId] === nextValue) {
        return current;
      }

      return { ...current, [noteId]: nextValue };
    });
  };

  const handleClosePane = (paneId: string) => {
    dispatchPane({ type: "close-pane", paneId });
  };

  const handleSidebarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();

    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
    }

    resizeStateRef.current = { startX: event.clientX, startWidth: sidebarWidth };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (!resizeStateRef.current) return;
      const maxWidth = Math.floor(window.innerWidth * SIDEBAR_MAX_RATIO);
      const nextWidth =
        resizeStateRef.current.startWidth + (moveEvent.clientX - resizeStateRef.current.startX);
      const clamped = Math.min(Math.max(nextWidth, SIDEBAR_MIN_WIDTH), maxWidth);
      setSidebarWidth(clamped);
    };

    const handlePointerUp = () => {
      resizeStateRef.current = null;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  const activeNoteId =
    paneSession.panes.find((pane) => pane.id === paneSession.activePaneId)?.noteId ?? null;
  const resolvedSidebarWidth = sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : sidebarWidth;

  return (
    <main
      className={`app-shell ${sidebarCollapsed ? "app-shell--collapsed" : ""}`}
      style={{ "--sidebar-width": `${String(resolvedSidebarWidth)}px` } as CSSProperties}
    >
      <aside className={`app-sidebar ${sidebarCollapsed ? "app-sidebar--collapsed" : ""}`}>
        <NoteListErrorBoundary>
          <NoteList
            directoryPath={notesDirectory}
            notes={notes}
            trashEntries={trashEntries}
            selectedNoteId={activeNoteId}
            selectedFolderPath={selectedFolderPath}
            onOpenVault={() => {
              void handleOpenVault();
            }}
            onCreateNote={(title) => {
              void handleCreateNote(title);
            }}
            onRenameNote={(note, title) => {
              void handleRenameNote(note, title);
            }}
            onMoveNote={(note, folderPath) => {
              void handleMoveNote(note, folderPath);
            }}
            onCreateFolder={(name) => {
              void handleCreateFolder(name);
            }}
            onRenameFolder={(folderPath, name) => {
              void handleRenameFolder(folderPath, name);
            }}
            onMoveFolder={(folderPath, nextFolderPath) => {
              void handleMoveFolder(folderPath, nextFolderPath);
            }}
            onDeleteFolder={(folderPath) => {
              void handleDeleteFolder(folderPath);
            }}
            onSelectFolder={(folderPath) => {
              setSelectedFolderPath(folderPath);
            }}
            onSelectNote={(note) => {
              void openNoteInPane(note, "active");
            }}
            onOpenInNewPane={(note) => {
              void openNoteInPane(note, "new");
            }}
            onDeleteNote={(note) => {
              void handleDeleteNote(note);
            }}
            onRestoreTrashEntry={(entry) => {
              void handleRestoreTrashEntry(entry);
            }}
            onPermanentlyDeleteTrashEntry={(entry) => {
              void handlePermanentDeleteTrashEntry(entry);
            }}
            errorMessage={errorMessage}
          />
        </NoteListErrorBoundary>
        {isLoading && <p className="note-list__loading">Loading notes...</p>}
      </aside>

      <div
        className="split-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={handleSidebarPointerDown}
      >
        <button
          className="split-handle__toggle"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setSidebarCollapsed((current) => !current);
          }}
          aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {sidebarCollapsed ? "\u00BB" : "\u00AB"}
        </button>
      </div>

      <section className="app-main">
        <header className="app-header">
          <div>
            <p className="app-header__eyebrow">Gravity Notes</p>
            <h1 className="app-header__title">Focus on the writing, not the window.</h1>
          </div>
          <div className="app-header__meta">
            <span className="app-header__label">
              {notesDirectory ? "Vault connected" : "No vault selected"}
            </span>
          </div>
        </header>

        {paneSession.panes.length > 0 ? (
          <PaneContainer
            panes={paneSession.panes}
            activePaneId={paneSession.activePaneId}
            getNoteById={getNoteById}
            getNoteViewMode={getNoteViewMode}
            noteContents={noteContents}
            loadingNoteIds={loadingNoteIds}
            onActivatePane={(paneId) => {
              dispatchPane({ type: "activate-pane", paneId });
            }}
            onClosePane={handleClosePane}
            onToggleNoteViewMode={toggleNoteViewMode}
            onChangeNote={handleChangeNoteContent}
            onAutoSaveNote={handleAutoSave}
          />
        ) : (
          <NoteEditor
            note={null}
            value=""
            onChange={() => {}}
            onAutoSave={async () => {}}
            isLoading={false}
            viewMode="edit"
          />
        )}
      </section>
    </main>
  );
}

export default App;
