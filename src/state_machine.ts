/**
 * Character logic: per-actor finite state machines plus a scene Director that coordinates
 * couples, pets, reminders, drag physics and screen-edge collision.
 *
 * Two update paths keep CPU low:
 *  - `step(dt)`      : per rendered frame (physics, movement). Only runs while the frame
 *                      scheduler is active.
 *  - `heartbeat(dt)` : ~1 Hz from a Web Worker timer. Makes slow decisions (start a walk,
 *                      fall asleep, couple interactions) even while rendering is frozen,
 *                      and is what wakes the renderer up again.
 */
import type { ActorKind, AnimName } from './renderer';

export enum CharState {
  Idle = 'idle',
  Walk = 'walk',
  Follow = 'follow',
  Thirsty = 'thirsty',
  Drinking = 'drinking',
  SittingTooLong = 'sittingTooLong',
  Stretching = 'stretching',
  Dragged = 'dragged',
  Falling = 'falling',
  Sleeping = 'sleeping',
  Interact = 'interact',
  Celebrate = 'celebrate',
}

export type SceneMode = 'solo' | 'pet' | 'couple' | 'couple_pet';

export const SCENE_ACTORS: Record<SceneMode, readonly ActorKind[]> = {
  solo: ['hero'],
  pet: ['hero', 'cat'],
  couple: ['hero', 'partner'],
  couple_pet: ['hero', 'partner', 'cat', 'spirit'],
};

/** Legal transitions. `Dragged` is reachable from anywhere and handled separately. */
const TRANSITIONS: Record<CharState, readonly CharState[]> = {
  [CharState.Idle]: [CharState.Walk, CharState.Follow, CharState.Thirsty, CharState.SittingTooLong, CharState.Sleeping, CharState.Interact, CharState.Drinking, CharState.Celebrate],
  [CharState.Walk]: [CharState.Idle, CharState.Thirsty, CharState.SittingTooLong, CharState.Sleeping, CharState.Interact, CharState.Follow],
  [CharState.Follow]: [CharState.Idle, CharState.Walk, CharState.Thirsty, CharState.SittingTooLong, CharState.Sleeping, CharState.Interact],
  [CharState.Thirsty]: [CharState.Drinking, CharState.Idle, CharState.SittingTooLong],
  [CharState.Drinking]: [CharState.Celebrate, CharState.Idle],
  [CharState.SittingTooLong]: [CharState.Stretching, CharState.Celebrate, CharState.Idle, CharState.Thirsty],
  [CharState.Stretching]: [CharState.Celebrate, CharState.Idle, CharState.Thirsty],
  [CharState.Dragged]: [CharState.Falling],
  [CharState.Falling]: [CharState.Idle, CharState.Thirsty, CharState.SittingTooLong, CharState.Sleeping],
  [CharState.Sleeping]: [CharState.Idle, CharState.Thirsty, CharState.SittingTooLong],
  [CharState.Interact]: [CharState.Idle, CharState.Thirsty, CharState.SittingTooLong, CharState.Sleeping],
  [CharState.Celebrate]: [CharState.Idle, CharState.Thirsty, CharState.SittingTooLong],
};

export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  grounded: boolean;
  /** collision half-width and height (CSS px) */
  halfW: number;
  height: number;
}

export interface Actor {
  readonly id: number;
  readonly kind: ActorKind;
  readonly human: boolean;
  readonly flying: boolean;
  body: Body;
  state: CharState;
  /** seconds spent in current state */
  stateTime: number;
  targetX: number | null;
  /** id of the actor this one orients itself around (pets -> owner, partner -> hero) */
  anchorId: number | null;
  /** state to return to after a drag/fall interrupt */
  resume: CharState | null;
}

export interface World {
  width: number;
  floor: number;
}

export interface DirectorEvents {
  onSplash(x: number, y: number): void;
  onStateChange(actor: Actor, prev: CharState): void;
}

const GRAVITY = 2200;
const WALK_SPEED = 70;
const FOLLOW_SPEED = 110;
const ALERT_SPEED = 140;
const DRINK_SECONDS = 3.2;
const CELEBRATE_SECONDS = 1.8;
const INTERACT_SECONDS = 2.6;
const SPIRIT_HOVER = 86;

