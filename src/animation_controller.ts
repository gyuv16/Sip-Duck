/**
 * Animation controller: one `CharacterRig` interface over three asset back-ends.
 *
 *   1. Spine 2D skeletons (`.skel`/`.json` + `.atlas`) via the official
 *      `@esotericsoftware/spine-pixi-v8` runtime — mesh deformation, hair/cloth physics,
 *      animation mixing, facial expressions on a second track, attachment swapping.
 *      The runtime is code-split and only downloaded when a Spine character is configured.
 *   2. Spritesheet atlases (PNG/WEBP/AVIF + TexturePacker/Aseprite JSON).
 *   3. The built-in procedural atlas (always available as the fallback placeholder).
 *
 * Which back-end a character uses is decided by `public/assets/characters.json`:
 *
 * ```json
 * {
 *   "hero": {
 *     "type": "spine",
 *     "skeleton": "assets/hero/hero.skel",
 *     "atlas": "assets/hero/hero.atlas",
 *     "scale": 0.25,
 *     "mix": 0.2,
 *     "animations": { "idle": "idle", "walk": "walk", "collapse": "faint", "dragged": "panic-dangle" },
 *     "expressions": { "panic": "face/panic", "happy": "face/smile", "dizzy": "face/swirl" },
 *     "attachments": { "sign": { "slot": "prop-hand", "attachment": "warning-sign" } },
 *     "headY": -150
 *   },
 *   "cat": { "type": "spritesheet", "json": "assets/cat/cat.json" }
 * }
 * ```
 * Any character not listed (or failing to load) falls back to the procedural art, so a
 * broken asset never breaks the app.
 */
import { Assets, Container, Graphics, Rectangle, RenderTexture, Sprite, Text, Texture, type Renderer } from 'pixi.js';

import type { FxEngine, FxKind } from './fx_engine';
import { ALL_ANIMS, BANNER_KEY, ClipLibrary, cellFor, type ActorKind, type AnimClip, type AnimName } from './renderer';

export type Expression = 'neutral' | 'happy' | 'panic' | 'dizzy' | 'surprised' | 'determined' | 'sleepy' | 'love' | 'angry';
export type PropName = 'banner' | 'sign' | 'shout';

export interface PlayOptions {
  loop?: boolean;
  /** cross-fade duration from the previous animation (ms); default 140 */
  fadeMs?: number;
  restart?: boolean;
}

export interface CharacterRig {
  readonly kind: ActorKind;
  readonly backend: 'spine' | 'spritesheet' | 'procedural';
  readonly root: Container;
  readonly current: AnimName;
  /** a non-looping animation reached its end */
  readonly done: boolean;
  /** nominal frame rate this rig needs while animating */
  readonly fps: number;
  play(anim: AnimName, opts?: PlayOptions): boolean;
  setExpression(expr: Expression): boolean;
  /** show a held prop (or remove it with null) */
  attach(prop: PropName | null): boolean;
  setFacing(dir: 1 | -1): boolean;
  setFlipY(flip: boolean): boolean;
  setScale(scale: number): boolean;
  /** local y of the top of the head (negative, relative to the feet) */
  headY(): number;
  /** ms until the next visible change (Infinity when static) */
  msUntilNextFrame(): number;
  update(dtMs: number): boolean;
  destroy(): void;
}

// ---------------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------------

export interface SpineAttachmentRef {
  slot: string;
  attachment: string;
}

export interface CharacterManifestEntry {
  type: 'spine' | 'spritesheet';
  /** spine */
  skeleton?: string;
  atlas?: string;
  mix?: number;
  expressions?: Partial<Record<Expression, string>>;
  attachments?: Partial<Record<PropName, SpineAttachmentRef>>;
  /** spritesheet */
  json?: string;
  /** shared */
  scale?: number;
  animations?: Partial<Record<AnimName, string>>;
  headY?: number;
}

export type CharacterManifest = Partial<Record<ActorKind, CharacterManifestEntry>>;

