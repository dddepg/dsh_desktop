# router-jspace 整合预设安装脚本（Windows PowerShell）
# 不硬编码用户路径：优先 $env:DSH_HOME，否则使用当前用户 home 下的 .dsh。
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$presetTarget = Join-Path $dshHome '.agent-presets\router-jspace'
$jspaceTarget = Join-Path $dshHome 'skills\j-space'
$weNeedTarget = Join-Path $dshHome 'skills\oh-we-need'

Write-Host "=== 校验整合包 ===" -ForegroundColor Cyan
if (-not (Test-Path (Join-Path $root 'router-jspace.mjs'))) {
  throw "找不到 $root\router-jspace.mjs，请从整合包根目录运行"
}

Write-Host "=== 安装 preset: $presetTarget ===" -ForegroundColor Cyan
if (Test-Path $presetTarget) {
  Write-Host "目标已存在，先备份到 $presetTarget.bak-$([DateTimeOffset]::Now.ToUnixTimeSeconds())" -ForegroundColor Yellow
  Move-Item -Force $presetTarget "$presetTarget.bak-$([DateTimeOffset]::Now.ToUnixTimeSeconds())"
}
New-Item -ItemType Directory -Force -Path (Split-Path $presetTarget) | Out-Null
Copy-Item -Recurse -Force $root $presetTarget

Write-Host "=== 安装 j-space skill ===" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Split-Path $jspaceTarget) | Out-Null
if (-not (Test-Path $jspaceTarget)) {
  Copy-Item -Recurse -Force (Join-Path $root 'skills\j-space') $jspaceTarget
} else {
  Write-Host "已存在，跳过: $jspaceTarget" -ForegroundColor Yellow
}

Write-Host "=== 安装 oh-we-need skill ===" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Split-Path $weNeedTarget) | Out-Null
if (-not (Test-Path $weNeedTarget)) {
  Copy-Item -Recurse -Force (Join-Path $root 'skills\oh-we-need') $weNeedTarget
} else {
  Write-Host "已存在，跳过: $weNeedTarget" -ForegroundColor Yellow
}

Write-Host "=== 完成 ===" -ForegroundColor Green
Write-Host "1. 重启 DSH（web 服务）"
Write-Host "2. GUI 新建会话 → 选择 Router J-Space (experimental)"
Write-Host "3. 首次请求会自动分类 build/fix/weak，并选择 J-Space fast/full/loop 与模块"
Write-Host "4. 可使用 dev_router_status / dev_router_mode / cog_ledger 查看和调优"
