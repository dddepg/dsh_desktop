//! 单实例锁。
//!
//! Phase 0：锁文件实现（`app_data/single-instance.lock`，创建即持锁，进程退出
//! 由 Drop 删除）。语义与 Electron 版 `app.requestSingleInstanceLock()` 对齐：
//! 第二实例拿锁失败 → 激活已有窗口后退出。
//!
//! 生命周期语义（Review#2 实测定稿）：`AppHandle::exit(0)` 走 `std::process::exit`，
//! Drop 与 Exit 事件均不保证执行——**锁文件在任何退出路径下都可能残留**，这是
//! 设计内状态而非缺陷：下次启动经陈锁回收（pid 已死 → 删除重建）正常拿锁
//! （强弱杀两路径实测）。Phase 1 若换 `CreateMutexW` 则由 OS 自动回收，此歧义消失。

use std::fs;
use std::path::PathBuf;

/// 持锁守卫；Drop 时释放（删除锁文件）。
#[derive(Debug)]
pub struct SingleInstanceGuard {
    path: PathBuf,
    released: bool,
}

impl SingleInstanceGuard {
    /// 尝试以独占方式创建锁文件。
    /// - `Ok(guard)`：拿到单实例权
    /// - `Err(())`：已有实例在跑，**或锁文件为强杀残留**——残留判定：读文件内
    ///   pid，进程已不存在则视为陈锁，删除后重试一次（Windows 命名互斥体在
    ///   Phase 1 换上后此歧义彻底消失；锁文件实现保留为兜底与测试基线）。
    ///
    /// `Err(())`（而非自定义错误类型）是刻意的最小信号面：失败原因是二元的
    /// （拿到/没拿到），消费方（装配根 lib.rs）只做 `is_err` 分支——改签名属
    /// 跨 crate 破坏性变更，不值得。
    #[allow(clippy::result_unit_err)]
    pub fn acquire(path: impl Into<PathBuf>) -> Result<Self, ()> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                use std::io::Write;
                let _ = writeln!(f, "{}", std::process::id());
                Ok(Self { path, released: false })
            }
            Err(_) => {
                // 陈锁回收前的收敛窗口：`create_new` 成功到写 PID 之间存在微秒级
                // 空文件窗口，并发第二实例若此刻把空文件当「内容不可读」的陈锁
                // 回收，就会双持有者（ta15 八进程并发 CI 实测 denied<7 的根因）。
                // 先给空文件一个短暂填 PID 的机会，再按陈锁判定——既不误杀活锁，
                // 也不放过真陈锁（崩溃残留空文件 50ms 后仍空 → 照常回收）。
                for _ in 0..5 {
                    match fs::metadata(&path) {
                        Ok(m) if m.len() > 0 => break,
                        _ => std::thread::sleep(std::time::Duration::from_millis(10)),
                    }
                }
                if stale_lock(&path) {
                    let _ = fs::remove_file(&path);
                    return Self::acquire(&path);
                }
                Err(())
            }
        }
    }

    /// 显式释放（幂等）。
    pub fn release(&mut self) {
        if !self.released {
            self.released = true;
            let _ = fs::remove_file(&self.path);
        }
    }
}

impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        self.release();
    }
}

/// 第二实例 → 首实例的「唤起主窗」请求（`app_data/focus-request`，内容
/// `<pid> <unix_millis>`）。
///
/// 与 tauri-plugin-single-instance 的管道回调互补：首实例尚在启动、管道
/// 监听未就位（或管道失败）的窗口期里，第二实例会落到本壳文件锁的失败
/// 路径——旧路径直接 panic（v0.6.2 用户实爆：三次二次启动全在 panics.log
/// 留下「Failed to setup app: DSH Desktop 已在运行」，用户双击无任何可见
/// 反馈）。新路径：第二实例写本请求文件后 exit(0)，首实例轮询发现即
/// show/unminimize/set_focus 主窗并删除文件（millis 去重防重复唤起）。
pub fn write_focus_request(app_data: &std::path::Path) -> std::io::Result<()> {
    let path = app_data.join("focus-request");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    std::fs::write(&path, format!("{} {}", std::process::id(), millis))
}

/// 读请求文件 → `(pid, unix_millis)`。不存在/内容不可解析 → None
///（不可解析也返回 None： watcher 靠 millis 变化触发，垃圾内容无从去重）。
pub fn read_focus_request(app_data: &std::path::Path) -> Option<(u32, u128)> {
    let raw = std::fs::read_to_string(app_data.join("focus-request")).ok()?;
    let mut it = raw.split_whitespace();
    let pid = it.next()?.parse::<u32>().ok()?;
    let millis = it.next().and_then(|m| m.parse::<u128>().ok()).unwrap_or(0);
    Some((pid, millis))
}

