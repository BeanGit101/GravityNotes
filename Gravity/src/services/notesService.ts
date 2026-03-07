import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { FileSystemItem, FolderItem, Note, TrashRecord } from "../types/notes";

const NOTES_DIRECTORY_KEY = "gravity.notesDirectory";

let activeVaultPath = "";

function normalizeSelection(selection: string | string[] | null): string | null {
  if (Array.isArray(selection)) {
    return selection[0] ?? null;
  }
  return selection ?? null;
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
        notes.push(entry);
        return;
      }

      visit(entry.children);
    });
  };

  visit(items);
  notes.sort((left, right) => left.title.localeCompare(right.title));
  return notes;
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
  return invoke<FileSystemItem[]>("list_vault_entries");
}

export async function listTrash(): Promise<TrashRecord[]> {
  await ensureVaultSelected();
  return invoke<TrashRecord[]>("list_trash_records");
}

export async function createNote(title: string, folderPath?: string | null): Promise<Note> {
  await ensureVaultSelected();
  return invoke<Note>("create_note", {
    title,
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

export async function readNote(path: string): Promise<string> {
  await ensureVaultSelected();
  return invoke<string>("read_note", { path });
}

export async function updateNote(path: string, content: string): Promise<void> {
  await ensureVaultSelected();
  await invoke("write_note", { path, content });
}

export async function trashEntry(path: string): Promise<TrashRecord> {
  await ensureVaultSelected();
  return invoke<TrashRecord>("trash_entry", { path });
}

export async function restoreTrashItem(trashPath: string): Promise<string> {
  await ensureVaultSelected();
  return invoke<string>("restore_trashed_item", { trashPath });
}

export async function permanentlyDeleteTrashItem(trashPath: string): Promise<void> {
  await ensureVaultSelected();
  await invoke("permanently_delete_trashed_item", { trashPath });
}

export async function renameEntry(path: string, nextName: string): Promise<string> {
  await ensureVaultSelected();
  return invoke<string>("rename_entry", { path, nextName });
}

export async function moveEntry(path: string, folderPath?: string | null): Promise<string> {
  await ensureVaultSelected();
  return invoke<string>("move_entry", {
    path,
    folderPath: folderPath ?? null,
  });
}

export function slugify(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
