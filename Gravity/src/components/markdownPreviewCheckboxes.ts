import type { CheckboxDescriptor } from "../editor/checkboxParser";
import { parseCheckboxes } from "../editor/checkboxParser";

interface PositionPoint {
  offset?: number | null;
}

interface Position {
  start?: PositionPoint;
  end?: PositionPoint;
}

interface HastNodeBase {
  type: string;
  position?: Position;
}

interface HastParent extends HastNodeBase {
  children: HastNode[];
}

interface HastText extends HastNodeBase {
  type: "text";
  value: string;
}

interface HastElement extends HastParent {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
}

interface HastRoot extends HastParent {
  type: "root";
}

type HastNode = HastRoot | HastElement | HastText | HastParent;

function isParent(node: HastNode): node is HastParent {
  return Array.isArray((node as HastParent).children);
}

function isElement(node: HastNode): node is HastElement {
  return isParent(node) && typeof (node as HastElement).tagName === "string";
}

function isText(node: HastNode): node is HastText {
  return node.type === "text" && typeof (node as HastText).value === "string";
}

function getStartOffset(node: HastNode): number | null {
  const offset = node.position?.start?.offset;
  return typeof offset === "number" ? offset : null;
}

function getEndOffset(node: HastNode): number | null {
  const offset = node.position?.end?.offset;
  return typeof offset === "number" ? offset : null;
}

function shouldSkipInlineTraversal(node: HastElement): boolean {
  return ["code", "input", "pre", "script", "style"].includes(node.tagName);
}

function isCheckboxInput(node: HastElement): boolean {
  const type = node.properties?.["type"];
  return node.tagName === "input" && (type === "checkbox" || type === "CHECKBOX");
}

function createInlineCheckboxNode(checkbox: CheckboxDescriptor): HastElement {
  return {
    type: "element",
    tagName: "input",
    properties: {
      type: "checkbox",
      checked: checkbox.checked,
      dataTaskIndex: checkbox.index,
      "data-task-index": checkbox.index,
    },
    children: [],
    position: {
      start: { offset: checkbox.from },
      end: { offset: checkbox.to },
    },
  };
}

function createTextNode(value: string): HastText {
  return {
    type: "text",
    value,
  };
}

function findFirstCheckboxInput(node: HastNode): HastElement | null {
  if (isElement(node) && isCheckboxInput(node)) {
    return node;
  }

  if (!isParent(node)) {
    return null;
  }

  for (const child of node.children) {
    const match = findFirstCheckboxInput(child);
    if (match) {
      return match;
    }
  }

  return null;
}

function splitTextNode(
  node: HastText,
  checkboxes: CheckboxDescriptor[],
  usedIndexes: Set<number>
): HastNode[] | null {
  const startOffset = getStartOffset(node);
  const endOffset = getEndOffset(node);

  if (startOffset === null || endOffset === null) {
    return null;
  }

  const relevantCheckboxes = checkboxes.filter(
    (checkbox) =>
      !usedIndexes.has(checkbox.index) &&
      checkbox.kind === "inline" &&
      checkbox.from >= startOffset &&
      checkbox.to <= endOffset
  );

  if (relevantCheckboxes.length === 0) {
    return null;
  }

  const nextNodes: HastNode[] = [];
  let currentOffset = startOffset;
  let currentIndex = 0;

  for (const checkbox of relevantCheckboxes) {
    const nextIndex = currentIndex + (checkbox.from - currentOffset);
    if (nextIndex < currentIndex || nextIndex > node.value.length) {
      return null;
    }

    const beforeText = node.value.slice(currentIndex, nextIndex);
    if (beforeText.length > 0) {
      nextNodes.push(createTextNode(beforeText));
    }

    nextNodes.push(createInlineCheckboxNode(checkbox));
    usedIndexes.add(checkbox.index);

    currentOffset = checkbox.to;
    currentIndex = nextIndex + (checkbox.to - checkbox.from);

    if (currentIndex > node.value.length) {
      return null;
    }
  }

  const trailingText = node.value.slice(currentIndex);
  if (trailingText.length > 0) {
    nextNodes.push(createTextNode(trailingText));
  }

  return nextNodes;
}

function annotateListCheckboxes(
  node: HastNode,
  checkboxes: CheckboxDescriptor[],
  usedIndexes: Set<number>
): void {
  if (!isParent(node)) {
    return;
  }

  if (isElement(node) && node.tagName === "li") {
    const startOffset = getStartOffset(node);
    const endOffset = getEndOffset(node);

    if (startOffset !== null && endOffset !== null) {
      const matchingCheckbox = checkboxes.find(
        (checkbox) =>
          !usedIndexes.has(checkbox.index) &&
          checkbox.kind === "list" &&
          checkbox.from >= startOffset &&
          checkbox.to <= endOffset
      );

      if (matchingCheckbox) {
        const input = findFirstCheckboxInput(node);
        if (input) {
          const properties = input.properties ?? {};
          properties["checked"] = matchingCheckbox.checked;
          properties["dataTaskIndex"] = matchingCheckbox.index;
          properties["data-task-index"] = matchingCheckbox.index;
          input.properties = properties;
          usedIndexes.add(matchingCheckbox.index);
        }
      }
    }
  }

  node.children.forEach((child) => {
    annotateListCheckboxes(child, checkboxes, usedIndexes);
  });
}

function injectInlineCheckboxes(
  node: HastNode,
  checkboxes: CheckboxDescriptor[],
  usedIndexes: Set<number>
): void {
  if (!isParent(node)) {
    return;
  }

  const nextChildren: HastNode[] = [];

  node.children.forEach((child) => {
    if (isText(child)) {
      const replacement = splitTextNode(child, checkboxes, usedIndexes);
      if (replacement) {
        nextChildren.push(...replacement);
        return;
      }
    }

    if (isElement(child) && shouldSkipInlineTraversal(child)) {
      nextChildren.push(child);
      return;
    }

    injectInlineCheckboxes(child, checkboxes, usedIndexes);
    nextChildren.push(child);
  });

  node.children = nextChildren;
}

export function createCheckboxPreviewPlugin(markdown: string) {
  const checkboxes = parseCheckboxes(markdown);

  return function checkboxPreviewPlugin() {
    return (tree: HastRoot) => {
      const usedIndexes = new Set<number>();
      annotateListCheckboxes(tree, checkboxes, usedIndexes);
      injectInlineCheckboxes(tree, checkboxes, usedIndexes);
    };
  };
}
