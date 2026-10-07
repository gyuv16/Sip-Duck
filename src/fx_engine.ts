/**
 * Lightweight overlay FX / particle system.
 *
 * - Every effect texture (water droplet, sparkle, heart, anime sweat drop, "Z", dust puff,
 *   paper sheet, "!" mark, anger vein) is baked ONCE into a tiny private atlas.
 * - A fixed pool of sprites is allocated up front; bursts and emitters only recycle them, so
 *   the system never allocates during animation and never leaks textures.
 * - Emitters can follow a moving point (e.g. a character's head) and run for a duration.
 * - `update()` reports whether anything is alive so the frame scheduler can drop to 0 FPS
 *   as soon as the last particle disappears.
 */
import { Container, Graphics, Rectangle, RenderTexture, Sprite, Text, Texture, type Renderer } from 'pixi.js';

export type FxKind =
  | 'droplet'
  | 'sparkle'
  | 'heart'
  | 'sweat'
  | 'zzz'
  | 'dust'
  | 'paper'
  | 'exclaim'
  | 'anger'
  | 'glitch';

interface FxProfile {
  /** initial speed range (px/s) */
  speed: [number, number];
  /** emission angle centre (radians, 0 = right, -PI/2 = up) and spread */
  angle: number;
  spread: number;
  gravity: number;
  /** lifetime range (s) */
  life: [number, number];
  scale: [number, number];
  /** scale change per second (negative shrinks) */
  grow: number;
  spin: number;
  /** horizontal sine wobble amplitude (px/s) */
  wobble: number;
  /** stop at the floor instead of falling through */
  floorStop: boolean;
}

const PROFILES: Record<FxKind, FxProfile> = {
  droplet: { speed: [160, 420], angle: -Math.PI / 2, spread: Math.PI * 0.9, gravity: 950, life: [0.8, 1.3], scale: [0.6, 1.2], grow: -0.2, spin: 0, wobble: 0, floorStop: true },
  sparkle: { speed: [60, 240], angle: -Math.PI / 2, spread: Math.PI * 2, gravity: -40, life: [0.6, 1.1], scale: [0.5, 1.1], grow: -0.6, spin: 4, wobble: 0, floorStop: false },
  heart: { speed: [30, 70], angle: -Math.PI / 2, spread: 0.6, gravity: -30, life: [1.4, 2.0], scale: [0.6, 1.0], grow: 0.15, spin: 0, wobble: 40, floorStop: false },
  sweat: { speed: [40, 90], angle: -Math.PI / 4, spread: 0.8, gravity: 520, life: [0.5, 0.8], scale: [0.7, 1.0], grow: 0, spin: 0, wobble: 0, floorStop: true },
  zzz: { speed: [18, 30], angle: -Math.PI / 2 + 0.35, spread: 0.3, gravity: -6, life: [2.2, 2.8], scale: [0.5, 0.7], grow: 0.35, spin: 0.2, wobble: 14, floorStop: false },
  dust: { speed: [20, 70], angle: -Math.PI / 2, spread: Math.PI * 0.8, gravity: -20, life: [0.4, 0.7], scale: [0.5, 0.9], grow: 1.2, spin: 1, wobble: 0, floorStop: false },
  paper: { speed: [140, 260], angle: -Math.PI / 2, spread: 1.2, gravity: 520, life: [1.6, 2.2], scale: [0.8, 1.1], grow: 0, spin: 6, wobble: 60, floorStop: true },
  exclaim: { speed: [0, 0], angle: -Math.PI / 2, spread: 0, gravity: 0, life: [0.7, 0.7], scale: [1, 1], grow: 0, spin: 0, wobble: 0, floorStop: false },
  glitch: { speed: [10, 60], angle: 0, spread: Math.PI * 2, gravity: 0, life: [0.18, 0.4], scale: [0.8, 1.7], grow: 0, spin: 0, wobble: 0, floorStop: false },
  anger: { speed: [0, 10], angle: -Math.PI / 2, spread: 0.3, gravity: 0, life: [0.6, 0.6], scale: [0.9, 1.0], grow: 0.4, spin: 0, wobble: 0, floorStop: false },
};

