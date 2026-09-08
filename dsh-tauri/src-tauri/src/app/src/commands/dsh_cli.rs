//! dsh CLI shim（终端执行 `dsh` 命令 → 内核 CLI → 插件/skill 安装链）。
//!
//! 安装根写入 `dsh.cmd`（Windows）/`dsh`（unix，本轮仅 Windows 接线）：
//!   @echo off
//!   "<安装根>\dsh-desktop\vendor\node\node.exe" "<安装根>\node_modules\@deepseek-ai\dsh\lib\bin.js" %*
//! 并把安装根幂等追加到**用户 PATH**（HKCU\Environment，PowerShell 走
//! DoNotExpandEnvironmentNames 读原文 + ExpandString 写回——保留用户 PATH 中
//! 未展开的 %VAR% 形态）。失败静默（日志告警，不阻断启动）：CLI 暴露是增强面。
//!
//! 幂等：shim 内容一致不重写；PATH 已含安装根（当前进程 PATH 继承自启动
//! 环境，重启后的追加对下次启动可见）不重复追加。
//!
//! 范围：仅 Windows 接线（issue #180 的用户群与 dsh-files/终端链均在
//! Windows）；非 Windows 直接返回。

use std::path::PathBuf;

/// exe 所在目录（安装根）。便携版/NSIS currentUser/开发态各自成立；
/// 开发态（debug）直接跳过，避免污染开发机 PATH。
fn install_root() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        return None;
    }
    #[allow(unreachable_code)]
    {
        std::env::current_exe().ok()?.parent().map(|p| p.to_path_buf())
    }
}

fn shim_content(node_exe: &std::path::Path, bin_js: &std::path::Path) -> String {
    if cfg!(windows) {
        format!("@echo off\r\n\"{}\" \"{}\" %*\r\n", node_exe.display(), bin_js.display())
    } else {
        format!("#!/bin/sh\nexec \"{}\" \"{}\" \"$@\"\n", node_exe.display(), bin_js.display())
    }
}

/// 幂等追加用户 PATH（仅 Windows；unix 无注册表，交由用户手动 export）。
#[cfg(windows)]
fn append_user_path(dir: &std::path::Path) -> Result<(), String> {
    let dir_str = dir.to_string_lossy().to_string();
    // 当前进程 PATH 已含 → 用户 PATH 已含（进程继承自启动环境）或更上层已配。
    let in_proc_path = std::env::var("PATH")
        .map(|p| p.split(';').any(|seg| seg.eq_ignore_ascii_case(&dir_str)))
        .unwrap_or(false);
    if in_proc_path {
        return Ok(());
    }
    let script = format!(
        "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true); \
         $cur=[string]$k.GetValue('Path','','DoNotExpandEnvironmentNames'); \
         if (($cur -split ';') -notcontains '{dir}') {{ \
           $k.SetValue('Path', ($cur.TrimEnd(';') + ';' + '{dir}'), [Microsoft.Win32.RegistryValueKind]::ExpandString) \
         }}",
        dir = dir_str
    );
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .output()
        .map_err(|e| format!("spawn powershell: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "powershell exit {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).chars().take(200).collect::<String>()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn append_user_path(_dir: &std::path::Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// shim 内容形态：vendored node/bin 路径带引号、%* 透传参数、首行 @echo off。
    #[test]
    fn shim_content_shape() {
        let c = shim_content(
            std::path::Path::new("C:\\app\\dsh-desktop\\vendor\\node\\node.exe"),
            std::path::Path::new("C:\\app\\dsh-desktop\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"),
        );
        assert!(c.starts_with("@echo off"), "首行 @echo off");
        assert!(c.contains("\\vendor\\node\\node.exe"), "必须用 vendored node（免系统环境）");
        assert!(c.contains("@deepseek-ai\\dsh\\lib\\bin.js"), "必须指向内核 bin.js");
        assert!(c.trim_end().ends_with("%*"), "参数必须透传");
        assert_eq!(c.matches('"').count() % 2, 0, "引号必须成对");
    }
}
/// 入口：写 shim（内容变化才写）+ PATH 幂等追加。任何失败仅日志告警。
pub fn ensure_dsh_cli_shim() {
    let result = (|| -> Result<(), String> {
        let root = install_root().ok_or_else(|| "无法定位安装根（current_exe）".to_string())?;
        let app_dir = root.join("dsh-desktop");
        let node = app_dir.join("vendor").join("node").join(if cfg!(windows) { "node.exe" } else { "node" });
        let bin_js = app_dir
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js");
        if !node.exists() || !bin_js.exists() {
            return Err(format!("内核/node 不在位（{} / {}），跳过 shim", node.display(), bin_js.display()));
        }
        let shim_name = if cfg!(windows) { "dsh.cmd" } else { "dsh" };
        let shim = root.join(shim_name);
        let content = shim_content(&node, &bin_js);
        let need_write = std::fs::read_to_string(&shim).map(|c| c != content).unwrap_or(true);
        if need_write {
            std::fs::write(&shim, content).map_err(|e| format!("写 shim 失败: {e}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755));
            }
        }
        append_user_path(&root)
    })();
    match result {
        Ok(()) => crate::supervisor::file_log("[dsh-cli] shim/PATH 自检通过"),
        Err(e) => crate::supervisor::file_log(&format!("[dsh-cli] shim/PATH 自检失败（不影响启动）: {e}")),
    }
}
