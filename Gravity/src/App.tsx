import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "./App.css";
import { NoteList } from "./components/NoteList";
import { NoteEditor } from "./components/NoteEditor";
import { PaneContainer, type PaneState } from "./components/PaneContainer";
import type { FileSystemItem, Note } from "./types/notes";
import {
  createFolder,
  createNote,
  deleteNote,
  getNotesDirectory,
  listNotesWithFolders,
  readNote,
  selectNotesDirectory,
  updateNote,
} from "./services/notesService";

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

function App() {
  const SIDEBAR_WIDTH_KEY = "gravity.sidebarWidth";
  const SIDEBAR_MIN_WIDTH = 200;
  const SIDEBAR_COLLAPSED_WIDTH = 64;
  const SIDEBAR_MAX_RATIO = 0.6;
  const [notesDirectory, setNotesDirectory] = useState(getNotesDirectory());
  const [notes, setNotes] = useState<FileSystemItem[]>([]);
  const [openPanes, setOpenPanes] = useState<PaneState[]>([]);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [noteContents, setNoteContents] = useState<Record<string, string>>({});
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

  const loadNotes = useCallback(async () => {
    if (!notesDirectory) {
      setNotes([]);
      setOpenPanes([]);
      setActivePaneId(null);
      setNoteContents({});
      setLoadingNoteIds(new Set());
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    try {
      const entries = await listNotesWithFolders();
      setNotes(entries);
      setSelectedFolderPath((current) => {
        if (!current) return current;
        return folderExists(entries, current) ? current : null;
      });
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to load notes. Check folder permissions.");
    } finally {
      setIsLoading(false);
    }
  }, [notesDirectory]);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

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
        setOpenPanes([]);
        setActivePaneId(null);
        setNoteContents({});
        setLoadingNoteIds(new Set());
      }
    } catch (error) {
      console.error(error);
      setErrorMessage("Failed to open a folder. Try again.");
    }
  };

  const ensureNoteLoaded = useCallback(
    async (note: Note) => {
      if (Object.prototype.hasOwnProperty.call(noteContents, note.id)) return;
      if (loadingNoteIds.has(note.id)) return;

      setLoadingNoteIds((current) => {
        const next = new Set(current);
        next.add(note.id);
        return next;
      });

      try {
        const content = await readNote(note.path);
        setNoteContents((current) => ({ ...current, [note.id]: content }));
      } catch (error) {
        console.error(error);
        setErrorMessage("Unable to read the note.");
      } finally {
        setLoadingNoteIds((current) => {
          const next = new Set(current);
          next.delete(note.id);
          return next;
        });
      }
    },
    [loadingNoteIds, noteContents]
  );

  const openNoteInPane = useCallback(
    async (note: Note, mode: "active" | "new") => {
      setErrorMessage(null);

      setOpenPanes((current) => {
        const existing = current.find((pane) => pane.noteId === note.id);
        if (existing) {
          setActivePaneId(existing.id);
          return current;
        }

        if (mode === "new") {
          if (current.length < 4) {
            const id = globalThis.crypto.randomUUID();
            setActivePaneId(id);
            return [...current, { id, noteId: note.id }];
          }

          if (activePaneId) {
            return current.map((pane) =>
              pane.id === activePaneId ? { ...pane, noteId: note.id } : pane
            );
          }
        }

        if (activePaneId) {
          return current.map((pane) =>
            pane.id === activePaneId ? { ...pane, noteId: note.id } : pane
          );
        }

        const id = globalThis.crypto.randomUUID();
        setActivePaneId(id);
        return [...current, { id, noteId: note.id }];
      });

      await ensureNoteLoaded(note);
    },
    [activePaneId, ensureNoteLoaded]
  );

  const handleCreateNote = async (title: string) => {
    setErrorMessage(null);
    try {
      const created = await createNote(title, selectedFolderPath);
      await loadNotes();
      setNoteContents((current) => ({ ...current, [created.id]: "" }));
      await openNoteInPane(created, "active");
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to create the note.");
    }
  };

  const handleDeleteNote = async (note: Note) => {
    setErrorMessage(null);
    try {
      await deleteNote(note.path);
      await loadNotes();
      setOpenPanes((current) => {
        const remaining = current.filter((pane) => pane.noteId !== note.id);
        setActivePaneId((active) => {
          if (!active) return remaining[0]?.id ?? null;
          return remaining.some((pane) => pane.id === active) ? active : (remaining[0]?.id ?? null);
        });
        return remaining;
      });
      setNoteContents((current) => {
        return Object.fromEntries(Object.entries(current).filter(([key]) => key !== note.id));
      });
      setLoadingNoteIds((current) => {
        const next = new Set(current);
        next.delete(note.id);
        return next;
      });
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to delete the note.");
    }
  };

  const handleCreateFolder = async (name: string) => {
    setErrorMessage(null);
    try {
      const created = await createFolder(name, selectedFolderPath);
      await loadNotes();
      setSelectedFolderPath(created.path);
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to create the folder.");
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
    setNoteContents((current) => ({ ...current, [noteId]: nextValue }));
  };

  const handleClosePane = (paneId: string) => {
    setOpenPanes((current) => {
      const remaining = current.filter((pane) => pane.id !== paneId);
      setActivePaneId((active) => {
        if (active !== paneId) return active;
        return remaining[0]?.id ?? null;
      });
      return remaining;
    });
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

  const activeNoteId = openPanes.find((pane) => pane.id === activePaneId)?.noteId ?? null;
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
          selectedNoteId={activeNoteId}
          selectedFolderPath={selectedFolderPath}
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
          onDeleteNote={(note) => {
            void handleDeleteNote(note);
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
          {sidebarCollapsed ? "»" : "«"}
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

        {openPanes.length > 0 ? (
          <PaneContainer
            panes={openPanes}
            activePaneId={activePaneId}
            getNoteById={getNoteById}
            noteContents={noteContents}
            loadingNoteIds={loadingNoteIds}
            onActivatePane={setActivePaneId}
            onClosePane={handleClosePane}
            onChangeNote={handleChangeNoteContent}
            onAutoSaveNote={handleAutoSave}
          />
        ) : (
          <NoteEditor
            note={null}
            value=""
            onChange={() => {}}
            onAutoSave={async () => {}}
            isReadOnly
          />
        )}
      </section>
    </main>
  );
}

export default App;