const CELL = 24;
const KINDS: readonly FxKind[] = ['droplet', 'sparkle', 'heart', 'sweat', 'zzz', 'dust', 'paper', 'exclaim', 'anger', 'glitch'];

function paintFx(kind: FxKind, g: Graphics, holder: Container): void {
  const c = CELL / 2;
  switch (kind) {
    case 'droplet':
      g.poly([c, 3, c - 6, c + 3, c + 6, c + 3]).fill(0x5ec2ff);
      g.circle(c, c + 4, 6.5).fill(0x5ec2ff);
      g.circle(c - 2.5, c + 2, 2).fill({ color: 0xffffff, alpha: 0.85 });
      break;
    case 'sparkle':
      g.poly([c, 2, c + 2.4, c - 2.4, c + 10, c, c + 2.4, c + 2.4, c, CELL - 2, c - 2.4, c + 2.4, c - 10, c, c - 2.4, c - 2.4]).fill(0xfff38a);
      g.circle(c, c, 2.2).fill(0xffffff);
      break;
    case 'heart':
      g.circle(c - 4.5, c - 2, 5.5).fill(0xff4d7d);
      g.circle(c + 4.5, c - 2, 5.5).fill(0xff4d7d);
      g.poly([c - 10, c, c + 10, c, c, c + 10]).fill(0xff4d7d);
      g.circle(c - 6, c - 4, 1.6).fill({ color: 0xffffff, alpha: 0.8 });
      break;
    case 'sweat':
      g.poly([c, 2, c - 5, c + 2, c + 5, c + 2]).fill(0x9fdcff);
      g.circle(c, c + 3, 5.5).fill(0x9fdcff);
      g.circle(c - 2, c + 2, 1.6).fill(0xffffff);
      g.stroke({ width: 1, color: 0x4f9bd9 });
      break;
    case 'zzz': {
      const t = new Text({ text: 'Z', style: { fontFamily: 'system-ui, sans-serif', fontSize: 20, fontWeight: '900', fill: 0x8ab4ff, stroke: { color: 0xffffff, width: 3 } } });
      t.anchor.set(0.5);
      t.position.set(c, c);
      holder.addChild(t);
      return;
    }
    case 'dust':
      g.circle(c - 4, c + 2, 6).fill({ color: 0xd9d4e6, alpha: 0.85 });
      g.circle(c + 4, c + 1, 7).fill({ color: 0xe8e4f2, alpha: 0.85 });
      g.circle(c, c - 4, 6).fill({ color: 0xf4f2fa, alpha: 0.9 });
      break;
    case 'paper':
      g.rect(c - 7, c - 9, 14, 18).fill(0xffffff).stroke({ width: 1, color: 0xb9b4cc });
      for (let i = 0; i < 4; i++) g.moveTo(c - 4, c - 5 + i * 4).lineTo(c + 4, c - 5 + i * 4).stroke({ width: 1, color: 0x8fb3ff });
      break;
    case 'exclaim': {
      const t = new Text({ text: '!!', style: { fontFamily: 'system-ui, sans-serif', fontSize: 20, fontWeight: '900', fill: 0xff3d5a, stroke: { color: 0xffffff, width: 4 } } });
      t.anchor.set(0.5);
      t.position.set(c, c);
      holder.addChild(t);
      return;
    }
    case 'glitch':
      // Screen-tearing slice: offset RGB-split bars.
      g.rect(1, c - 7, CELL - 2, 3).fill({ color: 0x00e5ff, alpha: 0.75 });
      g.rect(5, c - 2, CELL - 6, 4).fill({ color: 0xff2bd6, alpha: 0.7 });
      g.rect(0, c + 4, CELL - 8, 2).fill({ color: 0xffffff, alpha: 0.85 });
      g.rect(8, c + 8, CELL - 10, 2).fill({ color: 0x00e5ff, alpha: 0.6 });
      break;
    case 'anger': {
      const s = { width: 3, color: 0xff3d5a, cap: 'round' as const };
      g.moveTo(c - 8, c - 3).quadraticCurveTo(c - 3, c - 3, c - 3, c - 8).stroke(s);
      g.moveTo(c + 3, c - 8).quadraticCurveTo(c + 3, c - 3, c + 8, c - 3).stroke(s);
      g.moveTo(c + 8, c + 3).quadraticCurveTo(c + 3, c + 3, c + 3, c + 8).stroke(s);
      g.moveTo(c - 3, c + 8).quadraticCurveTo(c - 3, c + 3, c - 8, c + 3).stroke(s);
      break;
    }
  }
  holder.addChild(g);
}

