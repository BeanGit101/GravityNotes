import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  buildTemplatePayload,
  parseTemplateMarkdown,
  serializeTemplateMarkdown,
} from "./templateContent";
import type { FileSystemItem, FolderItem, Note } from "../types/notes";
import type { TemplateContent, TemplateSummary } from "../types/templates";

const NOTES_DIRECTORY_KEY = "gravity.notesDirectory";

let activeVaultPath = "";

type TemplateSeed = Pick<TemplateContent, "body" | "subject" | "tags">;

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
        notes.push({ id: entry.id, title: entry.title, path: entry.path });
      } else {
        visit(entry.children);
      }
    });
  };

  visit(items);
  notes.sort((a, b) => a.title.localeCompare(b.title));
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

export async function listTemplates(): Promise<TemplateSummary[]> {
  await ensureVaultSelected();
  return invoke<TemplateSummary[]>("list_templates");
}

export async function readTemplate(path: string): Promise<TemplateContent> {
  await ensureVaultSelected();
  return invoke<TemplateContent>("read_template", { path });
}

export async function createNote(
  title: string,
  folderPath?: string | null,
  template?: TemplateSeed | null
): Promise<Note> {
  await ensureVaultSelected();
  const initialContent = template ? serializeTemplateMarkdown(template) : "";
  return invoke<Note>("create_note", {
    title,
    folderPath: folderPath ?? null,
    initialContent,
  });
}

export async function createFolder(name: string, folderPath?: string | null): Promise<FolderItem> {
  await ensureVaultSelected();
  return invoke<FolderItem>("create_folder", {
    name,
    folderPath: folderPath ?? null,
  });
}

export async function createTemplate(
  name: string,
  template: TemplateSeed
): Promise<TemplateContent> {
  await ensureVaultSelected();
  const payload = buildTemplatePayload(template);
  return invoke<TemplateContent>("create_template", {
    name,
    body: payload.body,
    subject: payload.subject ?? null,
    tags: payload.tags ?? null,
  });
}

export async function createTemplateFromNote(
  name: string,
  markdown: string
): Promise<TemplateContent> {
  return createTemplate(name, parseTemplateMarkdown(markdown));
}

export async function renameTemplate(path: string, newName: string): Promise<TemplateSummary> {
  await ensureVaultSelected();
  return invoke<TemplateSummary>("rename_template", {
    path,
    newName,
  });
}

export async function deleteTemplate(path: string): Promise<void> {
  await ensureVaultSelected();
  await invoke("delete_template", { path });
}

export async function readNote(path: string): Promise<string> {
  await ensureVaultSelected();
  return invoke<string>("read_note", { path });
}

export async function updateNote(path: string, content: string): Promise<void> {
  await ensureVaultSelected();
  await invoke("write_note", { path, content });
}

export async function deleteNote(path: string): Promise<void> {
  await ensureVaultSelected();
  await invoke("delete_note", { path });
}

export function slugify(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
