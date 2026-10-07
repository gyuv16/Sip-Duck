/**
 * PixiJS application engine, adaptive frame scheduler and IPC wiring.
 *
 * Rendering model ("render on demand"):
 *  - Pixi's own ticker is stopped. A custom FrameScheduler drives frames at the rate the
 *    scene actually needs: 60 FPS while something moves / is dragged / hovered, 6–12 FPS for
 *    breathing idles, 0 FPS (fully frozen, no rAF, no GPU work) when everyone sleeps or the
 *    overlay is suspended.
 *  - Low rates use setTimeout + a single rAF instead of spinning rAF at 60 Hz, so the JS
 *    thread genuinely sleeps between frames.
 *  - Inside a frame the GPU render is skipped entirely if no sprite changed.
 *  - A tiny Web Worker heartbeat (1 Hz) runs slow decisions while rendering is frozen and
 *    wakes the scheduler when needed (worker timers are not throttled like page timers).
 */
import { Application, Container } from 'pixi.js';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import { AnimationController, type CharacterRig } from './animation_controller';
import { FxEngine } from './fx_engine';
import { cellFor } from './renderer';
import { SceneManager } from './scene_manager';
import { CharState, Director, SCENE_ACTORS, type Actor, type SceneMode } from './state_machine';
import { HydrationTracker, ToastUI, formatDuration, type Rect } from './tracker_ui';

// ---------------------------------------------------------------------------------------------
// IPC (typed, and inert when running in a plain browser via `vite dev`)
// ---------------------------------------------------------------------------------------------

interface ActivitySnapshot {
  idleSecs: number;
  activeStreakSecs: number;
  screenSecsToday: number;
  sedentaryThresholdSecs: number;
  nextAlertInSecs: number;
  fullscreen: boolean;
  userAway: boolean;
  idleSupported: boolean;
}

interface OverlayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  monitorHeight: number;
  monitorIndex: number;
  monitorCount: number;
  monitorName: string;
}

interface SuspendPayload {
  suspended: boolean;
  reason: 'paused' | 'fullscreen' | 'resumed';
}

const IN_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IN_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.warn(`[sip-duck] ${cmd} failed`, err);
    return null;
  }
}

async function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!IN_TAURI) return () => {};
  return listen<T>(event, (e) => handler(e.payload));
}

const SCENE_KEY = 'sip-duck:scene';
const SCENE_MODES: readonly SceneMode[] = ['solo', 'pet', 'couple', 'couple_pet'];

function loadScene(): SceneMode {
  try {
    const v = localStorage.getItem(SCENE_KEY);
    if (v && (SCENE_MODES as readonly string[]).includes(v)) return v as SceneMode;
  } catch {
    /* ignore */
  }
  return 'pet';
}

// ---------------------------------------------------------------------------------------------
// Frame scheduler
// ---------------------------------------------------------------------------------------------

class FrameScheduler {
  private fps = 0;
  private rafId = 0;
  private timeoutId = 0;
  private last = 0;
  private once = false;
  private stopped = false;

  constructor(private readonly onFrame: (dtMs: number) => void) {}

  get target(): number {
    return this.fps;
  }

  setFps(fps: number): void {
    const next = Math.max(0, Math.min(60, Math.round(fps)));
    if (next === this.fps) return;
    const wasIdle = this.fps === 0;
    this.fps = next;
    if (this.stopped) return;
    this.cancel();
    if (next > 0 || this.once) this.schedule(wasIdle ? 0 : undefined);
  }

  /** Render exactly one frame soon, even when frozen at 0 FPS. */
  requestFrame(): void {
    if (this.stopped) return;
    this.once = true;
    if (!this.rafId && !this.timeoutId) this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.stopped = true;
    this.cancel();
  }