/** Frame-rate demand per state (frames per second). */
const FPS_DEMAND: Record<CharState, number> = {
  [CharState.Idle]: 6,
  [CharState.Walk]: 60,
  [CharState.Follow]: 60,
  [CharState.Thirsty]: 60,
  [CharState.Drinking]: 30,
  [CharState.SittingTooLong]: 60,
  [CharState.Stretching]: 12,
  [CharState.Dragged]: 60,
  [CharState.Falling]: 60,
  [CharState.Sleeping]: 0,
  [CharState.Interact]: 30,
  [CharState.Celebrate]: 30,
};

export class Director {
  readonly actors: Actor[] = [];
  private nextId = 1;
  private hydrationDue = false;
  private sedentaryDue = false;
  private userAway = false;
  private dragged: Actor | null = null;
  private dragOffset = { x: 0, y: 0 };
  private interactCooldown = 8;

  constructor(private world: World, private readonly events: DirectorEvents, private readonly rng: () => number = Math.random) {}

  // ----------------------------------------------------------------------------- setup

  setWorld(world: World): void {
    this.world = world;
    for (const a of this.actors) {
      this.clampToWorld(a);
      if (!a.flying && a.body.y > world.floor) a.body.y = world.floor;
    }
  }

  populate(mode: SceneMode, sizes: (kind: ActorKind) => { w: number; h: number }): Actor[] {
    this.actors.length = 0;
    this.dragged = null;
    const kinds = SCENE_ACTORS[mode];
    const w = this.world.width;
    let heroId: number | null = null;
    kinds.forEach((kind, i) => {
      const size = sizes(kind);
      const human = kind === 'hero' || kind === 'partner';
      const flying = kind === 'spirit';
      const x = kind === 'partner' ? w * 0.72 : kind === 'hero' ? w * 0.28 : w * 0.28 + 70 + i * 30;
      const actor: Actor = {
        id: this.nextId++,
        kind,
        human,
        flying,
        body: {
          x, y: flying ? this.world.floor - SPIRIT_HOVER : this.world.floor,
          vx: 0, vy: 0, facing: kind === 'partner' ? -1 : 1, grounded: !flying,
          halfW: size.w * 0.3, height: size.h * 0.9,
        },
        state: CharState.Idle,
        stateTime: 0,
        targetX: null,
        anchorId: heroId,
        resume: null,
      };
      if (kind === 'hero') heroId = actor.id;
      this.actors.push(actor);
    });
    // Restore pending reminders into the fresh cast.
    if (this.hydrationDue) this.triggerHydration();
    if (this.sedentaryDue) this.triggerSedentary();
    return this.actors;
  }

  // ----------------------------------------------------------------------------- transitions

  private transition(a: Actor, next: CharState): boolean {
    if (a.state === next) return false;
    if (next !== CharState.Dragged && !TRANSITIONS[a.state].includes(next)) return false;
    const prev = a.state;
    a.state = next;
    a.stateTime = 0;
    if (next !== CharState.Walk && next !== CharState.Follow && next !== CharState.SittingTooLong) a.targetX = null;
    if (next === CharState.Idle || next === CharState.Sleeping || next === CharState.Stretching) a.body.vx = 0;
    this.events.onStateChange(a, prev);
    return true;
  }

  /** The resting state an actor should fall back to given the global flags. */
  private baseline(a: Actor): CharState {
    if (a.human && this.sedentaryDue) return CharState.SittingTooLong;
    if (a.human && this.hydrationDue) return CharState.Thirsty;
    if (this.userAway) return CharState.Sleeping;
    return CharState.Idle;
  }

  private isBusy(a: Actor): boolean {
    return a.state === CharState.Dragged || a.state === CharState.Falling;
  }

  private byId(id: number | null): Actor | undefined {
    return id == null ? undefined : this.actors.find((x) => x.id === id);
  }

  // ----------------------------------------------------------------------------- reminders

  triggerHydration(): void {
    this.hydrationDue = true;
    for (const a of this.actors) {
      if (!a.human) continue;
      if (this.isBusy(a)) a.resume = CharState.Thirsty;
      else if (a.state !== CharState.SittingTooLong && a.state !== CharState.Stretching) {
        if (a.state === CharState.Sleeping) this.transition(a, CharState.Idle);
        this.transition(a, CharState.Thirsty);
      }
    }
  }

  /** `logged` = user actually drank (play drink + splash), otherwise snoozed/dismissed. */
  completeHydration(logged: boolean): void {
    this.hydrationDue = false;
    for (const a of this.actors) {
      if (!a.human) continue;
      if (this.isBusy(a)) {
        a.resume = logged ? CharState.Drinking : null;
        continue;
      }
      if (logged) {
        // A pending stretch alert wins; the drink plays once it is resolved.
        if (a.state === CharState.SittingTooLong || a.state === CharState.Stretching) continue;
        if (a.state !== CharState.Thirsty) this.transition(a, CharState.Idle);
        this.transition(a, CharState.Drinking);
      } else if (a.state === CharState.Thirsty) {
        this.transition(a, CharState.Idle);
      }
    }
  }