interface Particle {
  sprite: Sprite;
  kind: FxKind;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  grow: number;
  spin: number;
  wobble: number;
  phase: number;
  gravity: number;
  floorStop: boolean;
}

export interface EmitterOptions {
  /** particles per second */
  rate: number;
  /** seconds; Infinity = until stopped */
  duration: number;
  /**
   * Current spawn point. `null` stops the emitter for good; `undefined` skips this tick
   * (e.g. only puff dust while the character is actually moving).
   */
  at: () => { x: number; y: number } | null | undefined;
  count?: number;
}

interface Emitter extends EmitterOptions {
  id: number;
  kind: FxKind;
  acc: number;
  elapsed: number;
  /** last tick skipped (at() returned undefined): don't keep the renderer awake for it */
  waiting: boolean;
}

export class FxEngine {
  readonly root = new Container();
  private readonly textures = new Map<FxKind, Texture>();
  private readonly frames: Texture[] = [];
  private atlas: RenderTexture | null = null;
  private readonly pool: Particle[] = [];
  private readonly emitters: Emitter[] = [];
  private alive = 0;
  private cursor = 0;
  private nextEmitterId = 1;
  private hadLive = false;

  constructor(renderer: Renderer, poolSize = 96) {
    this.bake(renderer);
    for (let i = 0; i < poolSize; i++) {
      const sprite = new Sprite(Texture.EMPTY);
      sprite.anchor.set(0.5);
      sprite.visible = false;
      this.root.addChild(sprite);
      this.pool.push({ sprite, kind: 'droplet', vx: 0, vy: 0, life: 0, maxLife: 1, grow: 0, spin: 0, wobble: 0, phase: 0, gravity: 0, floorStop: false });
    }
  }

  private bake(renderer: Renderer): void {
    const resolution = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
    const root = new Container();
    KINDS.forEach((kind, i) => {
      const holder = new Container();
      holder.position.set(i * (CELL + 2), 0);
      paintFx(kind, new Graphics(), holder);
      root.addChild(holder);
    });
    const atlas = RenderTexture.create({ width: KINDS.length * (CELL + 2), height: CELL, resolution, antialias: true });
    renderer.render({ container: root, target: atlas, clear: true, clearColor: [0, 0, 0, 0] });
    root.destroy({ children: true, texture: true, textureSource: true });
    this.atlas = atlas;
    KINDS.forEach((kind, i) => {
      const tex = new Texture({ source: atlas.source, frame: new Rectangle(i * (CELL + 2), 0, CELL, CELL) });
      this.frames.push(tex);
      this.textures.set(kind, tex);
    });
  }

  /** Texture for a kind (used by the animation controller for emote icons). */
  texture(kind: FxKind): Texture {
    return this.textures.get(kind) ?? Texture.EMPTY;
  }

  /**
   * True while particles are alive or an emitter is actively spawning. Waiting emitters
   * don't count, so the scheduler can still freeze; a state change wakes it to re-check.
   */
  get busy(): boolean {
    return this.alive > 0 || this.emitters.some((e) => !e.waiting);
  }

  /** One-shot burst. */
  burst(kind: FxKind, x: number, y: number, count: number): void {
    for (let i = 0; i < count; i++) this.spawn(kind, x, y);
  }

  /** Continuous emitter; returns an id for `stop()`. */
  emit(kind: FxKind, opts: EmitterOptions): number {
    const id = this.nextEmitterId++;
    this.emitters.push({ ...opts, id, kind, acc: 0, elapsed: 0, waiting: false });
    return id;
  }

