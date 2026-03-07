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
  deleteNote,
  getNotesDirectory,
  listNotesWithFolders,
  readNote,
  selectNotesDirectory,
  updateNote,
} from "./services/notesService";
import { initialPaneSessionState, paneSessionReducer, type OpenMode } from "./state/paneReducer";
import type { NoteViewMode } from "./types/editor";
import type { FileSystemItem, Note, NoteDocument, NoteMetadata } from "./types/notes";
import {
  DEFAULT_TAG_OPTIONS,
  createEmptyNoteMetadata,
  normalizeNoteMetadata,
  normalizeTag,
  parseNoteDocument,
  serializeNoteDocument,
} from "./utils/frontmatter";

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

function flattenNotes(items: FileSystemItem[]): Note[] {
  const notes: Note[] = [];

  const visit = (entries: FileSystemItem[]) => {
    entries.forEach((entry) => {
      if (entry.type === "file") {
        notes.push(entry);
      } else {
        visit(entry.children);
      }
    });
  };

  visit(items);
  return notes;
}

function mergeMetadataIntoItems(
  items: FileSystemItem[],
  noteMetadataById: Record<string, NoteMetadata>
): FileSystemItem[] {
  return items.map((item) => {
    if (item.type === "folder") {
      return {
        ...item,
        children: mergeMetadataIntoItems(item.children, noteMetadataById),
      };
    }

    const metadata = normalizeNoteMetadata(noteMetadataById[item.id] ?? item);
    return {
      ...item,
      subject: metadata.subject,
      tags: metadata.tags,
      updatedAt: metadata.updatedAt,
    };
  });
}

