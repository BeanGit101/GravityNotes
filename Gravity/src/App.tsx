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
  createTemplate,
  createTemplateFromNote,
  deleteFolder,
  deleteNote,
  deleteTemplate,
  getNotesDirectory,
  listNotesWithFolders,
  listTemplates,
  listTrashEntries,
  moveFolder,
  moveNote,
  permanentlyDeleteTrashEntry,
  readNote,
  readTemplate,
  renameFolder,
  renameNote,
  renameTemplate,
  restoreTrashEntry,
  selectNotesDirectory,
  updateNote,
} from "./services/notesService";
import { initialPaneSessionState, paneSessionReducer, type OpenMode } from "./state/paneReducer";
import { markStartupError, markStartupReady, recordStartupEvent } from "./state/startupDiagnostics";
import type { NoteViewMode } from "./types/editor";
import type {
  FileSystemItem,
  FolderItem,
  Note,
  NoteDocument,
  NoteMetadata,
  SidebarPreferences,
  TrashEntry,
} from "./types/notes";
import { SaveState } from "./types/shell";
import type { TemplateSummary } from "./types/templates";
import {
  DEFAULT_TAG_OPTIONS,
  createEmptyNoteMetadata,
  normalizeNoteMetadata,
  normalizeTag,
  parseNoteDocument,
  serializeNoteDocument,
} from "./utils/frontmatter";

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

function isSortMode(value: unknown): value is SidebarPreferences["sortMode"] {
  return value === "name" || value === "updated";
}

function isSortDirection(value: unknown): value is SidebarPreferences["sortDirection"] {
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

function findFolderByPath(items: FileSystemItem[], path: string): FolderItem | null {
  for (const item of items) {
    if (item.type !== "folder") {
      continue;
    }

    if (item.path === path) {
      return item;
    }

    const nested = findFolderByPath(item.children, path);
    if (nested) {
      return nested;
    }
  }

  return null;
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

    const metadata = noteMetadataById[item.id] ?? noteMetadataFromNote(item);
    return {
      ...item,
      subject: metadata.subject,
      tags: metadata.tags,
    };
  });
}

