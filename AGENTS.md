## After every change, run these commands and fix all errors before considering the task complete:

### Type checking
npm run typecheck  # or: npx tsc --noEmit

### Linting
npm run lint       # or: npx eslint . --ext .ts,.tsx

### Format check
npm run format:check  # or: npx prettier --check .

### Build verification (catches errors the above may miss)
npm run build

## Rules
- Fix all TypeScript errors — do not use `any` or `@ts-ignore` to silence them
- Fix all ESLint errors — do not disable rules inline without explaining why