const MANIFEST_URL = 'assets/characters.json';

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    // Dev servers / the Tauri asset protocol may answer unknown paths with index.html.
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Sprite-based rig (spritesheet + procedural)
// ---------------------------------------------------------------------------------------------

const EXPRESSION_EMOTE: Record<Expression, FxKind | null> = {
  neutral: null,
  happy: 'sparkle',
  panic: 'exclaim',
  dizzy: 'sweat',
  surprised: 'exclaim',
  determined: 'anger',
  sleepy: 'zzz',
  love: 'heart',
  angry: 'anger',
};

const DEFAULT_FADE_MS = 140;
const EMOTE_POP_MS = 160;

class SpriteRig implements CharacterRig {
  readonly root = new Container();
  private readonly body = new Container();
  private readonly cur: Sprite;
  private readonly prev: Sprite;
  private readonly emote: Sprite;
  private readonly prop: Sprite;
  private clip: AnimClip;
  private anim: AnimName = 'idle';
  private frame = 0;
  private accMs = 0;
  private finished = false;
  private fadeLeft = 0;
  private fadeTotal = 0;
  private emotePop = 0;
  private expression: Expression = 'neutral';
  private propName: PropName | null = null;
  private readonly cellH: number;

  constructor(
    readonly kind: ActorKind,
    readonly backend: 'spritesheet' | 'procedural',
    private readonly clips: (anim: AnimName) => AnimClip,
    private readonly props: Record<PropName, Texture>,
    private readonly emotes: (kind: FxKind) => Texture,
    scale: number,
  ) {
    this.cellH = cellFor(kind).h;
    this.clip = clips('idle');
    this.prev = new Sprite(this.clip.frames[0]);
    this.cur = new Sprite(this.clip.frames[0]);
    for (const s of [this.prev, this.cur]) s.anchor.set(0.5, 1);
    this.prev.visible = false;
    this.body.addChild(this.prev, this.cur);

    this.prop = new Sprite(Texture.EMPTY);
    this.prop.anchor.set(0.5, 1);
    this.prop.visible = false;
    this.emote = new Sprite(Texture.EMPTY);
    this.emote.anchor.set(0.5, 1);
    this.emote.visible = false;

    this.root.addChild(this.body, this.prop, this.emote);
    this.root.scale.set(scale);
    this.layoutOverlays();
  }

  get current(): AnimName {
    return this.anim;
  }

  get done(): boolean {
    return this.finished;
  }

  get fps(): number {
    return this.fadeLeft > 0 || this.emotePop > 0 ? 60 : this.clip.fps;
  }

  headY(): number {
    return -this.cellH * 0.82;
  }

  private layoutOverlays(): void {
    const top = this.headY();
    this.prop.position.set(0, top + 8);
    this.emote.position.set(18, top - (this.prop.visible ? this.prop.height : 0) - 2);
  }

  play(anim: AnimName, opts: PlayOptions = {}): boolean {
    if (anim === this.anim && !opts.restart) return false;
    const fade = opts.fadeMs ?? DEFAULT_FADE_MS;
    if (fade > 0) {
      this.prev.texture = this.cur.texture;
      this.prev.alpha = 1;
      this.prev.visible = true;
      this.fadeLeft = this.fadeTotal = fade;
      this.cur.alpha = 0;
    }
    this.anim = anim;
    this.clip = this.clips(anim);
    const loop = opts.loop ?? this.clip.loop;
    if (loop !== this.clip.loop) this.clip = { ...this.clip, loop };
    this.frame = 0;
    this.accMs = 0;
    this.finished = false;
    this.cur.texture = this.clip.frames[0];
    return true;
  }

  setExpression(expr: Expression): boolean {
    if (expr === this.expression) return false;
    this.expression = expr;
    const kind = EXPRESSION_EMOTE[expr];
    if (!kind) {
      this.emote.visible = false;
      return true;
    }
    this.emote.texture = this.emotes(kind);
    this.emote.visible = true;
    this.emote.scale.set(0.2);
    this.emotePop = EMOTE_POP_MS;
    return true;
  }

