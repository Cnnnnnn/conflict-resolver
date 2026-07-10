# GitLab MR 远程冲突检测设计

## 目标

在现有本地 Git 冲突检测之外，增加 GitLab Merge Request 远程冲突状态检测。用户打开一个 GitLab 仓库和分支时，插件自动查找当前分支对应的 Open MR，并展示 MR 是否存在合并冲突。

## 范围

第一版只支持 GitLab MR：

- 通过 Git remote 自动识别 GitLab 项目；
- 通过当前分支查找对应 Open MR；
- 查询 MR 标题、IID、source branch、target branch、网页地址和 `has_conflicts`；
- 在 Conflict Resolver 面板中单独展示远程 MR 状态；
- 点击 MR 打开 GitLab 网页；
- 本地冲突与远程 MR 冲突分开显示；
- 支持 GitLab SaaS 和自建 GitLab。

第一版不包含：

- 自动解决或修改 MR 冲突；
- GitHub、Bitbucket 或其他平台；
- 通过 MR API 获取具体冲突行号；
- 直接调用 `glab` CLI 作为运行时依赖。

## 交互

面板增加远程 MR 分组：

```text
Conflict Resolver
├── 可定位冲突：3
├── Git 未解决但位置未知：1
└── 远程 MR
    └── !123 feature/login → main
        存在合并冲突
```

状态展示：

- `存在合并冲突`：GitLab 返回 `has_conflicts: true`；
- `无合并冲突`：GitLab 返回 `has_conflicts: false`；
- `未找到当前分支 MR`：没有 Open MR；
- `无法连接 GitLab`：网络、权限、Token 或项目识别失败。

点击远程 MR 节点打开 `webUrl`。远程 MR 不参与当前文件的上一个/下一个冲突导航，因为 GitLab API 第一版不提供稳定的本地行号映射。

## 配置与认证

新增配置：

```json
{
  "conflictResolver.gitlabUrl": {
    "type": "string",
    "default": "https://gitlab.com",
    "description": "GitLab instance URL"
  },
  "conflictResolver.gitlabToken": {
    "type": "string",
    "default": "",
    "description": "GitLab API token; prefer environment variable GITLAB_TOKEN"
  }
}
```

认证优先级：

1. `GITLAB_TOKEN` 环境变量；
2. `conflictResolver.gitlabToken` 配置项；
3. 无 Token 时匿名请求，若实例允许则继续工作，否则展示认证错误。

Token 只进入请求 Header，不写入日志、面板、错误消息或仓库文件。

## 架构

```text
GitRemoteService
├── 读取 git remote URL
├── 读取当前 branch
└── 解析 GitLab host/project path

GitLabApiClient
├── 请求项目 Open MR
├── 解析响应
└── 映射网络/认证/API 错误

MergeRequestConflictService
├── 读取当前仓库上下文
├── 查询当前 branch 的 MR
├── 缓存短时间结果
└── 发布远程 MR 状态

ConflictTreeProvider
└── 渲染远程 MR 分组和节点
```

核心类型：

```ts
type MergeRequestConflict = {
  iid: number;
  title: string;
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
  hasConflicts: boolean;
};

type RemoteMergeRequestSnapshot = {
  repositoryRoot: string;
  branch: string;
  mergeRequests: MergeRequestConflict[];
  error?: "not-configured" | "not-found" | "unauthorized" | "network" | "invalid-response";
  generatedAt: number;
};
```

## GitLab API 请求

使用项目 URL 编码后的路径作为项目标识，并按 source branch 查询 Open MR。请求需要：

- `state=opened`；
- 当前 branch 作为 `source_branch`；
- `per_page` 限制结果数量；
- `PRIVATE-TOKEN` Header（有 Token 时）。

解析只接受必要字段：`iid`、`title`、`web_url`、`source_branch`、`target_branch`、`has_conflicts`。缺少必要字段时返回 `invalid-response`，不让异常响应污染本地冲突状态。

## 刷新与缓存

- 工作区打开时查询一次；
- 当前分支变化时查询；
- Git remote 或工作区变化时查询；
- 手动执行 `Conflict Resolver: Refresh Remote MR` 时立即查询；
- 文档每次输入不触发远程请求；
- 相同仓库和分支短时间内复用缓存，避免 API 请求过于频繁；
- 查询失败保留最后一次成功结果，并在面板显示错误状态，避免远程故障清空本地冲突。

## 错误处理

- 非 GitLab remote：隐藏远程 MR 分组；
- 无 Open MR：显示“未找到当前分支 MR”；
- 401/403：显示 Token 或权限提示，不显示 Token 内容；
- 404：显示项目不存在或无访问权限；
- 网络错误/超时：显示连接失败，并保留上一次成功状态；
- 非法 JSON 或字段缺失：显示响应格式错误；
- 多个 Open MR：全部展示，按 IID 升序排列。

## 测试与验收

单元测试：

- SSH remote 和 HTTPS remote 的 GitLab URL 解析；
- 自建 GitLab host 解析；
- 当前分支查询参数和 URL 编码；
- Token Header 注入且不出现在错误文本；
- `has_conflicts`、字段缺失和非法响应；
- 401、403、404、网络超时；
- 多 MR 排序和无 MR 状态；
- 缓存命中与手动刷新。

验收标准：

1. GitLab 仓库当前分支存在 Open MR 时，面板显示 MR IID、标题和冲突状态。
2. GitLab 返回 `has_conflicts: true` 时，面板显示远程冲突，不要求本地存在冲突标记。
3. 点击 MR 节点能打开 GitLab 网页。
4. 本地冲突导航不混入远程 MR 状态。
5. Token 不出现在日志、错误消息或 UI 文本中。
6. GitLab 不可用时，本地冲突检测继续工作。

