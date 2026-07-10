# Conflict Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a VS Code/Cursor extension that counts Git conflicts, lists conflicted files, and navigates to every conflict that can be located.

**Architecture:** Use the VS Code Extension API for the UI, document events, decorations, commands, and editor navigation. Use Git CLI as the source of truth for repository and `unmerged` state, while a pure state-machine parser reads document text to locate standard conflict markers. A small in-memory store merges both sources and publishes one immutable snapshot to the tree view, status bar, decorations, and navigation controller.

**Tech Stack:** TypeScript, VS Code Extension API, Node.js child-process API, Git CLI, Vitest (unit tests), temporary Git repositories (integration tests), VS Code Extension Test Runner (host integration tests).

## Global Constraints

- Support VS Code and Cursor through the common VS Code Extension API surface.
- Preserve separate `locatedConflicts` and `gitUnmerged` state; never invent a line range for a Git-only unresolved file.
- Use the Git CLI through one repository service; do not execute one Git process per file.
- Use debounced document rescans and event-driven Git refreshes.
- Support LF and CRLF files, Unicode text, multi-root workspaces, nested repositories, worktrees, Windows, macOS, and Linux.
- Do not add automatic ours/theirs selection, cloud PR integration, conflict history, or built-in keybindings to the MVP.
- Every task ends with a focused test run and a separate commit.

---

## File Map

Create the following focused files:

- `package.json`: extension manifest, activation events, commands, views, scripts, and dependencies.
- `tsconfig.json`: strict TypeScript compilation for `src` to `dist`.
- `vitest.config.ts`: Node-based unit-test configuration.
- `src/extension.ts`: activation, service construction, event wiring, and disposal only.
- `src/types.ts`: public domain types shared by services and UI.
- `src/conflictParser.ts`: pure text parser and parser result types.
- `src/gitRepositoryService.ts`: Git command execution, repository discovery, unmerged-file lookup, and Merge Editor command.
- `src/conflictStore.ts`: debounced refresh orchestration and immutable workspace snapshot.
- `src/conflictTreeProvider.ts`: Activity Bar tree view and tree item commands.
- `src/conflictDecorations.ts`: editor decorations for located conflict ranges.
- `src/conflictNavigation.ts`: current-document selection and previous/next navigation.
- `src/statusBar.ts`: current-file count and unresolved-unknown status.
- `src/test/conflictParser.test.ts`: parser unit tests.
- `src/test/conflictStore.test.ts`: store merge and refresh tests using fakes.
- `src/test/gitRepositoryService.test.ts`: Git CLI parsing tests and temporary-repository integration tests.
- `src/test/extension.test.ts`: extension-host smoke tests for commands and view registration.
- `README.md`: installation, usage, limitations, and troubleshooting.
- `.vscodeignore`: package exclusions.

---

### Task 1: Scaffold the Extension and Test Harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.vscodeignore`
- Create: `src/types.ts`

**Interfaces:**
- Produces `ConflictFile`, `ConflictBlock`, `ConflictSnapshot`, and `GitUnmergedFile` types for every later task.

- [ ] **Step 1: Create the extension manifest and scripts**

Define these commands and view identifiers in `package.json`:

```json
{
  "activationEvents": ["onStartupFinished", "workspaceContains:.git"],
  "contributes": {
    "commands": [
      {"command": "conflictResolver.nextConflict", "title": "Conflict Resolver: Next Conflict"},
      {"command": "conflictResolver.previousConflict", "title": "Conflict Resolver: Previous Conflict"},
      {"command": "conflictResolver.openPanel", "title": "Conflict Resolver: Open Conflict Panel"},
      {"command": "conflictResolver.rescanCurrentFile", "title": "Conflict Resolver: Rescan Current File"},
      {"command": "conflictResolver.openMergeEditor", "title": "Conflict Resolver: Open Merge Editor"}
    ],
    "viewsContainers": {"activitybar": [{"id": "conflictResolver", "title": "Conflict Resolver", "icon": "resources/conflict.svg"}]},
    "views": {"conflictResolver": [{"id": "conflictResolver.tree", "name": "Conflicts"}]}
  },
  "scripts": {"compile": "tsc -p ./", "test:unit": "vitest run", "check": "npm run compile && npm run test:unit"}
}
```

Use package versions resolved from the current supported VS Code engine and repository toolchain during scaffold; record the resolved lockfile in the implementation commit.

- [ ] **Step 2: Define domain types**