  triggerSedentary(): void {
    this.sedentaryDue = true;
    for (const a of this.actors) {
      if (!a.human) continue;
      if (this.isBusy(a)) {
        a.resume = CharState.SittingTooLong;
        continue;
      }
      if (a.state === CharState.Sleeping || a.state === CharState.Drinking || a.state === CharState.Dragged) this.transition(a, CharState.Idle);
      this.transition(a, CharState.SittingTooLong);
      a.targetX = this.alertSpot(a);
    }
  }

  completeSedentary(celebrate: boolean): void {
    this.sedentaryDue = false;
    for (const a of this.actors) {
      if (!a.human) continue;
      if (this.isBusy(a)) {
        a.resume = null;
        continue;
      }
      if (a.state === CharState.SittingTooLong || a.state === CharState.Stretching) {
        this.transition(a, celebrate ? CharState.Celebrate : this.hydrationDue ? CharState.Thirsty : CharState.Idle);
      }
    }
  }

  setUserAway(away: boolean): void {
    if (away === this.userAway) return;
    this.userAway = away;
    for (const a of this.actors) {
      if (away && (a.state === CharState.Idle || a.state === CharState.Walk || a.state === CharState.Follow)) {
        this.transition(a, CharState.Sleeping);
      } else if (!away && a.state === CharState.Sleeping) {
        this.transition(a, CharState.Idle);
        this.transition(a, this.baseline(a));
      }
    }
  }

  get pendingHydration(): boolean {
    return this.hydrationDue;
  }

  get pendingSedentary(): boolean {
    return this.sedentaryDue;
  }

  /** Two humans spread out to "hold the screen hostage" from both sides. */
  private alertSpot(a: Actor): number {
    const humans = this.actors.filter((x) => x.human);
    const centre = this.world.width / 2;
    if (humans.length < 2) return centre;
    return a.kind === 'hero' ? centre - 120 : centre + 120;
  }

  // ----------------------------------------------------------------------------- drag

  hitTest(x: number, y: number): Actor | null {
    for (let i = this.actors.length - 1; i >= 0; i--) {
      const a = this.actors[i];
      const b = a.body;
      if (x >= b.x - b.halfW && x <= b.x + b.halfW && y >= b.y - b.height && y <= b.y) return a;
    }
    return null;
  }

  beginDrag(a: Actor, px: number, py: number): void {
    if (!this.isBusy(a) && a.state !== CharState.Dragged) {
      const pending = a.state;
      a.resume = pending === CharState.Thirsty || pending === CharState.SittingTooLong || pending === CharState.Stretching || pending === CharState.Drinking
        ? (pending === CharState.Stretching ? CharState.SittingTooLong : pending)
        : null;
    }
    this.dragged = a;
    this.dragOffset = { x: a.body.x - px, y: a.body.y - py };
    a.body.vx = 0;
    a.body.vy = 0;
    a.body.grounded = false;
    this.transition(a, CharState.Dragged);
  }

  dragTo(px: number, py: number): void {
    const a = this.dragged;
    if (!a) return;
    a.body.x = px + this.dragOffset.x;
    a.body.y = Math.min(this.world.floor, py + this.dragOffset.y);
    this.clampToWorld(a);
  }

  endDrag(vx: number, vy: number): void {
    const a = this.dragged;
    this.dragged = null;
    if (!a) return;
    a.body.vx = Math.max(-1800, Math.min(1800, vx));
    a.body.vy = Math.max(-1800, Math.min(1800, vy));
    if (Math.abs(a.body.vx) > 20) a.body.facing = a.body.vx > 0 ? 1 : -1;
    this.transition(a, CharState.Falling);
  }

  /** A click without dragging: idle characters wave back, pets do a happy hop. */
  poke(a: Actor): void {
    if (a.state === CharState.Idle || a.state === CharState.Walk || a.state === CharState.Follow) {
      if (a.state !== CharState.Idle) this.transition(a, CharState.Idle);
      this.transition(a, CharState.Interact);
    } else if (a.state === CharState.Sleeping) {
      this.transition(a, CharState.Idle);
      this.transition(a, CharState.Interact);
    }
  }

  get dragging(): boolean {
    return this.dragged !== null;
  }

