//! Low-level user-activity + screen-time tracker.
//!
//! One background thread wakes once per second, asks the OS how long ago the last
//! keyboard/mouse input happened (`GetLastInputInfo` on Windows,
//! `CGEventSourceSecondsSinceLastEventType` on macOS) and derives:
//!
//! * the continuous "sitting" streak (reset after `BREAK_RESET_SECS` of inactivity),
//! * total screen-on time for the current day,
//! * whether the user is away (drives the companion's sleep state / 0 FPS),
//! * whether a fullscreen app (game / video) is in the foreground (drives render suspension).
//!
//! The thread never allocates in steady state and only emits IPC events when something
//! changed or on a slow 5 s heartbeat, keeping idle CPU well below 0.1 %.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Inactivity that counts as "got up from the desk" and resets the sitting streak.
pub const BREAK_RESET_SECS: u64 = 180;
/// Inactivity after which the user is considered away (companion falls asleep).
pub const AWAY_SECS: u64 = 300;
/// After an un-acknowledged sedentary alert, nag again after this many seconds.
pub const ALERT_REPEAT_SECS: u64 = 600;
/// Periodic `activity` event cadence in ticks (1 tick = 1 s).
const HEARTBEAT_TICKS: u32 = 5;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySnapshot {
    pub idle_secs: u64,
    pub active_streak_secs: u64,
    pub screen_secs_today: u64,
    pub sedentary_threshold_secs: u64,
    pub next_alert_in_secs: u64,
    pub fullscreen: bool,
    pub user_away: bool,
    pub idle_supported: bool,
}

struct Inner {
    streak_start: Option<Instant>,
    next_alert_at: u64,
    screen_secs_today: u64,
    day: u64,
    last_idle: u64,
    fullscreen: bool,
    away: bool,
}

pub struct Tracker {
    inner: Mutex<Inner>,
    threshold_secs: AtomicU64,
}

struct TickOutcome {
    snapshot: ActivitySnapshot,
    alert: bool,
    fullscreen_changed: bool,
    away_changed: bool,
}

fn utc_day() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0)
}

impl Tracker {
    pub fn new(threshold_secs: u64) -> Self {
        Self {
            inner: Mutex::new(Inner {
                streak_start: Some(Instant::now()),
                next_alert_at: threshold_secs,
                screen_secs_today: 0,
                day: utc_day(),
                last_idle: 0,
                fullscreen: false,
                away: false,
            }),
            threshold_secs: AtomicU64::new(threshold_secs.max(60)),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A poisoned lock only means another thread panicked mid-update; the data is
        // plain counters, so recovering it is always safe.
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn build_snapshot(&self, inner: &Inner) -> ActivitySnapshot {
        let streak = inner.streak_start.map(|s| s.elapsed().as_secs()).unwrap_or(0);
        ActivitySnapshot {
            idle_secs: inner.last_idle,
            active_streak_secs: streak,
            screen_secs_today: inner.screen_secs_today,
            sedentary_threshold_secs: self.threshold_secs.load(Ordering::Relaxed),
            next_alert_in_secs: inner.next_alert_at.saturating_sub(streak),
            fullscreen: inner.fullscreen,
            user_away: inner.away,
            idle_supported: IDLE_SUPPORTED,
        }
    }

    pub fn snapshot(&self) -> ActivitySnapshot {
        let inner = self.lock();
        self.build_snapshot(&inner)
    }

    /// The user confirmed they took a break: restart the streak from now.
    pub fn acknowledge_break(&self) {
        let mut inner = self.lock();
        inner.streak_start = Some(Instant::now());
        inner.next_alert_at = self.threshold_secs.load(Ordering::Relaxed);
    }

    /// Postpone the next sedentary alert by `minutes` from the current streak position.
    pub fn snooze(&self, minutes: u64) {
        let mut inner = self.lock();
        let streak = inner.streak_start.map(|s| s.elapsed().as_secs()).unwrap_or(0);
        inner.next_alert_at = streak + minutes.clamp(1, 240) * 60;
    }

    pub fn set_threshold(&self, secs: u64) {
        let secs = secs.clamp(60, 4 * 3600);
        self.threshold_secs.store(secs, Ordering::Relaxed);
        let mut inner = self.lock();
        let streak = inner.streak_start.map(|s| s.elapsed().as_secs()).unwrap_or(0);
        inner.next_alert_at = secs.max(streak + 60);
    }

    fn tick(&self, idle: Option<u64>, fullscreen: bool) -> TickOutcome {
        let threshold = self.threshold_secs.load(Ordering::Relaxed);
        let mut inner = self.lock();

        let today = utc_day();
        if today != inner.day {
            inner.day = today;
            inner.screen_secs_today = 0;
        }

        // Platforms without an idle API report "always active" so reminders still work.
        let idle = idle.unwrap_or(0);
        inner.last_idle = idle;

        if idle >= BREAK_RESET_SECS {
            inner.streak_start = None;
            inner.next_alert_at = threshold;
        } else if inner.streak_start.is_none() {
            inner.streak_start = Some(Instant::now() - Duration::from_secs(idle));
        }
        if idle < AWAY_SECS {
            inner.screen_secs_today += 1;
        }

        let away = idle >= AWAY_SECS;
        let away_changed = away != inner.away;
        inner.away = away;

        let fullscreen_changed = fullscreen != inner.fullscreen;
        inner.fullscreen = fullscreen;

        let streak = inner.streak_start.map(|s| s.elapsed().as_secs()).unwrap_or(0);
        // Never interrupt a fullscreen game/video; the alert fires once it is closed.
        let alert = !fullscreen && inner.streak_start.is_some() && streak >= inner.next_alert_at;
        if alert {
            inner.next_alert_at = streak + ALERT_REPEAT_SECS;
        }

        TickOutcome {
            snapshot: self.build_snapshot(&inner),
            alert,
            fullscreen_changed,
            away_changed,
        }
    }
}

/// Starts the 1 Hz tracker thread. `on_fullscreen` runs whenever the foreground
/// fullscreen state flips (used to hide the overlay and suspend rendering).
pub fn spawn<F>(app: AppHandle, tracker: Arc<Tracker>, on_fullscreen: F)
where
    F: Fn(&AppHandle, bool) + Send + 'static,
{
    let spawned = thread::Builder::new()
        .name("activity-tracker".into())
        .stack_size(64 * 1024)
        .spawn(move || {
            let mut ticks: u32 = 0;
            loop {
                thread::sleep(Duration::from_secs(1));
                let outcome = tracker.tick(idle_seconds(), foreground_fullscreen());
                ticks = ticks.wrapping_add(1);

                if outcome.fullscreen_changed {
                    on_fullscreen(&app, outcome.snapshot.fullscreen);
                }
                if outcome.alert {
                    let _ = app.emit("sedentary-alert", &outcome.snapshot);
                }
                if outcome.away_changed || outcome.fullscreen_changed || ticks % HEARTBEAT_TICKS == 0 {
                    let _ = app.emit("activity", &outcome.snapshot);
                }
            }
        });
    if let Err(err) = spawned {
        eprintln!("[sip-duck] failed to start activity tracker: {err}");
    }
}

// ---------------------------------------------------------------------------------------------
// Platform: Windows
// ---------------------------------------------------------------------------------------------

#[cfg(target_os = "windows")]
const IDLE_SUPPORTED: bool = true;

#[cfg(target_os = "windows")]
pub fn idle_seconds() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: `info` is a valid, correctly sized LASTINPUTINFO living on our stack.
    let ok = unsafe { GetLastInputInfo(&mut info) };
    if ok == 0 {
        return None;
    }
    // SAFETY: GetTickCount has no preconditions. Both values are u32 ms counters that wrap
    // every ~49.7 days, so wrapping_sub yields the correct elapsed time across the wrap.
    let now = unsafe { GetTickCount() };
    Some(u64::from(now.wrapping_sub(info.dwTime)) / 1000)
}

#[cfg(target_os = "windows")]
pub fn foreground_fullscreen() -> bool {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetDesktopWindow, GetForegroundWindow, GetShellWindow, GetWindowRect,
        GetWindowThreadProcessId,
    };

