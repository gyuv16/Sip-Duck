/**
 * Scene manager: action queue + coordinated multi-character choreography.
 *
 * The Director (state_machine.ts) owns each character's logical state and default physics.
 * The SceneManager layers two things on top:
 *
 *  1. **Reactive presentation** — expressions, held props, emitters and z-order derived from
 *     each actor's state (panic + sweat when dragged, dizzy sweat when thirsty, Zzz when asleep,
 *     cheer + water sparkles after drinking, banner while stretching…).
 *  2. **Choreographies** — scripted pair actions built from small composable actions
 *     (`moveTo`, `follow`, `jumpTo`, `wait`, `set`, `fx`) run as per-actor queues in parallel.
 *     While scripted, an actor's position and animation come from here; the Director skips it.
 *
 * Sedentary wake-up calls per scene mode:
 *   - Couple:  the heroine drags the male lead across the screen by his hoodie, OR both hold
 *              a giant warning sign.
 *   - Pet:     cat jumps onto the human's head and rides there, OR does zoomies across the
 *              screen knocking (fake) papers off the desktop.
 *   - Solo:    the Director's whistle-and-banner routine.
 */
import type { CharacterRig, Expression, PropName } from './animation_controller';
import type { FxEngine } from './fx_engine';
import type { AnimName } from './renderer';
import { CharState, type Actor, type Director } from './state_machine';

export interface ActorHandle {
  actor: Actor;
  rig: CharacterRig;
}

/** One step of an actor's queue. `update` returns true when the step is finished. */
interface Action {
  start?(): void;
  update(dt: number): boolean;
}

interface Track {
  actor: Actor;
  queue: Action[];
  current: Action | null;
}

interface Choreography {
  name: string;
  tracks: Track[];
  /** actors under scripted control (released when the choreography ends) */
  cast: Actor[];
}

interface ScriptedLook {
  anim: AnimName;
  expression?: Expression;
  prop?: PropName | null;
  z?: number;
}

const RUN_SPEED = 220;
const DRAG_SPEED = 130;
/** The giant sign is held this long, then the (low-FPS) stretch-banner routine takes over. */
const SIGN_HOLD_SECS = 20;

export class SceneManager {
  private readonly handles = new Map<number, ActorHandle>();
  private choreo: Choreography | null = null;
  private readonly looks = new Map<number, ScriptedLook>();
  private readonly emitters = new Map<number, number[]>();
  private readonly hops = new Map<number, number>();
  /** actor id -> id of the actor whose head it sits on */
  private readonly riding = new Map<number, number>();

  constructor(
    private readonly director: Director,
    private readonly fx: FxEngine,
    private readonly world: () => { width: number; floor: number },
    private readonly rng: () => number = () => Math.random(),
  ) {}

  setCast(handles: ActorHandle[]): void {
    this.cancel();
    for (const ids of this.emitters.values()) for (const id of ids) this.fx.stop(id);
    this.emitters.clear();
    this.handles.clear();
    this.hops.clear();
    for (const h of handles) this.handles.set(h.actor.id, h);
    for (const h of handles) this.onStateChange(h.actor, h.actor.state);
  }

  get busy(): boolean {
    return this.choreo !== null || this.hops.size > 0;
  }

  /** Running choreography, e.g. `pull+headHop`, `sign`, `zoomies`. */
  get running(): string | null {
    return this.choreo?.name ?? null;
  }

  // ----------------------------------------------------------------------------- lookup

  private find(kind: Actor['kind']): ActorHandle | undefined {
    for (const h of this.handles.values()) if (h.actor.kind === kind) return h;
    return undefined;
  }

  private headOf(h: ActorHandle): { x: number; y: number } {
    return { x: h.actor.body.x, y: h.actor.body.y + h.rig.headY() * h.rig.root.scale.y };
  }

  // ----------------------------------------------------------------------------- presentation

  /** Animation for an actor this frame (scripted look wins over the Director). */
  animFor(actor: Actor): AnimName {
    if (actor.scripted) {
      const look = this.looks.get(actor.id);
      if (look) return look.anim;
    }
    if (this.riding.has(actor.id)) return 'idle';
    if (this.petFainting(actor)) return 'collapse';
    // The male lead raises the explosive "fainting from thirst" bubble instead of fainting.
    if (actor.kind === 'partner' && actor.state === CharState.Thirsty) return 'stretch';
    return this.director.animFor(actor);
  }

