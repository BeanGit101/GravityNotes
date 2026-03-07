import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { lintGutter } from "@codemirror/lint";
import { Compartment, EditorState } from "@codemirror/state";
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
  note: Note | null;
  value: string;
  availableTags: string[];
  onChange: (value: string) => void;
  onMetadataChange: (metadata: NoteMetadata) => void;
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

function formatUpdatedAt(updatedAt?: string): string | null {
  if (!updatedAt) {
    return null;
  }

  const parsed = new Date(updatedAt);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toLocaleString();
}

export function NoteEditor({
  note,
  value,
  availableTags,
  onChange,
  onMetadataChange,
  onAutoSave,
  toolbarActions,
  isActive = false,
  viewMode = "edit",
  isLoading = false,
}: NoteEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const metadataRef = useRef<NoteMetadata>(createEmptyNoteMetadata());
  const lastSavedRef = useRef(createDocumentSnapshot(value, createEmptyNoteMetadata()));
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

  const noteMetadata = useMemo(
    () =>
      note
        ? normalizeNoteMetadata({
            subject: note.subject,
            tags: note.tags,
            updatedAt: note.updatedAt,
          })
        : createEmptyNoteMetadata(),
    [note]
  );

  const documentSnapshot = useMemo(
    () => createDocumentSnapshot(value, noteMetadata),
    [noteMetadata, value]
  );
  const activeNoteId = note?.id ?? null;
  const tagInput = tagDraft.noteId === activeNoteId ? tagDraft.value : "";
  const isPreviewMode = viewMode === "preview";
  const canToggleCheckboxes = Boolean(note) && !isLoading && !isPreviewMode;
  const isEditable = canToggleCheckboxes;
  const isMetadataEditable = Boolean(note) && !isLoading;
  const updatedAtLabel = note ? formatUpdatedAt(note.updatedAt) : null;
  const suggestedTags = useMemo(() => {
    const assigned = new Set(noteMetadata.tags.map((tag) => normalizeTag(tag).toLocaleLowerCase()));
    return availableTags.filter((tag) => !assigned.has(normalizeTag(tag).toLocaleLowerCase()));
  }, [availableTags, noteMetadata.tags]);

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

    const view = new EditorView({
      state,
      parent: container,
    });

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
    if (note?.path) {
      lastSavedRef.current = documentSnapshot;
    }
  }, [documentSnapshot, note?.path]);

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
    if (!note || isLoading) return;
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
  }, [documentSnapshot, isLoading, note, noteMetadata, value]);

  const emitMetadataChange = (nextMetadata: NoteMetadata) => {
    metadataRef.current = nextMetadata;
    onMetadataChangeRef.current(nextMetadata);
  };

  const clearTagDraft = () => {
    setTagDraft({ noteId: activeNoteId, value: "" });
  };

  const handleTogglePreviewTask = (taskIndex: number) => {
    if (!note || isLoading) {
      return;
    }

    const currentValue = valueRef.current;
    const nextValue = toggleNthTaskMarker(currentValue, taskIndex);
    if (nextValue === currentValue) {
      return;
    }

    valueRef.current = nextValue;
    onChangeRef.current(nextValue);
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
              : "Frontmatter is added only when metadata is set."}
          </p>
        </div>
        {toolbarActions && <div className="note-editor__actions">{toolbarActions}</div>}
      </div>

      {note && (
        <div className="note-editor__properties">
          <label className="note-editor__field">
            <span className="note-editor__field-label">Subject</span>
            <input
              className="input note-editor__input"
              type="text"
              value={noteMetadata.subject ?? ""}
              onChange={handleSubjectChange}
              placeholder="Add a subject for this note"
              disabled={!isMetadataEditable}
            />
          </label>

          <div className="note-editor__field">
            <span className="note-editor__field-label">Tags</span>
            <div className="note-editor__tag-editor">
              <div className="note-editor__tag-list">
                {noteMetadata.tags.map((tag) => (
                  <span key={tag} className="note-editor__tag-chip">
                    <span>#{tag}</span>
                    <button
                      className="note-editor__tag-remove"
                      type="button"
                      onClick={() => {
                        emitMetadataChange({
                          ...metadataRef.current,
                          tags: metadataRef.current.tags.filter((entry) => entry !== tag),
                        });
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
                    setTagDraft({ noteId: activeNoteId, value: event.target.value });
                  }}
                  onKeyDown={handleTagInputKeyDown}
                  onBlur={() => {
                    if (tagInput.trim()) {
                      commitTag(tagInput);
                    }
                  }}
                  placeholder={
                    noteMetadata.tags.length === 0 ? "Add a tag and press Enter" : "Add tag"
                  }
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
                      commitTag(tag);
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
