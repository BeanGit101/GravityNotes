import { open } from "@tauri-apps/plugin-dialog";
import { exists, mkdir, readDir, readTextFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import type { FileSystemItem, FolderItem, Note, NoteItem } from "../types/notes";

const NOTES_DIRECTORY_KEY = "gravity.notesDirectory";

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

export async function selectNotesDirectory(): Promise<string | null> {
  const selection = await open({
    directory: true,
    multiple: false,
    title: "Select your notes folder",
  });

  const directory = normalizeSelection(selection);
  if (directory) {
    localStorage.setItem(NOTES_DIRECTORY_KEY, directory);
    return directory;
  }
  return null;
}

export function getNotesDirectory(): string {
  return localStorage.getItem(NOTES_DIRECTORY_KEY) ?? "";
}

export async function listNotes(): Promise<Note[]> {
  const directory = ensureNotesDirectory();
  const entries = await readDir(directory);

  const notes = await Promise.all(
    entries
      .filter((entry) => entry.isFile && entry.name.toLowerCase().endsWith(".md"))
      .map(async (entry) => {
        const path = await join(directory, entry.name);
        const title = entry.name.replace(/\.md$/i, "");
        return { id: path, title, path };
      })
  );

  return notes.sort((a, b) => a.title.localeCompare(b.title));
}

function resolveTargetDirectory(folderPath?: string | null): string {
  const directory = ensureNotesDirectory();
  if (folderPath && folderPath.trim()) {
    return folderPath;
  }
  return directory;
}

function buildNoteItem(path: string, filename: string): NoteItem {
  const title = filename.replace(/\.md$/i, "");
  return { id: path, title, path, type: "file" };
}

function buildFolderItem(path: string, name: string, children: FileSystemItem[]): FolderItem {
  return { id: path, name, path, type: "folder", children };
}

function sortFileSystemItems(items: FileSystemItem[]): FileSystemItem[] {
  return items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "folder" ? -1 : 1;
    }
    const labelA = a.type === "folder" ? a.name : a.title;
    const labelB = b.type === "folder" ? b.name : b.title;
    return labelA.localeCompare(labelB);
  });
}

async function listDirectoryEntries(directory: string): Promise<FileSystemItem[]> {
  const entries = await readDir(directory);
  const items = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = await join(directory, entry.name);
      if (entry.isDirectory) {
        const children = await listDirectoryEntries(entryPath);
        return buildFolderItem(entryPath, entry.name, sortFileSystemItems(children));
      }
      if (entry.isFile && entry.name.toLowerCase().endsWith(".md")) {
        return buildNoteItem(entryPath, entry.name);
      }
      return null;
    })
  );

  return sortFileSystemItems(items.filter((item): item is FileSystemItem => item !== null));
}

export async function listNotesWithFolders(): Promise<FileSystemItem[]> {
  const directory = ensureNotesDirectory();
  return listDirectoryEntries(directory);
}

export async function createNote(title: string, folderPath?: string | null): Promise<Note> {
  const directory = resolveTargetDirectory(folderPath);
  const trimmedTitle = title.trim();
  const baseSlug = slugify(trimmedTitle) || "untitled";

  let suffix = 0;
  let path = "";
  while (suffix < 1000) {
    const slug = suffix === 0 ? baseSlug : `${baseSlug}-${suffix.toString()}`;
    path = await join(directory, `${slug}.md`);
    if (!(await exists(path))) {
      break;
    }
    suffix += 1;
  }

  if (!path) {
    throw new Error("Unable to create a unique note file.");
  }

  await writeTextFile(path, "");

  return {
    id: path,
    title: trimmedTitle || "Untitled",
    path,
  };
}

export async function createFolder(name: string, folderPath?: string | null): Promise<FolderItem> {
  const directory = resolveTargetDirectory(folderPath);
  const trimmedName = name.trim();
  const baseSlug = slugify(trimmedName) || "new-folder";

  let suffix = 0;
  let path = "";
  let folderName = "";
  while (suffix < 1000) {
    folderName = suffix === 0 ? baseSlug : `${baseSlug}-${suffix.toString()}`;
    path = await join(directory, folderName);
    if (!(await exists(path))) {
      break;
    }
    suffix += 1;
  }

  if (!path) {
    throw new Error("Unable to create a unique folder.");
  }

  await mkdir(path, { recursive: true });

  return buildFolderItem(path, folderName, []);
}

export async function readNote(path: string): Promise<string> {
  return readTextFile(path);
}

export async function updateNote(path: string, content: string): Promise<void> {
  await writeTextFile(path, content);
}

export async function deleteNote(path: string): Promise<void> {
  await remove(path);
}

export function slugify(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
