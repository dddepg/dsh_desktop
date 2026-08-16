# 内置 Agent 预设清单（Bundled Agent Presets）

所有预设存放在 `assets/agent-presets/<id>/`，由 `scripts/install-minimal-win-preset.js`
在 `npm start`（开发）与 `afterPack`（打包）时复制进内置 dsh 的
`config/agent-presets/`。WSL 托管模式启动/更新时会经 UNC 调用同一安装逻辑写入
WSL 内的 dsh 包；`scripts/sync-companion-plugins.js` 也会为 WSL / Linux 里另装的
dsh 同步这批预设（自动探测 `DSH_HOME/agent` 与 PATH 上的 dsh 命令，或 `--dsh-package`
指定包目录）。
目录名即 preset id（`[a-z0-9-]+`），显示名与描述在各目录的 `preset.yml` 中。

## 预设与上游来源

| id | 显示名 | 上游仓库 | 许可证 | 说明 |
|---|---|---|---|---|
| `anchored-standard` | 官pro | [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) | MIT | 官方 API pro 方案：两阶段锚定 |
| `v4-flash-godmode-opencode-go` | goflash | [SheberDavid/v4-flash-godmode-opencode-go](https://github.com/SheberDavid/v4-flash-godmode-opencode-go) | ⚠️ 仓库无 LICENSE 文件（见下方注意） | opencode-go flash：build/fix 内路由 |
| `router-standard` | router-standard | [yjh051108/dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite)（preset 子模块 [yjh051108/dsh-router-standard](https://github.com/yjh051108/dsh-router-standard)） | MIT | 官方 API flash 方案：任务感知路由 |
| `router-jspace` | Router J-Space (experimental) | [DreamRift/dsh-router-jspace](https://github.com/DreamRift/dsh-router-jspace) | MIT（上游组件 Apache-2.0 / MIT / BSD-3-Clause，见目录内 NOTICE.md） | 路由套件外部路由 + J-Space fast/full/loop 认知协议 + oh-we-need V4 思考风格；自带 `j-space` / `oh-we-need` 两个 skill |

## 同步与更新

- 上游有更新时，把对应 `preset/` 目录（含 `agent.cordis.yml`、`preset.yml` 与
  引用的 `.mjs`/`.json`，以及 `skills/`、`scripts/` 等子目录）覆盖到
  `assets/agent-presets/<id>/`，并同步 LICENSE/NOTICE。
- 预设目录整树复制进 dsh 包；若预设自带 `skills/<name>` 子目录，安装脚本会
  一并随装到 `$DSH_HOME/skills/<name>`（已存在的同名 skill 不覆盖，与上游
  install.ps1 语义一致）。skill 由 `dsh-skill-filesystem` 从 `$DSH_HOME/skills`
  发现，无需额外配置。
- 更新后运行 `node scripts/install-minimal-win-preset.js` 验证能安装进 dsh 包。
- 禁止修改 `agent.cordis.yml` 中引用的相对文件路径，除非同步调整文件名。

## 许可注意

- `router-standard` 与 `anchored-standard` 上游均为 MIT，LICENSE/NOTICE 已随
  每个预设目录分发。
- `v4-flash-godmode-opencode-go` 上游**未提供 LICENSE 文件**：源码内置是应项目
  要求执行；对外分发前请与作者确认许可，或移除该预设。
