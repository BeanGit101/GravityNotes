import { Decoration, DecorationSet, WidgetType } from "@codemirror/view";
import { EditorState, RangeSet } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNodeRef } from "@lezer/common";

const NODE_DECORATORS: Record<string, Decoration> = {
  // Headings
  ATXHeading1: Decoration.mark({ class: "md-h1" }),
  ATXHeading2: Decoration.mark({ class: "md-h2" }),
  ATXHeading3: Decoration.mark({ class: "md-h3" }),
  SetextHeading1: Decoration.mark({ class: "md-h1" }),
  SetextHeading2: Decoration.mark({ class: "md-h2" }),

  // Inline
  Emphasis: Decoration.mark({ class: "md-italic" }),
  StrongEmphasis: Decoration.mark({ class: "md-bold" }),
  InlineCode: Decoration.mark({ class: "md-inline-code" }),
  Strikethrough: Decoration.mark({ class: "md-strikethrough" }),

  // Block
  Blockquote: Decoration.mark({ class: "md-blockquote" }),
  Link: Decoration.mark({ class: "md-link" }),
  Image: Decoration.mark({ class: "md-image" }),

  // Tables
  Table: Decoration.mark({ class: "md-table" }),
  TableHeader: Decoration.mark({ class: "md-table-header" }),
  TableCell: Decoration.mark({ class: "md-table-cell" }),
  TableDelimiter: Decoration.mark({ class: "md-table-delimiter" }),
};

const HEADING_LINE_CLASSES: Record<string, string> = {
  ATXHeading1: "md-h1-line",
  SetextHeading1: "md-h1-line",
  ATXHeading2: "md-h2-line",
  SetextHeading2: "md-h2-line",
  ATXHeading3: "md-h3-line",
};

const HIDDEN_MARKER_DECORATION = Decoration.replace({});

const SIMPLE_MARKER_NODE_NAMES = new Set([
  "EmphasisMark",
  "StrongEmphasisMark",
  "StrikethroughMark",
  "HeaderMark",
  "QuoteMark",
  "ListMark",
  "CodeMark",
  "TaskMarker",
]);

const LINK_DESTINATION_NODE_NAMES = new Set(["URL", "LinkTitle"]);
const LINK_MARKER_TEXT_TO_HIDE = new Set(["(", ")"]);

type TableAlignment = "left" | "center" | "right" | null;

interface ParsedTableBlock {
  header: string[];
  alignments: TableAlignment[];
  rows: string[][];
}

class CodeBlockWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly language: string
  ) {
    super();
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "md-codeblock";

    const pre = document.createElement("pre");
    const codeEl = document.createElement("code");
    codeEl.className = `language-${this.language}`;
    codeEl.textContent = this.code;
    pre.appendChild(codeEl);

    const langBadge = document.createElement("span");
    langBadge.className = "md-codeblock-lang-badge";
    langBadge.textContent = this.language || "text";

    const copyBtn = document.createElement("button");
    copyBtn.className = "md-codeblock-copy";
    copyBtn.textContent = "Copy";

    copyBtn.addEventListener("mousedown", (event) => {
      event.preventDefault();
      void navigator.clipboard.writeText(this.code).then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
          copyBtn.textContent = "Copy";
        }, 2000);
      });
    });

    wrapper.appendChild(langBadge);
    wrapper.appendChild(copyBtn);
    wrapper.appendChild(pre);

    return wrapper;
  }

  override eq(other: CodeBlockWidget): boolean {
    return other.code === this.code && other.language === this.language;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "md-table-widget";

    const parsedTable = parseTableBlock(this.source);
    if (!parsedTable) {
      wrapper.textContent = this.source;
      return wrapper;
    }

    const table = document.createElement("table");
    table.className = "markdown-preview__table";

    const thead = document.createElement("thead");
    thead.className = "markdown-preview__thead";

    const headerRow = document.createElement("tr");
    headerRow.className = "markdown-preview__row";

    parsedTable.header.forEach((cell, index) => {
      const th = document.createElement("th");
      th.className = "markdown-preview__header-cell";
      th.scope = "col";
      applyTableAlignment(th, parsedTable.alignments[index] ?? null);
      th.textContent = cell;
      headerRow.appendChild(th);
    });

    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    tbody.className = "markdown-preview__tbody";

    parsedTable.rows.forEach((row) => {
      const tr = document.createElement("tr");
      tr.className = "markdown-preview__row";

      row.forEach((cell, index) => {
        const td = document.createElement("td");
        td.className = "markdown-preview__cell";
        applyTableAlignment(td, parsedTable.alignments[index] ?? null);
        td.textContent = cell;
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrapper.appendChild(table);

    return wrapper;
  }

  override eq(other: TableWidget): boolean {
    return other.source === this.source;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function applyTableAlignment(cell: HTMLTableCellElement, alignment: TableAlignment): void {
  if (alignment) {
    cell.style.textAlign = alignment;
  }
}

function selectionIntersectsRange(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => {
    if (range.empty) {
      return range.from >= from && range.from < to;
    }

    return range.from < to && range.to > from;
  });
}

function stripQuotePrefix(line: string): string {
  return line.replace(/^\s*(?:>\s*)+/, "");
}

function splitTableRow(line: string): string[] {
  const normalizedLine = stripQuotePrefix(line).trim();
  const content = normalizedLine.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;

  for (const char of content) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  if (escaped) {
    current += "\\";
  }

  cells.push(current.trim());
  return cells;
}

function parseTableAlignment(cell: string): TableAlignment {
  const normalizedCell = cell.replace(/\s+/g, "");
  if (!/^:?-{3,}:?$/.test(normalizedCell)) {
    return null;
  }

  const startsWithColon = normalizedCell.startsWith(":");
  const endsWithColon = normalizedCell.endsWith(":");

  if (startsWithColon && endsWithColon) {
    return "center";
  }

  if (endsWithColon) {
    return "right";
  }

  return "left";
}

function normalizeTableRow<T>(row: T[], columnCount: number, fillValue: T): T[] {
  return Array.from({ length: columnCount }, (_, index) => row[index] ?? fillValue);
}

function parseTableBlock(source: string): ParsedTableBlock | null {
  const lines = source
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim().length > 0);

  if (lines.length < 2) {
    return null;
  }

  const header = splitTableRow(lines[0] ?? "");
  const delimiter = splitTableRow(lines[1] ?? "");
  const alignments = delimiter.map(parseTableAlignment);

  if (alignments.length === 0 || alignments.some((alignment) => alignment === null)) {
    return null;
  }

  const bodyRows = lines.slice(2).map((line) => splitTableRow(line));
  const columnCount = Math.max(
    header.length,
    alignments.length,
    0,
    ...bodyRows.map((row) => row.length)
  );

  return {
    header: normalizeTableRow(header, columnCount, ""),
    alignments: normalizeTableRow(alignments, columnCount, null),
    rows: bodyRows.map((row) => normalizeTableRow(row, columnCount, "")),
  };
}

function isInsideFencedCode(node: SyntaxNodeRef): boolean {
  let current = node.node.parent;
  while (current) {
    if (current.name === "FencedCode") {
      return true;
    }
    current = current.parent;
  }
  return false;
}

export function buildDecorations(state: EditorState): DecorationSet {
  const ranges: Array<{ from: number; to: number; deco: Decoration }> = [];
  const tree = syntaxTree(state);
  const cursorLine = state.doc.lineAt(state.selection.main.head);
  const cursorLineFrom = cursorLine.from;
  const cursorLineTo = cursorLine.to;

  tree.iterate({
    enter(node) {
      if (node.name === "Table") {
        const cursorInsideTable = selectionIntersectsRange(state, node.from, node.to);
        if (!cursorInsideTable) {
          ranges.push({
            from: node.from,
            to: node.to,
            deco: Decoration.replace({
              widget: new TableWidget(state.sliceDoc(node.from, node.to)),
              block: true,
            }),
          });
          return false;
        }
      }

      const deco = NODE_DECORATORS[node.name];
      if (deco) {
        ranges.push({ from: node.from, to: node.to, deco });
      }

      if (node.name === "FencedCode") {
        if (cursorLineFrom <= node.to && cursorLineTo >= node.from) {
          return;
        }

        const src = state.sliceDoc(node.from, node.to);
        const lines = src.split("\n");
        const lang = lines[0]?.replace(/^`+/, "").trim() || "";
        const code = lines.slice(1, -1).join("\n");

        ranges.push({
          from: node.from,
          to: node.to,
          deco: Decoration.replace({
            widget: new CodeBlockWidget(code, lang),
            block: true,
          }),
        });
      }

      const headingLineClass = HEADING_LINE_CLASSES[node.name];
      if (headingLineClass) {
        const line = state.doc.lineAt(node.from);
        ranges.push({
          from: line.from,
          to: line.from,
          deco: Decoration.line({ class: headingLineClass }),
        });
      }

      if (node.name === "Blockquote") {
        const line = state.doc.lineAt(node.from);
        ranges.push({
          from: line.from,
          to: line.from,
          deco: Decoration.line({ class: "md-blockquote-line" }),
        });
      }

      if (SIMPLE_MARKER_NODE_NAMES.has(node.name)) {
        if (isInsideFencedCode(node)) {
          return;
        }
        const onCursorLine = node.from >= cursorLineFrom && node.from <= cursorLineTo;
        if (!onCursorLine) {
          ranges.push({ from: node.from, to: node.to, deco: HIDDEN_MARKER_DECORATION });
        }
      }

      if (node.name === "LinkMark") {
        if (isInsideFencedCode(node)) {
          return;
        }
        const onCursorLine = node.from >= cursorLineFrom && node.from <= cursorLineTo;
        if (!onCursorLine) {
          const markerText = state.doc.sliceString(node.from, node.to);
          if (LINK_MARKER_TEXT_TO_HIDE.has(markerText)) {
            ranges.push({ from: node.from, to: node.to, deco: HIDDEN_MARKER_DECORATION });
          }
        }
      }

      if (LINK_DESTINATION_NODE_NAMES.has(node.name)) {
        if (isInsideFencedCode(node)) {
          return;
        }
        const onCursorLine = node.from >= cursorLineFrom && node.from <= cursorLineTo;
        if (!onCursorLine) {
          ranges.push({ from: node.from, to: node.to, deco: HIDDEN_MARKER_DECORATION });
        }
      }
    },
  });

  const cmDecorations = ranges.map((range) => range.deco.range(range.from, range.to));
  cmDecorations.sort((a, b) => {
    const aSide = "startSide" in a.value ? a.value.startSide : 0;
    const bSide = "startSide" in b.value ? b.value.startSide : 0;
    return a.from - b.from || aSide - bSide;
  });

  return RangeSet.of(cmDecorations, true);
}
