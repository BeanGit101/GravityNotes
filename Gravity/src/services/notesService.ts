import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  FileSystemItem,
  FolderItem,
  Note,
  NoteMetadata,
  NoteSearchResult,
  TemplateApplyMode,
  TemplateItem,
  TrashEntry,
} from "../types/notes";

const NOTES_DIRECTORY_KEY = "gravity.notesDirectory";

let activeVaultPath = "";

function normalizeSelection(selection: string | string[] | null): string | null {
  if (Array.isArray(selection)) {
    return selection[0] ?? null;
  }
  return selection ?? null;
}

function normalizeNote(note: Pick<Note, "id" | "title" | "path"> & Partial<Note>): Note {
  return {
    id: note.id,
    title: note.title,
    path: note.path,
    subject: note.subject,
    tags: Array.isArray(note.tags) ? note.tags : [],
    updatedAt: note.updatedAt,
  };
}

function normalizeFileSystemItem(item: FileSystemItem): FileSystemItem {
  if (item.type === "file") {
    return {
      ...normalizeNote(item),
      type: "file",
    };
  }

  return {
    ...item,
    children: item.children.map((child) => normalizeFileSystemItem(child)),
  };
}

function ensureNotesDirectory(): string {
  const directory = getNotesDirectory();
  if (!directory) {
    throw new Error("No notes directory selected.");
  }
  return directory;
}

async function ensureVaultPath(directory: string): Promise<string> {
  if (directory === activeVaultPath) {
    return directory;
  }

  const normalized = await invoke<string>("set_vault_path", { path: directory });
  activeVaultPath = normalized;

  if (normalized !== directory) {
    localStorage.setItem(NOTES_DIRECTORY_KEY, normalized);
  }

  return normalized;
}

async function ensureVaultSelected(): Promise<string> {
  const directory = ensureNotesDirectory();
  return ensureVaultPath(directory);
}

function flattenNotes(items: FileSystemItem[]): Note[] {
  const notes: Note[] = [];

  const visit = (entries: FileSystemItem[]) => {
    entries.forEach((entry) => {
      if (entry.type === "file") {
        notes.push(normalizeNote(entry));
      } else {
        visit(entry.children);
      }
    });
  };

  visit(items);
  notes.sort((a, b) => a.title.localeCompare(b.title));
  return notes;
}

function buildRelativePath(basePath: string, targetPath: string): string {
  if (!targetPath.startsWith(basePath)) {
    return targetPath;
  }

  const trimmed = targetPath.slice(basePath.length).replace(/^[\\/]+/, "");
  return trimmed || targetPath;
}

export function buildFilenameSearchResults(
  items: FileSystemItem[],
  query: string,
  vaultPath: string
): NoteSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const results: NoteSearchResult[] = [];
  const visit = (entries: FileSystemItem[], folderPath: string | null) => {
    entries.forEach((entry) => {
      if (entry.type === "file") {
        if (!entry.title.toLowerCase().includes(normalizedQuery)) {
          return;
        }

        const relativePath = buildRelativePath(vaultPath, entry.path);
        const folderLabel = folderPath ? buildRelativePath(vaultPath, folderPath) : "Vault root";
        results.push({
          note: normalizeNote(entry),
          folderPath,
          folderLabel,
          relativePath,
        });
        return;
      }

      visit(entry.children, entry.path);
    });
  };

  visit(items, null);
  results.sort((left, right) => {
    const folderCompare = left.folderLabel.localeCompare(right.folderLabel);
    if (folderCompare !== 0) {
      return folderCompare;
    }
    return left.note.title.localeCompare(right.note.title);
  });
  return results;
}

export async function searchNotesByFilename(
  query: string,
  items?: FileSystemItem[],
  vaultPath?: string
): Promise<NoteSearchResult[]> {
  const entries = items ?? (await listNotesWithFolders());
  const directory = vaultPath ?? getNotesDirectory();
  return buildFilenameSearchResults(entries, query, directory);
}

export async function selectNotesDirectory(): Promise<string | null> {
  const selection = await open({
    directory: true,
    multiple: false,
    title: "Select your notes folder",
  });

  const directory = normalizeSelection(selection);
  if (directory) {
    const normalized = await ensureVaultPath(directory);
    localStorage.setItem(NOTES_DIRECTORY_KEY, normalized);
    return normalized;
  }
  return null;
}

