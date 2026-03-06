export interface SaveController {
  save: (
    value: string,
    saveOperation: (value: string) => Promise<void>,
    onCommitted: (value: string) => void
  ) => Promise<boolean>;
  reset: () => void;
}

export function createSaveController(): SaveController {
  let requestCounter = 0;
  let generation = 0;

  return {
    async save(value, saveOperation, onCommitted) {
      const requestId = ++requestCounter;
      const requestGeneration = generation;

      await saveOperation(value);

      if (requestGeneration !== generation) {
        return false;
      }

      if (requestId !== requestCounter) {
        return false;
      }

      onCommitted(value);
      return true;
    },
    reset() {
      generation += 1;
      requestCounter = 0;
    },
  };
}
