import { useEffect, useMemo, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import type { Note } from "../types/notes";

type SaveStatus = "idle" | "saving" | "saved" | "error";

interface NoteEditorProps {
  note: Note | null;
  value: string;
  saveStatus: SaveStatus;
  onChange: (value: string) => void;
  onAutoSave: (value: string) => Promise<void>;
}

export function NoteEditor({ note, value, saveStatus, onChange, onAutoSave }: NoteEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const lastSavedRef = useRef<string>(value);
  const valueRef = useRef(value);
  const initialStateRef = useRef({
    value,
    isEditable: Boolean(note),
    placeholder: note ? "Start writing your note..." : "Select or create a note to begin.",
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

    const isEditable = Boolean(note);
    view.dispatch({
      effects: [
        editableCompartment.reconfigure(EditorView.editable.of(isEditable)),
        placeholderCompartment.reconfigure(
          placeholder(
            isEditable ? "Start writing your note..." : "Select or create a note to begin."
          )
        ),
      ],
    });

    const currentValue = view.state.doc.toString();
    if (currentValue !== value) {
      view.dispatch({
        changes: { from: 0, to: currentValue.length, insert: value },
      });
    }
  }, [editableCompartment, note, placeholderCompartment, value]);

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

  const statusLabel = (() => {
    switch (saveStatus) {
      case "saving":
        return "Saving...";
      case "saved":
        return "Saved";
      case "error":
        return "Save failed";
      default:
        return "Idle";
    }
  })();

  return (
    <section className="note-editor">
      <div className="note-editor__toolbar">
        <div>
          <p className="note-editor__eyebrow">Editor</p>
          <h3 className="note-editor__title">{note ? note.title : "No note selected"}</h3>
        </div>
        <span className={`note-editor__status note-editor__status--${saveStatus}`}>
          {statusLabel}
        </span>
      </div>
      <div className="note-editor__surface" ref={containerRef} />
    </section>
  );
}