  stop(id: number): void {
    const i = this.emitters.findIndex((e) => e.id === id);
    if (i >= 0) this.emitters.splice(i, 1);
  }

  stopAll(): void {
    this.emitters.length = 0;
  }

  private spawn(kind: FxKind, x: number, y: number): void {
    // Round-robin search: when the pool is exhausted the oldest slot is recycled.
    let p: Particle | null = null;
    for (let n = 0; n < this.pool.length; n++) {
      const cand = this.pool[(this.cursor + n) % this.pool.length];
      if (cand.life <= 0) {
        p = cand;
        this.cursor = (this.cursor + n + 1) % this.pool.length;
        break;
      }
    }
    if (!p) {
      p = this.pool[this.cursor];
      this.cursor = (this.cursor + 1) % this.pool.length;
      this.alive--;
    }
    const pr = PROFILES[kind];
    const a = pr.angle + (Math.random() - 0.5) * pr.spread;
    const speed = pr.speed[0] + Math.random() * (pr.speed[1] - pr.speed[0]);
    const life = pr.life[0] + Math.random() * (pr.life[1] - pr.life[0]);
    p.kind = kind;
    p.vx = Math.cos(a) * speed;
    p.vy = Math.sin(a) * speed;
    p.life = life;
    p.maxLife = life;
    p.grow = pr.grow;
    p.spin = (Math.random() - 0.5) * 2 * pr.spin;
    p.wobble = pr.wobble;
    p.phase = Math.random() * Math.PI * 2;
    p.gravity = pr.gravity;
    p.floorStop = pr.floorStop;
    const s = p.sprite;
    s.texture = this.texture(kind);
    s.position.set(x, y);
    s.rotation = 0;
    s.alpha = 1;
    s.scale.set(pr.scale[0] + Math.random() * (pr.scale[1] - pr.scale[0]));
    s.visible = true;
    this.alive++;
  }

  /** Advance everything. Returns true when something visible changed. */
  update(dt: number, floor: number): boolean {
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i];
      e.elapsed += dt;
      const at = e.at();
      if (at === null || e.elapsed >= e.duration) {
        this.emitters.splice(i, 1);
        continue;
      }
      e.waiting = !at;
      if (!at) {
        e.acc = 0;
        continue;
      }
      e.acc += dt * e.rate;
      while (e.acc >= 1) {
        e.acc -= 1;
        for (let k = 0; k < (e.count ?? 1); k++) this.spawn(e.kind, at.x, at.y);
      }
    }

    if (this.alive === 0) {
      // One more frame after the last particle died so it gets erased.
      const changed = this.hadLive;
      this.hadLive = false;
      return changed;
    }
    this.hadLive = true;

    for (const p of this.pool) {
      if (p.life <= 0) continue;
      p.life -= dt;
      const s = p.sprite;
      if (p.life <= 0) {
        s.visible = false;
        this.alive--;
        continue;
      }
      p.vy += p.gravity * dt;
      p.phase += dt * 4;
      s.x += (p.vx + Math.sin(p.phase) * p.wobble) * dt;
      s.y += p.vy * dt;
      if (p.floorStop && s.y > floor - 3) {
        s.y = floor - 3;
        p.vx *= 0.8;
        p.vy = 0;
        p.spin = 0;
        s.rotation = 0;
      }
      s.rotation += p.spin * dt;
      if (p.grow !== 0) s.scale.set(Math.max(0.05, s.scale.x + p.grow * dt));
      const t = p.life / p.maxLife;
      s.alpha = t < 0.35 ? t / 0.35 : 1;
    }
    return true;
  }

  destroy(): void {
    this.emitters.length = 0;
    this.pool.length = 0;
    this.root.destroy({ children: true, texture: false, textureSource: false });
    for (const t of this.frames) t.destroy(false);
    this.frames.length = 0;
    this.textures.clear();
    this.atlas?.destroy(true);
    this.atlas = null;
  }
}
