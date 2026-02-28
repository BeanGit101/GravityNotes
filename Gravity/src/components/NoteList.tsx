import { useState, type FormEvent } from "react";
import type { Note } from "../types/notes";

interface NoteListProps {
  directoryPath: string;
  notes: Note[];
  selectedNoteId: string | null;
  onOpenVault: () => void;
  onCreateNote: (title: string) => void;
  onSelectNote: (note: Note) => void;
  onDeleteNote: (note: Note) => void;
  errorMessage: string | null;
}

export function NoteList({
  directoryPath,
  notes,
  selectedNoteId,
  onOpenVault,
  onCreateNote,
  onSelectNote,
  onDeleteNote,
  errorMessage,
}: NoteListProps) {
  const [newTitle, setNewTitle] = useState("");
  const canCreate = Boolean(directoryPath && newTitle.trim());

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreate) return;
    onCreateNote(newTitle.trim());
    setNewTitle("");
  };

  return (
    <div className="note-list">
      <div className="note-list__header">
        <div>
          <p className="note-list__eyebrow">Vault</p>
          <h2 className="note-list__title">
            {directoryPath ? "Gravity Vault" : "No Vault Connected"}
          </h2>
          <p className="note-list__path">{directoryPath || "Choose a folder to start writing."}</p>
        </div>
        {!directoryPath && (
          <button className="button button--primary" type="button" onClick={onOpenVault}>
            Open Vault
          </button>
        )}
      </div>

      {directoryPath && (
        <form className="note-list__new" onSubmit={handleCreate}>
          <input
            className="input"
            placeholder="New note title"
            value={newTitle}
            onChange={(event) => {
              setNewTitle(event.target.value);
            }}
          />
          <button className="button button--secondary" type="submit" disabled={!canCreate}>
            New Note
          </button>
        </form>
      )}

      {errorMessage && <p className="note-list__error">{errorMessage}</p>}

      {directoryPath && (
        <ul className="note-list__items">
          {notes.length === 0 && (
            <li className="note-list__empty">No notes yet. Create the first one.</li>
          )}
          {notes.map((note) => (
            <li
              key={note.id}
              className={`note-list__item ${
                selectedNoteId === note.id ? "note-list__item--active" : ""
              }`}
            >
              <button
                className="note-list__select"
                type="button"
                onClick={() => {
                  onSelectNote(note);
                }}
              >
                {note.title}
              </button>
              <button
                className="note-list__delete"
                type="button"
                onClick={() => {
                  onDeleteNote(note);
                }}
                aria-label={`Delete ${note.title}`}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
