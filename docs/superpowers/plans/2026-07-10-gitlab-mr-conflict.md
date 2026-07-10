# GitLab MR Conflict Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitLab Merge Request conflict-status detection without mixing remote MR state into local file conflict navigation.

**Architecture:** Read the current Git remote and branch locally, resolve them to a GitLab project and source branch, then query GitLab's merge-request list API with `state=opened` and `source_branch`. Keep the remote snapshot in a dedicated service and add a separate tree group; local ConflictStore remains the source for file-level conflicts.

**Tech Stack:** TypeScript, VS Code Extension API, Node.js `fetch`, Git CLI through the existing service boundary, Vitest.

## Global Constraints

- Support GitLab.com and self-managed GitLab through `conflictResolver.gitlabUrl`.
- Support HTTPS and SSH GitLab remote URLs.
- Prefer `GITLAB_TOKEN` over `conflictResolver.gitlabToken`; never log or display token values.
- Query only opened MRs for the current source branch and encode project paths correctly.
- Keep remote MR status separate from local `locatedConflicts` and `gitUnmerged` state.
- Do not add GitHub, GitLab CLI, automatic conflict resolution, or remote line-level navigation.
- Network failures must not clear a previously successful remote snapshot.

---

## File Map

- Modify: `package.json` — GitLab settings and refresh command.
- Modify: `src/types.ts` — remote MR and remote snapshot types.
- Create: `src/gitRemoteService.ts` — Git remote URL/current branch parsing and GitLab project identity.
- Create: `src/gitlabApiClient.ts` — authenticated HTTP request and response validation.
- Create: `src/mergeRequestConflictService.ts` — refresh, cache, error mapping, and snapshot publication.
- Modify: `src/conflictTreeProvider.ts` — remote MR group and nodes.
- Modify: `src/extension.ts` — instantiate service, register refresh command/events, open MR URLs.
- Create: `src/test/gitRemoteService.test.ts` — remote parsing.
- Create: `src/test/gitlabApiClient.test.ts` — HTTP/auth/response behavior.
- Create: `src/test/mergeRequestConflictService.test.ts` — cache, refresh, errors, and state retention.
- Modify: `src/test/conflictTreeProvider.test.ts` — remote group rendering and command.

---

### Task 1: Add Remote Types and GitLab Settings

**Files:** `src/types.ts`, `package.json`

- [ ] Add `MergeRequestConflict` and `RemoteMergeRequestSnapshot` types exactly as specified in the design.
- [ ] Add `conflictResolver.gitlabUrl` with default `https://gitlab.com`.
- [ ] Add `conflictResolver.gitlabToken` as a password-style setting with an empty default.
- [ ] Add `conflictResolver.refreshRemoteMR` command.
- [ ] Run `npm run check` and commit `feat: add GitLab MR settings and types`.

### Task 2: Implement Git Remote Parsing

**Files:** `src/gitRemoteService.ts`, `src/test/gitRemoteService.test.ts`

- [ ] Define `GitRemoteService.getContext(root)` returning `{ host, projectPath, branch } | undefined`.
- [ ] Parse HTTPS remotes such as `https://gitlab.example.com/group/project.git`.
- [ ] Parse SSH remotes such as `git@gitlab.example.com:group/project.git`.
- [ ] Preserve nested groups and URL-decode project path segments only after extracting the remote path.
- [ ] Read branch using `git -C root branch --show-current`; detached HEAD returns a typed `detached-head` result.
- [ ] Reject non-GitLab hosts without throwing.
- [ ] Use the existing `execFile` argument-array pattern and avoid shell interpolation.
- [ ] Add tests for GitLab.com, self-managed hosts, SSH/HTTPS, `.git` suffix, nested groups, non-GitLab remote, and detached HEAD.
- [ ] Run `npm run test:unit -- src/test/gitRemoteService.test.ts` and `npm run check`; commit `feat: parse GitLab project context`.

### Task 3: Implement the GitLab API Client