  private cancel(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.timeoutId) clearTimeout(this.timeoutId);
    this.rafId = 0;
    this.timeoutId = 0;
  }

  private schedule(delayOverride?: number): void {
    if (this.stopped || this.rafId || this.timeoutId) return;
    if (this.fps >= 30 || this.once) {
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    const interval = 1000 / this.fps;
    const delay = delayOverride ?? Math.max(0, interval - (performance.now() - this.last));
    this.timeoutId = window.setTimeout(() => {
      this.timeoutId = 0;
      this.rafId = requestAnimationFrame(this.tick);
    }, delay);
  }

  private readonly tick = (now: number): void => {
    this.rafId = 0;
    if (this.stopped) return;
    const interval = this.fps > 0 ? 1000 / this.fps : 0;
    // At 60 Hz rAF we may be called slightly early for a 30 FPS target: skip until due.
    if (!this.once && this.fps >= 30 && this.fps < 60 && now - this.last < interval - 2) {
      this.schedule();
      return;
    }
    const dt = this.last === 0 ? 16.7 : Math.min(100, now - this.last);
    this.last = now;
    this.once = false;
    this.onFrame(dt);
    if (this.fps > 0) this.schedule();
  };
}

// ---------------------------------------------------------------------------------------------
// Heartbeat worker (inline, ~200 bytes)
// ---------------------------------------------------------------------------------------------

function createHeartbeat(onBeat: () => void): () => void {
  const src = 'let t=setInterval(()=>postMessage(0),1000);onmessage=()=>{clearInterval(t);close()}';
  try {
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const worker = new Worker(url);
    worker.onmessage = onBeat;
    return () => {
      worker.postMessage(0);
      worker.terminate();
      URL.revokeObjectURL(url);
    };
  } catch {
    // CSP or platform without workers: fall back to a page timer.
    const id = window.setInterval(onBeat, 1000);
    return () => clearInterval(id);
  }
}

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------

const DRAG_THRESHOLD = 5;
const HITBOX_PAD = 6;

class Engine {
  private readonly app = new Application();
  private readonly actorLayer = new Container();
  private readonly fxLayer = new Container();
  private anims: AnimationController | null = null;
  private fx!: FxEngine;
  private scene!: SceneManager;
  private readonly rigs = new Map<number, CharacterRig>();
  private director!: Director;
  private readonly hydration = new HydrationTracker();
  private toasts!: ToastUI;
  private scheduler!: FrameScheduler;
  private stopHeartbeat: (() => void) | null = null;
  private readonly unlisteners: UnlistenFn[] = [];
  private readonly domAbort = new AbortController();

  private mode: SceneMode = loadScene();
  private modeToken = 0;
  private dirty = true;
  private hover = false;
  private suspended = false;
  private destroyed = false;
  private activity: ActivitySnapshot | null = null;

  private lastHitKey = '';
  private lastHitSent = 0;
  private hitTimer = 0;

  private pointer: { id: number; x: number; y: number; t: number; actor: Actor | null; dragging: boolean; samples: Array<{ x: number; y: number; t: number }> } | null = null;

  async start(): Promise<void> {
    await this.app.init({
      backgroundAlpha: 0,
      resizeTo: window,
      antialias: false,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      preference: 'webgl',
      powerPreference: 'low-power',
      autoStart: false,
      sharedTicker: false,
      hello: false,
      eventMode: 'none',
      eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
    });
    this.app.ticker.stop();
    this.app.stage.eventMode = 'none';
    // Dynamic depth: pets behind humans, riders on heads and dragged actors on top.
    this.actorLayer.sortableChildren = true;
    this.app.stage.addChild(this.actorLayer, this.fxLayer);
    this.fx = new FxEngine(this.app.renderer);
    this.fxLayer.addChild(this.fx.root);
    const canvas = this.app.canvas;
    canvas.id = 'stage';
    document.body.appendChild(canvas);

    this.director = new Director(this.world(), {
      onSplash: (x, y) => {
        this.fx.burst('droplet', x, y, 10);
        this.updateFps();
      },
      onStateChange: (actor, prev) => {
        this.scene?.onStateChange(actor, prev);
        this.dirty = true;
        this.updateFps();
      },
    });
    this.scene = new SceneManager(this.director, this.fx, () => this.world());
    this.toasts = new ToastUI(() => this.scheduleHitboxes());
    this.scheduler = new FrameScheduler((dt) => this.frame(dt));

    this.bindDom(canvas);
    await this.bindIpc();
    await this.setMode(this.mode);
    void call('set_scene_mode', { mode: this.mode });

    const initial = await call<ActivitySnapshot>('get_activity');
    if (initial) this.applyActivity(initial);

    this.stopHeartbeat = createHeartbeat(() => this.heartbeat());
    this.scheduler.requestFrame();
  }