    // SAFETY: every call below only reads window/monitor metadata through handles returned
    // by the OS in the same expression, and all out-params point at stack locals.
    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_null() || fg == GetDesktopWindow() || fg == GetShellWindow() {
            return false;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(fg, &mut pid);
        if pid == std::process::id() {
            return false;
        }
        let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        if GetWindowRect(fg, &mut rect) == 0 {
            return false;
        }
        let monitor = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
        if monitor.is_null() {
            return false;
        }
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return false;
        }
        let m = info.rcMonitor;
        rect.left <= m.left && rect.top <= m.top && rect.right >= m.right && rect.bottom >= m.bottom
    }
}

// ---------------------------------------------------------------------------------------------
// Platform: macOS
// ---------------------------------------------------------------------------------------------

#[cfg(target_os = "macos")]
const IDLE_SUPPORTED: bool = true;

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
}

#[cfg(target_os = "macos")]
pub fn idle_seconds() -> Option<u64> {
    const COMBINED_SESSION_STATE: i32 = 0; // kCGEventSourceStateCombinedSessionState
    const ANY_INPUT_EVENT: u32 = u32::MAX; // kCGAnyInputEventType
    // SAFETY: pure query function with plain-value arguments and no side effects.
    let secs = unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT) };
    if secs.is_finite() && secs >= 0.0 {
        Some(secs as u64)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
pub fn foreground_fullscreen() -> bool {
    // macOS fullscreen apps live in their own Space; the overlay is not shown there unless
    // it is explicitly joined to all Spaces, and the webview is then occluded and throttled
    // by WebKit automatically, so no extra suspension is needed.
    false
}

// ---------------------------------------------------------------------------------------------
// Platform: other (Linux/BSD) — no portable idle API without extra X11/Wayland deps.
// ---------------------------------------------------------------------------------------------

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const IDLE_SUPPORTED: bool = false;

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn idle_seconds() -> Option<u64> {
    None
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn foreground_fullscreen() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streak_resets_after_break_and_alerts_after_threshold() {
        let t = Tracker::new(60);
        // Simulate 3 minutes away -> streak cleared.
        let out = t.tick(Some(BREAK_RESET_SECS), false);
        assert_eq!(out.snapshot.active_streak_secs, 0);
        assert!(!out.alert);

        // Back at the desk: force the streak start into the past to cross the threshold.
        t.tick(Some(0), false);
        t.lock().streak_start = Some(Instant::now() - Duration::from_secs(61));
        let out = t.tick(Some(0), false);
        assert!(out.alert);
        // Second tick must not re-alert until ALERT_REPEAT_SECS passes.
        assert!(!t.tick(Some(0), false).alert);
    }

    #[test]
    fn fullscreen_defers_alert() {
        let t = Tracker::new(60);
        t.lock().streak_start = Some(Instant::now() - Duration::from_secs(120));
        let out = t.tick(Some(0), true);
        assert!(!out.alert);
        assert!(out.fullscreen_changed);
        assert!(t.tick(Some(0), false).alert);
    }

    #[test]
    fn snooze_moves_next_alert() {
        let t = Tracker::new(60);
        t.snooze(10);
        assert!(t.snapshot().next_alert_in_secs >= 599);
    }
}
