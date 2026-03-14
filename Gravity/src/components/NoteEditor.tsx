import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { lintGutter } from "@codemirror/lint";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { checkboxPlugin, checkboxToggleFacet } from "../codemirror/checkboxPlugin";
import { markdownDecoratorPlugin, markdownTheme } from "../codemirror/markdownDecorations";
import { spellLinter } from "../editor/spellLinter";
import { toggleNthTaskMarker } from "../editor/taskList";
import {
  applyRedo,
  applyUndo,
  createHistorySnapshot,
  createUndoRedoState,
  diffToCommand,
  recordCommand,
  restoreHistorySnapshot,
  sealBurst,
  type UndoRedoHistorySnapshot,
} from "../editor/undoRedo";
import { createSaveController } from "../state/saveController";
import type { NoteViewMode } from "../types/editor";
import type { Note, NoteDocument, NoteMetadata } from "../types/notes";
import { createEmptyNoteMetadata, normalizeNoteMetadata, normalizeTag } from "../utils/frontmatter";
import { MarkdownPreview } from "./MarkdownPreview";

interface NoteEditorProps {
  note: Pick<Note, "id" | "title" | "path" | "updatedAt"> | null;
  metadata?: NoteMetadata;
  value: string;
  availableTags?: string[];
  onChange: (value: string) => void;
  onMetadataChange?: (metadata: NoteMetadata) => void;
  onAutoSave: (value: NoteDocument) => Promise<void>;
  toolbarActions?: ReactNode;
  isActive?: boolean;
  viewMode?: NoteViewMode;
  isLoading?: boolean;
}

function createDocumentSnapshot(body: string, metadata: NoteMetadata): string {
  return JSON.stringify({
    body,
    subject: metadata.subject ?? "",
    tags: metadata.tags,
  });
}

function formatUpdatedAt(updatedAt?: number): string | null {
  if (!updatedAt) {
    return null;
  }

  const parsed = new Date(updatedAt);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toLocaleString();
}

function normalizeTagOptions(tags: string[] | undefined): string[] {
  const normalizedTags = new Map<string, string>();

  (tags ?? []).forEach((tag) => {
    const normalized = normalizeTag(tag);
    if (!normalized) {
      return;
    }

    const key = normalized.toLocaleLowerCase();
    if (!normalizedTags.has(key)) {
      normalizedTags.set(key, normalized);
    }
  });

  return Array.from(normalizedTags.values());
}

interface OptionalFrontmatterPanelProps {
  metadata: NoteMetadata;
  isMetadataEditable: boolean;
  tagInput: string;
  suggestedTags: string[];
  onSubjectChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onTagInputChange: (value: string) => void;
  onTagInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onTagInputBlur: () => void;
  onRemoveTag: (tag: string) => void;
  onCommitTag: (tag: string) => void;
}

