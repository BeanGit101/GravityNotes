import type { ReactNode } from "react";
import type { NoteSortMode, SortDirection } from "./notes";

export interface NoteSummary {
  id: string;
  title: string;
  preview: string;
  tags: string[];
  updatedAt: number;
  filePath: string;
}

export enum SaveState {
  Saved = "saved",
  Saving = "saving",
  Dirty = "dirty",
  Error = "error",
}

export type ActiveFilter = string | null;

export interface Filters {
  selectedTags: string[];
  sortMode: NoteSortMode;
  sortDirection: SortDirection;
}

export interface GravityNotesShellProps {
  notes: NoteSummary[];
  activeNoteId: string | null;
  searchQuery: string;
  saveState: SaveState;
  filters: Filters;
  activeFilter: ActiveFilter;
  editor: ReactNode;
  onNoteSelect: (noteId: string) => void;
  onSearchChange: (query: string) => void;
  onFilterChange: (filter: ActiveFilter) => void;
  onListPanelToggle: () => void;
  onInfoPanelToggle: () => void;
  onFocusModeToggle: () => void;
}

export const TAG_COLORS = [
  { name: "Lavender", value: "#c6c6e8" },
  { name: "Blush", value: "#f7c5d5" },
  { name: "Sage", value: "#c6e8d5" },
  { name: "Sky", value: "#c5d5f7" },
  { name: "Peach", value: "#f7d5c5" },
  { name: "Mint", value: "#c5f7e8" },
  { name: "Lilac", value: "#e8c5f7" },
  { name: "Sand", value: "#f7e8c5" },
] as const;
