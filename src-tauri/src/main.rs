//! Sip Duck — Tauri v2 entry point.
//!
//! Responsibilities:
//! * create/configure the transparent overlay (see `overlay.rs`),
//! * start the native activity tracker (see `system_hook.rs`),
//! * native system tray (scene modes, click-through, pause, monitor switching),
//! * global hotkeys,
//! * the IPC bridge: small typed commands in, small JSON events out.
//!
//! Events emitted to the frontend:
//! `activity`, `sedentary-alert`, `overlay-bounds`, `hover-changed`, `click-through-changed`,
//! `suspend`, `scene-mode`, `tray-action`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod overlay;
mod system_hook;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, Wry};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use overlay::{HitRect, MonitorInfo, OverlayBounds, OverlayState, OVERLAY_LABEL};
use system_hook::{ActivitySnapshot, Tracker};

const DEFAULT_SEDENTARY_SECS: u64 = 45 * 60;

const SCENE_MODES: [(&str, &str); 4] = [
    ("solo", "Solo Human"),
    ("pet", "Human + Pet"),
    ("couple", "Couple"),
    ("couple_pet", "Couple + Pet"),
];

/// Handles to stateful tray items so commands/hotkeys can keep the checkmarks in sync.
struct TrayHandles {
    scene_items: Vec<(&'static str, CheckMenuItem<Wry>)>,
    click_through: CheckMenuItem<Wry>,
    paused: CheckMenuItem<Wry>,
}

/// User-level pause (independent of automatic fullscreen suspension).
#[derive(Default)]
struct PauseState {
    user_paused: Mutex<bool>,
    fullscreen: Mutex<bool>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SuspendPayload {
    suspended: bool,
    reason: &'static str,
}

fn sync_scene_checks(tray: &TrayHandles, mode: &str) {
    for (id, item) in &tray.scene_items {
        let _ = item.set_checked(*id == mode);
    }
}

/// Recomputes the effective suspension from user pause + fullscreen detection and
/// applies it to the window, the cursor watcher and the renderer.
fn apply_suspension(app: &AppHandle) {
    let pause = app.state::<PauseState>();
    let user = *pause.user_paused.lock().unwrap_or_else(|p| p.into_inner());
    let fullscreen = *pause.fullscreen.lock().unwrap_or_else(|p| p.into_inner());
    let suspended = user || fullscreen;

    let overlay_state = app.state::<Arc<OverlayState>>();
    overlay::set_suspended(app, &overlay_state, suspended);

    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        // A hidden webview gets its rAF loop and timers throttled by the OS webview,
        // which is the cheapest possible "suspend" for the WebGL context.
        let _ = if suspended { window.hide() } else { window.show() };
    }
    let reason = if user { "paused" } else if fullscreen { "fullscreen" } else { "resumed" };
    let _ = app.emit("suspend", SuspendPayload { suspended, reason });
}

fn set_user_paused(app: &AppHandle, paused: bool) {
    *app.state::<PauseState>().user_paused.lock().unwrap_or_else(|p| p.into_inner()) = paused;
    let _ = app.state::<TrayHandles>().paused.set_checked(paused);
    apply_suspension(app);
}

fn toggle_click_through(app: &AppHandle) {
    let state = app.state::<Arc<OverlayState>>();
    let locked = !state.locked.load(Ordering::SeqCst);
    overlay::set_locked(app, &state, locked);
    let _ = app.state::<TrayHandles>().click_through.set_checked(locked);
}

fn next_monitor(app: &AppHandle) {
    let state = app.state::<Arc<OverlayState>>();
    let next = state.bounds().monitor_index + 1;
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        if let Err(err) = overlay::configure_window(app, &window, &state, next) {
            eprintln!("[sip-duck] monitor switch failed: {err}");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// IPC commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
fn set_hitboxes(state: State<'_, Arc<OverlayState>>, rects: Vec<HitRect>) {
    state.set_hitboxes(rects);
}

#[tauri::command]
fn set_capture(state: State<'_, Arc<OverlayState>>, capture: bool) {
    state.capture.store(capture, Ordering::SeqCst);
}

#[tauri::command]
fn set_click_through_lock(app: AppHandle, state: State<'_, Arc<OverlayState>>, tray: State<'_, TrayHandles>, locked: bool) {
    overlay::set_locked(&app, &state, locked);
    let _ = tray.click_through.set_checked(locked);
}

#[tauri::command]
fn get_overlay_bounds(state: State<'_, Arc<OverlayState>>) -> OverlayBounds {
    state.bounds()
}

#[tauri::command]
fn get_monitors(app: AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let window = app.get_webview_window(OVERLAY_LABEL).ok_or("overlay window missing")?;
    overlay::list_monitors(&window).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_overlay_monitor(app: AppHandle, state: State<'_, Arc<OverlayState>>, index: usize) -> Result<OverlayBounds, String> {
    let window = app.get_webview_window(OVERLAY_LABEL).ok_or("overlay window missing")?;
    overlay::configure_window(&app, &window, &state, index).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_activity(tracker: State<'_, Arc<Tracker>>) -> ActivitySnapshot {
    tracker.snapshot()
}

#[tauri::command]
fn acknowledge_break(tracker: State<'_, Arc<Tracker>>) -> ActivitySnapshot {
    tracker.acknowledge_break();
    tracker.snapshot()
}

#[tauri::command]
fn snooze_sedentary(tracker: State<'_, Arc<Tracker>>, minutes: u64) -> ActivitySnapshot {
    tracker.snooze(minutes);
    tracker.snapshot()
}

#[tauri::command]
fn set_sedentary_threshold(tracker: State<'_, Arc<Tracker>>, minutes: u64) -> ActivitySnapshot {
    tracker.set_threshold(minutes.saturating_mul(60));
    tracker.snapshot()
}

#[tauri::command]
fn set_scene_mode(app: AppHandle, tray: State<'_, TrayHandles>, mode: String) -> Result<(), String> {
    let known = SCENE_MODES.iter().find(|(id, _)| *id == mode).ok_or("unknown scene mode")?;
    sync_scene_checks(&tray, known.0);
    let _ = app.emit("scene-mode", known.0);
    Ok(())
}

#[tauri::command]
fn set_paused(app: AppHandle, paused: bool) {
    set_user_paused(&app, paused);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ---------------------------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------------------------

fn build_tray(app: &tauri::App) -> tauri::Result<TrayHandles> {
    let mut scene_items = Vec::with_capacity(SCENE_MODES.len());
    let mut scene_menu = SubmenuBuilder::new(app, "Scene Mode");
    for (i, (id, label)) in SCENE_MODES.iter().enumerate() {
        let item = CheckMenuItemBuilder::with_id(format!("scene:{id}"), *label).checked(i == 1).build(app)?;
        scene_menu = scene_menu.item(&item);
        scene_items.push((*id, item));
    }
    let scene_menu = scene_menu.build()?;

    let hydrate = MenuItemBuilder::with_id("hydrate", "Remind me to drink now").accelerator("Ctrl+Shift+H").build(app)?;
    let stretch = MenuItemBuilder::with_id("stretch", "Stretch break now").build(app)?;
    let ack = MenuItemBuilder::with_id("ack-break", "I just took a break").build(app)?;
    let click_through = CheckMenuItemBuilder::with_id("click-through", "Click-through (lock)")
        .accelerator("Ctrl+Shift+D")
        .checked(false)
        .build(app)?;
    let paused = CheckMenuItemBuilder::with_id("pause", "Pause companion").checked(false).build(app)?;
    let monitor = MenuItemBuilder::with_id("monitor", "Move to next monitor").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit Sip Duck").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&scene_menu)
        .separator()
        .item(&hydrate)
        .item(&stretch)
        .item(&ack)
        .separator()
        .item(&click_through)
        .item(&paused)
        .item(&monitor)
        .separator()
        .item(&quit)
        .build()?;

    let mut tray = TrayIconBuilder::with_id("sip-duck-tray")
        .tooltip("Sip Duck — stay hydrated!")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(mode) = id.strip_prefix("scene:") {
                if let Some((known, _)) = SCENE_MODES.iter().find(|(m, _)| *m == mode) {
                    sync_scene_checks(&app.state::<TrayHandles>(), known);
                    let _ = app.emit("scene-mode", *known);
                }
                return;
            }
            match id {
                "hydrate" => {
                    let _ = app.emit("tray-action", "hydrate");
                }
                "stretch" => {
                    let snap = app.state::<Arc<Tracker>>().snapshot();
                    let _ = app.emit("sedentary-alert", snap);
                }
                "ack-break" => {
                    let tracker = app.state::<Arc<Tracker>>();
                    tracker.acknowledge_break();
                    let _ = app.emit("activity", tracker.snapshot());
                    let _ = app.emit("tray-action", "break-acknowledged");
                }
                "click-through" => toggle_click_through(app),
                "pause" => {
                    let paused = *app.state::<PauseState>().user_paused.lock().unwrap_or_else(|p| p.into_inner());
                    set_user_paused(app, !paused);
                }
                "monitor" => next_monitor(app),
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Left click: quick toggle of the pause state.
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                let app = tray.app_handle();
                let paused = *app.state::<PauseState>().user_paused.lock().unwrap_or_else(|p| p.into_inner());
                set_user_paused(app, !paused);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    Ok(TrayHandles { scene_items, click_through, paused })
}

// ---------------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------------

fn main() {
    let toggle_ct = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyD);
    let hydrate_now = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyH);

    let shortcut_plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            if shortcut == &toggle_ct {
                toggle_click_through(app);
            } else if shortcut == &hydrate_now {
                let _ = app.emit("tray-action", "hydrate");
            }
        })
        .build();

    let result = tauri::Builder::default()
        .plugin(shortcut_plugin)
        .manage(PauseState::default())
        .setup(move |app| {
            let handle = app.handle().clone();

            let overlay_state = Arc::new(OverlayState::default());
            app.manage(overlay_state.clone());

            let tracker = Arc::new(Tracker::new(DEFAULT_SEDENTARY_SECS));
            app.manage(tracker.clone());

            let tray = build_tray(app)?;
            app.manage(tray);

            let window = app.get_webview_window(OVERLAY_LABEL).ok_or("overlay window missing from tauri.conf.json")?;
            overlay::configure_window(&handle, &window, &overlay_state, 0)?;
            overlay::spawn_cursor_watcher(handle.clone(), overlay_state);

            system_hook::spawn(handle.clone(), tracker, |app, fullscreen| {
                *app.state::<PauseState>().fullscreen.lock().unwrap_or_else(|p| p.into_inner()) = fullscreen;
                apply_suspension(app);
            });

            // Hotkeys are optional: another app may already own them.
            let shortcuts = app.global_shortcut();
            for sc in [toggle_ct, hydrate_now] {
                if let Err(err) = shortcuts.register(sc) {
                    eprintln!("[sip-duck] could not register hotkey {sc:?}: {err}");
                }
            }

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_hitboxes,
            set_capture,
            set_click_through_lock,
            get_overlay_bounds,
            get_monitors,
            set_overlay_monitor,
            get_activity,
            acknowledge_break,
            snooze_sedentary,
            set_sedentary_threshold,
            set_scene_mode,
            set_paused,
            quit_app,
        ])
        .run(tauri::generate_context!());

    if let Err(err) = result {
        eprintln!("[sip-duck] fatal: {err}");
        std::process::exit(1);
    }
}
