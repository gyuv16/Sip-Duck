# Sip Duck — anime desktop overlay companion

Tauri v2 (Rust) + PixiJS v8 (WebGL) desktop buddy that walks on your taskbar, faints when
you forget to drink water and blows a whistle when you have been sitting too long.

```
├── package.json            # Tauri CLI wrapper (installs ./src on postinstall)
├── src-tauri/              # Rust backend
│   ├── Cargo.toml          # size-optimised release profile (lto, opt-level=z, abort, strip)
│   ├── tauri.conf.json     # transparent, frameless, always-on-top, skip-taskbar window
│   └── src/
│       ├── main.rs         # setup, tray, global hotkeys, IPC commands
│       ├── system_hook.rs  # GetLastInputInfo / CGEventSource idle + screen-time + fullscreen detection
│       └── overlay.rs      # work-area sizing, multi-monitor, smart click-through engine
└── src/                    # frontend
    ├── index.html
    ├── app.ts              # Pixi engine, adaptive frame scheduler, worker heartbeat, IPC
    ├── state_machine.ts    # per-character FSM + scene Director (couple/pet/drag physics)
    ├── renderer.ts         # procedural → packed texture atlas, ActorView, particle pool
    └── tracker_ui.ts       # hydration tracker + non-blocking toast UI
```

## Run / build

Prerequisites: Rust ≥ 1.77, Node ≥ 20, plus the [Tauri v2 OS prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm install          # also installs ./src
npm run dev          # tauri dev
npm run build        # release installer (NSIS / DMG / AppImage)
```

Frontend only, in a browser: `npm --prefix src run dev` → http://localhost:1420 (IPC calls become no-ops).

## Controls

| Action | How |
| --- | --- |
| Drag & throw a character | click-drag it (physics, wall bounce, lands on the taskbar line) |
| Poke | click it (waves back; re-opens a dismissed reminder) |
| Lock full click-through | `Ctrl+Shift+D` or tray |
| Hydration reminder now | `Ctrl+Shift+H` or tray |
| Scene mode, pause, next monitor, quit | tray menu (left-click tray = pause/resume) |

## Performance design

* **Render on demand.** Pixi's ticker is stopped; `FrameScheduler` runs 60 FPS only while
  something moves, is dragged or hovered, 4–12 FPS for idle breathing, and **0 FPS** (no rAF at
  all) when everyone sleeps. Low rates use `setTimeout` + one rAF so the thread really sleeps,
  and frames where no sprite changed skip the GPU draw entirely.
* **Single atlas.** All character frames are rasterised once into one packed `RenderTexture`
  (≈1–3 MB of GPU memory) and the vector geometry is destroyed right after. Switching scenes
  builds the new atlas first, then destroys the old textures — nothing leaks.
* **Suspension.** Fullscreen foreground app (Windows) or user pause → the window is hidden,
  the cursor watcher backs off to 2.5 Hz and the renderer freezes. WebGL context loss is handled.
* **Click-through without OS regions.** The window ignores the mouse; a 20 Hz Rust thread
  checks the global cursor against hit boxes published by the frontend and enables input only
  over characters/toasts.
* **Native idle tracking**: one 1 Hz thread, IPC events only on change or every 5 s.

## Custom art

Drop a TexturePacker/Aseprite JSON + PNG/AVIF sheet at `src/public/assets/<hero|partner|cat|spirit>.json`
with `animations` named `idle, walk, drink, stretch, whistle, dragged, fall, collapse, sleep, wave`
(frames anchored bottom-centre, 96×128 for humans, 72×64 for pets). It replaces the procedural art automatically.

## Platform notes

* Idle tracking: Windows and macOS. On Linux there is no portable idle API without extra X11/Wayland
  dependencies, so the sedentary timer counts from start-up / last acknowledged break.
* Fullscreen suspension: Windows. On macOS fullscreen apps run in their own Space (WebKit throttles the hidden overlay).
* Click-through hover detection needs a global cursor position (not available on Wayland): there
  the overlay stays click-through and characters are not draggable.
* Hydration counts reset at local midnight; screen-time-today resets at UTC midnight.

## CI & releases

`.github/workflows/build.yml` runs on every push/PR: frontend typecheck + build, then clippy,
unit tests and a full `tauri build` on Windows (NSIS `.exe`), macOS (`.dmg`) and Linux (`.AppImage`).
Installers are attached to each run as artifacts (Actions tab → run → *Artifacts*).

To publish a GitHub Release with the installers attached:

```bash
git tag v0.1.0 && git push origin v0.1.0
```
