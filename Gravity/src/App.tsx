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
import { PaneContainer } from "./components/PaneContainer";
import {
  createFolder,
  createNote,
  listNotesWithFolders,
  listTrash,
  readNote,
  restoreTrashItem,
  selectNotesDirectory,
  trashEntry,
  updateNote,
  permanentlyDeleteTrashItem,
  getNotesDirectory,
} from "./services/notesService";
import { initialPaneSessionState, paneSessionReducer, type OpenMode } from "./state/paneReducer";
import type { NoteViewMode } from "./types/editor";
import type {
  FileSystemItem,
  Note,
  NoteSortMode,
  SidebarPreferences,
  SortDirection,
  TrashRecord,
} from "./types/notes";
import { collectNotes, findFolderByPath } from "./utils/noteTree";

const SIDEBAR_WIDTH_KEY = "gravity.sidebarWidth";
const SIDEBAR_PREFERENCES_KEY = "gravity.sidebarPreferences";
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_COLLAPSED_WIDTH = 64;
const SIDEBAR_MAX_RATIO = 0.6;

const defaultSidebarPreferences: SidebarPreferences = {
  searchText: "",
  selectedTags: [],
  sortMode: "updated",
  sortDirection: "desc",
};

function isSortMode(value: unknown): value is NoteSortMode {
  return value === "name" || value === "updated";
}

function isSortDirection(value: unknown): value is SortDirection {
  return value === "asc" || value === "desc";
}

function readSidebarPreferences(): SidebarPreferences {
  if (typeof window === "undefined") {
    return defaultSidebarPreferences;
  }

  const stored = window.localStorage.getItem(SIDEBAR_PREFERENCES_KEY);
  if (!stored) {
    return defaultSidebarPreferences;
  }

  try {
    const parsed = JSON.parse(stored) as Partial<SidebarPreferences>;
    return {
      searchText: typeof parsed.searchText === "string" ? parsed.searchText : "",
      selectedTags: Array.isArray(parsed.selectedTags)
        ? parsed.selectedTags.filter((tag): tag is string => typeof tag === "string")
        : [],
      sortMode: isSortMode(parsed.sortMode) ? parsed.sortMode : defaultSidebarPreferences.sortMode,
      sortDirection: isSortDirection(parsed.sortDirection)
        ? parsed.sortDirection
        : defaultSidebarPreferences.sortDirection,
    };
  } catch {
    return defaultSidebarPreferences;
  }
}

function retainRecordEntries<T>(
  record: Record<string, T>,
  validIds: Set<string>
): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => validIds.has(key))) as Record<
    string,
    T
  >;
}

function retainLoadingIds(current: Set<string>, validIds: Set<string>): Set<string> {
  const next = new Set<string>();
  current.forEach((noteId) => {
    if (validIds.has(noteId)) {
      next.add(noteId);
    }
  });
  return next;
}