  attach(prop: PropName | null): boolean {
    if (prop === this.propName) return false;
    this.propName = prop;
    if (prop) {
      this.prop.texture = this.props[prop];
      this.prop.visible = true;
    } else {
      this.prop.visible = false;
    }
    this.layoutOverlays();
    return true;
  }

  setFacing(dir: 1 | -1): boolean {
    if (this.body.scale.x === dir) return false;
    this.body.scale.x = dir;
    return true;
  }

  setFlipY(flip: boolean): boolean {
    const want = flip ? -1 : 1;
    if (this.body.scale.y === want) return false;
    this.body.scale.y = want;
    this.body.y = flip ? -this.cellH : 0;
    return true;
  }

  setScale(scale: number): boolean {
    if (this.root.scale.x === scale) return false;
    this.root.scale.set(scale);
    return true;
  }

  msUntilNextFrame(): number {
    if (this.fadeLeft > 0 || this.emotePop > 0) return 0;
    if (this.finished || this.clip.frames.length < 2) return Infinity;
    return Math.max(0, 1000 / this.clip.fps - this.accMs);
  }

  update(dtMs: number): boolean {
    let changed = false;

    if (this.fadeLeft > 0) {
      this.fadeLeft = Math.max(0, this.fadeLeft - dtMs);
      const t = 1 - this.fadeLeft / this.fadeTotal;
      // Smoothstep cross-fade: outgoing pose dissolves while the new one appears.
      const e = t * t * (3 - 2 * t);
      this.cur.alpha = e;
      this.prev.alpha = 1 - e;
      if (this.fadeLeft === 0) this.prev.visible = false;
      changed = true;
    }

    if (this.emotePop > 0) {
      this.emotePop = Math.max(0, this.emotePop - dtMs);
      const t = 1 - this.emotePop / EMOTE_POP_MS;
      // Overshoot "pop" like a manga emote.
      this.emote.scale.set(t < 0.7 ? (t / 0.7) * 1.25 : 1.25 - ((t - 0.7) / 0.3) * 0.25);
      changed = true;
    }

    if (!this.finished && this.clip.frames.length > 1) {
      this.accMs += dtMs;
      const step = 1000 / this.clip.fps;
      if (this.accMs >= step) {
        const n = Math.floor(this.accMs / step);
        this.accMs -= n * step;
        let next = this.frame + n;
        if (next >= this.clip.frames.length) {
          if (this.clip.loop) next %= this.clip.frames.length;
          else {
            next = this.clip.frames.length - 1;
            this.finished = true;
          }
        }
        if (next !== this.frame) {
          this.frame = next;
          this.cur.texture = this.clip.frames[next];
          changed = true;
        }
      }
    }
    return changed;
  }

  destroy(): void {
    this.root.destroy({ children: true, texture: false, textureSource: false });
  }
}

// ---------------------------------------------------------------------------------------------
// Spine rig
// ---------------------------------------------------------------------------------------------

type SpineModule = typeof import('@esotericsoftware/spine-pixi-v8');
type SpineObject = InstanceType<SpineModule['Spine']>;

class SpineRig implements CharacterRig {
  readonly backend = 'spine' as const;
  readonly root = new Container();
  private anim: AnimName = 'idle';
  private loop = true;
  private expression: Expression = 'neutral';
  private propName: PropName | null = null;
  private facing: 1 | -1 = 1;
  private flipY = false;

  constructor(readonly kind: ActorKind, private readonly spine: SpineObject, private readonly cfg: CharacterManifestEntry) {
    spine.autoUpdate = false;
    spine.state.data.defaultMix = cfg.mix ?? 0.2;
    this.root.addChild(spine);
    this.play('idle', { fadeMs: 0, restart: true });
  }

  get current(): AnimName {
    return this.anim;
  }

  get done(): boolean {
    const entry = this.spine.state.getTrack(0);
    return !this.loop && !!entry && entry.isComplete();
  }

