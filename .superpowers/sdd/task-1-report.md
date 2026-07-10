# Task 1 Report: Conflict Resolver Scaffold

## Scope

Implemented only Task 1 scaffold in `/Users/shien.liang/Documents/Codex/2026-07-10/xian`:

- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `vitest.config.ts`
- `.vscodeignore`
- `src/types.ts`

No later-task runtime files were added.

## What Was Implemented

### Extension manifest and scripts

Created `package.json` with:

- activation events: `onStartupFinished`, `workspaceContains:.git`
- commands:
  - `conflictResolver.nextConflict`
  - `conflictResolver.previousConflict`
  - `conflictResolver.openPanel`
  - `conflictResolver.rescanCurrentFile`
  - `conflictResolver.openMergeEditor`
- activity bar container id: `conflictResolver`
- tree view id: `conflictResolver.tree`
- scripts:
  - `compile`: `tsc -p ./`
  - `test:unit`: `vitest run`
  - `check`: `npm run compile && npm run test:unit`

Resolved scaffold toolchain around the official VS Code sample engine floor `^1.100.0` and pinned the local Node 18-compatible toolchain in the lockfile:

- `@types/vscode`: `1.100.0`
- `typescript`: `5.8.3`
- `vitest`: `3.2.4`
- `vite`: `6.3.5`
- `@types/node`: `18.17.19`

### Domain types

Created `src/types.ts` exporting:

- `ConflictBlock`
- `ConflictFile`
- `ConflictSnapshot`
- `GitUnmergedFile`

The first three match the brief exactly. `GitUnmergedFile` was added because Task 1 explicitly says later tasks depend on it.

### Packaging harness

Created:

- `tsconfig.json` for strict TypeScript compilation from `src` to `dist`
- `vitest.config.ts` with Node test environment and `passWithNoTests: true`
- `.vscodeignore` to exclude source and local planning files from a future package

`passWithNoTests: true` was necessary to satisfy the brief's expected result that Vitest reports zero test files without failing while still keeping the required script as `vitest run`.

## Blocker Encountered and Resolution

### Blocker

The first `npm install` attempt failed against the internal registry:

- registry error: `404 Not Found`
- package: `@vitest/pretty-format@3.2.7`
- registry note: newly published packages are quarantined for 7 days

### Resolution

Kept the requested Vitest line but made transitive resolution deterministic:

- pinned `vite` to `6.3.5` for Node 18 compatibility
- added `overrides` for `@vitest/pretty-format: 3.2.4`

After that, install succeeded and the lockfile was generated normally.

## Verification

Commands run:

```bash
npm install --no-audit --no-fund
npm run compile
npm run test:unit
npm run check
git diff --check
npm ls vitest vite @vitest/pretty-format
```

Results:

- `npm install --no-audit --no-fund`: passed, added 53 packages
- `npm run compile`: passed
- `npm run test:unit`: passed, zero test files found, exit code 0
- `npm run check`: passed
- `git diff --check`: passed with no diff formatting issues
- `npm ls vitest vite @vitest/pretty-format`: confirmed
  - `vitest@3.2.4`
  - `vite@6.3.5`
  - `@vitest/pretty-format@3.2.4 overridden`

## Commit

Implementation commit:

- `98615a1e9a54c2346e75ee89344b588e13be395e` `chore: scaffold conflict resolver extension`

The commit includes only the Task 1 scaffold files plus `package-lock.json`.

## Self-Review

### Checked against the brief

- Required files created: yes
- Required manifest command ids: yes
- Required view ids: yes
- Required scripts: yes
- Required domain types: yes, plus `GitUnmergedFile`
- Required install/compile/test flow: yes
- Lockfile recorded in commit: yes
- Scope limited to Task 1 scaffold: yes

### Review findings

No functional issues found within Task 1 scope.

## Remaining Concerns

1. `npm run test:unit` emits a Vite CJS deprecation warning, but exits successfully and does not block Task 1.
2. The working tree still has untracked local/generated directories after verification: `.superpowers/`, `dist/`, and `node_modules/`. They were not added to the implementation commit.

## Review Fix Follow-Up

Addressed the Task 1 review findings without expanding beyond scaffold scope:

- added `src/extension.ts` with minimal exported `activate(context)` and `deactivate()` functions so `package.json#main` now resolves to a compiled entrypoint
- added `resources/conflict.svg` as a valid activity bar icon asset for the declared view container

### Fresh verification for the review fix

Commands run after applying the scaffold fix:

```bash
npm run compile
npm run test:unit
```

Results:

- `npm run compile`: passed and produced the extension entrypoint in `dist/extension.js`
- `npm run test:unit`: passed with exit code 0; Vitest reported no test files and emitted the pre-existing Vite CJS deprecation warning

### Scope check

No later-task functionality was implemented in the extension entrypoint. The added file is a no-op scaffold only, consistent with Task 1.
