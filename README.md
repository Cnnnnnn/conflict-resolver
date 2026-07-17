# Conflict Resolver

Conflict Resolver 是一个兼容 VS Code 和 Cursor 的 Git 冲突导航扩展。

仓库：[github.com/Cnnnnnn/conflict-resolver](https://github.com/Cnnnnnn/conflict-resolver)

## 安装

### 方式一：从 GitHub Release 安装（无需插件市场）

1. 打开 [Releases](https://github.com/Cnnnnnn/conflict-resolver/releases) 下载最新 `.vsix`
2. VS Code / Cursor 中 `Cmd+Shift+P` → `Extensions: Install from VSIX...`
3. 选择下载的文件，执行 `Developer: Reload Window`

### 方式二：Open VSX（Cursor 可直接搜索安装）

扩展市场页面：[open-vsx.org/extension/shienLiang/conflict-resolver](https://open-vsx.org/extension/shienLiang/conflict-resolver)

在 Cursor 扩展面板搜索 **Conflict Resolver**（Publisher: `shienLiang`），扩展 ID：`shienLiang.conflict-resolver`

### 方式三：VS Code Marketplace（待发布）

`shienLiang.conflict-resolver`

## 功能

- 在左侧 Conflict Resolver 面板显示冲突文件和冲突数量；
- 点击冲突项跳转到冲突起始位置；
- 支持跨文件的上一个/下一个冲突导航，状态栏显示 `◀ 冲突 2/15 · 3 文件 ▶`，左右箭头可点击跳转；
- 编辑器标题栏和 Conflict Resolver 面板标题栏同样提供上一处/下一处箭头按钮；
- 仍保留单文件内导航命令（`Next/Previous Conflict in File`）；
- 面板顶部和视图消息显示合并进度，例如 `剩余 3 文件 · 8 处冲突`；
- 冲突项悬停可预览 **当前 (HEAD)** / **传入** 内容摘要；
- 冲突项右侧提供 **采用当前** / **采用传入** / **保留双方** 一键按钮；新增 **对比当前 vs 传入** 按钮，在只读 diff 编辑器中预览两侧内容；未知冲突文件可一键打开 Merge Editor；
- 全部冲突标记处理完后弹出提醒，面板顶部显示 **✓ 完成态**（含 `git add` 提示）；
- 编辑冲突文件时**同步**刷新冲突计数与面板列表（无需等待 Git 全量扫描）；
- 编辑器内冲突 marker 全部清除后，扩展徽章和冲突列表会立即移除该文件；执行 `git add` 后才会从 Git「合并更改」原生列表消失；
- 文件保存、编辑器切换和 Git 状态变化后自动刷新；
- 识别 Git 已记录为 `unmerged`、但文件中没有标准冲突标记的情况；
- 无法定位具体行时尝试打开 Merge Editor，并提供明确的降级提示；
- 在源代码管理「合并更改」和文件资源管理器中，于冲突文件名旁显示冲突数量徽章。
- **跳过 lock 文件**：`pnpm-lock.yaml` 等默认不扫描（设置 `conflictResolver.includeLockFiles` 可开启），性能更佳；
- **跳到冲突后自动选区**：选中 `<<<<<<<` 到 `=======` 区间，方便直接替换或整体采纳；
- **批量采纳**：勾选多个冲突后，顶部按钮可一键采用当前 / 传入 / 保留双方；支持文件内全选、清空、Quick Pick 搜索定位；
- **采纳后自动跳转**：单条或批量采纳完成后，自动跳转到下一个未处理冲突；
- **冲突预览**：面板每个冲突项右侧显示一行对比摘要（`← 当前 · → 传入`），hover 仍可看完整多行预览；
- **撤销采纳**：每次单条 / 批量采纳前自动快照原始文件内容，提供 `Undo Last Accept` 命令恢复；
- **返回上处**：`Alt+Left` 跳回上一个处理过的冲突；
- **按文件跳转**：新增 `Alt+Shift+[` / `Alt+Shift+]` 在冲突文件之间循环跳转（不同于按冲突顺序的 `Alt+[` / `Alt+]`），`Alt+Shift+F` 跳到当前文件首个冲突；批量冲突列表下不再依赖鼠标点文件节点；
- **当前文件高亮**：Tree 面板中当前打开的文件名前自动追加 `$(eye)` 标记并加粗，tooltip 同步标注，便于长时间停留在大文件时不丢锚点；
- **按文件批量采纳**：在 Tree 文件节点右键菜单新增 **采用当前** / **采用传入** / **保留双方**，一键对当前文件的所有冲突应用同一种解决方案；解决 lock 文件批量一致化的常见场景；
- **Stage All Resolved**：冲突标记全部清除后，面板顶栏出现 `✓ 冲突标记已处理` 完成态并新增 **Stage All** 按钮（命令面板：`Conflict Resolver: Stage All Resolved Conflicts`），一键调用内置 `git add` 把所有已解决的冲突文件加入索引，闭环完成合并；
- **Undo 升级**：栈深度 5 → 20（可配置 `conflictResolver.maxUndoDepth`，范围 1–200），每批采纳原子撤销（一次回退整批采纳的所有文件，而非单条），撤销提示展示 batch 标签（如 `pkg-lock.json × 4` / `5 个文件`）；
- **命令面板命名空间 `cr`**：所有命令在命令面板统一分类为 **Conflict Resolver (cr)**；输入 `cr` 即可过滤所有 Conflict Resolver 命令。命令 **Conflict Resolver: Quick Pick Command**（`$(list-filter)`）打开一个内置 Quick Pick，支持模糊匹配、关键字搜索、按分组（导航 / 状态栏 / Tree / 批量 / 场景）筛选，并按当前冲突状态动态隐藏/显示命令（如未在合并场景时不显示 "Continue Merge/Rebase/Cherry-pick"）。Quick Pick 查询前缀 `cr ` 会被自动剥除再匹配，避免命令名误吃前缀；
- **SCM 标题栏按钮**：源代码管理视图标题栏新增 **Continue Merge/Rebase/Cherry-pick**（仅当 `scenarioInProgress`）和 **Stage All Resolved**（仅当 markers cleared）两个按钮，无需打开命令面板即可一键推进合并流程；
- **场景图标区分**：状态栏上的合并/变基/拣选状态使用不同 codicon 前缀（merge=`$(git-merge)` / rebase=`$(history)` / cherry-pick=`$(git-cherry-pick)`），远看就能识别当前场景；
- **静默继续场景**：设置 `conflictResolver.silentScenarioContinue` 可让 "Continue Merge/Rebase/Cherry-pick" 不再打开终端，而是在子进程中直接执行 `git <verb> --continue`（30 秒超时，结果通过通知显示），适合脚本化或 CI 残留场景；
- **Tree 文件图标**：面板中每个冲突文件按类型显示 codicon——lock 文件 `$(lock)`、源代码 `$(file-code)`、其他 `$(file)`——大仓库里一眼区分 lock 批量一致化 vs 源码逐个处理；
- **Tree 新鲜度徽章**：分组标题会显示 `$(clock) · N 秒前` 形式的 staleness 提示，1 分钟以上视为 stale 并加 tooltip 提示重新扫描，避免按 stale 数据做批量采纳；

## 冲突切换方式

仓库存在可定位冲突时，可用以下三种方式在冲突间跳转（均支持跨文件）。

### 1. 专属冲突面板切换

打开 Activity Bar 的 **Conflict Resolver** 面板，在「可定位冲突」分组中展开文件，点击具体冲突项（如 `冲突 1 · 第 75 行`），编辑器会跳转到对应位置。面板顶部同步显示合并进度（如 `剩余 2 文件 · 6 处冲突`）。

![专属冲突面板切换](resources/screenshots/conflict-panel.png)

### 2. 底部箭头按钮切换

状态栏左侧显示 `◀ 冲突 · N 处 ▶`（或 `冲突 2/6 · 2 文件`）。点击左右箭头，在**全仓库**冲突间循环跳转，无需打开侧边面板。

![底部箭头按钮切换](resources/screenshots/status-bar-arrows.png)

编辑器标题栏和 Conflict Resolver 面板标题栏也提供同样的 `◀` / `▶` 按钮。默认快捷键：`Alt+[` 上一个，`Alt+]` 下一个。

展开冲突项后，行右侧有 **← 采用当前** / **→ 采用传入** / **保留双方** 按钮；悬停可预览双方内容摘要。

### 3. 文件定位切换

在源代码管理「合并更改」中，对冲突文件**右键** → **冲突** 子菜单：

- 若当前文件已打开且路径匹配：直接列出 **冲突 1**、**冲突 2** … 逐项跳转
- 若路径不匹配或冲突较多：选择 **选择冲突位置…**，在 Quick Pick 中按行号跳转

![合并更改右键冲突菜单](resources/screenshots/scm-conflict-menu.png)

![选择冲突位置 Quick Pick](resources/screenshots/conflict-quick-pick.png)

### 4. 完成态与 Stage All

当所有冲突标记处理完毕时：

- 面板顶部显示 **✓ 冲突标记已处理 · 剩余 N 个文件待 git add**
- 弹出通知提醒执行 `git add`
- **新增 Stage All 按钮**：面板顶栏在完成态下出现 **Stage All Resolved** 按钮（命令面板：`Conflict Resolver: Stage All Resolved Conflicts`），一键调用内置 `git add` 把所有已解决的冲突文件加入索引
- 全部 `git add` 后显示 **✓ 合并冲突已全部处理完毕**

### 5. 按文件跳转

冲突文件较多时，`Alt+[` / `Alt+]` 按冲突顺序跳转仍会反复在同一文件里翻页。改用以下快捷键按**文件**循环：

- `Alt+Shift+]`：下一个有冲突的文件（跳到该文件首个冲突）
- `Alt+Shift+[`：上一个有冲突的文件
- `Alt+Shift+F`：跳到当前打开文件的首个冲突

Tree 面板中当前打开的文件名前会自动加上 `$(eye)` 标记，不会再迷失在长长的列表里。

## 使用

1. 在 Git 仓库中打开 VS Code 或 Cursor。
2. 点击 Activity Bar 中的 Conflict Resolver 图标。
3. 使用上方 [三种切换方式](#冲突切换方式) 在冲突间跳转。
4. 使用命令面板执行（输入 `cr` 过滤全部 Conflict Resolver 命令）：
   - `Conflict Resolver (cr): Next Conflict`
   - `Conflict Resolver (cr): Previous Conflict`
   - `Conflict Resolver (cr): Next Conflict in File`
   - `Conflict Resolver (cr): Previous Conflict in File`
   - `Conflict Resolver (cr): Open Conflict Panel`
   - `Conflict Resolver (cr): Quick Pick Command`（打开内置 Quick Pick 模糊搜索）
   - `Conflict Resolver (cr): Rescan Current File`
   - `Conflict Resolver (cr): Open Merge Editor`
   - `Conflict Resolver (cr): Accept Selected (Current)` / `Accept Selected (Incoming)` / `Accept Selected (Both)`
   - `Conflict Resolver (cr): Select All Conflicts` / `Clear Selection` / `Select Conflicts in File`
   - `Conflict Resolver (cr): Show All / Source / Lock Conflicts`
   - `Conflict Resolver (cr): Search Conflicts`（默认快捷键 `Ctrl+Shift+F`，聚焦面板时）
   - `Conflict Resolver (cr): Next Conflict File` / `Previous Conflict File` / `Jump to First Conflict in Active File`
   - `Conflict Resolver (cr): Stage All Resolved Conflicts`
   - `Conflict Resolver (cr): Back to Previous Conflict`
   - `Conflict Resolver (cr): Undo Last Accept`（默认快捷键 `Ctrl+Shift+U`，撤销最近一批采纳）
   - `Conflict Resolver (cr): Continue Merge/Rebase/Cherry-pick`（仅当处于合并/变基/拣选场景时显示）

默认快捷键：

| 快捷键 | 作用 |
| --- | --- |
| `Alt+]` | 下一个冲突 |
| `Alt+[` | 上一个冲突 |
| `Alt+Shift+]` | 下一个有冲突的文件 |
| `Alt+Shift+[` | 上一个有冲突的文件 |
| `Alt+Shift+F` | 跳到当前文件首个冲突 |
| `Alt+Left` | 返回上处 |
| `Ctrl+Shift+U` | 撤销最近一批采纳 |
| `Ctrl+Shift+F`（面板聚焦） | 搜索冲突 |

## 设置

全部设置作用域为 `window`，可通过 VS Code Settings（搜索 `conflictResolver.*`）调整。

| Setting | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `conflictResolver.includeLockFiles` | boolean | `false` | 是否扫描 lock 文件（`pnpm-lock.yaml` / `package-lock.json` 等）。默认跳过以提升性能；遇到 lock 文件冲突需要批量采纳时打开。 |
| `conflictResolver.treeFilterMode` | enum `all` / `source` / `lock` | `all` | 冲突面板的过滤模式。`source` 仅显示源代码文件、隐藏 lock 文件；`lock` 仅显示 lock 文件，便于批量一致化。 |
| `conflictResolver.silentScenarioContinue` | boolean | `false` | 场景继续（merge / rebase / cherry-pick）时静默执行。`false` 打开临时终端；`true` 直接在子进程调用 `git <verb> --continue`，30 秒超时，结果通过通知显示。 |
| `conflictResolver.maxUndoDepth` | integer 1–200 | `20` | 保留的撤销批次上限。一次采纳（或一组批量采纳）作为一个撤销批次。 |

## Git-only 未解决状态

如果 Git 索引仍然处于 `unmerged`，但文件中没有可识别的冲突标记，面板会将其放在“Git 未解决但位置未知”分组。扩展不会伪造具体行号；点击或导航时会尝试打开 Merge Editor。

## 合并进度

当仓库处于合并冲突状态时，Conflict Resolver 面板顶部会显示进度摘要，例如：

`剩余 3 文件 · 8 处冲突 · 1 处未知冲突`

视图底部的 message 区域也会同步显示同样信息。状态栏悬停可查看该摘要。

## SCM 冲突徽章

扩展会在源代码管理面板的「合并更改」列表，以及文件资源管理器中，为冲突文件显示简短徽章（如 `6个`），悬停可看到完整说明（如 `6个冲突`）。Conflict Resolver 面板文件行右侧会显示完整的 `N个冲突` 文案。

- `6个`、`12个`：可定位的冲突（SCM 徽章受 API 长度限制，显示为「数字+个」）
- `99+`：冲突超过 99 个
- `!`：未知冲突（Git 未解决但定位不到行号）；悬停显示「未知冲突」

## 合并更改右键菜单

详见 [文件定位切换](#3-文件定位切换)。在「合并更改」中右键冲突文件，可打开 **冲突** 子菜单：

- **冲突 1**、**冲突 2** …：跳转到该文件第 N 个可定位冲突（当前文件已打开时）
- **选择冲突位置…**：Quick Pick 按行号选择（路径不匹配或冲突较多时）
- **打开 Merge Editor**：用于无法定位具体行号的未合并文件

## 批量采纳与面板搜索

Conflict Resolver 面板顶部新增一组操作按钮，可对所选冲突执行批量处理：

- **全选** / **清空** 按钮：一次性勾选所有可见冲突，或清空当前选择。
- **采用当前** / **采用传入** / **保留双方** 按钮：对当前选择执行批量处理（也支持在单个冲突上右键）。没有任何选择时，作用于所有可定位冲突。
- **文件右键 → 批量采纳**：Tree 中**文件节点**右键菜单新增 **采用当前** / **采用传入** / **保留双方**，一键对当前文件下所有可定位冲突应用同一种解决方案（典型场景：lock 文件批量一致化）。
- **文件右键 → 选择**：可一键勾选该文件下的所有冲突。
- **搜索**：面板聚焦时按 `Ctrl+Shift+F`，输入关键字或行号；多结果时弹出 Quick Pick 选择目标文件后跳转。

面板分组右上方还提供 **显示模式** 切换：`全部` / `仅源代码` / `仅 lock 文件`，可在过滤后批量处理某一类文件。设置项 `conflictResolver.treeFilterMode` 也会同步生效。

## 性能

- 大仓库下 `git ls-files -u` 与所有 unmerged 文件读取/解析走 **Promise.all 并行**（同文件内仍串行，避免 read-modify-write 竞争），从 O(N · t_io) 降到接近 max(t_io)
- setContext 调用按值 diff 缓存，避免重复 IPC；Git 子进程 30 秒超时 + `kill` 兜底，防止网络操作卡死 UI
- 大文件（>5MB）跳过磁盘读取，仅依赖保存时刷新

## 限制

- 不自动解决冲突，也不连接 GitHub、GitLab 等远程 PR/MR API；
- 大文件会降低实时扫描频率，优先在保存时刷新；
- 内置 Merge Conflict 扩展未启用时，采纳操作走文本回退实现。

## 开发

```bash
npm install
npm run check
```

打包：

```bash
npx @vscode/vsce package
```

## CI / 发布

GitHub Actions：

- `ci.yml`：日常 PR / push main 时执行 matrix 测试（ubuntu / macOS / Windows latest × `test` + `package` 两个 job），PR 上传 vsix artifact 供 review；用 `npm install --no-audit --registry=https://registry.npmjs.org/`（先删除 lockfile 以避免内部 Nexus 的 resolved URL）以绕开作者本机 `~/.npmrc` 的私有 registry。
- `release.yml`：只在推送 `v*.*.*` tag 时触发，`npm install && npm run check && vsce package --no-dependencies`，随后发布到 Marketplace / Open VSX 并创建 GitHub Release。

### VS Code Marketplace

1. 在 [Marketplace 管理页](https://marketplace.visualstudio.com/manage) 创建 Publisher：`shienLiang`
2. 在 [Azure DevOps](https://dev.azure.com/_users/settings/tokens) 创建 PAT，Scope 选 **Marketplace → Manage**
3. 登录并发布：

```bash
nvm use 22
npx @vscode/vsce login shienLiang
npm run publish:marketplace
```

### Open VSX（Cursor 等）

1. 在 [open-vsx.org](https://open-vsx.org) 用 GitHub 登录并关联 Publisher
2. 在 [Access Tokens](https://open-vsx.org/user-settings/tokens) 创建 Token
3. 发布：

```bash
npx ovsx publish -p <你的-open-vsx-token>
```

扩展目标平台为 Windows、macOS 和 Linux，运行时依赖本机 Git 命令。