  // ----------------------------------------------------------------------------- slow decisions

  heartbeat(dt: number): void {
    this.interactCooldown = Math.max(0, this.interactCooldown - dt);
    const hero = this.actors.find((a) => a.kind === 'hero');
    const partner = this.actors.find((a) => a.kind === 'partner');

    for (const a of this.actors) {
      if (this.isBusy(a)) continue;

      switch (a.state) {
        case CharState.Idle: {
          if (this.userAway) {
            this.transition(a, CharState.Sleeping);
            break;
          }
          const owner = this.byId(a.anchorId);
          if (!a.human && owner && Math.abs(owner.body.x - a.body.x) > 110) {
            this.transition(a, CharState.Follow);
            break;
          }
          if (a.human && this.rng() < 0.12) {
            const span = this.world.width;
            a.targetX = Math.max(60, Math.min(span - 60, a.body.x + (this.rng() - 0.5) * span * 0.5));
            this.transition(a, CharState.Walk);
          } else if (a.kind === 'cat' && this.rng() < 0.05) {
            this.transition(a, CharState.Interact);
          }
          break;
        }
        default:
          break;
      }
    }

    // Couple choreography.
    if (hero && partner && this.interactCooldown === 0 && hero.state === CharState.Idle && partner.state === CharState.Idle && !this.userAway) {
      const dist = Math.abs(hero.body.x - partner.body.x);
      if (dist > this.world.width * 0.45 && this.rng() < 0.35) {
        // Wave at each other across the screen.
        hero.body.facing = partner.body.x > hero.body.x ? 1 : -1;
        partner.body.facing = (-hero.body.facing) as 1 | -1;
        this.transition(hero, CharState.Interact);
        this.transition(partner, CharState.Interact);
        this.interactCooldown = 25;
      } else if (this.rng() < 0.25) {
        partner.targetX = hero.body.x + (hero.body.x < this.world.width / 2 ? 64 : -64);
        this.transition(partner, CharState.Walk);
        this.interactCooldown = 12;
      }
    }
  }

  // ----------------------------------------------------------------------------- per-frame

  /** Advances physics/behaviour. Returns true if anything visibly moved. */
  step(dt: number): boolean {
    let moved = false;
    for (const a of this.actors) {
      a.stateTime += dt;
      const b = a.body;
      const before = b.x + b.y * 1e4 + b.facing;

      switch (a.state) {
        case CharState.Walk:
        case CharState.Follow:
        case CharState.SittingTooLong: {
          const owner = this.byId(a.anchorId);
          if (a.state === CharState.Follow && owner) a.targetX = owner.body.x - owner.body.facing * 52;
          const target = a.targetX ?? b.x;
          const speed = a.state === CharState.Walk ? WALK_SPEED : a.state === CharState.Follow ? FOLLOW_SPEED : ALERT_SPEED;
          const dx = target - b.x;
          if (Math.abs(dx) < 4) {
            b.vx = 0;
            if (a.state === CharState.SittingTooLong) this.transition(a, CharState.Stretching);
            else {
              this.transition(a, this.baseline(a));
              this.faceAnchor(a);
              if (a.kind === 'partner') this.maybeMeet(a);
            }
          } else {
            b.facing = dx > 0 ? 1 : -1;
            b.vx = b.facing * speed;
            b.x += b.vx * dt;
            if ((dx > 0 && b.x > target) || (dx < 0 && b.x < target)) b.x = target;
          }
          break;
        }
        case CharState.Thirsty: {
          // Dramatic stagger once the collapse finished: drift a tiny bit back and forth.
          if (a.stateTime > 1.2) {
            const sway = Math.sin(a.stateTime * 1.7) * 10 * dt;
            b.x += sway;
          }
          break;
        }
        case CharState.Drinking:
          if (a.stateTime >= DRINK_SECONDS) {
            this.events.onSplash(b.x + b.facing * 14, b.y - b.height * 0.75);
            this.transition(a, CharState.Celebrate);
          }
          break;
        case CharState.Celebrate:
          if (a.stateTime >= CELEBRATE_SECONDS) this.transition(a, this.baseline(a));
          break;
        case CharState.Interact:
          if (a.stateTime >= INTERACT_SECONDS) this.transition(a, this.baseline(a));
          break;
        case CharState.Falling: {
          b.vy += GRAVITY * dt;
          b.x += b.vx * dt;
          b.y += b.vy * dt;
          b.vx *= Math.pow(0.6, dt);
          const floor = a.flying ? this.world.floor - SPIRIT_HOVER : this.world.floor;
          if (a.flying) {
            // Spirits glide back to their hover height instead of crashing.
            b.vy *= Math.pow(0.02, dt);
            b.y += (floor - b.y) * Math.min(1, dt * 3);
          }
          if (this.bounceWalls(a)) moved = true;
          if (b.y >= floor) {
            b.y = floor;
            if (!a.flying && b.vy > 600) {
              b.vy = -b.vy * 0.28; // small bounce
            } else {
              b.vy = 0;
              b.vx = 0;
              b.grounded = true;
              const resume = a.resume;
              a.resume = null;
              this.transition(a, CharState.Idle);
              if (resume && resume !== CharState.Idle) this.transition(a, resume);
              else this.transition(a, this.baseline(a));
              if ((a.state as CharState) === CharState.SittingTooLong) a.targetX = this.alertSpot(a);
            }
          } else if (a.flying && Math.abs(b.y - floor) < 2 && Math.abs(b.vx) < 15) {
            b.y = floor;
            b.vx = 0;
            this.transition(a, CharState.Idle);
          }
          break;
        }
        default:
          break;
      }

      // Spirits hover with a gentle bob near their owner.
      if (a.flying && a.state !== CharState.Dragged && a.state !== CharState.Falling) {
        const owner = this.byId(a.anchorId);
        if (owner) {
          const tx = owner.body.x + owner.body.facing * -40;
          b.x += (tx - b.x) * Math.min(1, dt * 1.5);
          b.facing = owner.body.facing;
        }
        b.y = this.world.floor - SPIRIT_HOVER + Math.sin(a.stateTime * 2.2 + a.id) * 5;
      }

      this.clampToWorld(a);
      if (b.x + b.y * 1e4 + b.facing !== before) moved = true;
    }
    return moved;
  }