  get fps(): number {
    return 30;
  }

  headY(): number {
    return this.cfg.headY ?? -cellFor(this.kind).h * 0.82;
  }

  private resolve(anim: AnimName): string | null {
    const data = this.spine.skeleton.data;
    const wanted = this.cfg.animations?.[anim] ?? anim;
    if (data.findAnimation(wanted)) return wanted;
    const idle = this.cfg.animations?.idle ?? 'idle';
    return data.findAnimation(idle) ? idle : data.animations[0]?.name ?? null;
  }

  play(anim: AnimName, opts: PlayOptions = {}): boolean {
    if (anim === this.anim && !opts.restart) return false;
    const name = this.resolve(anim);
    if (!name) return false;
    this.anim = anim;
    this.loop = opts.loop ?? !(anim === 'collapse');
    const entry = this.spine.state.setAnimation(0, name, this.loop);
    if (opts.fadeMs !== undefined) entry.mixDuration = opts.fadeMs / 1000;
    return true;
  }

  setExpression(expr: Expression): boolean {
    if (expr === this.expression) return false;
    this.expression = expr;
    const name = this.cfg.expressions?.[expr];
    if (name && this.spine.skeleton.data.findAnimation(name)) this.spine.state.setAnimation(1, name, true);
    else this.spine.state.setEmptyAnimation(1, 0.15);
    return true;
  }

  attach(prop: PropName | null): boolean {
    if (prop === this.propName) return false;
    const old = this.propName ? this.cfg.attachments?.[this.propName] : undefined;
    if (old) this.spine.skeleton.setAttachment(old.slot, null);
    this.propName = prop;
    const ref = prop ? this.cfg.attachments?.[prop] : undefined;
    if (ref) this.spine.skeleton.setAttachment(ref.slot, ref.attachment);
    return true;
  }

  setFacing(dir: 1 | -1): boolean {
    if (dir === this.facing) return false;
    this.facing = dir;
    this.spine.scale.x = Math.abs(this.spine.scale.x) * dir;
    return true;
  }

  setFlipY(flip: boolean): boolean {
    if (flip === this.flipY) return false;
    this.flipY = flip;
    this.spine.scale.y = Math.abs(this.spine.scale.y) * (flip ? -1 : 1);
    this.spine.y = flip ? this.headY() : 0;
    return true;
  }

  setScale(scale: number): boolean {
    if (this.root.scale.x === scale) return false;
    this.root.scale.set(scale);
    return true;
  }

  msUntilNextFrame(): number {
    return this.done ? Infinity : 0;
  }