function App() {
  const SIDEBAR_WIDTH_KEY = "gravity.sidebarWidth";
  const SIDEBAR_MIN_WIDTH = 200;
  const SIDEBAR_COLLAPSED_WIDTH = 64;
  const SIDEBAR_MAX_RATIO = 0.6;

  const [notesDirectory, setNotesDirectory] = useState(getNotesDirectory());
  const [notes, setNotes] = useState<FileSystemItem[]>([]);
  const [paneSession, dispatchPane] = useReducer(paneSessionReducer, initialPaneSessionState);
  const [noteContents, setNoteContents] = useState<Record<string, string>>({});
  const [noteMetadataById, setNoteMetadataById] = useState<Record<string, NoteMetadata>>({});
  const [noteViewModes, setNoteViewModes] = useState<Record<string, NoteViewMode>>({});
  const [loadingNoteIds, setLoadingNoteIds] = useState<Set<string>>(() => new Set());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedFolderPath, setSelectedFolderPath] = useState<string | null>(null);
  const [selectedTagFilters, setSelectedTagFilters] = useState<string[]>([]);
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
  const loadingRef = useRef<Set<string>>(new Set());
  const cryptoRef = useRef((globalThis as { crypto?: Crypto }).crypto);

  const notesWithMetadata = useMemo(
    () => mergeMetadataIntoItems(notes, noteMetadataById),
    [noteMetadataById, notes]
  );

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

    walk(notesWithMetadata);
    return map;
  }, [notesWithMetadata]);

  const availableTags = useMemo(() => {
    const defaultTagKeys = new Set(DEFAULT_TAG_OPTIONS.map((tag) => tag.toLocaleLowerCase()));
    const customTags = new Map<string, string>();

    Object.values(noteMetadataById).forEach((metadata) => {
      metadata.tags.forEach((tag) => {
        const key = tag.toLocaleLowerCase();
        if (defaultTagKeys.has(key) || customTags.has(key)) {
          return;
        }
        customTags.set(key, tag);
      });
    });

    return [
      ...DEFAULT_TAG_OPTIONS,
      ...Array.from(customTags.values()).sort((left, right) => left.localeCompare(right)),
    ];
  }, [noteMetadataById]);

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

  const loadNotes = useCallback(async () => {
    if (!notesDirectory) {
      setNotes([]);
      dispatchPane({ type: "reset" });
      setNoteContents({});
      setNoteMetadataById({});
      setNoteViewModes({});
      setLoadingNoteIds(new Set());
      setSelectedTagFilters([]);
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);

    try {
      const entries = await listNotesWithFolders();
      const flatNotes = flattenNotes(entries);

      setLoadingNoteIds(new Set(flatNotes.map((note) => note.id)));

      const settledDocuments = await Promise.allSettled(
        flatNotes.map(async (note) => {
          const rawContent = await readNote(note.path);
          return {
            noteId: note.id,
            document: parseNoteDocument(rawContent),
          };
        })
      );

      const nextContents: Record<string, string> = {};
      const nextMetadataById: Record<string, NoteMetadata> = {};
      let unreadableCount = 0;

      settledDocuments.forEach((result, index) => {
        const note = flatNotes[index];
        if (!note) {
          return;
        }

        if (result.status === "fulfilled") {
          nextContents[note.id] = result.value.document.body;
          nextMetadataById[note.id] = normalizeNoteMetadata({
            ...result.value.document.metadata,
            updatedAt: note.updatedAt,
          });
          return;
        }

        console.error(result.reason);
        nextContents[note.id] = "";
        nextMetadataById[note.id] = createEmptyNoteMetadata();
        unreadableCount += 1;
      });

      setNotes(entries);
      setSelectedFolderPath((current) => {
        if (!current) return current;
        return folderExists(entries, current) ? current : null;
      });

      const existingIds = collectNoteIds(entries);
      setNoteViewModes((current) => {
        const next = Object.fromEntries(
          Object.entries(current).filter(([noteId]) => existingIds.has(noteId))
        ) as Record<string, NoteViewMode>;
        return next;
      });
      setNoteContents(nextContents);
      setNoteMetadataById(nextMetadataById);
      setLoadingNoteIds(new Set());

      if (unreadableCount > 0) {
        setErrorMessage(
          `${String(unreadableCount)} note${unreadableCount === 1 ? " was" : "s were"} unreadable during load.`
        );
      }
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to load notes. Check folder permissions.");
      setLoadingNoteIds(new Set());
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

  useEffect(() => {
    const availableTagKeys = new Set(availableTags.map((tag) => tag.toLocaleLowerCase()));
    setSelectedTagFilters((current) =>
      current.filter((tag) => availableTagKeys.has(normalizeTag(tag).toLocaleLowerCase()))
    );
  }, [availableTags]);

  const handleOpenVault = async () => {
    setErrorMessage(null);
    try {
      const directory = await selectNotesDirectory();
      if (directory) {
        setNotesDirectory(directory);
        setSelectedFolderPath(null);
        setSelectedTagFilters([]);
        dispatchPane({ type: "reset" });
        setNoteContents({});
        setNoteMetadataById({});
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

      if (
        Object.prototype.hasOwnProperty.call(noteContents, noteId) &&
        Object.prototype.hasOwnProperty.call(noteMetadataById, noteId)
      ) {
        return;
      }
      if (loadingRef.current.has(noteId)) return;

      loadingRef.current.add(noteId);
      setLoadingNoteIds((current) => new Set(current).add(noteId));

      try {
        const rawContent = await readNote(notePath);
        const document = parseNoteDocument(rawContent);
        setNoteContents((current) => ({ ...current, [noteId]: document.body }));
        setNoteMetadataById((current) => ({
          ...current,
          [noteId]: normalizeNoteMetadata({
            ...document.metadata,
            updatedAt: current[noteId]?.updatedAt ?? note.updatedAt,
          }),
        }));
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
    [noteContents, noteMetadataById]
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
      await loadNotes();
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
      dispatchPane({ type: "remove-note", noteId: note.id });
      setNoteContents((current) => {
        return Object.fromEntries(Object.entries(current).filter(([key]) => key !== note.id));
      });
      setNoteMetadataById((current) => {
        return Object.fromEntries(Object.entries(current).filter(([key]) => key !== note.id));
      });
      setNoteViewModes((current) => {
        const next = Object.fromEntries(
          Object.entries(current).filter(([key]) => key !== note.id)
        ) as Record<string, NoteViewMode>;
        return next;
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

  const handleAutoSave = async (noteId: string, nextDocument: NoteDocument) => {
    const note = getNoteById(noteId);
    if (!note) return;

    const updatedMetadata = normalizeNoteMetadata({
      ...nextDocument.metadata,
      updatedAt: new Date().toISOString(),
    });
    const serialized = serializeNoteDocument({
      body: nextDocument.body,
      metadata: updatedMetadata,
    });

    try {
      await updateNote(note.path, serialized);
      setNoteMetadataById((current) => ({
        ...current,
        [noteId]: updatedMetadata,
      }));
    } catch (error) {
      console.error(error);
      setErrorMessage("Auto-save failed. Check disk access.");
    }
  };

  const handleChangeNoteContent = (noteId: string, nextValue: string) => {
    setNoteContents((current) => ({ ...current, [noteId]: nextValue }));
  };

  const handleChangeNoteMetadata = (noteId: string, metadata: NoteMetadata) => {
    setNoteMetadataById((current) => ({
      ...current,
      [noteId]: normalizeNoteMetadata({
        ...metadata,
        updatedAt: current[noteId]?.updatedAt,
      }),
    }));
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
        <NoteList
          directoryPath={notesDirectory}
          notes={notesWithMetadata}
          selectedNoteId={activeNoteId}
          selectedFolderPath={selectedFolderPath}
          availableTags={availableTags}
          selectedTags={selectedTagFilters}
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
          onToggleTagFilter={(tag) => {
            setSelectedTagFilters((current) => {
              const normalized = normalizeTag(tag).toLocaleLowerCase();
              return current.some((entry) => normalizeTag(entry).toLocaleLowerCase() === normalized)
                ? current.filter((entry) => normalizeTag(entry).toLocaleLowerCase() !== normalized)
                : [...current, tag];
            });
          }}
          onClearTagFilters={() => {
            setSelectedTagFilters([]);
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
            availableTags={availableTags}
            onActivatePane={(paneId) => {
              dispatchPane({ type: "activate-pane", paneId });
            }}
            onClosePane={handleClosePane}
            onToggleNoteViewMode={toggleNoteViewMode}
            onChangeNote={handleChangeNoteContent}
            onChangeNoteMetadata={handleChangeNoteMetadata}
            onAutoSaveNote={handleAutoSave}
          />
        ) : (
          <NoteEditor
            note={null}
            value=""
            availableTags={availableTags}
            onChange={() => {}}
            onMetadataChange={() => {}}
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