**Files:** `src/gitlabApiClient.ts`, `src/test/gitlabApiClient.test.ts`

- [ ] Define `listOpenedMergeRequests(host, projectPath, sourceBranch, token)`.
- [ ] Request `/api/v4/projects/{encodeURIComponent(projectPath)}/merge_requests` with `state=opened`, `source_branch`, and bounded `per_page`.
- [ ] Send `PRIVATE-TOKEN` only when a token exists.
- [ ] Validate each response item contains `iid`, `title`, `web_url`, `source_branch`, `target_branch`, and boolean `has_conflicts`.
- [ ] Map 401/403 to `unauthorized`, 404 to `not-found`, network/timeout to `network`, and malformed JSON/fields to `invalid-response`.
- [ ] Never include the token in thrown error messages.
- [ ] Use injected `fetch` and clock/abort behavior for deterministic tests.
- [ ] Test URL encoding, headers, multiple MRs, status mapping, malformed response, and token redaction.
- [ ] Run focused tests and commit `feat: query GitLab merge request conflicts`.

### Task 4: Add Refresh, Cache, and Error Retention

**Files:** `src/mergeRequestConflictService.ts`, `src/test/mergeRequestConflictService.test.ts`

- [ ] Define `getSnapshot()`, `onDidChange()`, `refresh(root, force?)`, and `scheduleRefresh(root)`.
- [ ] Resolve current GitLab context, select token from `GITLAB_TOKEN` then configuration, and query the API.
- [ ] Sort multiple MRs by IID ascending.
- [ ] Cache successful repository/branch results for a short configurable TTL.
- [ ] On failure, retain the previous successful MR list and attach an error code.
- [ ] Return `not-configured` for non-GitLab remotes or missing context, `not-found` for no opened MR, and `detached-head` without network calls.
- [ ] Test cache hit, forced refresh, branch change, error retention, token precedence, no MR, and multiple-MR ordering.
- [ ] Run focused tests and commit `feat: refresh GitLab MR conflict snapshots`.

### Task 5: Render Remote MR State

**Files:** `src/conflictTreeProvider.ts`, `src/test/conflictTreeProvider.test.ts`

- [ ] Extend the provider to consume the remote service snapshot.
- [ ] Add a `远程 MR` group separate from local groups.
- [ ] Render IID, title, source/target branch, and `存在合并冲突` / `无合并冲突` / error status.
- [ ] Add a node command that opens `webUrl` through an injected callback/registered command.
- [ ] Keep MR nodes out of previous/next local conflict navigation.
- [ ] Test remote group rendering, error state, IID sorting, and open-URL command arguments.
- [ ] Run focused tests and commit `feat: show remote GitLab MR status`.

### Task 6: Wire Extension Lifecycle and Configuration

**Files:** `src/extension.ts`, `package.json`, `src/test/extension.test.ts`

- [ ] Construct the remote service with Git root, branch, configuration, and API adapters.
- [ ] Register `Conflict Resolver: Refresh Remote MR`.
- [ ] Register the MR open-URL command and use `vscode.env.openExternal`.
- [ ] Refresh on activation, workspace-folder changes, and active branch/editor changes; do not refresh on every keystroke.
- [ ] Refresh local and remote services independently so GitLab errors do not break local conflict detection.
- [ ] Verify token values are not written to logs or UI.
- [ ] Run `npm run check` and package listing; commit `feat: wire GitLab MR conflict detection`.

### Task 7: Documentation and Packaging Verification

**Files:** `README.md`, `.vscodeignore`

- [ ] Document GitLab URL/token configuration, `GITLAB_TOKEN`, permissions, remote vs local conflict distinction, and failure states.
- [ ] Exclude tests, source maps, repository metadata, and local caches from the VSIX.
- [ ] Run `npm run check`.
- [ ] Run VSCE package listing with a Node version compatible with the installed VSCE runtime and confirm only runtime files are included.
- [ ] Commit `docs: document GitLab MR conflict detection`.

