export type CommandType = "insert" | "delete" | "replace";

export interface EditorCommand {
  type: CommandType;
  position: number;
  text: string;
  deletedText: string;
  timestamp: number;
}

export interface UndoRedoState {
  undoStack: EditorCommand[];
  redoStack: EditorCommand[];
  currentBurst: EditorCommand | null;
  burstTimer: ReturnType<typeof window.setTimeout> | null;
  BURST_TIMEOUT_MS: number;
  MAX_STACK_SIZE: number;
}

export interface UndoRedoHistorySnapshot {
  undoStack: EditorCommand[];
  redoStack: EditorCommand[];
}

export function createUndoRedoState(): UndoRedoState {
  return {
    undoStack: [],
    redoStack: [],
    currentBurst: null,
    burstTimer: null,
    BURST_TIMEOUT_MS: 600,
    MAX_STACK_SIZE: 100,
  };
}

export function resetUndoRedoState(state: UndoRedoState): void {
  if (state.burstTimer !== null) {
    window.clearTimeout(state.burstTimer);
  }
  state.undoStack = [];
  state.redoStack = [];
  state.currentBurst = null;
  state.burstTimer = null;
}

export function createHistorySnapshot(state: UndoRedoState): UndoRedoHistorySnapshot {
  return {
    undoStack: [...state.undoStack],
    redoStack: [...state.redoStack],
  };
}

export function restoreHistorySnapshot(
  state: UndoRedoState,
  snapshot: UndoRedoHistorySnapshot | null | undefined
): void {
  if (state.burstTimer !== null) {
    window.clearTimeout(state.burstTimer);
  }
  state.currentBurst = null;
  state.burstTimer = null;
  state.undoStack = snapshot ? [...snapshot.undoStack] : [];
  state.redoStack = snapshot ? [...snapshot.redoStack] : [];
}

export function sealBurst(state: UndoRedoState): void {
  if (!state.currentBurst) return;

  state.undoStack.push(state.currentBurst);
  if (state.undoStack.length > state.MAX_STACK_SIZE) {
    state.undoStack.shift();
  }
  state.currentBurst = null;
  state.burstTimer = null;
}

function shouldMergeBurst(currentBurst: EditorCommand, command: EditorCommand): boolean {
  if (currentBurst.type !== command.type) return false;

  if (command.type === "insert") {
    return (
      command.deletedText.length === 0 &&
      currentBurst.position + currentBurst.text.length === command.position
    );
  }

  if (command.type === "delete") {
    const deletesAtSameStart = command.position === currentBurst.position;
    const backspaceAdjacent =
      command.position + command.deletedText.length === currentBurst.position;
    return command.text.length === 0 && (deletesAtSameStart || backspaceAdjacent);
  }

  return command.position === currentBurst.position;
}

function mergeBurst(currentBurst: EditorCommand, command: EditorCommand): EditorCommand {
  if (
    command.type === "delete" &&
    command.position + command.deletedText.length === currentBurst.position
  ) {
    return {
      ...currentBurst,
      position: command.position,
      deletedText: command.deletedText + currentBurst.deletedText,
      timestamp: command.timestamp,
    };
  }

  return {
    ...currentBurst,
    text: currentBurst.text + command.text,
    deletedText: currentBurst.deletedText + command.deletedText,
    timestamp: command.timestamp,
  };
}

export function recordCommand(state: UndoRedoState, command: EditorCommand): void {
  state.redoStack = [];

  if (!state.currentBurst) {
    state.currentBurst = { ...command };
  } else if (shouldMergeBurst(state.currentBurst, command)) {
    state.currentBurst = mergeBurst(state.currentBurst, command);
  } else {
    sealBurst(state);
    state.currentBurst = { ...command };
  }

  if (state.burstTimer !== null) {
    window.clearTimeout(state.burstTimer);
  }
  state.burstTimer = window.setTimeout(() => {
    sealBurst(state);
  }, state.BURST_TIMEOUT_MS);
}

export function applyUndo(state: UndoRedoState, currentContent: string): string {
  sealBurst(state);
  if (!state.undoStack.length) return currentContent;

  const command = state.undoStack.pop();
  if (!command) return currentContent;
  state.redoStack.push(command);

  const before = currentContent.slice(0, command.position);
  const after = currentContent.slice(command.position + command.text.length);
  return before + command.deletedText + after;
}

export function applyRedo(state: UndoRedoState, currentContent: string): string {
  if (!state.redoStack.length) return currentContent;

  const command = state.redoStack.pop();
  if (!command) return currentContent;
  state.undoStack.push(command);

  const before = currentContent.slice(0, command.position);
  const after = currentContent.slice(command.position + command.deletedText.length);
  return before + command.text + after;
}

export function diffToCommand(oldContent: string, newContent: string): EditorCommand | null {
  if (oldContent === newContent) return null;

  let start = 0;
  const minLength = Math.min(oldContent.length, newContent.length);
  while (start < minLength && oldContent[start] === newContent[start]) {
    start += 1;
  }

  let oldEnd = oldContent.length - 1;
  let newEnd = newContent.length - 1;
  while (oldEnd >= start && newEnd >= start && oldContent[oldEnd] === newContent[newEnd]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const deletedText = oldContent.slice(start, oldEnd + 1);
  const text = newContent.slice(start, newEnd + 1);
  if (!text && !deletedText) return null;

  const type: CommandType = text && deletedText ? "replace" : text ? "insert" : "delete";
  return {
    type,
    position: start,
    text,
    deletedText,
    timestamp: Date.now(),
  };
}