  /** During a hydration alert pets dramatically faint against the taskbar. */
  private petFainting(actor: Actor): boolean {
    return !actor.human && !actor.flying && this.director.pendingHydration && (actor.state === CharState.Idle || actor.state === CharState.Follow || actor.state === CharState.Interact);
  }

  /** Who holds the "SIP BUDDY IS FAINTING FROM THIRST!" bubble: the partner, else the hero. */
  private shouter(): Actor | undefined {
    return (this.find('partner') ?? this.find('hero'))?.actor;
  }

  /** Start hydration-alert ambience: water droplets raining over fainted pets. */
  onHydrationAlert(): void {
    for (const h of this.handles.values()) {
      const a = h.actor;
      if (a.human || a.flying) continue;
      this.track(a.id, this.fx.emit('droplet', {
        rate: 3,
        duration: Infinity,
        at: () => (this.handles.has(a.id) && this.director.pendingHydration ? (this.petFainting(a) ? { x: a.body.x + (this.rng() - 0.5) * 40, y: a.body.y - 30 } : undefined) : null),
      }));
    }
  }

  expressionFor(actor: Actor): Expression {
    const look = actor.scripted ? this.looks.get(actor.id) : undefined;
    if (look?.expression) return look.expression;
    if (this.petFainting(actor)) return 'dizzy';
    switch (actor.state) {
      case CharState.Dragged: return 'panic';
      case CharState.Falling: return 'surprised';
      case CharState.Thirsty: return actor.kind === 'partner' ? 'panic' : 'dizzy';
      case CharState.Drinking: return 'happy';
      case CharState.Celebrate: return actor.human ? 'happy' : 'love';
      case CharState.SittingTooLong: return 'determined';
      case CharState.Stretching: return 'determined';
      case CharState.Sleeping: return 'sleepy';
      case CharState.Interact: return 'love';
      default: return 'neutral';
    }
  }

  propFor(actor: Actor): PropName | null {
    const look = actor.scripted ? this.looks.get(actor.id) : undefined;
    if (look && look.prop !== undefined) return look.prop;
    if (actor.human && actor.state === CharState.Stretching) return 'banner';
    if (this.director.pendingHydration && actor === this.shouter() && actor.state !== CharState.Drinking && actor.state !== CharState.Dragged) return 'shout';
    return null;
  }

  zFor(actor: Actor): number {
    if (actor.state === CharState.Dragged) return 10;
    const look = actor.scripted ? this.looks.get(actor.id) : undefined;
    if (look?.z !== undefined) return look.z;
    if (this.riding.has(actor.id)) return 8;
    return actor.kind === 'hero' ? 4 : actor.human ? 3 : actor.flying ? 5 : 2;
  }

  /** Extra vertical offset for cheer hops (purely visual). */
  hopOffset(actor: Actor): number {
    const t = this.hops.get(actor.id);
    if (t === undefined) return 0;
    // Two quick bounces over 0.9 s.
    const phase = (t / 0.45) % 1;
    return -Math.sin(phase * Math.PI) * 26;
  }