/// 消费后删除请求文件（幂等；删除失败无害——watcher 有 millis 去重兜底）。
pub fn clear_focus_request(app_data: &std::path::Path) {
    let _ = std::fs::remove_file(app_data.join("focus-request"));
}

/// 陈锁判定：文件内 pid 不再存活（或内容不可读/非法——按陈锁处理，
/// 宁可误删锁也不把用户锁死在「永远已在运行」）。
fn stale_lock(path: &std::path::Path) -> bool {
    let Ok(raw) = fs::read_to_string(path) else { return true };
    let Ok(pid) = raw.trim().parse::<u32>() else { return true };
    !pid_alive(pid)
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    // tasklist 过滤 PID（无 wmic 依赖的现代 Windows 兜底）。
    // CREATE_NO_WINDOW：GUI 进程起 console 程序必须抑制终端窗（陈锁回收
    // 在启动路径触发，无旗则闪终端——0.5.0 修复）。
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}")])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(true) // 查询失败按存活处理（保守：不删活锁）
    }
}

/// macOS 无 /proc：`ps -p <pid>` 探测（退出码 0 = 存在）。查询失败按存活
/// （保守，与 Windows 分支同口径）——此前非 Windows 一律查 /proc，mac 上
/// 恒 false → 活锁被当陈锁回收，单实例失效（双实例并发）。
#[cfg(target_os = "macos")]
fn pid_alive(pid: u32) -> bool {
    match std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "pid="])
        .output()
    {
        Ok(o) => o.status.success(),
        Err(_) => true, // 查询失败按存活处理（保守：不删活锁）
    }
}

/// Linux：/proc/<pid> 存在性（零子进程开销）。
#[cfg(all(unix, not(target_os = "macos")))]
fn pid_alive(pid: u32) -> bool {
    std::path::Path::new("/proc").join(pid.to_string()).exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_acquire_fails_and_release_allows_again() {
        let mut p = std::env::temp_dir();
        p.push(format!("dsh-single-inst-{}.lock", std::process::id()));
        let _ = fs::remove_file(&p);

        let mut first = SingleInstanceGuard::acquire(&p).expect("首个实例应拿到锁");
        assert!(SingleInstanceGuard::acquire(&p).is_err(), "第二实例必须失败");

        first.release();
        drop(first);
        assert!(SingleInstanceGuard::acquire(&p).is_ok(), "释放后可重新获取");
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn stale_lock_from_dead_pid_is_reclaimed() {
        let mut p = std::env::temp_dir();
        p.push(format!("dsh-single-inst-stale-{}.lock", std::process::id()));
        let _ = fs::remove_file(&p);
        // 写一个几乎不可能存活的 pid（Windows 冷启动 pid 区间之外的大值）。
        fs::write(&p, "3999999").unwrap();
        let mut g = SingleInstanceGuard::acquire(&p).expect("陈锁应被回收");
        g.release();
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn live_pid_lock_not_reclaimed() {
        let mut p = std::env::temp_dir();
        p.push(format!("dsh-single-inst-live-{}.lock", std::process::id()));
        let _ = fs::remove_file(&p);
        fs::write(&p, std::process::id().to_string()).unwrap();
        assert!(SingleInstanceGuard::acquire(&p).is_err(), "活进程的锁不得回收");
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn focus_request_roundtrip_and_clear() {
        let dir = std::env::temp_dir().join(format!("dsh-focus-req-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        write_focus_request(&dir).expect("写唤起请求");
        let (pid, m1) = read_focus_request(&dir).expect("读回唤起请求");
        assert_eq!(pid, std::process::id());
        assert!(m1 > 0, "unix millis 非零");
        clear_focus_request(&dir);
        assert_eq!(read_focus_request(&dir), None, "消费后应读到 None");
        // 两次写入 millis 不同 → watcher 可靠变化去重。
        std::thread::sleep(std::time::Duration::from_millis(2));
        write_focus_request(&dir).unwrap();
        let (_, m2) = read_focus_request(&dir).unwrap();
        assert!(m2 > m1, "millis 单调（去重锚）: {m1} -> {m2}");
        clear_focus_request(&dir);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn focus_request_garbage_is_none() {
        let dir = std::env::temp_dir().join(format!("dsh-focus-garbage-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("focus-request"), "not a request").unwrap();
        assert_eq!(read_focus_request(&dir), None, "垃圾内容不触发唤起");
        let _ = fs::remove_dir_all(&dir);
    }
}