function OptionalFrontmatterPanel({
  metadata,
  isMetadataEditable,
  tagInput,
  suggestedTags,
  onSubjectChange,
  onTagInputChange,
  onTagInputKeyDown,
  onTagInputBlur,
  onRemoveTag,
  onCommitTag,
}: OptionalFrontmatterPanelProps) {
  const frontmatterPanelId = useId();
  const [isExpanded, setIsExpanded] = useState(false);
  const frontmatterSummary = useMemo(() => {
    const parts: string[] = [];

    if (metadata.subject) {
      parts.push(metadata.subject);
    }
    if (metadata.tags.length > 0) {
      parts.push(metadata.tags.map((tag) => `#${tag}`).join(" "));
    }

    return parts.join(" | ");
  }, [metadata.subject, metadata.tags]);

  return (
    <section className="note-editor__frontmatter">
      <div className="note-editor__frontmatter-header">
        <div className="note-editor__frontmatter-copy">
          <p className="note-editor__frontmatter-title">Details (optional)</p>
          <p className="note-editor__frontmatter-description">
            Store a subject or tags in note metadata without changing the note body.
          </p>
          {!isExpanded && frontmatterSummary && (
            <p className="note-editor__frontmatter-summary">{frontmatterSummary}</p>
          )}
        </div>
        <button
          className="button button--secondary note-editor__frontmatter-toggle"
          type="button"
          onClick={() => {
            setIsExpanded((current) => !current);
          }}
          aria-expanded={isExpanded}
          aria-controls={frontmatterPanelId}
        >
          {isExpanded ? "Hide details" : frontmatterSummary ? "Edit details" : "Add details"}
        </button>
      </div>

      {isExpanded && (
        <div className="note-editor__properties" id={frontmatterPanelId}>
          <label className="note-editor__field">
            <span className="note-editor__field-label">Subject</span>
            <input
              className="input note-editor__input"
              type="text"
              value={metadata.subject ?? ""}
              onChange={onSubjectChange}
              placeholder="Optional subject"
              disabled={!isMetadataEditable}
            />
          </label>

          <div className="note-editor__field">
            <span className="note-editor__field-label">Tags</span>
            <div className="note-editor__tag-editor">
              <div className="note-editor__tag-list">
                {metadata.tags.map((tag) => (
                  <span key={tag} className="note-editor__tag-chip">
                    <span>#{tag}</span>
                    <button
                      className="note-editor__tag-remove"
                      type="button"
                      onClick={() => {
                        onRemoveTag(tag);
                      }}
                      disabled={!isMetadataEditable}
                      aria-label={`Remove ${tag}`}
                    >
                      x
                    </button>
                  </span>
                ))}
                <input
                  className="note-editor__tag-input"
                  type="text"
                  value={tagInput}
                  onChange={(event) => {
                    onTagInputChange(event.target.value);
                  }}
                  onKeyDown={onTagInputKeyDown}
                  onBlur={onTagInputBlur}
                  placeholder="Add an optional tag"
                  disabled={!isMetadataEditable}
                />
              </div>
            </div>
            {suggestedTags.length > 0 && (
              <div className="note-editor__tag-options">
                {suggestedTags.map((tag) => (
                  <button
                    key={tag}
                    className="note-editor__tag-option"
                    type="button"
                    onClick={() => {
                      onCommitTag(tag);
                    }}
                    disabled={!isMetadataEditable}
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

interface SearchMatch {
  from: number;
  to: number;
}

function findMatches(value: string, query: string, matchCase: boolean): SearchMatch[] {
  if (!query) {
    return [];
  }

  const matches: SearchMatch[] = [];
  const source = matchCase ? value : value.toLowerCase();
  const needle = matchCase ? query : query.toLowerCase();
  let startIndex = 0;

  while (startIndex <= source.length - needle.length) {
    const index = source.indexOf(needle, startIndex);
    if (index === -1) {
      break;
    }

    matches.push({ from: index, to: index + needle.length });
    startIndex = index + Math.max(needle.length, 1);
  }

  return matches;
}

export function NoteEditor({
  note,
  metadata,
  value,
  availableTags = [],
  onChange,
  onMetadataChange = () => {},
  onAutoSave,
  toolbarActions,
  isActive = false,
  viewMode = "edit",
  isLoading = false,
}: NoteEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const metadataRef = useRef<NoteMetadata>(createEmptyNoteMetadata());
  const lastSavedRef = useRef(createDocumentSnapshot(value, createEmptyNoteMetadata()));
  const lastLoadedStateRef = useRef<{ noteKey: string | null; isLoading: boolean }>({
    noteKey: null,
    isLoading: true,
  });
  const onChangeRef = useRef(onChange);
  const onMetadataChangeRef = useRef(onMetadataChange);
  const onAutoSaveRef = useRef(onAutoSave);
  const saveControllerRef = useRef(createSaveController());
  const undoRedoRef = useRef(createUndoRedoState());
  const undoHistoryByNoteRef = useRef<Map<string, UndoRedoHistorySnapshot>>(new Map());
  const activeHistoryKeyRef = useRef<string | null>(note?.path ?? note?.id ?? null);
  const suppressHistoryRef = useRef(false);
  const [tagDraft, setTagDraft] = useState<{ noteId: string | null; value: string }>({
    noteId: note?.id ?? null,
    value: "",
  });
  const openFindRef = useRef<(showReplace: boolean) => void>(() => {});
  const findNextRef = useRef<() => void>(() => {});
  const findPrevRef = useRef<() => void>(() => {});

  const [isFindOpen, setIsFindOpen] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceValue, setReplaceValue] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState(0);

  const noteMetadata = note ? normalizeNoteMetadata(metadata) : createEmptyNoteMetadata();
  const noteKey = note?.path ?? note?.id ?? null;
  const normalizedAvailableTags = useMemo(
    () => normalizeTagOptions(availableTags),
    [availableTags]
  );

  const documentSnapshot = useMemo(
    () => createDocumentSnapshot(value, noteMetadata),
    [noteMetadata, value]
  );
  const activeNoteId = note?.id ?? null;
  const tagInput = tagDraft.noteId === activeNoteId ? tagDraft.value : "";
  const isPreviewMode = viewMode === "preview";
  const canToggleCheckboxes = Boolean(note) && !isLoading && !isPreviewMode;
  const canTogglePreviewTasks = Boolean(note) && !isLoading;
  const isEditable = canToggleCheckboxes;
  const isMetadataEditable = Boolean(note) && !isLoading;
  const updatedAtLabel = note ? formatUpdatedAt(note.updatedAt) : null;
  const suggestedTags = useMemo(() => {
    const assigned = new Set(noteMetadata.tags.map((tag) => normalizeTag(tag).toLocaleLowerCase()));
    return normalizedAvailableTags.filter(
      (tag) => !assigned.has(normalizeTag(tag).toLocaleLowerCase())
    );
  }, [normalizedAvailableTags, noteMetadata.tags]);
  const matches = useMemo(
    () => findMatches(value, findQuery, matchCase),
    [findQuery, matchCase, value]
  );
  const resolvedActiveMatchIndex =
    matches.length === 0 ? 0 : Math.min(activeMatchIndex, matches.length - 1);
  const activeMatch = matches.length > 0 ? matches[resolvedActiveMatchIndex] : null;

  const placeholderText = note
    ? isLoading
      ? "Loading note..."
      : isPreviewMode
        ? "Preview mode is active."
        : "Start writing your note..."
    : "Select or create a note to begin.";

  const initialStateRef = useRef({
    value,
    isEditable,
    placeholder: placeholderText,
    canToggleCheckboxes,
  });

  const editableCompartment = useMemo(() => new Compartment(), []);
  const placeholderCompartment = useMemo(() => new Compartment(), []);
  const checkboxToggleCompartment = useMemo(() => new Compartment(), []);

  const selectMatch = useCallback((match: SearchMatch | null, focusEditor = false) => {
    const view = viewRef.current;
    if (!view || !match) {
      return;
    }

    view.dispatch({
      selection: EditorSelection.single(match.from, match.to),
      scrollIntoView: true,
    });
    if (focusEditor) {
      view.focus();
    }
  }, []);

  const openFind = useCallback((nextShowReplace: boolean) => {
    setIsFindOpen(true);
    setShowReplace(nextShowReplace);

    const view = viewRef.current;
    if (!view) {
      return;
    }

    const selection = view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to
    );
    if (selection.trim()) {
      setFindQuery(selection);
      setActiveMatchIndex(0);
    }
  }, []);

  const goToMatch = useCallback(
    (direction: 1 | -1) => {
      if (matches.length === 0) {
        return;
      }

      setActiveMatchIndex((current) => {
        const next = (current + direction + matches.length) % matches.length;
        window.requestAnimationFrame(() => {
          const match = matches[next] ?? null;
          selectMatch(match, true);
        });
        return next;
      });
    },
    [matches, selectMatch]
  );

  const replaceCurrentMatch = useCallback(() => {
    const view = viewRef.current;
    if (!view || !activeMatch || !findQuery || isPreviewMode || isLoading) {
      return;
    }

    const currentValue = view.state.doc.toString();
    const nextValue = `${currentValue.slice(0, activeMatch.from)}${replaceValue}${currentValue.slice(activeMatch.to)}`;
    view.dispatch({
      changes: { from: activeMatch.from, to: activeMatch.to, insert: replaceValue },
      selection: EditorSelection.single(activeMatch.from, activeMatch.from + replaceValue.length),
      scrollIntoView: true,
    });
    view.focus();

    const nextMatches = findMatches(nextValue, findQuery, matchCase);
    setActiveMatchIndex(Math.min(resolvedActiveMatchIndex, Math.max(nextMatches.length - 1, 0)));
  }, [
    activeMatch,
    findQuery,
    isLoading,
    isPreviewMode,
    matchCase,
    replaceValue,
    resolvedActiveMatchIndex,
  ]);

  const replaceAllMatches = useCallback(() => {
    const view = viewRef.current;
    if (!view || !findQuery || matches.length === 0 || isPreviewMode || isLoading) {
      return;
    }

    const currentValue = view.state.doc.toString();
    let cursor = 0;
    const nextValue =
      matches
        .map((match) => {
          const segment = `${currentValue.slice(cursor, match.from)}${replaceValue}`;
          cursor = match.to;
          return segment;
        })
        .join("") + currentValue.slice(matches[matches.length - 1]?.to ?? currentValue.length);

    sealBurst(undoRedoRef.current);
    view.dispatch({
      changes: { from: 0, to: currentValue.length, insert: nextValue },
      selection: EditorSelection.single(0),
      scrollIntoView: true,
    });
    view.focus();
    setActiveMatchIndex(0);
  }, [findQuery, isLoading, isPreviewMode, matches, replaceValue]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onMetadataChangeRef.current = onMetadataChange;
  }, [onMetadataChange]);

  useEffect(() => {
    onAutoSaveRef.current = onAutoSave;
  }, [onAutoSave]);

  useEffect(() => {
    metadataRef.current = noteMetadata;
  }, [noteMetadata]);

  useEffect(() => {
    if (!isFindOpen) {
      return;
    }
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [isFindOpen, showReplace]);

  useEffect(() => {
    openFindRef.current = openFind;
    findNextRef.current = () => {
      goToMatch(1);
    };
    findPrevRef.current = () => {
      goToMatch(-1);
    };
  }, [goToMatch, openFind]);

  useEffect(() => {
    if (!activeMatch || !isFindOpen) {
      return;
    }
    selectMatch(activeMatch);
  }, [activeMatch, isFindOpen, selectMatch]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const applyContent = (view: EditorView, nextContent: string) => {
      const currentContent = view.state.doc.toString();
      if (currentContent === nextContent) {
        return true;
      }

      suppressHistoryRef.current = true;
      view.dispatch({
        changes: { from: 0, to: currentContent.length, insert: nextContent },
      });
      suppressHistoryRef.current = false;
      return true;
    };

    const customHistoryKeymap = keymap.of([
      {
        key: "Mod-z",
        run: (view) => {
          const currentContent = view.state.doc.toString();
          const nextContent = applyUndo(undoRedoRef.current, currentContent);
          return applyContent(view, nextContent);
        },
      },
      {
        key: "Mod-y",
        run: (view) => {
          const currentContent = view.state.doc.toString();
          const nextContent = applyRedo(undoRedoRef.current, currentContent);
          return applyContent(view, nextContent);
        },
      },
      {
        key: "Mod-Shift-z",
        run: (view) => {
          const currentContent = view.state.doc.toString();
          const nextContent = applyRedo(undoRedoRef.current, currentContent);
          return applyContent(view, nextContent);
        },
      },
    ]);

    const eventHandlers = EditorView.domEventHandlers({
      keydown: (event, view) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          openFindRef.current(false);
          return true;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "h") {
          event.preventDefault();
          openFindRef.current(true);
          return true;
        }

        if (event.key === "F3") {
          event.preventDefault();
          if (event.shiftKey) {
            findPrevRef.current();
          } else {
            findNextRef.current();
          }
          return true;
        }

        if (event.key === "Enter") {
          sealBurst(undoRedoRef.current);
        }

        const selection = view.state.selection.main;
        if ((event.key === "Backspace" || event.key === "Delete") && !selection.empty) {
          sealBurst(undoRedoRef.current);
        }

        return false;
      },
      paste: () => {
        sealBurst(undoRedoRef.current);
        return false;
      },
    });

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const nextValue = update.state.doc.toString();
        const previousValue = valueRef.current;

        if (!suppressHistoryRef.current) {
          const command = diffToCommand(previousValue, nextValue);
          if (command) {
            recordCommand(undoRedoRef.current, command);
          }
        }

        valueRef.current = nextValue;
        onChangeRef.current(nextValue);
      } else if (update.selectionSet) {
        const movedCursor =
          update.startState.selection.main.head !== update.state.selection.main.head ||
          update.startState.selection.main.anchor !== update.state.selection.main.anchor;
        if (movedCursor) {
          sealBurst(undoRedoRef.current);
        }
      }
    });

    const state = EditorState.create({
      doc: initialStateRef.current.value,
      extensions: [
        markdown({ extensions: [GFM] }),
        checkboxPlugin,
        markdownDecoratorPlugin,
        markdownTheme,
        lintGutter(),
        spellLinter,
        EditorView.lineWrapping,
        customHistoryKeymap,
        keymap.of(defaultKeymap),
        eventHandlers,
        updateListener,
        editableCompartment.of(EditorView.editable.of(initialStateRef.current.isEditable)),
        placeholderCompartment.of(placeholder(initialStateRef.current.placeholder)),
        checkboxToggleCompartment.of(
          checkboxToggleFacet.of(initialStateRef.current.canToggleCheckboxes)
        ),
        EditorView.theme({
          "&": { minHeight: "360px", fontSize: "0.98rem" },
          ".cm-content": { padding: "1.5rem 1.75rem" },
          ".cm-line": { lineHeight: "1.6" },
          "&.cm-focused": { outline: "none" },
        }),
      ],
    });

    const view = new EditorView({ state, parent: container });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [checkboxToggleCompartment, editableCompartment, placeholderCompartment]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    const previous = lastLoadedStateRef.current;
    const didNoteChange = previous.noteKey !== noteKey;
    const didFinishLoading = previous.isLoading && !isLoading;

    if ((didNoteChange || didFinishLoading) && noteKey && !isLoading) {
      lastSavedRef.current = documentSnapshot;
    }

    lastLoadedStateRef.current = { noteKey, isLoading };
  }, [documentSnapshot, isLoading, noteKey]);

  useEffect(() => {
    const nextKey = note?.path ?? note?.id ?? null;
    const previousKey = activeHistoryKeyRef.current;
    if (previousKey === nextKey) return;

    const state = undoRedoRef.current;
    sealBurst(state);

    if (previousKey) {
      undoHistoryByNoteRef.current.set(previousKey, createHistorySnapshot(state));
    }

    const restored = nextKey ? undoHistoryByNoteRef.current.get(nextKey) : null;
    restoreHistorySnapshot(state, restored);
    activeHistoryKeyRef.current = nextKey;
    saveControllerRef.current.reset();
  }, [note?.id, note?.path]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    view.dispatch({
      effects: [
        editableCompartment.reconfigure(EditorView.editable.of(isEditable)),
        placeholderCompartment.reconfigure(placeholder(placeholderText)),
        checkboxToggleCompartment.reconfigure(checkboxToggleFacet.of(canToggleCheckboxes)),
      ],
    });

    const currentValue = view.state.doc.toString();
    if (currentValue !== value) {
      sealBurst(undoRedoRef.current);
      suppressHistoryRef.current = true;
      view.dispatch({
        changes: { from: 0, to: currentValue.length, insert: value },
      });
      suppressHistoryRef.current = false;
    }
  }, [
    canToggleCheckboxes,
    checkboxToggleCompartment,
    editableCompartment,
    isEditable,
    placeholderCompartment,
    placeholderText,
    value,
  ]);

  useEffect(() => {
    if (!noteKey || isLoading) return;
    if (documentSnapshot === lastSavedRef.current) return;

    const pendingDocument: NoteDocument = {
      body: value,
      metadata: noteMetadata,
    };
    const pendingSnapshot = documentSnapshot;
    const handle = window.setTimeout(() => {
      void saveControllerRef.current
        .save(
          pendingSnapshot,
          async () => onAutoSaveRef.current(pendingDocument),
          (committedValue) => {
            lastSavedRef.current = committedValue;
          }
        )
        .catch(() => {
          // Save status handled upstream.
        });
    }, 1000);

    return () => {
      window.clearTimeout(handle);
    };
  }, [documentSnapshot, isLoading, noteKey, noteMetadata, value]);

  const emitMetadataChange = (nextMetadata: NoteMetadata) => {
    metadataRef.current = nextMetadata;
    onMetadataChangeRef.current(nextMetadata);
  };

  const clearTagDraft = () => {
    setTagDraft({ noteId: activeNoteId, value: "" });
  };

  const handleTogglePreviewTask = (taskIndex: number) => {
    if (!canTogglePreviewTasks) {
      return;
    }

    const currentValue = valueRef.current;
    const nextValue = toggleNthTaskMarker(currentValue, taskIndex);
    if (nextValue === currentValue) {
      return;
    }

    sealBurst(undoRedoRef.current);
    const command = diffToCommand(currentValue, nextValue);
    if (command) {
      recordCommand(undoRedoRef.current, command);
    }

    valueRef.current = nextValue;
    onChangeRef.current(nextValue);

    const pendingDocument: NoteDocument = {
      body: nextValue,
      metadata: metadataRef.current,
    };
    const pendingSnapshot = createDocumentSnapshot(nextValue, metadataRef.current);

    void saveControllerRef.current
      .save(
        pendingSnapshot,
        async () => onAutoSaveRef.current(pendingDocument),
        (committedValue) => {
          lastSavedRef.current = committedValue;
        }
      )
      .catch(() => {
        // Save status handled upstream.
      });
  };

  const commitTag = (rawTag: string) => {
    if (!isMetadataEditable) {
      return;
    }

    const nextTag = normalizeTag(rawTag);
    if (!nextTag) {
      clearTagDraft();
      return;
    }

    if (
      metadataRef.current.tags.some(
        (tag) => normalizeTag(tag).toLocaleLowerCase() === nextTag.toLocaleLowerCase()
      )
    ) {
      clearTagDraft();
      return;
    }

    emitMetadataChange({
      ...metadataRef.current,
      tags: [...metadataRef.current.tags, nextTag],
    });
    clearTagDraft();
  };

  const handleTagInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" && event.key !== ",") {
      return;
    }

    event.preventDefault();
    commitTag(tagInput);
  };

  const handleSubjectChange = (event: ChangeEvent<HTMLInputElement>) => {
    emitMetadataChange({
      ...metadataRef.current,
      subject: event.target.value,
    });
  };

  const previewContent = !note ? (
    <p className="note-editor__preview-empty">Select or create a note to preview.</p>
  ) : isLoading ? (
    <p className="note-editor__preview-empty">Loading note...</p>
  ) : (
    <MarkdownPreview value={value} onToggleTask={handleTogglePreviewTask} />
  );

  return (
    <section className={`note-editor ${isActive ? "note-editor--active" : ""}`}>
      <div className="note-editor__toolbar">
        <div>
          <p className="note-editor__eyebrow">Editor</p>
          <h3 className="note-editor__title">{note ? note.title : "No note selected"}</h3>
          <p className="note-editor__meta">
            {updatedAtLabel
              ? `Updated ${updatedAtLabel}`
              : "Subject and tags stay out of the note unless you choose to add them."}
          </p>
        </div>
        <div className="note-editor__actions">
          {note && !isPreviewMode && !isLoading && (
            <>
              <button
                className="button button--secondary"
                type="button"
                onClick={() => {
                  openFind(false);
                }}
              >
                Find
              </button>
              <button
                className="button button--secondary"
                type="button"
                onClick={() => {
                  openFind(true);
                }}
              >
                Replace
              </button>
            </>
          )}
          {toolbarActions}
        </div>
      </div>
      {noteKey && (
        <OptionalFrontmatterPanel
          key={noteKey}
          metadata={noteMetadata}
          isMetadataEditable={isMetadataEditable}
          tagInput={tagInput}
          suggestedTags={suggestedTags}
          onSubjectChange={handleSubjectChange}
          onTagInputChange={(nextValue) => {
            setTagDraft({ noteId: activeNoteId, value: nextValue });
          }}
          onTagInputKeyDown={handleTagInputKeyDown}
          onTagInputBlur={() => {
            if (tagInput.trim()) {
              commitTag(tagInput);
            }
          }}
          onRemoveTag={(tag) => {
            emitMetadataChange({
              ...metadataRef.current,
              tags: metadataRef.current.tags.filter((entry) => entry !== tag),
            });
          }}
          onCommitTag={commitTag}
        />
      )}

      {isFindOpen && !isPreviewMode && (
        <div className="note-editor__findbar">
          <div className="note-editor__find-row">
            <input
              ref={findInputRef}
              className="input note-editor__find-input"
              placeholder="Find"
              value={findQuery}
              onChange={(event) => {
                setFindQuery(event.target.value);
                setActiveMatchIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (event.shiftKey) {
                    goToMatch(-1);
                  } else {
                    goToMatch(1);
                  }
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setIsFindOpen(false);
                }
              }}
            />
            <span className="note-editor__find-status">
              {matches.length === 0
                ? "0 matches"
                : `${String(resolvedActiveMatchIndex + 1)} / ${String(matches.length)}`}
            </span>
            <button
              className="button button--secondary"
              type="button"
              onClick={() => {
                goToMatch(-1);
              }}
            >
              Prev
            </button>
            <button
              className="button button--secondary"
              type="button"
              onClick={() => {
                goToMatch(1);
              }}
            >
              Next
            </button>
            <label className="note-editor__toggle-option">
              <input
                type="checkbox"
                checked={matchCase}
                onChange={(event) => {
                  setMatchCase(event.target.checked);
                  setActiveMatchIndex(0);
                }}
              />
              Match case
            </label>
            <button
              className="button button--secondary"
              type="button"
              onClick={() => {
                setShowReplace((current) => !current);
              }}
            >
              {showReplace ? "Hide Replace" : "Show Replace"}
            </button>
            <button
              className="button button--secondary"
              type="button"
              onClick={() => {
                setIsFindOpen(false);
              }}
            >
              Close
            </button>
          </div>
          {showReplace && (
            <div className="note-editor__find-row">
              <input
                className="input note-editor__find-input"
                placeholder="Replace"
                value={replaceValue}
                onChange={(event) => {
                  setReplaceValue(event.target.value);
                }}
              />
              <button
                className="button button--secondary"
                type="button"
                onClick={replaceCurrentMatch}
              >
                Replace
              </button>
              <button
                className="button button--secondary"
                type="button"
                onClick={replaceAllMatches}
              >
                Replace All
              </button>
            </div>
          )}
        </div>
      )}
      <div
        className={`note-editor__surface ${isPreviewMode ? "note-editor__surface--preview" : ""}`}
      >
        {isPreviewMode && <div className="note-editor__preview-layer">{previewContent}</div>}
        <div
          className={`note-editor__editor-layer ${isPreviewMode ? "note-editor__editor-layer--hidden" : ""}`}
          ref={containerRef}
          aria-hidden={isPreviewMode}
        />
      </div>
    </section>
  );
}