  /** Call whenever the Director changes an actor's state. */
  onStateChange(actor: Actor, prev: CharState): void {
    this.stopEmitters(actor.id);
    const h = this.handles.get(actor.id);
    if (!h) return;
    const head = () => (this.handles.has(actor.id) ? this.headOf(h) : null);
    // Dust only while the feet actually move.
    const movingFeet = () => {
      let lastX = actor.body.x;
      return () => {
        if (!this.handles.has(actor.id)) return null;
        const moved = Math.abs(actor.body.x - lastX) > 0.5;
        lastX = actor.body.x;
        return moved ? { x: actor.body.x, y: actor.body.y - 4 } : undefined;
      };
    };

    if (actor.state !== CharState.Idle && actor.state !== CharState.Follow && actor.state !== CharState.Walk) {
      // Moving the owner away from under a riding pet must not leave it floating.
      for (const [rider, mount] of this.riding) if (mount === actor.id && actor.state === CharState.Dragged) this.dismount(rider);
    }

    switch (actor.state) {
      case CharState.Dragged:
        this.track(actor.id, this.fx.emit('sweat', { rate: 5, duration: Infinity, at: () => offset(head(), 14, 4) }));
        break;
      case CharState.Thirsty:
        this.track(actor.id, this.fx.emit('sweat', { rate: 1.2, duration: 6, at: () => offset(head(), 12, 6) }));
        break;
      case CharState.Sleeping:
        this.track(actor.id, this.fx.emit('zzz', { rate: 0.5, duration: 12, at: () => offset(head(), 10, -4) }));
        break;
      case CharState.SittingTooLong:
        if (actor.human) this.track(actor.id, this.fx.emit('dust', { rate: 8, duration: Infinity, at: movingFeet() }));
        break;
      case CharState.Celebrate: {
        const p = head();
        if (p && prev === CharState.Drinking) {
          // High-energy splash: water droplets + flying sparkles + a double cheer hop.
          this.fx.burst('droplet', p.x, p.y + 10, 14);
          this.fx.burst('sparkle', p.x, p.y, 16);
          this.hops.set(actor.id, 0);
        } else if (p) {
          this.fx.burst('sparkle', p.x, p.y, 10);
          this.fx.burst('heart', p.x, p.y, 3);
          this.hops.set(actor.id, 0);
        }
        break;
      }
      case CharState.Interact: {
        const p = head();
        if (p) this.fx.burst('heart', p.x, p.y - 6, actor.human ? 3 : 2);
        break;
      }
      case CharState.Falling:
        break;
      default:
        break;
    }

    if (prev === CharState.Falling && actor.state !== CharState.Falling) {
      this.fx.burst('dust', actor.body.x, actor.body.y - 4, 6);
    }
  }

  private track(actorId: number, emitterId: number): void {
    const list = this.emitters.get(actorId) ?? [];
    list.push(emitterId);
    this.emitters.set(actorId, list);
  }

  private stopEmitters(actorId: number): void {
    const list = this.emitters.get(actorId);
    if (!list) return;
    for (const id of list) this.fx.stop(id);
    this.emitters.delete(actorId);
  }

  // ----------------------------------------------------------------------------- choreographies

  /** Starts the scene-appropriate sedentary wake-up call. */
  runSedentary(coupleVariant?: 'pull' | 'sign', petVariant?: 'headHop' | 'zoomies' | 'none'): void {
    if (this.choreo) return;
    const hero = this.find('hero');
    const partner = this.find('partner');
    const cat = this.find('cat');
    if (!hero) return;

    const tracks: Track[] = [];
    const cast: Actor[] = [];
    const parts: string[] = [];

    if (partner && this.isFree(hero.actor) && this.isFree(partner.actor)) {
      // The heroine grabs the male lead by the hoodie and drags him away from the screen.
      const v = coupleVariant ?? (this.rng() < 0.5 ? 'pull' : 'sign');
      parts.push(v);
      if (v === 'pull') this.buildPull(partner, hero, tracks, cast);
      else this.buildSign(hero, partner, tracks, cast);
    }
    if (cat && petVariant !== 'none' && this.isFree(cat.actor)) {
      const v = petVariant ?? (this.rng() < 0.55 ? 'headHop' : 'zoomies');
      parts.push(v);
      if (v === 'headHop') this.buildHeadHop(cat, partner && cast.length ? partner : hero, tracks, cast);
      else this.buildZoomies(cat, tracks, cast);
    }
    if (!tracks.length) return; // Solo: the Director's whistle + banner routine is enough.
    this.start(parts.join('+'), tracks, cast);
  }

  /** Ends any running choreography and hands every actor back to the Director. */
  cancel(): void {
    const c = this.choreo;
    this.choreo = null;
    if (c) {
      for (const a of c.cast) {
        a.scripted = false;
        this.looks.delete(a.id);
        this.stopEmitters(a.id);
        a.body.y = a.flying ? a.body.y : this.world().floor;
      }
    }
    for (const rider of [...this.riding.keys()]) this.dismount(rider);
  }

