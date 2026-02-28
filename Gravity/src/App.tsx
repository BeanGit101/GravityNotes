import { useCallback, useEffect, useState } from "react";
import "./App.css";
import { NoteEditor } from "./components/NoteEditor";
import { NoteList } from "./components/NoteList";
import type { Note } from "./types/notes";
import {
  createNote,
  deleteNote,
  getNotesDirectory,
  listNotes,
  readNote,
  selectNotesDirectory,
  updateNote,
} from "./services/notesService";

function App() {
  const [notesDirectory, setNotesDirectory] = useState(getNotesDirectory());
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [noteContent, setNoteContent] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const loadNotes = useCallback(async () => {
    if (!notesDirectory) {
      setNotes([]);
      setSelectedNote(null);
      setNoteContent("");
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    try {
      const entries = await listNotes();
      setNotes(entries);
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
    if (saveStatus !== "saved") return;
    const handle = window.setTimeout(() => {
      setSaveStatus("idle");
    }, 2000);
    return () => {
      window.clearTimeout(handle);
    };
  }, [saveStatus]);

  const handleOpenVault = async () => {
    setErrorMessage(null);
    try {
      const directory = await selectNotesDirectory();
      if (directory) {
        setNotesDirectory(directory);
      }
    } catch (error) {
      console.error(error);
      setErrorMessage("Failed to open a folder. Try again.");
    }
  };

  const handleSelectNote = async (note: Note) => {
    setSelectedNote(note);
    setSaveStatus("idle");
    setErrorMessage(null);
    try {
      const content = await readNote(note.path);
      setNoteContent(content);
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to read the note.");
    }
  };

  const handleCreateNote = async (title: string) => {
    setErrorMessage(null);
    try {
      const created = await createNote(title);
      await loadNotes();
      setSelectedNote(created);
      setNoteContent("");
      setSaveStatus("idle");
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
      if (selectedNote?.id === note.id) {
        setSelectedNote(null);
        setNoteContent("");
        setSaveStatus("idle");
      }
    } catch (error) {
      console.error(error);
      setErrorMessage("Unable to delete the note.");
    }
  };

  const handleAutoSave = async (nextValue: string) => {
    if (!selectedNote) return;
    setSaveStatus("saving");
    try {
      await updateNote(selectedNote.path, nextValue);
      setSaveStatus("saved");
    } catch (error) {
      console.error(error);
      setSaveStatus("error");
      setErrorMessage("Auto-save failed. Check disk access.");
    }
  };

  return (
    <main className="app-shell">
      <aside className="app-sidebar">
        <NoteList
          directoryPath={notesDirectory}
          notes={notes}
          selectedNoteId={selectedNote?.id ?? null}
          onOpenVault={() => {
            void handleOpenVault();
          }}
          onCreateNote={(title) => {
            void handleCreateNote(title);
          }}
          onSelectNote={(note) => {
            void handleSelectNote(note);
          }}
          onDeleteNote={(note) => {
            void handleDeleteNote(note);
          }}
          errorMessage={errorMessage}
        />
        {isLoading && <p className="note-list__loading">Loading notes...</p>}
      </aside>

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

        <NoteEditor
          note={selectedNote}
          value={noteContent}
          saveStatus={saveStatus}
          onChange={setNoteContent}
          onAutoSave={handleAutoSave}
        />
      </section>
    </main>
  );
}

export default App;