  update(dtMs: number): boolean {
    if (this.done && this.spine.state.getTrack(1) === null) return false;
    this.spine.update(dtMs / 1000);
    return true;
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------------------------

function bakeProps(renderer: Renderer, bannerTexture: Texture): { textures: Record<PropName, Texture>; atlas: RenderTexture; frames: Texture[]; extra: RenderTexture[] } {
  // Giant cartoon warning sign held overhead during the sedentary wake-up call.
  const W = 230;
  const H = 120;
  const root = new Container();
  const g = new Graphics();
  g.moveTo(40, H).lineTo(40, 70).moveTo(W - 40, H).lineTo(W - 40, 70).stroke({ width: 6, color: 0x8b5a2b, cap: 'round' });
  g.roundRect(4, 4, W - 8, 76, 10).fill(0xffd23f).stroke({ width: 5, color: 0x2b2440 });
  g.roundRect(12, 12, W - 24, 60, 6).stroke({ width: 2, color: 0x2b2440, alpha: 0.5 });
  root.addChild(g);
  const title = new Text({ text: '⚠ 45+ MIN! ⚠', style: { fontFamily: 'system-ui, Segoe UI, sans-serif', fontSize: 22, fontWeight: '900', fill: 0xff3d3d, stroke: { color: 0xffffff, width: 4 } } });
  title.anchor.set(0.5);
  title.position.set(W / 2, 30);
  const sub = new Text({ text: 'GET UP & MOVE!', style: { fontFamily: 'system-ui, Segoe UI, sans-serif', fontSize: 17, fontWeight: '900', fill: 0x2b2440 } });
  sub.anchor.set(0.5);
  sub.position.set(W / 2, 57);
  root.addChild(title, sub);

  const resolution = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
  const atlas = RenderTexture.create({ width: W, height: H, resolution, antialias: true });
  renderer.render({ container: root, target: atlas, clear: true, clearColor: [0, 0, 0, 0] });
  root.destroy({ children: true, texture: true, textureSource: true });
  const sign = new Texture({ source: atlas.source, frame: new Rectangle(0, 0, W, H) });
  const shout = bakeShout(renderer);
  return { textures: { sign, banner: bannerTexture, shout: shout.texture }, atlas, frames: [sign, shout.texture], extra: [shout.atlas] };
}

/** Explosive manga speech bubble (jagged starburst) for the hydration alarm. */
function bakeShout(renderer: Renderer): { texture: Texture; atlas: RenderTexture } {
  const W = 250;
  const H = 136;
  const cx = W / 2;
  const cy = H / 2 - 8;
  const spikes = 18;
  const pts: number[] = [];
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? 1 : 0.8 + ((i * 37) % 7) / 60;
    pts.push(cx + Math.cos(a) * (W / 2 - 6) * r, cy + Math.sin(a) * (H / 2 - 18) * r);
  }
  const root = new Container();
  const g = new Graphics();
  // Tail pointing down to the speaker's hand.
  g.poly([cx - 18, cy + 30, cx + 6, cy + 34, cx - 6, H - 2]).fill(0xffffff).stroke({ width: 4, color: 0xff3d3d, join: 'round' });
  g.poly(pts).fill(0xffffff).stroke({ width: 5, color: 0xff3d3d, join: 'miter' });
  g.poly(pts.map((v, i) => (i % 2 === 0 ? cx + (v - cx) * 0.86 : cy + (v - cy) * 0.86))).fill(0xfff1a8);
  root.addChild(g);
  const lines = ['SIP BUDDY IS', 'FAINTING FROM', 'THIRST!'];
  lines.forEach((line, i) => {
    const t = new Text({
      text: line,
      style: { fontFamily: 'Impact, system-ui, Segoe UI, sans-serif', fontSize: i === 2 ? 22 : 16, fontWeight: '900', fill: i === 2 ? 0xff2d55 : 0x2b2440, stroke: { color: 0xffffff, width: 3 }, letterSpacing: 0.5 },
    });
    t.anchor.set(0.5);
    t.position.set(cx, cy - 20 + i * 19 + (i === 2 ? 3 : 0));
    t.rotation = -0.04;
    root.addChild(t);
  });
  const resolution = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
  const atlas = RenderTexture.create({ width: W, height: H, resolution, antialias: true });
  renderer.render({ container: root, target: atlas, clear: true, clearColor: [0, 0, 0, 0] });
  root.destroy({ children: true, texture: true, textureSource: true });
  return { texture: new Texture({ source: atlas.source, frame: new Rectangle(0, 0, W, H) }), atlas };
}

export class AnimationController {
  private spineModule: SpineModule | null = null;
  private readonly spineAliases: string[] = [];
  private readonly rigs = new Set<CharacterRig>();
  private readonly propAtlases: RenderTexture[] = [];
  private readonly propFrames: Texture[] = [];
  private props!: Record<PropName, Texture>;

  private constructor(
    private readonly lib: ClipLibrary,
    private readonly fx: FxEngine,
    private readonly manifest: CharacterManifest,
    private readonly sheetKinds: ReadonlySet<ActorKind>,
  ) {}