  /** Dev-only console hooks (`npm run dev`): trigger reminders/scenes without waiting. */
  debugApi(): Record<string, (...args: never[]) => unknown> {
    return {
      sedentary: (coupleVariant?: 'pull' | 'sign', petVariant?: 'headHop' | 'zoomies' | 'none') => this.onSedentaryAlert({ idleSecs: 0, activeStreakSecs: 2760, screenSecsToday: 9000, sedentaryThresholdSecs: 2700, nextAlertInSecs: 600, fullscreen: false, userAway: false, idleSupported: true }, coupleVariant, petVariant),
      hydrate: () => (this.hydration.forceDue() ? this.onHydrationDue() : this.showHydrationToast()),
      drink: () => {
        this.toasts.dismissKind('hydration');
        this.hydration.logGlass();
        this.director.completeHydration(true);
        this.kick();
      },
      stretched: () => {
        this.toasts.dismissKind('sedentary');
        this.scene.cancel();
        this.director.completeSedentary(true);
        this.kick();
      },
      mode: (m: SceneMode) => this.setMode(m),
    };
  }

  // ----------------------------------------------------------------------------- scene

  private world(): { width: number; floor: number } {
    // The demo page reserves space for its mock taskbar so characters walk on top of it.
    const inset = Number(document.body.dataset.floorInset ?? 0) || 0;
    return { width: window.innerWidth, floor: window.innerHeight - 2 - inset };
  }

  /**
   * demo.html: plays "The Dynamic Interrupt" over a mock desktop — hydration alarm (male lead
   * raises the bubble, cat faints under water droplets) while the heroine drags him away.
   */
  async runDemo(): Promise<void> {
    await this.setMode('couple_pet');
    const loop = async () => {
      if (this.destroyed) return;
      this.toasts.dismissKind('hydration');
      this.toasts.dismissKind('sedentary');
      this.scene.cancel();
      this.director.completeSedentary(false);
      this.director.completeHydration(false);
      await sleep(1200);
      if (this.hydration.forceDue()) this.onHydrationDue();
      else this.showHydrationToast();
      await sleep(900);
      this.onSedentaryAlert({ idleSecs: 0, activeStreakSecs: 2760, screenSecsToday: 18000, sedentaryThresholdSecs: 2700, nextAlertInSecs: 600, fullscreen: false, userAway: false, idleSupported: true }, 'pull', 'none');
      window.setTimeout(() => void loop(), 16000);
    };
    void loop();
  }

  private async setMode(mode: SceneMode): Promise<void> {
    if (this.destroyed) return;
    const token = ++this.modeToken;
    const anims = await AnimationController.create(this.app.renderer, SCENE_ACTORS[mode], this.fx);
    if (token !== this.modeToken || this.destroyed) {
      anims.destroy();
      return;
    }
    this.mode = mode;
    try {
      localStorage.setItem(SCENE_KEY, mode);
    } catch {
      /* ignore */
    }

    // Tear down the previous cast & atlas *after* the new one is ready (no blank frame).
    this.scene.cancel();
    this.rigs.clear();
    this.anims?.destroy(); // destroys every rig it created
    this.anims = anims;
    this.fx.stopAll();

    const actors = this.director.populate(mode, cellFor);
    for (const actor of actors) {
      const rig = anims.createRig(actor.kind, actor.human ? 1 : 0.9);
      this.rigs.set(actor.id, rig);
      this.actorLayer.addChild(rig.root);
    }
    this.scene.setCast(actors.map((actor) => ({ actor, rig: this.rigs.get(actor.id)! })));
    this.syncViews(0);
    this.dirty = true;
    this.updateFps();
    this.scheduler.requestFrame();
  }

  // ----------------------------------------------------------------------------- frame loop