function App() {
  const [notesDirectory, setNotesDirectory] = useState(getNotesDirectory());
  const [notes, setNotes] = useState<FileSystemItem[]>([]);
  const [trashItems, setTrashItems] = useState<TrashRecord[]>([]);
  const [paneSession, dispatchPane] = useReducer(paneSessionReducer, initialPaneSessionState);
  const [noteContents, setNoteContents] = useState<Record<string, string>>({});
  const [noteViewModes, setNoteViewModes] = useState<Record<string, NoteViewMode>>({});
  const [loadingNoteIds, setLoadingNoteIds] = useState<Set<string>>(() => new Set());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarPreferences, setSidebarPreferences] = useState<SidebarPreferences>(() =>
    readSidebarPreferences()
  );
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
  const loadingRef = useRef<Set<string>>(new Set());
  const cryptoRef = useRef((globalThis as { crypto?: Crypto }).crypto);

  const noteIndex = useMemo(() => {
    const map = new Map<string, Note>();
    collectNotes(notes).forEach((note) => {
      map.set(note.id, note);
    });
    return map;
  }, [notes]);

  const getNoteById = useCallback((noteId: string) => noteIndex.get(noteId) ?? null, [noteIndex]);

  const getNoteViewMode = useCallback(
    (noteId: string): NoteViewMode => noteViewModes[noteId] ?? "edit",
    [noteViewModes]
  );

  const removeNotesFromState = useCallback((noteIds: string[]) => {
    if (noteIds.length === 0) {
      return;
    }

    const deletedIds = new Set(noteIds);
    dispatchPane({ type: "remove-notes", noteIds });
    setNoteContents((current) => {
      return Object.fromEntries(
        Object.entries(current).filter(([key]) => !deletedIds.has(key))
      ) as Record<string, string>;
    });
    setNoteViewModes((current) => {
      return Object.fromEntries(
        Object.entries(current).filter(([key]) => !deletedIds.has(key))
      ) as Record<string, NoteViewMode>;
    });
    setLoadingNoteIds((current) => {
      const next = new Set(current);
      noteIds.forEach((noteId) => {
        next.delete(noteId);
      });
      return next;
    });
    loadingRef.current = new Set(
      [...loadingRef.current].filter((noteId) => !deletedIds.has(noteId))
    );
  }, []);

  const toggleNoteViewMode = useCallback((noteId: string) => {
    setNoteViewModes((current) => {
      const nextMode = (current[noteId] ?? "edit") === "edit" ? "preview" : "edit";
      return { ...current, [noteId]: nextMode };
    });
  }, []);

  const loadVaultData = useCallback(async () => {
    if (!notesDirectory) {
      setNotes([]);
      setTrashItems([]);
      dispatchPane({ type: "reset" });
      setNoteContents({});
      setNoteViewModes({});
      setLoadingNoteIds(new Set());
      loadingRef.current = new Set();
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const [entries, trash] = await Promise.all([listNotesWithFolders(), listTrash()]);
      setNotes(entries);
      setTrashItems(trash);
      setSelectedFolderPath((current) => {
        if (!current) {
          return current;
        }
        return findFolderByPath(entries, current) ? current : null;
      });

      const existingIds = new Set(collectNotes(entries).map((note) => note.id));
      setNoteContents((current) => retainRecordEntries(current, existingIds));
      setNoteViewModes((current) => retainRecordEntries(current, existingIds));
      setLoadingNoteIds((current) => retainLoadingIds(current, existingIds));
      loadingRef.current = retainLoadingIds(loadingRef.current, existingIds);
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to load notes. Check folder permissions.");
    } finally {
      setIsLoading(false);
    }
  }, [notesDirectory]);

  useEffect(() => {
    void loadVaultData();
  }, [loadVaultData]);

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
    if (sidebarCollapsed) {
      return;
    }
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarCollapsed, sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_PREFERENCES_KEY, JSON.stringify(sidebarPreferences));
  }, [sidebarPreferences]);

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
        loadingRef.current = new Set();
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

      if (Object.prototype.hasOwnProperty.call(noteContents, noteId)) {
        return;
      }
      if (loadingRef.current.has(noteId)) {
        return;
      }

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
      await loadVaultData();
      await openNoteInPane(created, "active");
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to create the note.");
    }
  };

  const handleTrashNote = async (note: Note) => {
    if (!window.confirm(`Move "${note.title}" to trash?`)) {
      return;
    }

    setErrorMessage(null);
    try {
      await trashEntry(note.path);
      removeNotesFromState([note.id]);
      await loadVaultData();
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to move the note to trash.");
    }
  };

  const handleTrashFolder = async (folderPath: string) => {
    const folder = findFolderByPath(notes, folderPath);
    if (!folder) {
      return;
    }

    if (!window.confirm(`Move folder "${folder.name}" and its contents to trash?`)) {
      return;
    }

    setErrorMessage(null);
    try {
      await trashEntry(folder.path);
      removeNotesFromState(collectNotes([folder]).map((note) => note.id));
      await loadVaultData();
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to move the folder to trash.");
    }
  };

  const handleRestoreTrashItem = async (record: TrashRecord) => {
    setErrorMessage(null);
    try {
      await restoreTrashItem(record.trashPath);
      await loadVaultData();
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to restore the item from trash.");
    }
  };

  const handlePermanentDeleteTrashItem = async (record: TrashRecord) => {
    if (!window.confirm(`Permanently delete "${record.trashPath}"? This cannot be undone.`)) {
      return;
    }

    setErrorMessage(null);
    try {
      await permanentlyDeleteTrashItem(record.trashPath);
      await loadVaultData();
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to permanently delete the item.");
    }
  };

  const handleCreateFolder = async (name: string) => {
    setErrorMessage(null);
    try {
      const created = await createFolder(name, selectedFolderPath);
      await loadVaultData();
      setSelectedFolderPath(created.path);
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to create the folder.");
    }
  };

  const handleAutoSave = async (noteId: string, nextValue: string) => {
    const note = getNoteById(noteId);
    if (!note) {
      return;
    }

    try {
      await updateNote(note.path, nextValue);
      await loadVaultData();
    } catch (error) {
      console.error(error);
      setErrorMessage("Auto-save failed. Check disk access.");
    }
  };

  const handleChangeNoteContent = (noteId: string, nextValue: string) => {
    setNoteContents((current) => ({ ...current, [noteId]: nextValue }));
  };

  const handleClosePane = (paneId: string) => {
    dispatchPane({ type: "close-pane", paneId });
  };

  const handleSidebarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    if ((event.target as HTMLElement).closest("button")) {
      return;
    }
    event.preventDefault();

    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
    }

    resizeStateRef.current = { startX: event.clientX, startWidth: sidebarWidth };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (!resizeStateRef.current) {
        return;
      }
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
        <NoteList
          directoryPath={notesDirectory}
          notes={notes}
          trashItems={trashItems}
          selectedNoteId={activeNoteId}
          selectedFolderPath={selectedFolderPath}
          sidebarPreferences={sidebarPreferences}
          onSidebarPreferencesChange={setSidebarPreferences}
          onOpenVault={() => {
            void handleOpenVault();
          }}
          onCreateNote={(title) => {
            void handleCreateNote(title);
          }}
          onCreateFolder={(name) => {
            void handleCreateFolder(name);
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
          onTrashNote={(note) => {
            void handleTrashNote(note);
          }}
          onTrashFolder={(folderPath) => {
            void handleTrashFolder(folderPath);
          }}
          onRestoreTrashItem={(record) => {
            void handleRestoreTrashItem(record);
          }}
          onPermanentlyDeleteTrashItem={(record) => {
            void handlePermanentDeleteTrashItem(record);
          }}
          errorMessage={errorMessage}
        />
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
            isLoading
            viewMode="edit"
          />
        )}
      </section>
    </main>
  );
}

export default App;
