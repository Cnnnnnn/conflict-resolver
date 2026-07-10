# Conflict Resolver 插件设计

## 1. 目标

构建一个同时兼容 VS Code 和 Cursor 的扩展，帮助开发者快速发现、统计和定位 Git 合并冲突。

第一版目标：

- 展示工作区中存在冲突的文件及数量；
- 精确解析标准 Git 冲突标记并跳转到对应代码位置；
- 支持当前文件的上一个/下一个冲突导航；
- 识别 Git 已记录为 `unmerged`、但文件中没有标准冲突标记的情况；
- 文件保存或 Git 状态变化后自动刷新；
- 无法定位具体行时，打开 Merge Editor；若无法打开，则跳转文件首行并明确提示。

## 2. 产品交互

### 2.1 左侧冲突总览

新增 `Conflict Resolver` Activity Bar 入口，按两组展示：

```text
冲突解决
├── 工作区：4 个文件，8 个冲突
├── 可定位冲突：7
│   ├── src/a.ts                 3
│   └── src/components/b.ts      4
└── Git 未解决但位置未知：1
    └── src/config.json          Git 状态未解决
```

文件节点显示文件名、相对路径、可定位冲突数量和 Git 未解决状态。点击具体冲突后跳转到冲突起始位置。

### 2.2 当前文件导航

当前编辑器显示：

```text
冲突 1/3    上一个冲突 | 下一个冲突
```

提供以下命令，快捷键由用户自行配置：

- `Conflict Resolver: Next Conflict`
- `Conflict Resolver: Previous Conflict`
- `Conflict Resolver: Open Conflict Panel`
- `Conflict Resolver: Rescan Current File`
- `Conflict Resolver: Open Merge Editor`

### 2.3 编辑器标记

对可定位冲突，在冲突起始行、minimap 和 overview ruler 显示装饰标记；悬浮时显示冲突范围和序号。对只有 Git 未解决状态、但没有可定位范围的文件，不伪造具体行标记。

### 2.4 解决后的行为

文件保存后重新解析：冲突数量减少则立即更新；全部标记消失且 Git 不再是 `unmerged` 时从列表移除；标记消失但 Git 仍未解决时保留在“Git 未解决但位置未知”分组。

## 3. 总体架构

采用 VS Code Extension API + Git CLI 的混合方案。VS Code 和 Cursor 共用扩展 API；Git CLI 作为 Git 状态的事实来源；文件内容解析独立完成。

```text
extension.ts
├── GitRepositoryService
│   ├── 获取仓库根目录
│   ├── 执行 git status / git ls-files -u
│   └── 打开 Merge Editor
├── ConflictParser
│   ├── 解析冲突标记
│   ├── 生成行号和范围
│   └── 处理异常标记
├── ConflictStore
│   ├── 保存工作区状态
│   ├── 合并 Git 状态和文件解析结果
│   └── 提供查询和订阅
├── ConflictTreeProvider
│   └── 渲染左侧面板
├── ConflictDecorationProvider
│   ├── 行标记
│   ├── minimap 标记
│   └── overview ruler 标记
└── ConflictNavigationController
    ├── 上一个/下一个冲突
    └── 跳转到指定冲突
```

## 4. 数据模型

```ts
type ConflictFile = {
  uri: vscode.Uri;
  relativePath: string;
  locatedConflicts: ConflictBlock[];
  gitUnmerged: boolean;
};

type ConflictBlock = {
  id: string;
  startLine: number;
  separatorLine: number;
  endLine: number;
  oursRange: vscode.Range;
  theirsRange: vscode.Range;
};
```

文件内容解析和 Git 索引状态分别保留，避免一方覆盖另一方。

| 文件内容 | Git 状态 | 展示 |
|---|---|---|
| 有冲突标记 | `unmerged` | 可定位冲突 |
| 有冲突标记 | 非 `unmerged` | 显示内容冲突，并提示 Git 状态已变化 |
| 无冲突标记 | `unmerged` | Git 未解决但位置未知 |
| 无冲突标记 | 非 `unmerged` | 从冲突列表移除 |

## 5. 数据流与刷新

```text
工作区打开 / Git 状态变化 / 文件保存
                ↓
        获取 Git 仓库根目录
                ↓
        查询 Git 未解决文件
                ↓
       扫描当前文件内容标记
                ↓
      合并为统一 ConflictFile
                ↓
     更新面板、状态栏、编辑器标记
```

刷新触发条件：

- 工作区打开；
- 文件打开；
- 文档内容变化；
- 文件保存；
- Git 状态变化；
- 切换分支、拉取、合并或变基后。

文档内容变化使用 debounce，避免每次按键都执行 Git 命令。Git 查询按仓库根目录执行，避免每个文件启动一次进程。

## 6. 异常与兼容性

- 非 Git 工作区：显示“当前工作区不是 Git 仓库”，不渲染空冲突数据。
- Git 不可用：提示检查 Git 配置，但仍可独立解析文件中的冲突标记。
- 冲突标记不完整：使用状态机解析，保留已识别内容并标记解析异常。
- 异常顺序或疑似嵌套标记：不让整个扫描失败，不伪造完整冲突范围。
- 大文件：降低实时扫描频率，优先保存时扫描，并提示用户。
- 二进制文件：跳过文本解析。
- 多根工作区、嵌套仓库和 worktree：以文件所在仓库为查询边界。
- Windows、macOS、Linux：统一封装 Git 命令、路径和权限处理。

无法定位的 Git 未解决文件采用“打开 Merge Editor 为主、跳转文件首行为兜底”的交互。

## 7. MVP 范围

### 第一版包含

- 标准 Git 冲突标记解析；
- `git ls-files -u` 等 Git 状态检测；
- 工作区冲突树；
- 当前文件计数和上下冲突导航；
- 行、minimap、overview ruler 标记；
- 保存和 Git 状态变化后的刷新；
- Merge Editor 入口和无法定位提示；
- 单元测试和真实临时 Git 仓库集成测试。

### 第一版不包含

- 自动选择 ours/theirs；
- 自动合并建议；
- 云端 PR、GitHub 或 GitLab 冲突同步；
- 内置快捷键；
- 复杂的冲突解决历史记录。

## 8. 测试与验收标准

### 单元测试

- 单个和多个冲突块；
- 缺失或异常冲突标记；
- LF、CRLF、中文和 Unicode 内容；
- Git `unmerged` 但文件无冲突标记；
- 文件修改后冲突数减少；
- 全部解决后文件移除。

### 集成测试

- 临时 Git 仓库制造真实 merge conflict；
- 验证 `git ls-files -u`；
- 验证面板刷新；
- 验证点击后跳转到正确行；
- 验证多根工作区、子仓库和 Git 不可用场景。

### 验收标准

1. 标准冲突文件显示准确数量。
2. 每个可定位冲突都能跳转到正确起始行。
3. 文件保存后冲突数量及时更新。
4. Git 未解决但无标记的文件不会漏掉。
5. 无法定位时不伪造具体行号。
6. 不影响 VS Code/Cursor 原有 Git 功能。

