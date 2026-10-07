<div align="center">

<img src="src-tauri/icons/128x128.png" width="96" alt="Sip Duck logo" />

# Sip Duck

**An anime desktop companion that walks on your taskbar, reminds you to drink water and makes you stand up when you've been sitting too long.**

[![Build](https://github.com/gyuv16/Sip-Duck/actions/workflows/build.yml/badge.svg)](https://github.com/gyuv16/Sip-Duck/actions/workflows/build.yml)
![Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-backend-000000?logo=rust&logoColor=white)
![PixiJS](https://img.shields.io/badge/PixiJS-v8%20WebGL-E72264)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-4f6df5)
![License](https://img.shields.io/badge/license-MIT-green)

[Download](#-download) · [Features](#-features) · [Controls](#-controls) · [How it stays light](#-how-it-stays-light) · [Build from source](#-build-from-source)

<br />

<img src="docs/cinematic-overlay.png" alt="Overlay running above VS Code and a browser: the heroine drags the male lead across the screen with screen-tear particles while he holds up an explosive speech bubble reading SIP BUDDY IS FAINTING FROM THIRST!, the cat has fainted on the taskbar under water droplets, and glass HUD panels for hydration and sitting time glow in the top-right corner" width="860" />

<sub><i>“The Dynamic Interrupt” — the real engine rendering over a mock busy desktop (<code>src/demo.html</code>). Everything except the windows behind is the transparent, click-through overlay.</i></sub>

</div>

---

## ✨ Features

<table>
<tr>
<td width="50%" valign="top">

### 💧 Hydration reminders
Every 45 minutes (configurable) your buddy **collapses, dizzy from thirst**.
A small pop-up offers **I drank a glass** or **Snooze 10 min**. Logging a glass plays a
drinking animation with a **water splash**, and your daily count and goal are tracked.

</td>
<td width="50%" valign="top">

### 🧘 Sitting-too-long alerts
Real keyboard/mouse idle time is read from the OS. After **45 minutes of continuous
sitting**, the characters run to the middle of your screen, **blow a whistle** and hold a
**“STAND UP & STRETCH!”** banner. Three minutes away from the desk resets the timer.

</td>
</tr>
<tr>
<td valign="top">

### 🎭 Four scene modes
| Mode | Cast |
| --- | --- |
| Solo | Hina |
| Human + Pet | Hina + cat |
| Couple | Hina + Ren |
| Couple + Pet | Hina, Ren, cat and a floating spirit |

Couples walk to each other, wave across the screen and share hearts. Pets follow their owner.

</td>
<td valign="top">

### 🎬 Cinematic wake-up calls
| Scene | What happens |
| --- | --- |
| Couple | The heroine **grabs the male lead and drags him across the screen**, over your open windows, with screen-tear slices, dust and sweat drops — or both raise a **giant warning sign** |
| Pet | The cat **jumps onto a head and rides there**, or does **zoomies** knocking papers off your “desk” |
| Hydration | The male lead raises an explosive **“SIP BUDDY IS FAINTING FROM THIRST!”** bubble while the cat faints, ears wilted, under water droplets. Logging a glass gives a splash-and-sparkle cheer |
| Always | Glass **cinema HUD** panels (clock, arc gauge) instead of flat pop-ups; expressions pop up as manga emotes (‼, 💢, 💧, ♥, Z) |

</td>
</tr>
<tr>
<td valign="top" colspan="2">

### 🖱️ Lives on your desktop
- Walks on the **top edge of your taskbar**
- **Drag and throw** characters — they bounce off screen edges
- **Click** to get a wave back
- Clicks everywhere else **pass through** to your apps
- **Falls asleep** when you're away, **hides itself** during fullscreen games and videos
- Multi-monitor: move it to any screen from the tray

</td>
</tr>
</table>

<div align="center">
<img src="docs/screenshot-pet.png" alt="Human + Pet scene: girl with a pink ribbon and an orange cat" width="640" />
<br /><sub><i>Human + Pet mode</i></sub>
</div>

---

## 📥 Download

Grab the installer for your system from the **[Releases page](https://github.com/gyuv16/Sip-Duck/releases)**:

| System | File |
| --- | --- |
| Windows 10/11 | `Sip Duck_x.y.z_x64-setup.exe` |
| macOS | `Sip Duck_x.y.z_*.dmg` |
| Linux | `sip-duck_x.y.z_amd64.AppImage` |

> [!NOTE]
> The builds are not code-signed yet. On Windows click **More info → Run anyway**; on macOS
> right-click the app → **Open** the first time.

Every CI run also attaches the installers as artifacts (**Actions** tab → latest run → **Artifacts**).

---

## 🎮 Controls

| Action | How |
| --- | --- |
| Drag & throw a character | Click and drag it |
| Make a character react | Click it (re-opens a dismissed reminder) |
| Make everything click-through | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>D</kbd> |
| Hydration reminder now | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>H</kbd> |
| Pause / resume | Left-click the tray icon |
| Scene mode, stretch now, next monitor, quit | Right-click the tray icon |

---

## ⚡ How it stays light

No Electron, no bundled Chromium, no Python. The app uses the operating system's own webview through Tauri.

| Target | Design |
| --- | --- |
| Idle CPU < 0.5 % | Drawing **stops completely (0 FPS)** when nothing moves; idle breathing runs at 4–12 FPS using timers instead of a 60 Hz loop |
| Active CPU < 3 % | 60 FPS only while something moves, is dragged or hovered; frames where nothing changed skip the GPU |
| RAM < 20 MB (app side) | All character frames drawn once into **one shared texture**; old textures freed on every scene switch |
| Installer < 15 MB | Rust release profile: `lto`, `opt-level = "z"`, `codegen-units = 1`, `panic = "abort"`, `strip` |

> [!IMPORTANT]
> These are design targets. They have not been measured on real hardware yet.

```mermaid
flowchart LR
  subgraph Rust["Rust backend (src-tauri)"]
    H["system_hook.rs<br/>idle time · screen time · fullscreen"]
    O["overlay.rs<br/>transparent window · click-through"]
    M["main.rs<br/>tray · hotkeys · IPC"]
  end
  subgraph Web["Frontend (src)"]
    A["app.ts<br/>frame scheduler · input"]
    S["state_machine.ts<br/>character behaviour"]
    R["renderer.ts<br/>sprite atlas · animation"]
    T["tracker_ui.ts<br/>reminders · pop-ups"]
  end
  H -- "activity / sedentary-alert" --> A
  M -- "scene-mode / tray-action / suspend" --> A
  A -- "set_hitboxes / set_capture" --> O
  A --> S --> R
  A --> T
```

---

## 🛠️ Build from source

**Requirements:** Rust ≥ 1.77, Node ≥ 20, and the [Tauri v2 system prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
git clone https://github.com/gyuv16/Sip-Duck.git
cd Sip-Duck
npm install && npm ci --prefix src   # Tauri CLI + frontend deps
npm run dev        # run the app with hot reload
npm run build      # build the installer → src-tauri/target/release/bundle/
```

Preview the characters in a normal browser (desktop features turned off): `npm --prefix src run dev` → http://localhost:1420

<details>
<summary><b>📁 Project structure</b></summary>

```
├── package.json            # Tauri CLI wrapper
├── .github/workflows/      # CI: build installers on Windows/macOS/Linux, release on tags
├── src-tauri/              # Rust backend
│   ├── Cargo.toml          # size-optimised release profile
│   ├── tauri.conf.json     # transparent, frameless, always-on-top window
│   └── src/
│       ├── main.rs         # setup, tray, global hotkeys, IPC commands
│       ├── system_hook.rs  # idle + screen-time tracking, fullscreen detection
│       └── overlay.rs      # window sizing, multi-monitor, click-through engine
└── src/                    # frontend
    ├── app.ts                  # PixiJS engine, frame scheduler, IPC, demo driver
    ├── animation_controller.ts # Spine / spritesheet / procedural rigs, cross-fades, expressions, props
    ├── scene_manager.ts        # action queue + pair choreographies, reactive FX, depth sorting
    ├── fx_engine.ts            # pooled particles: droplets, sparkles, hearts, sweat, Zzz, glitch…
    ├── state_machine.ts        # character state machines + physics director
    ├── renderer.ts             # procedural fallback art baked into one atlas
    ├── tracker_ui.ts           # hydration tracker + cinema HUD panels
    └── demo.html               # overlay above a mock desktop (showcase / screenshots)
```
</details>

<details>
<summary><b>🎨 Use your own character art (Spine 2D skeletons or sprite sheets)</b></summary>

Characters are configured in `src/public/assets/characters.json`; anything not listed (or failing to load) falls back to the built-in art, so a broken asset never breaks the app. Start from [`characters.example.json`](src/public/assets/characters.example.json):

```jsonc
{
  "hero": {
    "type": "spine",                       // skeletal: mesh deformation, hair/cloth physics
    "skeleton": "assets/hero/hero.skel",   // binary .skel or .json export
    "atlas": "assets/hero/hero.atlas",
    "scale": 0.25,
    "mix": 0.2,                            // cross-fade seconds between animations
    "animations": { "collapse": "faint", "dragged": "panic-dangle" },   // our name → your name
    "expressions": { "panic": "face/panic", "happy": "face/smile" },     // played on track 1
    "attachments": { "sign": { "slot": "prop-hand", "attachment": "warning-sign" } }
  },
  "cat": { "type": "spritesheet", "json": "assets/cat/cat.json" }
}
```

- **Spine**: export with **Spine editor 4.3** (the runtime is `@esotericsoftware/spine-pixi-v8` 4.3; versions must match). The runtime is code-split and only downloaded when a Spine character is configured.
- **Sprite sheets**: TexturePacker/Aseprite JSON + PNG/WEBP/AVIF with an `animations` map; frames anchored bottom-centre (96×128 people, 72×64 pets).
- Animation names used by the engine: `idle, walk, drink, stretch, whistle, dragged, fall, collapse, sleep, wave`. Expressions: `neutral, happy, panic, dizzy, surprised, determined, sleepy, love, angry`. Props: `banner, sign, shout`.

Swapping art in code:

```ts
const anims = await AnimationController.create(app.renderer, ['hero', 'cat'], fx, 'assets/characters.json');
const hero = anims.createRig('hero');      // SpineRig, or SpriteRig fallback — same interface
hero.play('walk', { fadeMs: 200 });        // blended transition
hero.setExpression('panic');               // Spine: track-1 face animation; sprites: manga emote
hero.attach('sign');                       // Spine: slot attachment swap; sprites: held prop
hero.setFacing(-1);
```
</details>

<details>
<summary><b>🎬 Watch the cinematic demo</b></summary>

`npm --prefix src run dev`, then open http://localhost:1420/demo.html — the real engine loops “The Dynamic Interrupt” over a mock desktop. In dev builds you can also drive scenes from the browser console: `sipDuck.sedentary('pull', 'none')`, `sipDuck.hydrate()`, `sipDuck.drink()`, `sipDuck.stretched()`, `sipDuck.mode('couple_pet')`.
</details>

<details>
<summary><b>🚀 Publishing a release</b></summary>

```bash
git tag v0.1.0
git push origin v0.1.0
```

CI builds all three installers and publishes them on the Releases page with generated notes.
Or without a local tag: **Actions → Build → Run workflow**, enter `v0.1.0` as *release_tag*.
</details>

<details>
<summary><b>🐧 Platform notes</b></summary>

- **Idle tracking** works on Windows and macOS. Linux has no portable idle API, so the sitting timer counts from start-up / your last confirmed break.
- **Fullscreen auto-hide** is Windows only (macOS fullscreen apps use their own Space).
- **Wayland** doesn't expose the cursor position, so characters can't be dragged there; the overlay stays click-through.
- Hydration counts reset at local midnight; screen time today resets at UTC midnight.
</details>

---

<div align="center">
<sub>Made with 💧 and Tauri · Stay hydrated, stretch often.</sub>
</div>