  /**
   * Loads every configured asset for `kinds`. Spine characters that fail to load are
   * reported and transparently replaced by the procedural fallback.
   */
  static async create(renderer: Renderer, kinds: readonly ActorKind[], fx: FxEngine, manifestUrl = MANIFEST_URL): Promise<AnimationController> {
    const manifest = (await fetchJson<CharacterManifest>(manifestUrl)) ?? {};
    const unique = [...new Set(kinds)];

    const sheetUrls: Partial<Record<ActorKind, string>> = {};
    for (const kind of unique) {
      const entry = manifest[kind];
      if (entry?.type === 'spritesheet' && entry.json) sheetUrls[kind] = entry.json;
    }
    const lib = await ClipLibrary.build(renderer, unique, sheetUrls, (kind, anim) => manifest[kind]?.animations?.[anim]);
    const ctl = new AnimationController(lib, fx, manifest, new Set(unique.filter((k) => lib.isExternal(k))));
    const baked = bakeProps(renderer, lib.effect(BANNER_KEY));
    ctl.props = baked.textures;
    ctl.propAtlases.push(baked.atlas, ...baked.extra);
    ctl.propFrames.push(...baked.frames);

    const spineKinds = unique.filter((k) => manifest[k]?.type === 'spine' && manifest[k]?.skeleton && manifest[k]?.atlas);
    if (spineKinds.length) await ctl.loadSpine(spineKinds);
    return ctl;
  }

  private async loadSpine(kinds: ActorKind[]): Promise<void> {
    try {
      // Code-split: the Spine runtime is only fetched when a Spine character is configured.
      this.spineModule = await import('@esotericsoftware/spine-pixi-v8');
    } catch (err) {
      console.warn('[sip-duck] Spine runtime unavailable, using fallback art', err);
      return;
    }
    for (const kind of kinds) {
      const cfg = this.manifest[kind]!;
      const skel = `${kind}-skeleton`;
      const atlas = `${kind}-atlas`;
      try {
        if (!Assets.cache.has(skel)) Assets.add({ alias: skel, src: cfg.skeleton! });
        if (!Assets.cache.has(atlas)) Assets.add({ alias: atlas, src: cfg.atlas! });
        await Assets.load([skel, atlas]);
        this.spineAliases.push(skel, atlas);
      } catch (err) {
        console.warn(`[sip-duck] failed to load Spine assets for ${kind}; using fallback art`, err);
        this.manifest[kind] = undefined;
      }
    }
  }

  /** Creates a rig for `kind` using the best available back-end. */
  createRig(kind: ActorKind, scale = 1): CharacterRig {
    const cfg = this.manifest[kind];
    let rig: CharacterRig;
    if (cfg?.type === 'spine' && this.spineModule && this.spineAliases.includes(`${kind}-skeleton`)) {
      const spine = this.spineModule.Spine.from({ skeleton: `${kind}-skeleton`, atlas: `${kind}-atlas`, scale: cfg.scale ?? 1, autoUpdate: false });
      rig = new SpineRig(kind, spine, cfg);
      rig.setScale(scale);
    } else {
      rig = new SpriteRig(
        kind,
        this.sheetKinds.has(kind) ? 'spritesheet' : 'procedural',
        (anim) => this.lib.get(kind, anim),
        this.props,
        (k) => this.fx.texture(k),
        scale * (cfg?.type === 'spritesheet' ? cfg.scale ?? 1 : 1),
      );
    }
    this.rigs.add(rig);
    return rig;
  }

  releaseRig(rig: CharacterRig): void {
    if (this.rigs.delete(rig)) rig.destroy();
  }

  /** Every animation name the procedural fallback provides (for tooling / docs). */
  static readonly animations = ALL_ANIMS;

  destroy(): void {
    for (const rig of this.rigs) rig.destroy();
    this.rigs.clear();
    for (const t of this.propFrames) t.destroy(false);
    this.propFrames.length = 0;
    for (const a of this.propAtlases) a.destroy(true);
    this.propAtlases.length = 0;
    for (const alias of this.spineAliases) void Assets.unload(alias);
    this.spineAliases.length = 0;
    this.lib.destroy();
  }
}
