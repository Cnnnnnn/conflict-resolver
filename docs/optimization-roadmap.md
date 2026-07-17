# Conflict Resolver — 优化路线图

> 目标：在不破坏现有行为的前提下，提升扩展在大仓库与高频交互下的性能，并打磨日常合并冲突解决流程的体验。
>
> 验证：`npm run check`（`tsc` + `vitest`）
>
> 优先级：P0 必修 / P1 本迭代 / P2 后续清理

---

## 0. 总体策略

| 维度 | 现状 | 目标 |
| --- | --- | --- |
| 性能 | `buildSnapshot` 串行 await，`onDidChangeTextDocument` 同步解析 | 并行化（已落地）+ 文档变更防抖（待办） |
| 体验 | 依赖鼠标跳文件、采纳后无 stage 入口、Tree 无当前位置高亮、Undo 单条无法撤销整批 | 键盘直达 + Tree 锚点 + 一键 stage all + Undo 升级（均已落地） |
| 可维护性 | 部分谓词 / 排序 / 锁文件判定重复 | 单一事实源化（已在路上） |

---

## 1. 性能优化（P1）

### 1.1 `buildSnapshot` 并行化 ✅ 已实现

**现状**：`conflictStore.ts` 中 `for (const file of unmergedFiles)` 串行 `await mergeGitUnmergedFile`，IO 与解析相互阻塞。

**实现**：

- 按文件 key 分组：每个 key（同一文件）的 git + open document 合并**串行**执行（merge* 内部是 read-modify-write，需要顺序）；
- 不同 key 之间走 `Promise.all` **完全并行**——`mergeGitUnmergedFile` 对 `openDocumentsByKey` 只读，并行安全。

**收益**：N 个文件的快照构建从 `O(N · t_io)` 降到接近 `max(t_io)`，大仓库下从数秒缩到亚秒。

### 1.2 `setContext` diff ✅ 已实现

`extension.ts` 已用 `scmContextCache` 做 diff（见 `updateScmMenuContext`）。仅对值变化的 context 走 `setContext`。无需改动。

### 1.3 `applyOpenDocumentText` 防抖 ⏳ 待办

**现状**：`onDidChangeTextDocument` → `applyOpenDocumentText` 是同步路径（只在 `scheduleRefresh` 上有 16ms 防抖）。

**待实现**：在文档变更入口用 50ms 节流；纯行内编辑走 `parseLocatedConflicts` 增量；跨结构变更再触发 `scheduleRefresh`。

**收益**：键入流畅度提升。

### 1.4 Git 子进程超时 ✅ 已实现

`gitRepositoryService` 已加 `GIT_COMMAND_TIMEOUT_MS = 30_000` + 子进程 `kill` 兜底（位于 `createGitCommandRunner`）。网络型命令卡死 UI 已有保护。

---

## 2. 体验优化（P1）

### 2.1 键盘直达文件（E1）✅ 已实现

`conflictNavigation.ts` 新增 `nextFile/previousFile/jumpToFirstInFile`，`extension.ts` 注册 3 个命令 + keybindings `Alt+Shift+]` / `Alt+Shift+[` / `Alt+Shift+F`（在 `conflictResolver.hasLocatedConflicts` 上下文激活）。

### 2.2 Tree 当前文件高亮（E3）✅ 已实现

`ConflictTreeProvider` 维护 `activeFileUri` 状态，`extension.ts` 在 `onDidChangeActiveTextEditor` 与 `activate` 初始化时调用 `tree.setActiveFileUri(...)`；当前文件 label 前缀 `$(eye)` + tooltip 标注。

### 2.3 完成态 stage all 按钮（E7）✅ 已实现

`conflictResolver.stageAllResolved` 命令调用内置 `git.add` 批量暂存仍 `gitUnmerged` 的文件；view/title 按钮在 `conflictResolver.markersCleared` context 为 true 时显示；completion message 文本中提示命令面板路径。

### 2.4 后续体验（P2）

- E12：merge / rebase / cherry-pick 场景图标区分
- 场景继续按钮增加「静默模式」（不打开终端，直接走 `git --continue` 子进程）

---

### 2.x 已落地体验项（详见 §5 行动清单）

- E1 键盘直达文件：见 §5
- E3 Tree 当前文件高亮：见 §5
- E5 按文件批量采纳：见 §5
- E6 Undo 升级：见 §5
- E7 完成态 stage all 按钮：见 §5

---

## 3. 可维护性（P2）

- 锁文件判定收敛到 `conflictFilter.isLockFilePath` 单一事实源 ✅ 已存在
- `compareFiles` / `compareConflicts` 已抽到 `conflictCompare.ts`，全链路引用一致 ✅ 已存在
- `gitOnly` 谓词统一在 `conflictPredicates.ts`（`isGitOnlyUnresolved` / `isResolvedGitFile`）✅ 已存在

> 本次复查确认上述三条均已收敛，无需改动。

---

## 4. 验证

每条改动完成后：

1. `npm run check`（tsc + vitest）必须绿
2. 必要时补充单元测试
3. 在 sample 仓库手动验证大文件 / 多文件场景

---

## 5. 行动清单

### 本次迭代已完成