function noteMetadataFromNote(note: Pick<Note, "subject" | "tags">): NoteMetadata {
  return normalizeNoteMetadata({
    subject: note.subject,
    tags: note.tags,
  });
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
  const [notesDirectory, setNotesDirectory] = useState(getNotesDirectory());
  const [notes, setNotes] = useState<FileSystemItem[]>([]);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [trashEntries, setTrashEntries] = useState<TrashEntry[]>([]);
  const [paneSession, dispatchPane] = useReducer(paneSessionReducer, initialPaneSessionState);
  const [noteContents, setNoteContents] = useState<Record<string, string>>({});
  const [noteMetadataById, setNoteMetadataById] = useState<Record<string, NoteMetadata>>({});
  const [noteViewModes, setNoteViewModes] = useState<Record<string, NoteViewMode>>({});
  const [loadingNoteIds, setLoadingNoteIds] = useState<Set<string>>(() => new Set());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>(SaveState.Saved);
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
  const didRecordMountRef = useRef(false);
  const didMarkReadyRef = useRef(false);
  const loadingRef = useRef<Set<string>>(new Set());
  const noteContentsRef = useRef<Record<string, string>>({});
  const noteMetadataByIdRef = useRef<Record<string, NoteMetadata>>({});
  const noteViewModesRef = useRef<Record<string, NoteViewMode>>({});
  const cryptoRef = useRef((globalThis as { crypto?: Crypto }).crypto);

  useEffect(() => {
    noteContentsRef.current = noteContents;
  }, [noteContents]);

  useEffect(() => {
    noteMetadataByIdRef.current = noteMetadataById;
  }, [noteMetadataById]);

  useEffect(() => {
    noteViewModesRef.current = noteViewModes;
  }, [noteViewModes]);

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
      const normalized = normalizeNoteMetadata(metadata);
      normalized.tags.forEach((tag) => {
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

  const remapNoteState = useCallback((mapping: Record<string, string>) => {
    if (Object.keys(mapping).length === 0) {
      return;
    }

    dispatchPane({ type: "remap-note-ids", noteIds: mapping });
    setNoteContents((current) => remapRecordValues(current, mapping));
    setNoteMetadataById((current) => remapRecordValues(current, mapping));
    setNoteViewModes((current) => remapRecordValues(current, mapping));
    setLoadingNoteIds((current) => remapSetValues(current, mapping));
    loadingRef.current = remapSetValues(loadingRef.current, mapping);
  }, []);

  const removeNotesFromState = useCallback((noteIds: string[]) => {
    if (noteIds.length === 0) {
      return;
    }

    const removed = new Set(noteIds);
    dispatchPane({ type: "remove-notes", noteIds });
    setNoteContents((current) => removeRecordKeys(current, removed));
    setNoteMetadataById((current) => removeRecordKeys(current, removed));
    setNoteViewModes((current) => removeRecordKeys(current, removed));
    setLoadingNoteIds((current) => removeSetValues(current, removed));
    loadingRef.current = removeSetValues(loadingRef.current, removed);
  }, []);

  const refreshTemplates = useCallback(async () => {
    if (!notesDirectory) {
      setTemplates([]);
      return;
    }

    const nextTemplates = await listTemplates();
    setTemplates(nextTemplates);
  }, [notesDirectory]);

  const refreshVaultState = useCallback(async () => {
    if (!notesDirectory) {
      recordStartupEvent("vault.unselected");
      setNotes([]);
      setTemplates([]);
      setTrashEntries([]);
      dispatchPane({ type: "reset" });
      setNoteContents({});
      setNoteMetadataById({});
      setNoteViewModes({});
      setLoadingNoteIds(new Set());
      loadingRef.current = new Set();
      return;
    }

    recordStartupEvent("vault.refresh.started", { hasSelectedVault: true });
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const [entries, trash, templateSummaries] = await Promise.all([
        listNotesWithFolders(),
        listTrashEntries(),
        listTemplates(),
      ]);
      const flatNotes = flattenNotes(entries);

      setLoadingNoteIds(new Set(flatNotes.map((note) => note.id)));
      loadingRef.current = new Set(flatNotes.map((note) => note.id));

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
          nextMetadataById[note.id] = normalizeNoteMetadata(result.value.document.metadata);
          return;
        }

        console.error(result.reason);
        nextContents[note.id] = "";
        nextMetadataById[note.id] = createEmptyNoteMetadata();
        unreadableCount += 1;
      });

      setNotes(entries);
      setTemplates(templateSummaries);
      setTrashEntries(trash);
      setSelectedFolderPath((current) => {
        if (!current) {
          return current;
        }
        return folderExists(entries, current) ? current : null;
      });

      const existingIds = collectNoteIds(entries);
      const removedIds = new Set<string>(
        [
          ...Object.keys(noteContentsRef.current),
          ...Object.keys(noteMetadataByIdRef.current),
          ...Object.keys(noteViewModesRef.current),
          ...Array.from(loadingRef.current),
        ].filter((key) => !existingIds.has(key))
      );

      if (removedIds.size > 0) {
        setNoteContents((current) => removeRecordKeys(current, removedIds));
        setNoteMetadataById((current) => removeRecordKeys(current, removedIds));
        setNoteViewModes((current) => removeRecordKeys(current, removedIds));
        setLoadingNoteIds((current) => removeSetValues(current, removedIds));
      }

      loadingRef.current = new Set();
      setNoteContents(nextContents);
      setNoteMetadataById(nextMetadataById);
      setLoadingNoteIds(new Set());

      recordStartupEvent("vault.refresh.succeeded", {
        noteCount: existingIds.size,
        templateCount: templateSummaries.length,
        trashCount: trash.length,
      });

      if (unreadableCount > 0) {
        setErrorMessage(
          `${String(unreadableCount)} note${unreadableCount === 1 ? " was" : "s were"} unreadable during load.`
        );
      }
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      markStartupError("vault.refresh.failed", { message });
      setErrorMessage("Unable to load notes. Check folder permissions.");
      setLoadingNoteIds(new Set());
      loadingRef.current = new Set();
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
    if (sidebarCollapsed) {
      return;
    }
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarCollapsed, sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_PREFERENCES_KEY, JSON.stringify(sidebarPreferences));
  }, [sidebarPreferences]);

  useEffect(() => {
    const availableTagKeys = new Set(
      availableTags.map((tag) => normalizeTag(tag).toLocaleLowerCase())
    );
    setSidebarPreferences((current) => {
      const selectedTags = current.selectedTags.filter((tag) =>
        availableTagKeys.has(normalizeTag(tag).toLocaleLowerCase())
      );

      if (selectedTags.length === current.selectedTags.length) {
        return current;
      }

      return {
        ...current,
        selectedTags,
      };
    });
  }, [availableTags]);

  const handleOpenVault = async () => {
    setErrorMessage(null);
    try {
      const directory = await selectNotesDirectory();
      if (directory) {
        setNotesDirectory(directory);
        setSelectedFolderPath(null);
        dispatchPane({ type: "reset" });
        setNoteContents({});
        setNoteMetadataById({});
        setNoteViewModes({});
        setLoadingNoteIds(new Set());
        loadingRef.current = new Set();
        setTemplates([]);
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
      if (loadingRef.current.has(noteId)) {
        return;
      }

      loadingRef.current.add(noteId);
      setLoadingNoteIds((current) => new Set(current).add(noteId));

      try {
        const rawContent = await readNote(notePath);
        const document = parseNoteDocument(rawContent);
        setNoteContents((current) => ({ ...current, [noteId]: document.body }));
        setNoteMetadataById((current) => ({
          ...current,
          [noteId]: normalizeNoteMetadata(document.metadata),
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

  const handleCreateNote = async (title: string, templatePath: string | null) => {
    setErrorMessage(null);
    try {
      const template = templatePath ? await readTemplate(templatePath) : null;
      const created = await createNote(title, selectedFolderPath, template);
      await refreshVaultState();
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
    if (!window.confirm(`Move "${note.title}" to trash?`)) {
      return;
    }

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
    const folder = findFolderByPath(notes, folderPath);
    const folderLabel = folder?.name ?? folderPath;
    if (!window.confirm(`Move folder "${folderLabel}" and its contents to trash?`)) {
      return;
    }

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
    if (!window.confirm(`Permanently delete "${entry.name}"? This cannot be undone.`)) {
      return;
    }

    setErrorMessage(null);
    try {
      await permanentlyDeleteTrashEntry(entry.id);
      await refreshVaultState();
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to permanently delete the trash item.");
    }
  };

  const handleCreateTemplate = async (name: string) => {
    setErrorMessage(null);
    try {
      await createTemplate(name, { body: "" });
      await refreshTemplates();
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to create the template.");
    }
  };

  const handleRenameTemplate = async (template: TemplateSummary, nextName: string) => {
    setErrorMessage(null);
    try {
      await renameTemplate(template.path, nextName);
      await refreshTemplates();
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to rename the template.");
    }
  };

  const handleDeleteTemplate = async (template: TemplateSummary) => {
    setErrorMessage(null);
    try {
      await deleteTemplate(template.path);
      await refreshTemplates();
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to delete the template.");
    }
  };

  const handleCreateTemplateFromNote = async (note: Note, value: string) => {
    setErrorMessage(null);
    try {
      const markdown = serializeNoteDocument({
        body: value,
        metadata: noteMetadataByIdRef.current[note.id] ?? noteMetadataFromNote(note),
      });
      await createTemplateFromNote(note.title, markdown);
      await refreshTemplates();
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to create a template from this note.");
    }
  };

  const handleAutoSave = async (noteId: string, nextDocument: NoteDocument) => {
    const note = getNoteById(noteId);
    if (!note) {
      return;
    }

    const updatedMetadata = normalizeNoteMetadata({
      ...nextDocument.metadata,
      updatedAt: new Date().toISOString(),
    });
    const serialized = serializeNoteDocument({
      body: nextDocument.body,
      metadata: updatedMetadata,
    });

    setSaveState(SaveState.Saving);

    try {
      await updateNote(note.path, serialized);
      setNoteContents((current) => ({
        ...current,
        [noteId]: nextDocument.body,
      }));
      setNoteMetadataById((current) => ({
        ...current,
        [noteId]: updatedMetadata,
      }));
      setSaveState(SaveState.Saved);
    } catch (error) {
      console.error(error);
      setSaveState(SaveState.Error);
      setErrorMessage("Auto-save failed. Check disk access.");
    }
  };

  const handleChangeNoteContent = (noteId: string, nextValue: string) => {
    if (noteContents[noteId] === nextValue) {
      return;
    }

    setSaveState(SaveState.Dirty);
    setNoteContents((current) => ({ ...current, [noteId]: nextValue }));
  };

  const handleChangeNoteMetadata = (noteId: string, metadata: NoteMetadata) => {
    setSaveState(SaveState.Dirty);
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
      data-save-state={saveState}
      style={{ "--sidebar-width": `${String(resolvedSidebarWidth)}px` } as CSSProperties}
    >
      <aside className={`app-sidebar ${sidebarCollapsed ? "app-sidebar--collapsed" : ""}`}>
        <NoteListErrorBoundary>
          <NoteList
            directoryPath={notesDirectory}
            notes={notesWithMetadata}
            templates={templates}
            trashEntries={trashEntries}
            selectedNoteId={activeNoteId}
            selectedFolderPath={selectedFolderPath}
            sidebarPreferences={sidebarPreferences}
            availableTags={availableTags}
            onSidebarPreferencesChange={setSidebarPreferences}
            onOpenVault={() => {
              void handleOpenVault();
            }}
            onCreateNote={(title, templatePath) => {
              void handleCreateNote(title, templatePath);
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
            onCreateTemplate={(name) => {
              void handleCreateTemplate(name);
            }}
            onRenameTemplate={(template, nextName) => {
              void handleRenameTemplate(template, nextName);
            }}
            onDeleteTemplate={(template) => {
              void handleDeleteTemplate(template);
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
            availableTags={availableTags}
            onActivatePane={(paneId) => {
              dispatchPane({ type: "activate-pane", paneId });
            }}
            onClosePane={handleClosePane}
            onToggleNoteViewMode={toggleNoteViewMode}
            onCreateTemplateFromNote={(note, value) => {
              void handleCreateTemplateFromNote(note, value);
            }}
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
            isLoading={false}
            viewMode="edit"
          />
        )}
      </section>
    </main>
  );
}

export default App;