  private frame(dtMs: number): void {
    if (this.destroyed || !this.anims) return;
    const dt = dtMs / 1000;
    if (this.director.step(dt)) this.dirty = true;
    if (this.scene.update(dt)) this.dirty = true;
    if (this.syncViews(dtMs)) this.dirty = true;
    if (this.fx.update(dt, this.world().floor)) this.dirty = true;

    if (this.dirty) {
      this.dirty = false;
      this.app.renderer.render(this.app.stage);
      this.scheduleHitboxes();
      const hero = this.director.actors.find((a) => a.kind === 'hero');
      // Keep pop-ups clear of the giant warning sign when it is raised.
      if (hero) this.toasts.setAnchor(hero.body.x, hero.body.y - hero.body.height - (this.scene.propFor(hero) === 'sign' || this.scene.propFor(hero) === 'shout' ? 140 : 6));
    }
    this.updateFps();
  }

  /** Pushes actor + scene state into the rigs. Returns true if anything visible changed. */
  private syncViews(dtMs: number): boolean {
    let changed = false;
    for (const actor of this.director.actors) {
      const rig = this.rigs.get(actor.id);
      if (!rig) continue;
      if (rig.play(this.scene.animFor(actor))) changed = true;
      if (rig.setExpression(this.scene.expressionFor(actor))) changed = true;
      if (rig.attach(this.scene.propFor(actor))) changed = true;
      if (rig.setFacing(actor.body.facing)) changed = true;
      const x = Math.round(actor.body.x);
      const y = Math.round(actor.body.y + this.scene.hopOffset(actor));
      if (rig.root.x !== x || rig.root.y !== y) {
        rig.root.position.set(x, y);
        changed = true;
      }
      const z = this.scene.zFor(actor);
      if (rig.root.zIndex !== z) {
        rig.root.zIndex = z;
        changed = true;
      }
      if (dtMs > 0 && rig.update(dtMs)) changed = true;
    }
    return changed;
  }

  private updateFps(): void {
    if (!this.scheduler) return;
    if (this.suspended || document.hidden) {
      this.scheduler.setFps(0);
      return;
    }
    let fps = this.director.desiredFps((a) => this.rigs.get(a.id)?.done ?? true);
    if (this.hover || this.pointer || this.scene?.busy || this.fx?.busy) fps = 60;
    // Idle anims run at their clip fps; don't burn frames faster than frames change.
    if (fps > 0 && fps < 30) {
      let clipFps = 0;
      for (const r of this.rigs.values()) if (r.msUntilNextFrame() !== Infinity) clipFps = Math.max(clipFps, r.fps);
      fps = Math.max(clipFps, Math.min(fps, 12));
    }
    this.scheduler.setFps(fps);
  }

  private heartbeat(): void {
    if (this.destroyed || this.suspended) return;
    this.director.heartbeat(1);
    if (this.hydration.check()) this.onHydrationDue();
    this.updateFps();
    if (this.scheduler.target === 0 && this.dirty) this.scheduler.requestFrame();
  }

  // ----------------------------------------------------------------------------- reminders

  private onHydrationDue(): void {
    this.director.triggerHydration();
    this.scene.onHydrationAlert();
    this.showHydrationToast();
    this.scheduler.requestFrame();
  }

  private showHydrationToast(): void {
    const g = this.hydration.glasses;
    const goal = this.hydration.goal;
    this.toasts.show({
      kind: 'hydration',
      dock: 'corner',
      title: 'Hydration status',
      icon: 'drop',
      body: g >= goal ? 'Goal reached — one more keeps your buddy sparkling!' : 'Alert triggered: your buddy is fainting from thirst.',
      gauge: { value: g, max: goal, label: 'glasses logged' },
      actions: [
        {
          label: 'I drank a glass',
          primary: true,
          run: () => {
            this.hydration.logGlass();
            this.director.completeHydration(true);
            this.toasts.show({
              kind: 'info',
              title: `+1 glass · ${this.hydration.glasses}/${this.hydration.goal}`,
              icon: 'spark',
              body: 'Splendid! See you next sip.',
              actions: [],
              ttlMs: 2600,
            });
            this.kick();
          },
        },
        {
          label: 'Snooze 10 min',
          run: () => {
            this.hydration.snooze(10);
            this.director.completeHydration(false);
            this.kick();
          },
        },
      ],
    });
  }

