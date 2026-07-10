# Task 3 Report

## Scope

Implemented Task 3 in the requested owned files:

- `src/gitRepositoryService.ts`
- `src/test/gitRepositoryService.test.ts`

No other source files were changed.

## What Was Implemented

### Git repository service

Added `GitRepositoryService` with:

- `findRepositoryRoot(uri): Promise<string | undefined>`
- `listUnmergedFiles(root): Promise<GitUnmergedFile[]>`
- `openMergeEditor(uri): Promise<void>`

The service uses a single safe `execFile`-based Git runner:

- no shell interpolation
- `git -C <candidate> rev-parse --show-toplevel` for repository discovery
- `git -C <root> ls-files -u -z` for unmerged file discovery

### Error handling

Added typed error support in `src/gitRepositoryService.ts`:

- `GitCommandError` for low-level Git command execution failures
- `GitServiceError` for public service error mapping

Mapped failures into explicit service codes:

- `git-command-failed`
- `invalid-git-output`
- `unsafe-path`
- `merge-editor-failed`

`findRepositoryRoot` returns `undefined` for non-repository candidates instead of throwing.

### Unmerged-file parsing

Implemented NUL-delimited `git ls-files -u -z` parsing that:

- reads stage entries safely
- extracts repository-relative paths after the tab separator
- normalizes paths with POSIX separators
- rejects unsafe paths such as `../escape.txt`
- deduplicates repeated stage entries by normalized relative path
- returns stable `GitUnmergedFile` objects with file URIs

### Merge Editor delegation

Added injectable merge-editor command delegation through `runMergeEditorCommand`.

## TDD / Verification

1. Red run before implementation:
   - Command: `CI=1 npm run test:unit -- src/test/gitRepositoryService.test.ts`
   - Result: failed because `../gitRepositoryService` did not exist.
2. Focused Task 3 suite after implementation:
   - Command: `CI=1 npm run test:unit -- src/test/gitRepositoryService.test.ts`
   - Result: passed with 6/6 tests.
3. Full project gate:
   - Command: `npm run check`
   - Result: `tsc -p ./` passed and Vitest passed with 15/15 tests.

## Test Coverage Added

`src/test/gitRepositoryService.test.ts` now covers:

- non-repository discovery returns `undefined`
- NUL-delimited `git ls-files -u -z` parsing into unique paths
- spaces and Unicode path handling
- unsafe relative-path rejection
- typed `GitServiceError` mapping for Git command failure
- merge-editor delegation to an injected runner
- real temporary Git repository conflict creation and unmerged-file detection

## Commit

Created commit:

- `66d822f` `Enable repository-backed conflict discovery`

## Concerns

1. On macOS temp directories, Git may report repository roots under `/private/...` while `tmpdir()` returns `/var/...`; the integration test now asserts against `realpath(...)` to avoid false negatives.
2. The default merge-editor behavior intentionally requires an injected runner. Later extension wiring will need to supply the actual VS Code command integration.
3. The existing untracked `dist/` and `node_modules/` directories were left untouched.

## Review Follow-up: Repository Discovery Error Classification

Addressed the Task 3 review finding in `src/gitRepositoryService.ts`:

- removed broad stderr substring matching from `findRepositoryRoot`
- tightened candidate-path resolution so only missing-path cases fall back to `dirname(...)`
- now returns `undefined` only when Git exits with the not-a-repository shape and the candidate path has no `.git` marker in any accessible ancestor
- unsafe-repository and permission-denied discovery failures now surface as typed `GitServiceError` values with preserved command context

Added regression coverage in `src/test/gitRepositoryService.test.ts` for:

- unsafe repository / dubious ownership failure during repository discovery
- permission denied failure during repository discovery

### Follow-up Verification

1. Focused Task 3 suite:
   - Command: `CI=1 npm run test:unit -- src/test/gitRepositoryService.test.ts`
   - Result: passed with 8/8 tests.
2. Full project gate after the review fix:
   - Command: `npm run check`
   - Result: `tsc -p ./` passed and Vitest passed with 17/17 tests.

## Review Follow-up: Remaining Task 3 Findings

Addressed the remaining Task 3 review findings in the same owned files:

- `findRepositoryRoot(...)` now returns `undefined` only when both conditions are true:
  - Git exited with the known structural not-a-repository failure shape
  - no `.git` marker exists in the candidate path ancestors
- exit `128` with unrelated stderr now maps to `GitServiceError` instead of being treated as a non-repository result
- successful `rev-parse --show-toplevel` calls that return empty or whitespace-only stdout now throw `GitServiceError` with code `invalid-git-output`

Added regression coverage in `src/test/gitRepositoryService.test.ts` for:

- exit `128` plus unrelated stderr with no `.git` ancestor
- successful repository discovery with blank stdout

### Remaining-Findings Verification

1. Focused Task 3 suite:
   - Command: `CI=1 npm run test:unit -- src/test/gitRepositoryService.test.ts`
   - Result: passed with 10/10 tests.
2. Full project gate after the remaining-finding fix:
   - Command: `npm run check`
   - Result: `tsc -p ./` passed and Vitest passed with 19/19 tests.
