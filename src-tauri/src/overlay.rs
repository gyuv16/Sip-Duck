//! Transparent overlay window + smart click-through engine.
//!
//! The overlay covers the *work area* of one monitor (so the bottom edge is exactly the top
//! of the taskbar/dock — the characters' walking path). By default the whole window ignores
//! the mouse so the desktop underneath stays fully usable. The frontend publishes the
//! screen-space hit boxes of the characters and toasts; a tiny watcher thread polls the
//! global cursor position and only turns mouse capture on while the cursor is over one of
//! those boxes (or while a drag is in progress). This gives per-pixel-ish interactivity
//! without any OS-specific window-region APIs.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

pub const OVERLAY_LABEL: &str = "overlay";

const POLL_HOVER: Duration = Duration::from_millis(16);
const POLL_IDLE: Duration = Duration::from_millis(50);
const POLL_SUSPENDED: Duration = Duration::from_millis(400);
/// Upper bound on published hit boxes; protects the watcher from a runaway frontend.
const MAX_HITBOXES: usize = 32;

/// Rectangle in *physical* pixels, relative to the overlay window's top-left corner.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct HitRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl HitRect {
    #[inline]
    fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && py >= self.y && px <= self.x + self.w && py <= self.y + self.h
    }

    fn is_valid(&self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.w.is_finite() && self.h.is_finite() && self.w > 0.0 && self.h > 0.0
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayBounds {
    /// Physical top-left of the overlay (virtual desktop coordinates).
    pub x: i32,
    pub y: i32,
    /// Physical size of the overlay (= monitor work area).
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    /// Full monitor rectangle, to know how far the taskbar is below the floor.
    pub monitor_height: u32,
    pub monitor_index: usize,
    pub monitor_count: usize,
    pub monitor_name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

pub struct OverlayState {
    hitboxes: Mutex<Vec<HitRect>>,
    bounds: Mutex<OverlayBounds>,
    /// Frontend is dragging something: keep capturing even if the cursor leaves the box.
    pub capture: AtomicBool,
    /// User forced full click-through (tray / hotkey): characters become non-interactive.
    pub locked: AtomicBool,
    /// Rendering suspended (fullscreen app / user paused): watcher backs off.
    pub suspended: AtomicBool,
    ignoring: AtomicBool,
    hovering: AtomicBool,
}

impl Default for OverlayState {
    fn default() -> Self {
        Self {
            hitboxes: Mutex::new(Vec::with_capacity(8)),
            bounds: Mutex::new(OverlayBounds::default()),
            capture: AtomicBool::new(false),
            locked: AtomicBool::new(false),
            suspended: AtomicBool::new(false),
            ignoring: AtomicBool::new(true),
            hovering: AtomicBool::new(false),
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl OverlayState {
    pub fn set_hitboxes(&self, rects: Vec<HitRect>) {
        let mut boxes = lock(&self.hitboxes);
        boxes.clear();
        boxes.extend(rects.into_iter().filter(HitRect::is_valid).take(MAX_HITBOXES));
    }

    pub fn bounds(&self) -> OverlayBounds {
        lock(&self.bounds).clone()
    }
}

pub fn list_monitors(window: &WebviewWindow) -> tauri::Result<Vec<MonitorInfo>> {
    Ok(window
        .available_monitors()?
        .iter()
        .enumerate()
        .map(|(index, m)| MonitorInfo {
            index,
            name: m.name().cloned().unwrap_or_else(|| format!("Display {}", index + 1)),
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
            scale_factor: m.scale_factor(),
        })
        .collect())
}

/// Applies all overlay flags and stretches the window over the work area of monitor `index`
/// (wrapping around the monitor list). Emits `overlay-bounds` to the frontend.
pub fn configure_window(
    app: &AppHandle,
    window: &WebviewWindow,
    state: &OverlayState,
    index: usize,
) -> tauri::Result<OverlayBounds> {
    let monitors = window.available_monitors()?;
    let primary = window.primary_monitor()?;

    let (idx, monitor) = if monitors.is_empty() {
        (0, primary)
    } else {
        let idx = index % monitors.len();
        (idx, Some(monitors[idx].clone()))
    };

    window.set_decorations(false)?;
    window.set_shadow(false)?;
    window.set_resizable(false)?;
    window.set_always_on_top(true)?;
    window.set_skip_taskbar(true)?;
    window.set_ignore_cursor_events(true)?;
    state.ignoring.store(true, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    window.set_visible_on_all_workspaces(true)?;

    let bounds = match monitor {
        Some(m) => {
            let area = m.work_area();
            window.set_position(PhysicalPosition::new(area.position.x, area.position.y))?;
            window.set_size(PhysicalSize::new(area.size.width, area.size.height))?;
            OverlayBounds {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width,
                height: area.size.height,
                scale_factor: m.scale_factor(),
                monitor_height: m.size().height,
                monitor_index: idx,
                monitor_count: monitors.len().max(1),
                monitor_name: m.name().cloned().unwrap_or_else(|| format!("Display {}", idx + 1)),
            }
        }
        None => {
            // Headless / unknown monitor setup: keep whatever size the window has.
            let pos = window.outer_position()?;
            let size = window.inner_size()?;
            OverlayBounds {
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
                scale_factor: window.scale_factor()?,
                monitor_height: size.height,
                monitor_index: 0,
                monitor_count: 1,
                monitor_name: "Display".into(),
            }
        }
    };

    *lock(&state.bounds) = bounds.clone();
    window.show()?;
    let _ = app.emit("overlay-bounds", &bounds);
    Ok(bounds)
}

/// Force (or release) full click-through. Emits `click-through-changed`.
pub fn set_locked(app: &AppHandle, state: &OverlayState, locked: bool) {
    state.locked.store(locked, Ordering::SeqCst);
    if locked {
        apply_ignore(app, state, true);
    }
    let _ = app.emit("click-through-changed", locked);
}

pub fn set_suspended(app: &AppHandle, state: &OverlayState, suspended: bool) {
    state.suspended.store(suspended, Ordering::SeqCst);
    if suspended {
        state.capture.store(false, Ordering::SeqCst);
        apply_ignore(app, state, true);
    }
}

fn apply_ignore(app: &AppHandle, state: &OverlayState, ignore: bool) {
    if state.ignoring.load(Ordering::SeqCst) == ignore {
        return;
    }
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        if window.set_ignore_cursor_events(ignore).is_ok() {
            state.ignoring.store(ignore, Ordering::SeqCst);
        }
    }
}

/// Spawns the cursor watcher. Cost: one `cursor_position` query + a handful of rectangle
/// tests every 50 ms (16 ms while hovering for responsive drag pick-up).
pub fn spawn_cursor_watcher(app: AppHandle, state: Arc<OverlayState>) {
    let spawned = thread::Builder::new()
        .name("overlay-cursor".into())
        .stack_size(64 * 1024)
        .spawn(move || loop {
            if state.suspended.load(Ordering::Relaxed) {
                thread::sleep(POLL_SUSPENDED);
                continue;
            }

            let capture = state.capture.load(Ordering::Relaxed);
            let locked = state.locked.load(Ordering::Relaxed);

            let hovering = match app.cursor_position() {
                Ok(cursor) => {
                    let (ox, oy) = {
                        let b = lock(&state.bounds);
                        (f64::from(b.x), f64::from(b.y))
                    };
                    let (lx, ly) = (cursor.x - ox, cursor.y - oy);
                    lock(&state.hitboxes).iter().any(|r| r.contains(lx, ly))
                }
                // e.g. Wayland: cursor position unavailable -> only explicit captures enable input.
                Err(_) => false,
            };

            let want_ignore = locked || !(hovering || capture);
            apply_ignore(&app, &state, want_ignore);

            let effective_hover = hovering && !locked;
            if state.hovering.swap(effective_hover, Ordering::Relaxed) != effective_hover {
                let _ = app.emit("hover-changed", effective_hover);
            }

            thread::sleep(if effective_hover || capture { POLL_HOVER } else { POLL_IDLE });
        });
    if let Err(err) = spawned {
        eprintln!("[sip-duck] failed to start cursor watcher: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hit_rect_contains_and_validation() {
        let r = HitRect { x: 10.0, y: 10.0, w: 20.0, h: 30.0 };
        assert!(r.contains(10.0, 10.0));
        assert!(r.contains(30.0, 40.0));
        assert!(!r.contains(31.0, 20.0));
        assert!(!HitRect { x: 0.0, y: 0.0, w: 0.0, h: 5.0 }.is_valid());
        assert!(!HitRect { x: f64::NAN, y: 0.0, w: 1.0, h: 1.0 }.is_valid());
    }

    #[test]
    fn hitboxes_are_filtered_and_capped() {
        let s = OverlayState::default();
        let mut rects = vec![HitRect { x: 0.0, y: 0.0, w: -1.0, h: 1.0 }];
        rects.extend((0..100).map(|i| HitRect { x: i as f64, y: 0.0, w: 1.0, h: 1.0 }));
        s.set_hitboxes(rects);
        assert_eq!(lock(&s.hitboxes).len(), MAX_HITBOXES);
    }
}
