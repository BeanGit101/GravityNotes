export type CheckboxKind = "list" | "inline";

export interface CheckboxDescriptor {
  index: number;
  kind: CheckboxKind;
  checked: boolean;
  from: number;
  to: number;
  line: number;
}

const FENCE_PATTERN = /^\s{0,3}(`{3,}|~{3,})/;
const BLOCK_TASK_PATTERN = /^(\s*(?:>\s*)*(?:[-+*]|\d+[.)])\s+)(\[([ xX])\])/;
const INLINE_TASK_PATTERN = /-\s+(\[([ xX])\])/g;

interface InlineCodeRange {
  from: number;
  to: number;
}

function isFenceCloser(line: string, fenceMarker: string): boolean {
  const match = line.match(FENCE_PATTERN);
  if (!match) {
    return false;
  }

  const marker = match[1] ?? "";
  return marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length;
}

function collectInlineCodeRanges(line: string): InlineCodeRange[] {
  const ranges: InlineCodeRange[] = [];

  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "`") {
      continue;
    }

    let fenceLength = 1;
    while (line[index + fenceLength] === "`") {
      fenceLength += 1;
    }

    const fence = "`".repeat(fenceLength);
    const closeIndex = line.indexOf(fence, index + fenceLength);
    if (closeIndex === -1) {
      index += fenceLength - 1;
      continue;
    }

    ranges.push({ from: index, to: closeIndex + fenceLength });
    index = closeIndex + fenceLength - 1;
  }

  return ranges;
}

function isInsideInlineCode(index: number, ranges: InlineCodeRange[]): boolean {
  return ranges.some((range) => index >= range.from && index < range.to);
}

function hasNonWhitespaceBefore(line: string, index: number): boolean {
  return line.slice(0, index).trim().length > 0;
}

export function parseCheckboxes(markdown: string): CheckboxDescriptor[] {
  const lines = markdown.split("\n");
  const checkboxes: CheckboxDescriptor[] = [];
  let offset = 0;
  let activeFence: string | null = null;

  lines.forEach((line, lineIndex) => {
    const fenceMatch = line.match(FENCE_PATTERN);
    if (activeFence) {
      if (fenceMatch && isFenceCloser(line, activeFence)) {
        activeFence = null;
      }
      offset += line.length + 1;
      return;
    }

    if (fenceMatch) {
      activeFence = fenceMatch[1] ?? null;
      offset += line.length + 1;
      return;
    }

    const inlineCodeRanges = collectInlineCodeRanges(line);
    const blockMatch = line.match(BLOCK_TASK_PATTERN);
    let minimumInlineIndex = 0;

    if (blockMatch) {
      const [, prefix, markerText, checkedMarker] = blockMatch;
      if (!prefix || !markerText || !checkedMarker) {
        offset += line.length + 1;
        return;
      }

      const markerStart = prefix.length;
      minimumInlineIndex = markerStart + markerText.length;

      checkboxes.push({
        index: checkboxes.length,
        kind: "list",
        checked: checkedMarker.toLowerCase() === "x",
        from: offset + markerStart,
        to: offset + markerStart + markerText.length,
        line: lineIndex,
      });
    }

    for (const match of line.matchAll(INLINE_TASK_PATTERN)) {
      const fullMatch = match[0];
      const markerText = match[1];
      const checkedMarker = match[2];
      const markerIndex = match.index;

      if (markerText === undefined || checkedMarker === undefined) {
        continue;
      }

      const checkboxIndex = markerIndex + fullMatch.indexOf(markerText);
      if (checkboxIndex < minimumInlineIndex) {
        continue;
      }

      if (isInsideInlineCode(checkboxIndex, inlineCodeRanges)) {
        continue;
      }

      if (!hasNonWhitespaceBefore(line, markerIndex)) {
        continue;
      }

      checkboxes.push({
        index: checkboxes.length,
        kind: "inline",
        checked: checkedMarker.toLowerCase() === "x",
        from: offset + checkboxIndex,
        to: offset + checkboxIndex + markerText.length,
        line: lineIndex,
      });
    }

    offset += line.length + 1;
  });

  return checkboxes;
}

export function findCheckboxAtIndex(
  markdown: string,
  checkboxIndex: number
): CheckboxDescriptor | null {
  if (checkboxIndex < 0) {
    return null;
  }

  return parseCheckboxes(markdown).find((checkbox) => checkbox.index === checkboxIndex) ?? null;
}