  private isFree(a: Actor): boolean {
    return !a.scripted && a.state !== CharState.Dragged && a.state !== CharState.Falling;
  }

  private start(name: string, tracks: Track[], cast: Actor[]): void {
    for (const a of cast) a.scripted = true;
    this.choreo = { name, tracks, cast };
  }

  private look(a: Actor, look: ScriptedLook): void {
    this.looks.set(a.id, look);
  }

  /** Couple: `puller` marches over, grabs `victim` by the hoodie and drags them across the screen. */
  private buildPull(victim: ActorHandle, puller: ActorHandle, tracks: Track[], cast: Actor[]): void {
    const w = this.world().width;
    const h = victim.actor;
    const p = puller.actor;
    // Drag the victim across most of the screen (over whatever windows are open), towards
    // the far side: the puller grabs in front of the victim, who trails `dir * 44` px behind.
    const dir: 1 | -1 = h.body.x > w / 2 ? -1 : 1;
    const destination = dir === 1 ? Math.min(w - 90, w * 0.85) : Math.max(90, w * 0.15);
    const grabX = () => h.body.x + dir * 44;
    let dustId = 0;
    let arrived = false;

    tracks.push({
      actor: p,
      current: null,
      queue: [
        this.set(p, { anim: 'whistle', expression: 'angry' }),
        this.wait(0.8),
        this.moveTo(puller, grabX, RUN_SPEED, { anim: 'walk', expression: 'determined' }),
        this.set(p, { anim: 'walk', expression: 'determined', z: 5 }),
        this.call(() => {
          const head = this.headOf(victim);
          this.fx.burst('exclaim', head.x + 8, head.y - 6, 1);
          dustId = this.fx.emit('dust', { rate: 14, duration: Infinity, at: () => (this.choreo ? { x: h.body.x, y: this.world().floor - 4 } : null) });
          // Screen-tearing slices + anime sweat around the person being dragged.
          this.track(h.id, this.fx.emit('glitch', { rate: 22, duration: Infinity, at: () => (this.choreo && !arrived ? { x: h.body.x + (this.rng() - 0.5) * 70, y: h.body.y - this.rng() * 110 } : null) }));
          this.track(h.id, this.fx.emit('sweat', { rate: 6, duration: Infinity, at: () => (this.choreo && !arrived ? offset(this.headOf(victim), 14, 2) : null) }));
        }),
        this.moveTo(puller, () => destination, DRAG_SPEED, { anim: 'walk', expression: 'determined', z: 5 }),
        this.call(() => {
          this.fx.stop(dustId);
          arrived = true;
        }),
        this.set(p, { anim: 'whistle', expression: 'determined' }),
        this.wait(1.6),
      ],
    });
    tracks.push({
      actor: h,
      current: null,
      queue: [
        this.set(h, { anim: 'idle', expression: 'surprised' }),
        // Wait until the puller arrives, then get dragged along by the hand.
        this.until(() => Math.abs(p.body.x - grabX()) < 6),
        this.follow(victim, puller, -dir * 44, -10, () => arrived, { anim: 'dragged', expression: 'panic', z: 4 }, dir),
        this.set(h, { anim: 'collapse', expression: 'dizzy' }),
        this.wait(1.2),
      ],
    });
    cast.push(h, p);
  }

  /** Couple: both run to the centre and hold up a giant cartoon warning sign. */
  private buildSign(hero: ActorHandle, partner: ActorHandle, tracks: Track[], cast: Actor[]): void {
    const c = this.world().width / 2;
    const h = hero.actor;
    const p = partner.actor;
    tracks.push({
      actor: h,
      current: null,
      queue: [
        this.moveTo(hero, () => c - 70, RUN_SPEED, { anim: 'walk', expression: 'determined' }),
        this.face(h, 1),
        this.set(h, { anim: 'stretch', expression: 'angry', prop: 'sign', z: 6 }),
        this.call(() => {
          const head = this.headOf(hero);
          this.fx.burst('exclaim', head.x, head.y - 120, 1);
        }),
        this.wait(SIGN_HOLD_SECS),
      ],
    });
    tracks.push({
      actor: p,
      current: null,
      queue: [
        this.moveTo(partner, () => c + 70, RUN_SPEED, { anim: 'walk', expression: 'determined' }),
        this.face(p, -1),
        this.set(p, { anim: 'whistle', expression: 'determined' }),
        this.call(() => {
          this.track(p.id, this.fx.emit('anger', { rate: 0.8, duration: Infinity, at: () => (this.choreo ? offset(this.headOf(partner), 14, 0) : null) }));
        }),
        this.wait(SIGN_HOLD_SECS),
      ],
    });
    cast.push(h, p);
  }