  private onSedentaryAlert(snap: ActivitySnapshot, coupleVariant?: 'pull' | 'sign', petVariant?: 'headHop' | 'zoomies' | 'none'): void {
    this.director.triggerSedentary();
    this.scene.runSedentary(coupleVariant, petVariant);
    const running = this.scene.running ?? '';
    const action = running.includes('pull') ? 'Dragging initiated!'
      : running.includes('sign') ? 'Warning sign raised!'
      : running.includes('zoomies') ? 'Zoomies initiated!'
      : running.includes('headHop') ? 'Pet intervention!'
      : 'Stand up and stretch!';
    this.toasts.show({
      kind: 'sedentary',
      dock: 'corner',
      icon: 'clock',
      title: 'Time to move',
      body: `${formatDuration(snap.activeStreakSecs).toUpperCase()} SITTING STRAIGHT. ${action.toUpperCase()}`,
      actions: [
        {
          label: 'I stretched ✓',
          primary: true,
          run: () => {
            void call('acknowledge_break');
            this.scene.cancel();
            this.director.completeSedentary(true);
            this.kick();
          },
        },
        {
          label: 'Snooze 10 min',
          run: () => {
            void call('snooze_sedentary', { minutes: 10 });
            this.scene.cancel();
            this.director.completeSedentary(false);
            this.kick();
          },
        },
      ],
    });
    this.kick();
  }

  private applyActivity(snap: ActivitySnapshot): void {
    this.activity = snap;
    this.director.setUserAway(snap.userAway);
    this.kick();
  }

  private kick(): void {
    this.dirty = true;
    this.updateFps();
    this.scheduler.requestFrame();
  }

  // ----------------------------------------------------------------------------- hit boxes

  private scheduleHitboxes(): void {
    if (this.hitTimer) return;
    const wait = Math.max(0, 50 - (performance.now() - this.lastHitSent));
    this.hitTimer = window.setTimeout(() => {
      this.hitTimer = 0;
      this.publishHitboxes();
    }, wait);
  }

  private publishHitboxes(): void {
    if (this.destroyed) return;
    const s = window.devicePixelRatio || 1;
    const rects: Rect[] = [];
    for (const a of this.director.actors) {
      const b = a.body;
      rects.push({ x: b.x - b.halfW - HITBOX_PAD, y: b.y - b.height - HITBOX_PAD, w: 2 * (b.halfW + HITBOX_PAD), h: b.height + 2 * HITBOX_PAD });
    }
    for (const r of this.toasts.rects()) rects.push(r);
    const physical = rects.map((r) => ({ x: Math.round(r.x * s), y: Math.round(r.y * s), w: Math.round(r.w * s), h: Math.round(r.h * s) }));
    const key = physical.map((r) => `${r.x},${r.y},${r.w},${r.h}`).join('|');
    if (key === this.lastHitKey) return;
    this.lastHitKey = key;
    this.lastHitSent = performance.now();
    void call('set_hitboxes', { rects: physical });
  }

  // ----------------------------------------------------------------------------- input

  private bindDom(canvas: HTMLCanvasElement): void {
    const signal = this.domAbort.signal;

    canvas.addEventListener('pointerdown', (e) => {
      const actor = this.director.hitTest(e.clientX, e.clientY);
      if (!actor) return;
      canvas.setPointerCapture(e.pointerId);
      this.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, actor, dragging: false, samples: [] };
      void call('set_capture', { capture: true });
      this.kick();
    }, { signal });

    canvas.addEventListener('pointermove', (e) => {
      const p = this.pointer;
      if (!p || e.pointerId !== p.id || !p.actor) return;
      if (!p.dragging && Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_THRESHOLD) {
        p.dragging = true;
        // Grabbing an actor mid-choreography ends the scripted scene.
        if (p.actor.scripted) this.scene.cancel();
        this.director.beginDrag(p.actor, p.x, p.y);
      }
      if (p.dragging) {
        this.director.dragTo(e.clientX, e.clientY);
        p.samples.push({ x: e.clientX, y: e.clientY, t: e.timeStamp });
        if (p.samples.length > 6) p.samples.shift();
        this.dirty = true;
      }
    }, { signal });