export function getNotesDirectory(): string {
  return localStorage.getItem(NOTES_DIRECTORY_KEY) ?? "";
}

export async function listNotes(): Promise<Note[]> {
  const entries = await listNotesWithFolders();
  return flattenNotes(entries);
}

export async function listNotesWithFolders(): Promise<FileSystemItem[]> {
  await ensureVaultSelected();
  const entries = await invoke<FileSystemItem[]>("list_vault_entries");
  return entries.map((entry) => normalizeFileSystemItem(entry));
}

export async function listTrashEntries(): Promise<TrashEntry[]> {
  await ensureVaultSelected();
  return invoke<TrashEntry[]>("list_trash_entries");
}

export async function createNote(title: string, folderPath?: string | null): Promise<Note> {
  await ensureVaultSelected();
  const note = await invoke<Note>("create_note", {
    title,
    folderPath: folderPath ?? null,
  });
  return normalizeNote(note);
}

export async function renameNote(path: string, title: string): Promise<Note> {
  await ensureVaultSelected();
  return invoke<Note>("rename_note", { path, title });
}

export async function moveNote(path: string, folderPath?: string | null): Promise<Note> {
  await ensureVaultSelected();
  return invoke<Note>("move_note", {
    path,
    folderPath: folderPath ?? null,
  });
}

export async function createFolder(name: string, folderPath?: string | null): Promise<FolderItem> {
  await ensureVaultSelected();
  return invoke<FolderItem>("create_folder", {
    name,
    folderPath: folderPath ?? null,
  });
}

export async function renameFolder(path: string, name: string): Promise<FolderItem> {
  await ensureVaultSelected();
  return invoke<FolderItem>("rename_folder", { path, name });
}

export async function moveFolder(path: string, folderPath?: string | null): Promise<FolderItem> {
  await ensureVaultSelected();
  return invoke<FolderItem>("move_folder", {
    path,
    folderPath: folderPath ?? null,
  });
}

export async function readNote(path: string): Promise<string> {
  await ensureVaultSelected();
  return invoke<string>("read_note", { path });
}

export async function updateNote(path: string, content: string): Promise<void> {
  await ensureVaultSelected();
  await invoke("write_note", { path, content });
}

export async function readNoteMetadata(path: string): Promise<NoteMetadata> {
  await ensureVaultSelected();
  return invoke<NoteMetadata>("read_note_metadata", { path });
}

export async function writeNoteMetadata(
  path: string,
  metadata: NoteMetadata
): Promise<NoteMetadata> {
  await ensureVaultSelected();
  return invoke<NoteMetadata>("write_note_metadata", { path, metadata });
}

export async function deleteNote(path: string): Promise<void> {
  await ensureVaultSelected();
  await invoke("delete_note", { path });
}

export async function deleteFolder(path: string): Promise<void> {
  await ensureVaultSelected();
  await invoke("delete_folder", { path });
}

export async function restoreTrashEntry(id: string): Promise<void> {
  await ensureVaultSelected();
  await invoke("restore_trash_entry", { id });
}

export async function permanentlyDeleteTrashEntry(id: string): Promise<void> {
  await ensureVaultSelected();
  await invoke("permanently_delete_trash_entry", { id });
}

export async function listTemplates(): Promise<TemplateItem[]> {
  await ensureVaultSelected();
  return invoke<TemplateItem[]>("list_templates");
}

export async function createTemplate(name: string, content: string): Promise<TemplateItem> {
  await ensureVaultSelected();
  return invoke<TemplateItem>("create_template", { name, content });
}

export async function readTemplate(path: string): Promise<TemplateItem> {
  await ensureVaultSelected();
  return invoke<TemplateItem>("read_template", { path });
}

export async function updateTemplate(
  path: string,
  updates: { name?: string; content?: string }
): Promise<TemplateItem> {
  await ensureVaultSelected();
  return invoke<TemplateItem>("update_template", {
    path,
    name: updates.name ?? null,
    content: updates.content ?? null,
  });
}

export async function deleteTemplate(path: string): Promise<void> {
  await ensureVaultSelected();
  await invoke("delete_template", { path });
}

export async function applyTemplate(
  templatePath: string,
  notePath: string,
  mode: TemplateApplyMode = "replace"
): Promise<string> {
  await ensureVaultSelected();
  return invoke<string>("apply_template", {
    templatePath,
    notePath,
    mode,
  });
}

export function slugify(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