  /** Pet: runs over, hops onto the human's head and rides there until the break is taken. */
  private buildHeadHop(cat: ActorHandle, mount: ActorHandle, tracks: Track[], cast: Actor[]): void {
    const c = cat.actor;
    tracks.push({
      actor: c,
      current: null,
      queue: [
        this.moveTo(cat, () => mount.actor.body.x - mount.actor.body.facing * 36, RUN_SPEED, { anim: 'walk', expression: 'determined' }),
        this.jumpTo(cat, () => this.headOf(mount), 0.55, { anim: 'fall', expression: 'happy', z: 9 }),
        this.call(() => {
          const head = this.headOf(mount);
          this.fx.burst('sparkle', head.x, head.y, 6);
          this.riding.set(c.id, mount.actor.id);
        }),
      ],
    });
    cast.push(c);
  }

  /** Pet: zoomies across the whole screen, knocking papers off the "desk". */
  private buildZoomies(cat: ActorHandle, tracks: Track[], cast: Actor[]): void {
    const c = cat.actor;
    const w = this.world().width;
    const left = 50;
    const right = w - 50;
    const first = c.body.x < w / 2 ? right : left;
    const second = first === right ? left : right;
    let paperId = 0;
    let dustId = 0;
    tracks.push({
      actor: c,
      current: null,
      queue: [
        this.set(c, { anim: 'whistle', expression: 'surprised' }),
        this.wait(0.5),
        this.call(() => {
          dustId = this.fx.emit('dust', { rate: 18, duration: Infinity, at: () => (this.choreo ? { x: c.body.x, y: c.body.y - 3 } : null) });
          paperId = this.fx.emit('paper', { rate: 3.5, duration: Infinity, at: () => (this.choreo ? { x: c.body.x, y: c.body.y - 30 } : null) });
        }),
        this.moveTo(cat, () => first, RUN_SPEED * 1.9, { anim: 'walk', expression: 'happy' }),
        this.moveTo(cat, () => second, RUN_SPEED * 1.9, { anim: 'walk', expression: 'happy' }),
        this.moveTo(cat, () => w / 2, RUN_SPEED * 1.9, { anim: 'walk', expression: 'happy' }),
        this.call(() => {
          this.fx.stop(dustId);
          this.fx.stop(paperId);
        }),
        this.set(c, { anim: 'wave', expression: 'love' }),
        this.wait(1.4),
      ],
    });
    cast.push(c);
  }

  // ----------------------------------------------------------------------------- action factories

  private set(a: Actor, look: ScriptedLook): Action {
    return { update: () => (this.look(a, look), true) };
  }

  private face(a: Actor, dir: 1 | -1): Action {
    return { update: () => ((a.body.facing = dir), true) };
  }

  private call(fn: () => void): Action {
    return { update: () => (fn(), true) };
  }

  private wait(secs: number): Action {
    let t = 0;
    return { update: (dt) => (t += dt) >= secs };
  }

  private until(pred: () => boolean, timeout = 12): Action {
    let t = 0;
    return { update: (dt) => pred() || (t += dt) >= timeout };
  }

  private moveTo(h: ActorHandle, target: () => number, speed: number, look: ScriptedLook): Action {
    const a = h.actor;
    return {
      start: () => this.look(a, look),
      update: (dt) => {
        const tx = clamp(target(), a.body.halfW, this.world().width - a.body.halfW);
        const dx = tx - a.body.x;
        if (Math.abs(dx) <= speed * dt || Math.abs(dx) < 2) {
          a.body.x = tx;
          return true;
        }
        a.body.facing = dx > 0 ? 1 : -1;
        a.body.x += Math.sign(dx) * speed * dt;
        return false;
      },
    };
  }

