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
