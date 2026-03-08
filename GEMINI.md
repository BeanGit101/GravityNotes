# AGENTS.md

## Command context
- Run all npm commands from `Gravity/`, or use `npm --prefix Gravity ...` from repo root.

## Validation
- After each meaningful code change, run:
  - `npm --prefix Gravity run typecheck`
- Before considering any task complete, run:
  - `npm --prefix Gravity run typecheck`
  - `npm --prefix Gravity run lint`
  - `npm --prefix Gravity run format:check`
  - `npm --prefix Gravity run build`

## Rules
- Fix all TypeScript errors. Do not use `any` or `@ts-ignore` to silence them.
- Fix all ESLint errors. Do not disable rules inline unless explicitly approved and justified.
- Do not claim a task is complete while introduced errors remain.
- Prefer minimal, local changes that match existing code patterns.
- Do not perform opportunistic refactors, broad rewrites, or unrelated cleanup.
- Do not delete or simplify code, commands, types, or handlers just because they appear unused unless explicitly requested.
- When changing shared contracts or data shapes, verify all affected layers (e.g. frontend, services, Tauri backend).