  /** Stick to `leader` with an offset until `done()` returns true. */
  private follow(h: ActorHandle, leader: ActorHandle, dx: number, dy: number, done: () => boolean, look: ScriptedLook, facing: 1 | -1): Action {
    const a = h.actor;
    return {
      start: () => this.look(a, look),
      update: () => {
        a.body.x = leader.actor.body.x + dx;
        a.body.y = this.world().floor + dy;
        a.body.facing = facing;
        if (done()) {
          a.body.y = this.world().floor;
          return true;
        }
        return false;
      },
    };
  }

  /** Parabolic hop to a (possibly moving) point. */
  private jumpTo(h: ActorHandle, target: () => { x: number; y: number }, secs: number, look: ScriptedLook): Action {
    const a = h.actor;
    let t = 0;
    let sx = 0;
    let sy = 0;
    return {
      start: () => {
        this.look(a, look);
        sx = a.body.x;
        sy = a.body.y;
      },
      update: (dt) => {
        t = Math.min(secs, t + dt);
        const k = t / secs;
        const p = target();
        a.body.x = sx + (p.x - sx) * k;
        a.body.y = sy + (p.y - sy) * k - Math.sin(k * Math.PI) * 90;
        a.body.facing = p.x >= sx ? 1 : -1;
        return t >= secs;
      },
    };
  }

  private dismount(riderId: number): void {
    this.riding.delete(riderId);
    const h = this.handles.get(riderId);
    if (!h) return;
    const a = h.actor;
    a.scripted = false;
    this.looks.delete(a.id);
    // Let physics drop it back onto the taskbar.
    if (a.state !== CharState.Dragged) {
      a.body.vx = a.body.facing * 120;
      a.body.vy = -300;
      a.state = CharState.Falling;
      a.stateTime = 0;
    }
  }

  // ----------------------------------------------------------------------------- per frame

  /** Advance choreographies, riders and hops. Returns true when something moved. */
  update(dt: number): boolean {
    let moved = false;

    for (const [id, t] of this.hops) {
      const next = t + dt;
      if (next >= 0.9) this.hops.delete(id);
      else this.hops.set(id, next);
      moved = true;
    }

    // Riders stay glued to their mount's head, even after the choreography ended.
    for (const [riderId, mountId] of this.riding) {
      const rider = this.handles.get(riderId);
      const mount = this.handles.get(mountId);
      if (!rider || !mount) {
        this.riding.delete(riderId);
        continue;
      }
      if (mount.actor.state === CharState.Dragged || mount.actor.state === CharState.Falling) {
        this.dismount(riderId);
        continue;
      }
      const head = this.headOf(mount);
      rider.actor.scripted = true;
      this.look(rider.actor, { anim: 'idle', expression: 'happy', z: 9 });
      rider.actor.body.x = head.x;
      rider.actor.body.y = head.y + 6;
      rider.actor.body.facing = mount.actor.body.facing;
      moved = true;
    }

    const c = this.choreo;
    if (!c) return moved;
    let active = false;
    for (const track of c.tracks) {
      while (true) {
        if (!track.current) {
          const next = track.queue.shift();
          if (!next) break;
          next.start?.();
          track.current = next;
        }
        if (track.current.update(dt)) {
          track.current = null;
          continue; // instant actions chain within the same frame
        }
        break;
      }
      if (track.current || track.queue.length) active = true;
    }
    moved = true;

    if (!active) {
      // Finished: hand everyone back to the Director (riders stay mounted).
      this.choreo = null;
      for (const a of c.cast) {
        if (this.riding.has(a.id)) continue;
        a.scripted = false;
        this.looks.delete(a.id);
        if (!a.flying) a.body.y = this.world().floor;
      }
    }
    return moved;
  }

  destroy(): void {
    this.cancel();
    for (const ids of this.emitters.values()) for (const id of ids) this.fx.stop(id);
    this.emitters.clear();
    this.handles.clear();
    this.looks.clear();
    this.hops.clear();
  }
}

function offset(p: { x: number; y: number } | null, dx: number, dy: number): { x: number; y: number } | null {
  return p ? { x: p.x + dx, y: p.y + dy } : null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