    const release = (e: PointerEvent) => {
      const p = this.pointer;
      if (!p || e.pointerId !== p.id) return;
      this.pointer = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      void call('set_capture', { capture: false });
      if (p.dragging) {
        const first = p.samples[0];
        const last = p.samples[p.samples.length - 1];
        const span = first && last ? Math.max(1, last.t - first.t) : 1;
        const vx = first && last ? ((last.x - first.x) / span) * 1000 : 0;
        const vy = first && last ? ((last.y - first.y) / span) * 1000 : 0;
        this.director.endDrag(vx, vy);
      } else if (p.actor) {
        // A tap: re-open a dismissed reminder, otherwise get a cute reaction.
        if (p.actor.state === CharState.Thirsty && !this.toasts.has('hydration')) this.showHydrationToast();
        else if ((p.actor.state === CharState.SittingTooLong || p.actor.state === CharState.Stretching) && !this.toasts.has('sedentary') && this.activity) this.onSedentaryAlert(this.activity);
        else this.director.poke(p.actor);
      }
      this.kick();
    };
    canvas.addEventListener('pointerup', release, { signal });
    canvas.addEventListener('pointercancel', release, { signal });

    window.addEventListener('resize', () => {
      this.director.setWorld(this.world());
      this.kick();
    }, { signal });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.kick();
      else this.updateFps();
    }, { signal });

    // WebGL context loss (driver reset, GPU switch): freeze, then rebuild the atlas on restore.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.suspended = true;
      this.updateFps();
    }, { signal });
    canvas.addEventListener('webglcontextrestored', () => {
      this.suspended = false;
      void this.setMode(this.mode);
    }, { signal });

    window.addEventListener('beforeunload', () => this.destroy(), { signal });
  }

  private async bindIpc(): Promise<void> {
    this.unlisteners.push(
      await on<ActivitySnapshot>('activity', (s) => this.applyActivity(s)),
      await on<ActivitySnapshot>('sedentary-alert', (s) => {
        this.activity = s;
        this.onSedentaryAlert(s);
      }),
      await on<string>('scene-mode', (mode) => {
        if ((SCENE_MODES as readonly string[]).includes(mode) && mode !== this.mode) void this.setMode(mode as SceneMode);
      }),
      await on<string>('tray-action', (action) => {
        if (action === 'hydrate') {
          if (this.hydration.forceDue()) this.onHydrationDue();
          else this.showHydrationToast();
        } else if (action === 'break-acknowledged') {
          this.toasts.dismissKind('sedentary');
          this.scene.cancel();
          this.director.completeSedentary(true);
          this.kick();
        }
      }),
      await on<SuspendPayload>('suspend', (p) => {
        this.suspended = p.suspended;
        if (p.suspended) {
          this.pointer = null;
          this.updateFps();
        } else {
          this.kick();
        }
      }),
      await on<boolean>('hover-changed', (hover) => {
        this.hover = hover;
        this.updateFps();
      }),
      await on<OverlayBounds>('overlay-bounds', () => {
        // The window has been moved/resized by the backend; `resize` follows, but make sure.
        this.director.setWorld(this.world());
        this.kick();
      }),
      await on<boolean>('click-through-changed', (locked) => {
        if (locked) this.pointer = null;
        this.kick();
      }),
    );
  }

  // ----------------------------------------------------------------------------- teardown

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scheduler?.stop();
    this.stopHeartbeat?.();
    this.stopHeartbeat = null;
    if (this.hitTimer) clearTimeout(this.hitTimer);
    for (const un of this.unlisteners) un();
    this.unlisteners.length = 0;
    this.domAbort.abort();
    this.scene?.destroy();
    this.rigs.clear();
    this.anims?.destroy();
    this.anims = null;
    this.fx?.destroy();
    this.toasts?.destroy();
    this.app.destroy({ removeView: true }, { children: true, texture: false, textureSource: false });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const engine = new Engine();
const isDemo = document.body.dataset.demo === 'cinematic';
if (import.meta.env.DEV || isDemo) (window as unknown as { sipDuck: unknown }).sipDuck = engine.debugApi();
engine
  .start()
  .then(() => (isDemo ? engine.runDemo() : undefined))
  .catch((err) => {
    console.error('[sip-duck] failed to start', err);
    engine.destroy();
  });

if (import.meta.hot) {
  import.meta.hot.dispose(() => engine.destroy());
}
