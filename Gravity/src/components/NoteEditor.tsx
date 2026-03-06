import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { lintGutter } from "@codemirror/lint";
import { markdown } from "@codemirror/lang-markdown";
import { checkboxPlugin, checkboxToggleFacet } from "../codemirror/checkboxPlugin";
import { markdownDecoratorPlugin, markdownTheme } from "../codemirror/markdownDecorations";
import { spellLinter } from "../editor/spellLinter";
import type { Note } from "../types/notes";
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

interface NoteEditorProps {
  note: Note | null;
  value: string;
  onChange: (value: string) => void;
  onAutoSave: (value: string) => Promise<void>;
  toolbarActions?: ReactNode;
  isActive?: boolean;
  isPreviewMode?: boolean;
  isLoading?: boolean;
}

export function NoteEditor({
  note,
  value,
  onChange,
  onAutoSave,
  toolbarActions,
  isActive = false,
  isPreviewMode = false,
  isLoading = false,
}: NoteEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastSavedRef = useRef<string>(value);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onAutoSaveRef = useRef(onAutoSave);
  const undoRedoRef = useRef(createUndoRedoState());
  const undoHistoryByNoteRef = useRef<Map<string, UndoRedoHistorySnapshot>>(new Map());
  const activeHistoryKeyRef = useRef<string | null>(note?.path ?? note?.id ?? null);
  const suppressHistoryRef = useRef(false);
  const canToggleCheckboxes = Boolean(note) && !isLoading;
  const isEditable = canToggleCheckboxes && !isPreviewMode;
  const placeholderText = note
    ? isLoading
      ? "Loading note..."
      : isPreviewMode
        ? "Preview mode (checkboxes are still interactive)."
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
    onAutoSaveRef.current = onAutoSave;
  }, [onAutoSave]);

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
        markdown(),
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
      lastSavedRef.current = valueRef.current;
    }
  }, [note?.path]);

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
    if (value === lastSavedRef.current) return;

    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          await onAutoSaveRef.current(value);
          lastSavedRef.current = value;
        } catch {
          // Save status handled upstream.
        }
      })();
    }, 1000);

    return () => {
      window.clearTimeout(handle);
    };
  }, [isLoading, note, value]);

  return (
    <section className={`note-editor ${isActive ? "note-editor--active" : ""}`}>
      <div className="note-editor__toolbar">
        <div>
          <p className="note-editor__eyebrow">Editor</p>
          <h3 className="note-editor__title">{note ? note.title : "No note selected"}</h3>
        </div>
        {toolbarActions && <div className="note-editor__actions">{toolbarActions}</div>}
      </div>
      <div className="note-editor__surface" ref={containerRef} />
    </section>
  );
}
