# Router J-Space (experimental)

整合 `dsh-routing-suite` 的外部路由、`J-Space Cognition Suite` 的认知协议、`oh-we-need` 的 DeepSeek V4 思维风格。

## 安装

```powershell
.\scripts\install.ps1
```

安装后重启 DSH，新会话选择 `Router J-Space (experimental)`。

## 工具

- `dev_router_status`：查看 mode/band/J-Space pass/modules/ledger。
- `dev_router_mode`：临时切换 spec/weak/mixed/react 或数值模式。
- `dev_mode_subagent`：在独立上下文里用另一种模式跑子任务。
- `cog_ledger`：维护 J-Space 账本，支持 `update / read / ship / clear`。

## 目录

- `router-jspace.mjs`：DSH agent-preset 插件入口。
- `router-core.mjs`：路由与协议纯逻辑。
- `skills/j-space`：J-Space 原 Skill。
- `skills/oh-we-need`：oh-we-need Skill。

## 测试

```sh
node --test ../../tests/router-core.test.mjs
```
