# Task 4 Report

## Scope

Current Task 4 files:

- `src/conflictStore.ts`
- `src/test/conflictStore.test.ts`
- `.superpowers/sdd/task-4-report.md`

## Current State

`ConflictStore` now:

- refreshes immediately into a complete `ConflictSnapshot` and exposes the latest snapshot through `getSnapshot()`
- merges repository-scoped Git unmerged files with open marker-bearing documents by canonical file URI
- preserves `gitUnmerged` independently from `locatedConflicts`, so Git-only entries remain visible when marker blocks are absent
- discovers document-only conflicts from open documents even when Git no longer reports the file as unmerged
- sorts snapshot files deterministically by repository-relative path, then URI
- computes `locatedCount` from parsed conflict blocks and `gitOnlyCount` from unmerged files with zero located blocks
- emits `onDidChange` notifications only after a full snapshot build completes
- coalesces repeated `scheduleRefresh(reason)` calls behind one debounce timer while keeping direct `refresh()` immediate

## Test Coverage Added

Focused store coverage now exercises:

- separation of located conflicts from Git-only files
- removal of files once both markers and Git unmerged state disappear
- canonical URI merging between Git and open-document scans
- document-only conflicts when Git reports no unmerged files
- debounced scheduled refresh behavior with a single timer and change event

## Verification Evidence

Focused Task 4 suite:

- Command: `CI=1 npm run test:unit -- src/test/conflictStore.test.ts`
- Result: PASS

```text
✓ src/test/conflictStore.test.ts (5 tests) 7ms
Test Files  1 passed (1)
Tests  5 passed (5)
Duration  335ms
```

Full gate:

- Command: `npm run check`
- Result: PASS

```text
✓ src/test/conflictParser.test.ts (9 tests) 3ms
✓ src/test/conflictStore.test.ts (5 tests) 6ms
✓ src/test/gitRepositoryService.test.ts (14 tests) 418ms
Test Files  3 passed (3)
Tests  28 passed (28)
Duration  802ms
```

## Review Fixes

- `buildSnapshot()` now caches repository-root discovery within a refresh and reuses discovered roots for later open documents in the same repository, instead of calling `findRepositoryRoot()` once per document.
- Git-unmerged files now survive document load/read failures as Git-only entries with `locatedConflicts: []` and a preserved `parseError`.

## Review Fix Verification Evidence

Focused Task 4 review suite:

- Command: `CI=1 npm run test:unit -- src/test/conflictStore.test.ts`
- Result: PASS

```text
> conflict-resolver@0.0.1 test:unit
> vitest run src/test/conflictStore.test.ts

The CJS build of Vite's Node API is deprecated. See https://vite.dev/guide/troubleshooting.html#vite-cjs-node-api-deprecated for more details.

RUN  v3.2.4 /Users/shien.liang/Documents/Codex/2026-07-10/xian

✓ src/test/conflictStore.test.ts (7 tests) 8ms

Test Files  1 passed (1)
Tests  7 passed (7)
Start at  14:56:43
Duration  308ms (transform 86ms, setup 0ms, collect 92ms, tests 8ms, environment 0ms, prepare 53ms)
```

Full gate after review fixes:

- Command: `npm run check`
- Result: PASS

```text
> conflict-resolver@0.0.1 check
> npm run compile && npm run test:unit

> conflict-resolver@0.0.1 compile
> tsc -p ./

> conflict-resolver@0.0.1 test:unit
> vitest run

The CJS build of Vite's Node API is deprecated. See https://vite.dev/guide/troubleshooting.html#vite-cjs-node-api-deprecated for more details.

RUN  v3.2.4 /Users/shien.liang/Documents/Codex/2026-07-10/xian

✓ src/test/conflictParser.test.ts (9 tests) 4ms
✓ src/test/conflictStore.test.ts (7 tests) 7ms
✓ src/test/gitRepositoryService.test.ts (14 tests) 398ms
✓ GitRepositoryService > detects a real conflicted file in a temporary repository  348ms

Test Files  3 passed (3)
Tests  30 passed (30)
Start at  14:56:49
Duration  776ms (transform 234ms, setup 0ms, collect 319ms, tests 409ms, environment 0ms, prepare 261ms)
```