```ts
export type ConflictBlock = {
  id: string;
  startLine: number;
  separatorLine: number;
  endLine: number;
  oursRange: { startLine: number; endLine: number };
  theirsRange: { startLine: number; endLine: number };
};

export type ConflictFile = {
  uri: string;
  repositoryRoot: string;
  relativePath: string;
  locatedConflicts: ConflictBlock[];
  gitUnmerged: boolean;
  parseError?: string;
};

export type ConflictSnapshot = {
  files: ConflictFile[];
  locatedCount: number;
  gitOnlyCount: number;
  generatedAt: number;
};
```

- [ ] **Step 3: Install dependencies and verify the empty harness**

Run:

```bash
npm install
npm run compile
npm run test:unit
```

Expected: TypeScript compilation succeeds and Vitest reports zero test files without an error.

- [ ] **Step 4: Commit the scaffold**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .vscodeignore src/types.ts
git commit -m "chore: scaffold conflict resolver extension"
```

### Task 2: Implement the Conflict Marker Parser with TDD

**Files:**
- Create: `src/conflictParser.ts`
- Create: `src/test/conflictParser.test.ts`

**Interfaces:**
- Consumes: `string` document text.
- Produces: `parseConflictMarkers(text: string): ParseResult` where `ParseResult` contains `blocks: ConflictBlock[]` and optional `error`.

- [ ] **Step 1: Write failing parser tests**

```ts
it('finds a complete conflict block with zero-based lines', () => {
  const result = parseConflictMarkers('a\\n<<<<<<< HEAD\\nours\\n=======\\ntheirs\\n>>>>>>> feature\\nb');
  expect(result.blocks).toHaveLength(1);
  expect(result.blocks[0]).toMatchObject({startLine: 1, separatorLine: 3, endLine: 5});
});

it('supports CRLF and Unicode text', () => {
  const result = parseConflictMarkers('前\\r\\n<<<<<<< HEAD\\r\\n甲\\r\\n=======\\r\\n乙\\r\\n>>>>>>> branch');
  expect(result.blocks[0].oursRange.startLine).toBe(2);
});

