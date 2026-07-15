# Marketplace / Open VSX 发布配置

## 现状

v0.0.9 release 工作流（`.github/workflows/release.yml`）的发布步骤：

```
- Publish to VS Code Marketplace [skipped]
- Publish to Open VSX           [skipped]
```

原因是 `if: env.<PAT> != ''` 评估为 false —— **当前仓库还没有配置 `VSCE_PAT` / `OVSX_PAT` 两个 secret**。
所以 v0.0.9 只成功发布到了 GitHub Release（VSIX 可下载），未上市场。

## 解决步骤

### 1. 创建 PAT

- **VS Code Marketplace**（Azure DevOps）：
  1. https://dev.azure.com/_users/settings/tokens → New Token
  2. Organization: **All accessible organizations**
  3. Scopes: **Marketplace → Manage**（只勾这一个）
  4. 复制 token（一次性显示）
- **Open VSX**（Eclipse）：
  1. https://open-vsx.org/user-settings/tokens → New Access Token
  2. 勾选所有权限，命名例如 `conflict-resolver`
  3. 复制 token

### 2. 注册 GitHub Secrets

在 https://github.com/Cnnnnnn/conflict-resolver/settings/secrets/actions 添加：

| Secret 名    | 值                       |
| ------------ | ------------------------ |
| `VSCE_PAT`   | Azure DevOps PAT        |
| `OVSX_PAT`   | Open VSX access token   |

### 3. 触发发布

- 重新打 tag（推荐）：本地修改 `package.json` 升版本（如 `0.0.10`），然后
  ```bash
  git tag v0.0.10
  git push origin v0.0.10
  ```
- 或用 workflow_dispatch：在 Actions 页选择 `Release` → Run workflow（如果显式留了 workflow_dispatch 触发）。

### 4. 验证

- Marketplace：https://marketplace.visualstudio.com/items?itemName=shienLiang.conflict-resolver
- Open VSX：https://open-vsx.org/extension/shienLiang/conflict-resolver
- 或通过 API：
  ```bash
  curl https://open-vsx.org/api/shienLiang/conflict-resolver/latest | jq .version
  ```

## 本地调试

```bash
nvm use 22
npx @vscode/vsce login shienLiang  # 粘贴 VSCE_PAT
npx @vscode/vsce publish           # 上 Marketplace
npx ovsx publish -p <OVSX_PAT>     # 上 Open VSX
```

`--no-dependencies` 标志已在 CI 工作流中默认开启，本地发布视情况添加。