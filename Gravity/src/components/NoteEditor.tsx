import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import type { Note } from "../types/notes";

interface NoteEditorProps {
  note: Note | null;
  value: string;
  onChange: (value: string) => void;
  onAutoSave: (value: string) => Promise<void>;
  toolbarActions?: ReactNode;
  isActive?: boolean;
  isReadOnly?: boolean;
}

export function NoteEditor({
  note,
  value,
  onChange,
  onAutoSave,
  toolbarActions,
  isActive = false,
  isReadOnly = false,
}: NoteEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastSavedRef = useRef<string>(value);
  const valueRef = useRef(value);
  const isEditable = Boolean(note) && !isReadOnly;
  const placeholderText = note
    ? isReadOnly
      ? "Loading note..."
      : "Start writing your note..."
    : "Select or create a note to begin.";
  const initialStateRef = useRef({
    value,
    isEditable,
    placeholder: placeholderText,
  });

  const editableCompartment = useMemo(() => new Compartment(), []);
  const placeholderCompartment = useMemo(() => new Compartment(), []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChange(update.state.doc.toString());
      }
    });

    const state = EditorState.create({
      doc: initialStateRef.current.value,
      extensions: [
        markdown(),
        EditorView.lineWrapping,
        keymap.of(defaultKeymap),
        updateListener,
        editableCompartment.of(EditorView.editable.of(initialStateRef.current.isEditable)),
        placeholderCompartment.of(placeholder(initialStateRef.current.placeholder)),
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
  }, [editableCompartment, onChange, placeholderCompartment]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (note?.path) {
      lastSavedRef.current = valueRef.current;
    }
  }, [note?.path]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    view.dispatch({
      effects: [
        editableCompartment.reconfigure(EditorView.editable.of(isEditable)),
        placeholderCompartment.reconfigure(placeholder(placeholderText)),
      ],
    });

    const currentValue = view.state.doc.toString();
    if (currentValue !== value) {
      view.dispatch({
        changes: { from: 0, to: currentValue.length, insert: value },
      });
    }
  }, [editableCompartment, isEditable, placeholderCompartment, placeholderText, value]);

  useEffect(() => {
    if (!note) return;
    if (value === lastSavedRef.current) return;

    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          await onAutoSave(value);
          lastSavedRef.current = value;
        } catch {
          // Save status handled upstream.
        }
      })();
    }, 1000);

    return () => {
      window.clearTimeout(handle);
    };
  }, [note, onAutoSave, value]);

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
