import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NoteList } from "../src/components/NoteList";
import type { FileSystemItem, TrashEntry } from "../src/types/notes";

describe("NoteList rendering", () => {
  it("shows correct nested folder note count", () => {
    const notes: FileSystemItem[] = [
      {
        type: "folder",
        id: "/vault/projects",
        name: "Projects",
        path: "/vault/projects",
        children: [
          {
            type: "file",
            id: "/vault/projects/one.md",
            title: "one",
            path: "/vault/projects/one.md",
          },
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

    const trashEntries: TrashEntry[] = [];

    const html = renderToStaticMarkup(
      <NoteList
        directoryPath="/vault"
        notes={notes}
        trashEntries={trashEntries}
        selectedNoteId={null}
        selectedFolderPath={null}
        onOpenVault={() => {}}
        onCreateNote={() => {}}
        onRenameNote={() => {}}
        onMoveNote={() => {}}
        onCreateFolder={() => {}}
        onRenameFolder={() => {}}
        onMoveFolder={() => {}}
        onDeleteFolder={() => {}}
        onSelectFolder={() => {}}
        onSelectNote={() => {}}
        onOpenInNewPane={() => {}}
        onDeleteNote={() => {}}
        onRestoreTrashEntry={() => {}}
        onPermanentlyDeleteTrashEntry={() => {}}
        errorMessage={null}
      />
    );

    expect(html).toContain("2 notes");
    expect(html).toContain("Trash");
  });
});