it('reports an incomplete marker without throwing', () => {
  const result = parseConflictMarkers('<<<<<<< HEAD\\nours');
  expect(result.blocks).toHaveLength(0);
  expect(result.error).toContain('incomplete');
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm run test:unit -- src/test/conflictParser.test.ts`

Expected: FAIL because `parseConflictMarkers` does not exist.

- [ ] **Step 3: Implement the state machine**

Use line splitting that preserves line indexes and states `normal`, `ours`, and `theirs`. Accept only the sequence `<<<<<<<` → `=======` → `>>>>>>>`; return already completed blocks plus a parse error for incomplete or invalid sequences. Do not treat marker-like text inside a completed block as a second block.

- [ ] **Step 4: Run parser tests**

Run: `npm run test:unit -- src/test/conflictParser.test.ts`

Expected: PASS for complete, multiple, CRLF, Unicode, incomplete, invalid-order, and empty-input cases.

- [ ] **Step 5: Commit the parser**

```bash
git add src/conflictParser.ts src/test/conflictParser.test.ts
git commit -m "feat: parse git conflict markers"
```

### Task 3: Add Git Repository and Unmerged-State Services

**Files:**
- Create: `src/gitRepositoryService.ts`
- Create: `src/test/gitRepositoryService.test.ts`

**Interfaces:**
- Produces `GitRepositoryService.findRepositoryRoot(uri): Promise<string | undefined>`.
- Produces `GitRepositoryService.listUnmergedFiles(root): Promise<GitUnmergedFile[]>`.
- Produces `GitRepositoryService.openMergeEditor(uri): Promise<void>`.

- [ ] **Step 1: Write failing service tests**

Cover: non-repository root returns `undefined`; `git ls-files -u -z` maps stage records into unique file paths; paths with spaces and Unicode survive; command failure becomes a typed `GitServiceError`; Merge Editor delegates to an injectable command runner.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm run test:unit -- src/test/gitRepositoryService.test.ts`

Expected: FAIL because the service and fake runner do not exist.

- [ ] **Step 3: Implement one command runner**

Wrap `child_process.execFile` with `git` and argument arrays. Use `git -C <candidate> rev-parse --show-toplevel` for discovery and `git -C <root> ls-files -u -z` for unmerged files. Parse NUL-delimited records and deduplicate by normalized repository-relative path. Never interpolate paths into a shell string.

- [ ] **Step 4: Add temporary-repository integration coverage**

Create a temporary repository in the test, make two divergent commits to the same line, run `git merge`, and assert that `listUnmergedFiles` returns the conflicted path. Remove the temporary directory in `finally`.

- [ ] **Step 5: Run service and integration tests**

Run: `npm run test:unit -- src/test/gitRepositoryService.test.ts`

Expected: PASS with command parsing, error mapping, path handling, and real Git conflict tests.

- [ ] **Step 6: Commit the Git service**

```bash
git add src/gitRepositoryService.ts src/test/gitRepositoryService.test.ts
git commit -m "feat: detect git unmerged files"
```

### Task 4: Build the Conflict Store and Refresh Pipeline

**Files:**
- Create: `src/conflictStore.ts`
- Create: `src/test/conflictStore.test.ts`

**Interfaces:**
- Consumes: `GitRepositoryService`, `parseConflictMarkers`, and a document loader.
- Produces: `ConflictStore.refresh(): Promise<ConflictSnapshot>`, `getSnapshot(): ConflictSnapshot`, and `onDidChange` subscription.

- [ ] **Step 1: Write failing merge tests**

```ts
it('keeps located conflicts and git-only files separate', async () => {
  const snapshot = await store.refresh();
  expect(snapshot.locatedCount).toBe(2);
  expect(snapshot.gitOnlyCount).toBe(1);
  expect(snapshot.files.find(file => file.relativePath === 'config.json')?.locatedConflicts).toHaveLength(0);
});

it('removes a file when both marker and git-unmerged state disappear', async () => {
  await store.refresh();
  fakeDocuments.set('src/a.ts', 'resolved');
  fakeGit.setUnmerged([]);
  await store.refresh();
  expect(store.getSnapshot().files).toHaveLength(0);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm run test:unit -- src/test/conflictStore.test.ts`

Expected: FAIL because `ConflictStore` does not exist.

- [ ] **Step 3: Implement deterministic snapshot merging**

For every Git-unmerged file, load text and parse it. Also scan open text documents that contain markers even when Git does not report them. Merge by canonical URI, preserve `gitUnmerged`, and sort files by relative path. Calculate `locatedCount` from blocks and `gitOnlyCount` from files with `gitUnmerged === true` and zero blocks.

- [ ] **Step 4: Add debounced refresh triggers**

Expose `scheduleRefresh(reason)` with a single timer. Let `refresh()` run immediately for commands and tests. Keep Git command execution at repository scope and publish only after the complete snapshot is built.

- [ ] **Step 5: Run store tests**

Run: `npm run test:unit -- src/test/conflictStore.test.ts`

Expected: PASS for state merging, removal, sorting, document-only conflicts, and debounced refresh.

- [ ] **Step 6: Commit the store**

```bash
git add src/conflictStore.ts src/test/conflictStore.test.ts
git commit -m "feat: merge conflict scans into workspace snapshots"
```

### Task 5: Add Tree View, Status Bar, Decorations, and Navigation

**Files:**
- Create: `src/conflictTreeProvider.ts`
- Create: `src/conflictDecorations.ts`
- Create: `src/conflictNavigation.ts`
- Create: `src/statusBar.ts`

**Interfaces:**
- Consumes `ConflictSnapshot` and `ConflictStore.onDidChange`.
- Produces tree nodes, editor decorations, current-file count, and command handlers for previous/next conflict.

- [ ] **Step 1: Add tree provider tests for the view model**

Test that the provider renders file nodes under “可定位冲突” and “Git 未解决但位置未知”, shows counts, and returns a command argument containing the target URI and conflict ID.

- [ ] **Step 2: Implement tree nodes**

Use a `TreeDataProvider<ConflictTreeItem>` with group nodes, file nodes, and conflict nodes. File nodes with zero located blocks must remain visible only under the Git-only group. A conflict node command must call `navigation.goTo(uri, conflictId)`.

- [ ] **Step 3: Implement decorations**

Create one `TextEditorDecorationType` for the conflict start line and one overview-ruler/minimap decoration. Apply ranges only for `locatedConflicts`; clear decorations for documents absent from the current snapshot.

- [ ] **Step 4: Implement navigation**

Collect located conflicts for the active document, sort by `startLine`, and implement wrap-free previous/next behavior. If there is no located conflict but the file is Git-only, invoke `openMergeEditor` and show the fallback message when that command fails.

- [ ] **Step 5: Implement status bar**

Show `冲突 x/y` for the active document. Show `Git 未解决，位置未知` when the active file is Git-only. Hide the item when the active file has no conflict state.

- [ ] **Step 6: Run UI-model tests and compile**

Run: `npm run compile && npm run test:unit`

Expected: PASS with tree grouping, navigation ordering, and status-bar state tests.

- [ ] **Step 7: Commit the UI layer**

```bash
git add src/conflictTreeProvider.ts src/conflictDecorations.ts src/conflictNavigation.ts src/statusBar.ts
git commit -m "feat: add conflict navigation and workspace views"
```

### Task 6: Wire Activation, Commands, and Lifecycle

**Files:**
- Create: `src/extension.ts`
- Create: `src/test/extension.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes all services and providers from Tasks 1–5.
- Produces a disposable extension activation with registered commands, view, document listeners, save listeners, and editor-change listeners.

- [ ] **Step 1: Write the activation smoke test**

Assert that `activate(context)` registers all five commands, registers the tree view, performs an initial refresh, and adds every listener to `context.subscriptions`.

- [ ] **Step 2: Implement activation**

Construct one `GitRepositoryService`, `ConflictStore`, `ConflictTreeProvider`, `ConflictNavigationController`, decoration manager, and status-bar manager. Register commands exactly as declared in `package.json`. Subscribe to `onDidOpenTextDocument`, `onDidSaveTextDocument`, `onDidChangeTextDocument`, `onDidChangeActiveTextEditor`, and workspace-folder changes. Dispose timers, decoration types, status bar item, and event subscriptions through `context.subscriptions`.

- [ ] **Step 3: Add Git-state refresh hooks**

Refresh on command execution and after document saves. Add a debounced repository poll only when an active workspace contains a Git root; do not run an unbounded interval. Reuse the store's debounce timer.

- [ ] **Step 4: Run host smoke tests and compile**

Run: `npm run compile && npm run test:unit`

Expected: PASS with command registration and lifecycle disposal checks.

- [ ] **Step 5: Commit activation wiring**

```bash
git add src/extension.ts src/test/extension.test.ts package.json
git commit -m "feat: wire conflict resolver extension lifecycle"
```

### Task 7: Add End-to-End Acceptance Tests and User Documentation

**Files:**
- Modify: `src/test/extension.test.ts`
- Create: `src/test/acceptance/mergeConflict.test.ts`
- Create: `README.md`
- Modify: `.vscodeignore`

**Interfaces:**
- Consumes the packaged extension behavior from Tasks 1–6.
- Produces reproducible acceptance coverage and user-facing setup/troubleshooting documentation.

- [ ] **Step 1: Write the real-conflict acceptance test**

In a temporary repository, create a merge conflict containing two blocks, open the file in the extension host, assert the snapshot count is two, execute next/previous commands, and assert the active editor line changes to each block's start line.

- [ ] **Step 2: Add Git-only unresolved acceptance coverage**

Remove conflict markers while keeping the index unmerged, assert the file remains in the Git-only group, assert no line decoration is added, and assert the Merge Editor command is offered.

- [ ] **Step 3: Document usage and limitations**

Document installation, opening the Conflict Resolver view, command names, Git-only unresolved behavior, Merge Editor fallback, supported platforms, large-file behavior, and troubleshooting for missing Git.

- [ ] **Step 4: Package and inspect the extension**

Run:

```bash
npm run check
npx @vscode/vsce package
```

Expected: compile and tests pass; the `.vsix` contains `dist`, manifest metadata, README, and icon resources, and excludes source tests and development files.

- [ ] **Step 5: Commit acceptance and docs**

```bash
git add src/test/acceptance/mergeConflict.test.ts src/test/extension.test.ts README.md .vscodeignore
git commit -m "test: verify conflict resolver end to end"
```

### Task 8: Final Verification

**Files:**
- Verify: all files from Tasks 1–7

- [ ] **Step 1: Run the complete non-watch test suite**

Run: `npm run check`

Expected: compile succeeds and all unit/integration tests pass with no watch process left running.

- [ ] **Step 2: Verify the extension package**

Run: `npx @vscode/vsce ls`

Expected: package listing includes `package.json`, compiled `dist` files, README, and the icon; it excludes `src/test` and local configuration files.

- [ ] **Step 3: Manually verify the six acceptance criteria**

Use a real temporary merge conflict to verify count accuracy, click-to-jump, previous/next navigation, save refresh, Git-only unresolved fallback, and no impact on the built-in Source Control view.

- [ ] **Step 4: Commit verification metadata if needed**

If verification only produces local logs or a package artifact, do not commit generated artifacts. Commit only source, tests, manifests, and documentation that are required to reproduce the verified result.

