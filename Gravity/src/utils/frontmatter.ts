import type { NoteDocument, NoteMetadata } from "../types/notes";

const FRONTMATTER_DELIMITER = "---";

export const DEFAULT_TAG_OPTIONS = [
  "idea",
  "draft",
  "todo",
  "reference",
  "meeting",
  "project",
] as const;

export function createEmptyNoteMetadata(): NoteMetadata {
  return {
    tags: [],
  };
}

export function normalizeTag(tag: string): string {
  return tag.trim().replace(/\s+/g, " ");
}

export function normalizeNoteMetadata(
  metadata: Partial<NoteMetadata> | null | undefined
): NoteMetadata {
  const subject = typeof metadata?.subject === "string" ? metadata.subject.trim() : "";
  const updatedAt = typeof metadata?.updatedAt === "string" ? metadata.updatedAt : undefined;
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const rawTag of metadata?.tags ?? []) {
    const tag = normalizeTag(rawTag);
    if (!tag) {
      continue;
    }

    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    tags.push(tag);
  }

  return {
    subject: subject || undefined,
    tags,
    updatedAt,
  };
}

export function hasNoteMetadata(metadata: NoteMetadata): boolean {
  return Boolean(metadata.subject) || metadata.tags.length > 0;
}

export function parseNoteDocument(content: string): NoteDocument {
  if (
    !content.startsWith(`${FRONTMATTER_DELIMITER}\n`) &&
    !content.startsWith(`${FRONTMATTER_DELIMITER}\r\n`)
  ) {
    return {
      body: content,
      metadata: createEmptyNoteMetadata(),
    };
  }

  const lines = content.split(/\r?\n/);
  const closingLineIndex = lines.indexOf(FRONTMATTER_DELIMITER, 1);

  if (closingLineIndex === -1) {
    return {
      body: content,
      metadata: createEmptyNoteMetadata(),
    };
  }

  const frontmatterLines = lines.slice(1, closingLineIndex);
  const parsedMetadata = parseFrontmatterLines(frontmatterLines);

  if (!parsedMetadata) {
    return {
      body: content,
      metadata: createEmptyNoteMetadata(),
    };
  }

  const bodyStartIndex = findBodyStartIndex(content);

  return {
    body: bodyStartIndex === -1 ? "" : content.slice(bodyStartIndex),
    metadata: parsedMetadata,
  };
}

export function serializeNoteDocument(document: NoteDocument): string {
  const metadata = normalizeNoteMetadata(document.metadata);

  if (!hasNoteMetadata(metadata)) {
    return document.body;
  }

  const lines = [FRONTMATTER_DELIMITER];

  if (metadata.subject) {
    lines.push(`subject: ${JSON.stringify(metadata.subject)}`);
  }

  if (metadata.tags.length > 0) {
    lines.push("tags:");
    metadata.tags.forEach((tag) => {
      lines.push(`  - ${formatTagScalar(tag)}`);
    });
  }

  lines.push(FRONTMATTER_DELIMITER);

  if (!document.body) {
    return lines.join("\n");
  }

  return `${lines.join("\n")}\n${document.body}`;
}

function formatTagScalar(tag: string): string {
  return /^[A-Za-z0-9_-]+$/.test(tag) ? tag : JSON.stringify(tag);
}

function parseFrontmatterLines(lines: string[]): NoteMetadata | null {
  let subject = "";
  let tags: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    const delimiterIndex = trimmed.indexOf(":");
    if (delimiterIndex === -1) {
      return null;
    }

    const key = trimmed.slice(0, delimiterIndex).trim();
    const value = trimmed.slice(delimiterIndex + 1).trim();

    if (key === "subject") {
      subject = parseScalar(value);
      continue;
    }

    if (key === "tags") {
      if (!value) {
        const parsedTags: string[] = [];

        while (index + 1 < lines.length) {
          const nextLine = lines[index + 1] ?? "";
          if (!nextLine.trim()) {
            index += 1;
            continue;
          }

          if (!nextLine.startsWith(" ") && !nextLine.startsWith("\t")) {
            break;
          }

          const tagLine = nextLine.trimStart();
          if (!tagLine.startsWith("- ")) {
            return null;
          }

          parsedTags.push(parseScalar(tagLine.slice(2)));
          index += 1;
        }

        tags = parsedTags;
        continue;
      }

      if (value.startsWith("[") && value.endsWith("]")) {
        const inner = value.slice(1, -1).trim();
        tags = inner ? inner.split(",").map((tag) => parseScalar(tag)) : [];
        continue;
      }

      tags = [parseScalar(value)];
      continue;
    }

    return null;
  }

  return normalizeNoteMetadata({ subject, tags });
}

function parseScalar(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") {
        return parsed;
      }
    } catch {
      return trimmed.slice(1, -1);
    }
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  return trimmed;
}

function findBodyStartIndex(content: string): number {
  let boundaryCount = 0;

  for (let index = 0; index < content.length; index += 1) {
    const isLineStart = index === 0 || content[index - 1] === "\n";
    if (!isLineStart) {
      continue;
    }

    const lineEnd = content.indexOf("\n", index);
    const rawLine = lineEnd === -1 ? content.slice(index) : content.slice(index, lineEnd);
    const normalizedLine = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (normalizedLine === FRONTMATTER_DELIMITER) {
      boundaryCount += 1;
      if (boundaryCount === 2) {
        return lineEnd === -1 ? content.length : lineEnd + 1;
      }
    }

    if (lineEnd === -1) {
      break;
    }
  }

  return -1;
}