  private maybeMeet(partner: Actor): void {
    const hero = this.actors.find((a) => a.kind === 'hero');
    if (!hero || hero.state !== CharState.Idle) return;
    if (Math.abs(hero.body.x - partner.body.x) < 90) {
      hero.body.facing = partner.body.x > hero.body.x ? 1 : -1;
      partner.body.facing = (-hero.body.facing) as 1 | -1;
      this.transition(hero, CharState.Interact);
      this.transition(partner, CharState.Interact);
    }
  }

  private faceAnchor(a: Actor): void {
    const owner = this.byId(a.anchorId);
    if (owner) a.body.facing = owner.body.x >= a.body.x ? 1 : -1;
  }

  private bounceWalls(a: Actor): boolean {
    const b = a.body;
    if (b.x - b.halfW < 0) {
      b.x = b.halfW;
      b.vx = Math.abs(b.vx) * 0.5;
      return true;
    }
    if (b.x + b.halfW > this.world.width) {
      b.x = this.world.width - b.halfW;
      b.vx = -Math.abs(b.vx) * 0.5;
      return true;
    }
    return false;
  }

  private clampToWorld(a: Actor): void {
    const b = a.body;
    const min = b.halfW;
    const max = this.world.width - b.halfW;
    if (b.x < min) {
      b.x = min;
      if (a.state === CharState.Walk) a.targetX = min;
    } else if (b.x > max) {
      b.x = max;
      if (a.state === CharState.Walk) a.targetX = max;
    }
    if (b.y - b.height < 0) b.y = b.height;
  }

  // ----------------------------------------------------------------------------- presentation

  animFor(a: Actor): AnimName {
    switch (a.state) {
      case CharState.Idle: return 'idle';
      case CharState.Walk:
      case CharState.Follow: return 'walk';
      case CharState.Thirsty: return 'collapse';
      case CharState.Drinking: return a.human ? 'drink' : 'idle';
      case CharState.SittingTooLong: return a.human ? 'whistle' : 'walk';
      case CharState.Stretching: return 'stretch';
      case CharState.Dragged: return 'dragged';
      case CharState.Falling: return 'fall';
      case CharState.Sleeping: return 'sleep';
      case CharState.Interact:
      case CharState.Celebrate: return 'wave';
    }
  }

  /** Highest frame rate any actor currently needs. */
  desiredFps(animSettled: (a: Actor) => boolean): number {
    let fps = 0;
    for (const a of this.actors) {
      let demand = FPS_DEMAND[a.state];
      if (a.state === CharState.Thirsty && animSettled(a)) demand = 8;
      if (a.flying && a.state !== CharState.Sleeping) demand = Math.max(demand, 20);
      fps = Math.max(fps, demand);
    }
    return fps;
  }
}
