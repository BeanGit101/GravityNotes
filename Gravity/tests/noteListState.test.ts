import { describe, expect, it } from "vitest";
import {
  expandFoldersForNoteSelection,
  pruneExpandedFolders,
  toggleExpandedFolder,
} from "../src/components/NoteList";
import type { FileSystemItem } from "../src/types/notes";

const notes: FileSystemItem[] = [
  {
    type: "folder",
    id: "/vault/projects",
    name: "Projects",
    path: "/vault/projects",
    children: [
      {
        type: "folder",
        id: "/vault/projects/archive",
        name: "Archive",
        path: "/vault/projects/archive",
        children: [
          {
            type: "file",
            id: "/vault/projects/archive/two.md",
            title: "two",
            path: "/vault/projects/archive/two.md",
          },
        ],
      },
    ],
  },
];

describe("NoteList folder expansion helpers", () => {
  it("auto-expands ancestor folders for a selected note", () => {
    const expanded = expandFoldersForNoteSelection(
      notes,
      new Set<string>(),
      "/vault/projects/archive/two.md"
    );

    expect(Array.from(expanded)).toEqual(["/vault/projects", "/vault/projects/archive"]);
  });

  it("allows a manually collapsed folder to stay collapsed while the note remains selected", () => {
    const autoExpanded = expandFoldersForNoteSelection(
      notes,
      new Set<string>(),
      "/vault/projects/archive/two.md"
    );

    const collapsed = toggleExpandedFolder(autoExpanded, "/vault/projects");

    expect(collapsed.has("/vault/projects")).toBe(false);
    expect(collapsed.has("/vault/projects/archive")).toBe(true);
  });

  it("re-expands ancestors when the note is explicitly selected again", () => {
    const collapsed = new Set<string>();
    const reexpanded = expandFoldersForNoteSelection(
      notes,
      collapsed,
      "/vault/projects/archive/two.md"
    );

    expect(Array.from(reexpanded)).toEqual(["/vault/projects", "/vault/projects/archive"]);
  });

  it("prunes expanded folders that no longer exist", () => {
    const pruned = pruneExpandedFolders(new Set(["/vault/projects", "/vault/missing"]), notes);

    expect(Array.from(pruned)).toEqual(["/vault/projects"]);
  });
});
