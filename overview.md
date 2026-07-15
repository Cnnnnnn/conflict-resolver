# Conflict Resolver — 项目总览

本地 Git 合并冲突导航扩展，聚焦：**发现冲突 → 跳转导航 → 一键采纳 → 完成提醒**。

验证：`npm run check`（`tsc` + `vitest`）

## 核心模块

| 模块 | 职责 |
|------|------|
| `conflictParser` | 解析 `<<<<<<<` / `=======` / `>>>>>>>` 标记 |
| `conflictStore` | 合并打开文档与 `git ls-files -u` 状态 |
| `conflictNavigation` | 跨文件上一个/下一个冲突 |
| `conflictTreeProvider` | 侧边栏树视图 |
| `conflictResolution` | 采纳当前 / 传入 / 双方（含文本回退） |
| `gitRepositoryService` | Git 子进程封装（超时、路径安全） |

## 近期变更

- **移除 GitLab 远程 MR 集成**：删除 API 客户端、Token 配置、远程 MR 面板；扩展仅处理本地工作区冲突。
- **保留双方采纳**：冲突项新增第三个按钮；支持批量 `batchAcceptBoth`；内置 `merge-conflict.accept.both` 不可用时走文本回退。
- **兼容 Cursor / 旧版 VS Code**：`engines.vscode` 降至 `^1.85.0`。
- **activate 冒烟测试**：`src/test/extension.smoke.test.ts` 验证核心命令注册。

## 采纳策略

1. 优先使用内置 `merge-conflict.accept.*`（若已启用）
2. 内置不可用时，扩展用 `WorkspaceEdit` 文本替换（`resolveConflictByTextEdit`）
3. `accept.both` 在 Cursor 等环境可能缺失，此时自动走文本回退拼接双方内容

## 已知限制

- 不连接 GitHub / GitLab 等远程 PR/MR API
- 大文件（>5MB）跳过磁盘读取，依赖保存时刷新
- `engines.vscode` 降级若被 workspace hook 拦截，需手动调整 `package.json`