- [x] **1.1 buildSnapshot 并行化**：`src/conflictStore.ts` 重写 `buildSnapshot` 内的串行循环为「按 key 分组的 Promise.all」——同一文件的 git + open document 合并串行（避免 RMW 竞争），不同文件完全并行
- [x] **1.2 setContext diff**：已存在，无需改动
- [x] **1.3 文档变更防抖**：`extension.ts` 的 `onDidChangeTextDocument` 路径把 `refreshConflictUi` 用 50ms 防抖合并；store snapshot 仍同步更新，UI 渲染合并成单次
- [x] **1.4 Git 子进程超时**：已存在（`GIT_COMMAND_TIMEOUT_MS = 30_000`）
- [x] **2.1 键盘直达文件**：新增 `Conflict Resolver: Next/Previous Conflict File` 命令 + `Jump to First Conflict in Active File` 命令，keybindings: `Alt+Shift+]` / `Alt+Shift+[` / `Alt+Shift+F`
- [x] **2.2 Tree 当前文件高亮**：`ConflictTreeProvider.setActiveFileUri()` 在 `onDidChangeActiveTextEditor` 中更新，当前文件 label 前缀 `$(eye)` + tooltip 标注
- [x] **2.3 完成态 stage all 按钮**：
  - 新增命令 `conflictResolver.stageAllResolved`（调用内置 `git.add`）
  - view/title 按钮（仅在 `conflictResolver.markersCleared` context 为 true 时显示）
  - completion message 文本中提示命令面板路径
- [x] **E5 按文件批量采纳**：
  - `runBatchResolution` 接受 `{ uri }`（无 conflictId）即按 `collectBatchTargets({kind: "file", fileUri})` 收集目标
  - package.json `view/item/context` 新增 file item 上的 3 个采纳命令（采用当前/传入/双方）
- [x] **E6 Undo 升级 + WorkspaceEdit 反向**：
  - 栈深度 5 → 20
  - 每批 entries 上限 200（防巨型 batch 爆内存）
  - `take()` 一次返回整个 batch（原子撤销），不再只取栈顶单条
  - batch label 自适应：`filename` / `filename × N` / `N 个文件`
  - 撤销 UI 用 batch label 而非首条 label
  - 新增 3 个测试覆盖 batch 行为 + 深度上限
- [x] **E12 场景图标区分**：
  - `mergeScenario.ts` 新增 `formatScenarioIcon`：merge=`$(git-merge)` / rebase=`$(history)` / cherry-pick=`$(git-cherry-pick)`
  - `statusBar.setScenarioIcon(icon)` 公开方法，`ensureScenarioUpToDate` 中调用
  - 状态栏文本前缀对应 codicon
- [x] **跨平台 CI（Ubuntu + macOS + Windows）**：`.github/workflows/ci.yml` 三 job × 三 OS 矩阵全部通过
  - `test` job 跑 `npm install + npm run check`；`package` job `needs: test` 跑 `compile + vsce package`，PR 时上传 vsix artifact
  - `concurrency` 取消 in-flight，`fail-fast: false` 单次 run 看全平台
  - 踩坑：作者本机 `~/.npmrc` 把 registry 指向内部 Nexus + `package-lock.json` 的 `resolved` URL 已写死 Nexus，runner 无法到达；逐级尝试 `--registry` / `NPM_CONFIG_REGISTRY` / 项目 `.npmrc` / `npm install`（保留 lockfile）都被 lockfile 烧录的 URL 顶掉，最后在 CI 里 `rm package-lock.json && npm install --no-audit --registry=...` 让 lockfile 重新生成
  - Windows 默认 shell 是 PowerShell 7，`rm -f` 被解析为 `Remove-Item -Filter/-Force` 冲突，给多行 step 显式 `shell: bash`
  - `package` job 必须先 `npm run compile` 否则 vsce 报 `Extension entrypoint(s) missing`
- [x] **Windows 测试 fixture 路径归一化**：
  - `mergeScenario.test.ts`：`/tmp/conflict-resolver-scenario-` 改用 `join(tmpdir(), ...)`
  - `conflictStore.test.ts`：根常量用 `resolve(...)` 包成 OS-native；`FakeGitRepositoryService.findRepositoryRoot` 用 `toPosixWithLeadingSlash` 把 native 根路径对齐到 WHATWG URL pathname 形态（`/C:/repo/...`），让 prefix 检查跨平台工作
  - `gitRepositoryService.test.ts`：`expect(realpath)` 用 `toPosixPath` 归一化，跟 `git rev-parse` 的 forward-slash 输出对齐

### 已存在（roadmap 误报，本次复查确认）

- 锁文件判定收敛到 `conflictFilter.isLockFilePath`（`conflictTreeProvider.fileMatchesFilter` 已用同一源）
- `gitOnly` 谓词统一在 `conflictPredicates.ts`（`isGitOnlyUnresolved` / `isResolvedGitFile` 全局引用）
- `compareFiles` / `compareConflicts` 抽到 `conflictCompare.ts`

### 后续迭代

- 无。当前 roadmap 全部 P0/P1/P2 已落地（含跨平台 CI、场景静默模式、性能基准脚本）。后续优化应另开新 doc 跟踪。

### 验证

- `npm run check`：19 files / 116 tests passed（tsc 严格模式 + vitest）
- 打包：`conflict-resolver-0.0.10.vsix`（69.33 KB，Node 22 + `vsce package --no-dependencies`）
- 本次未触发端到端浏览器/E2E 测试（手测阶段）