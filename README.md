# Conflict Resolver

Conflict Resolver 是一个兼容 VS Code 和 Cursor 的 Git 冲突导航扩展。

## 功能

- 在左侧 Conflict Resolver 面板显示冲突文件和冲突数量；
- 点击冲突项跳转到冲突起始位置；
- 当前文件显示 `冲突 x/y`；
- 支持上一个/下一个冲突命令；
- 文件保存、编辑器切换和 Git 状态变化后自动刷新；
- 识别 Git 已记录为 `unmerged`、但文件中没有标准冲突标记的情况；
- 无法定位具体行时尝试打开 Merge Editor，并提供明确的降级提示。

## 使用

1. 在 Git 仓库中打开 VS Code 或 Cursor。
2. 点击 Activity Bar 中的 Conflict Resolver 图标。
3. 在“可定位冲突”分组中展开文件并点击具体冲突。
4. 使用命令面板执行：
   - `Conflict Resolver: Next Conflict`
   - `Conflict Resolver: Previous Conflict`
   - `Conflict Resolver: Open Conflict Panel`
   - `Conflict Resolver: Rescan Current File`
   - `Conflict Resolver: Open Merge Editor`

快捷键不由扩展预设，可在 Keyboard Shortcuts 中自行绑定。

## Git-only 未解决状态

如果 Git 索引仍然处于 `unmerged`，但文件中没有可识别的冲突标记，面板会将其放在“Git 未解决但位置未知”分组。扩展不会伪造具体行号；点击或导航时会尝试打开 Merge Editor。

## 限制

- 第一版只处理本地 Git 工作区，不连接 GitHub、GitLab 或云端 PR；
- 不自动选择 ours/theirs，也不自动修改冲突内容；
- 大文件会降低实时扫描频率，优先在保存时刷新；
- Git 不可用时仍会尝试解析当前文件中的标准冲突标记，但无法读取 Git 的 `unmerged` 状态。

## 开发

```bash
npm install
npm run check
```

打包需要 `@vscode/vsce`：

```bash
npx @vscode/vsce package
```

扩展目标平台为 Windows、macOS 和 Linux，运行时依赖本机 Git 命令。
