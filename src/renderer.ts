/**
 * Sprite atlas & animation pipeline.
 *
 * Characters are authored as compact pose tables and rasterised ONCE into a single packed
 * GPU texture atlas (one RenderTexture, one texture bind for the whole scene). Animation
 * at runtime is pure texture-frame swapping on plain Sprites — no per-frame Graphics
 * tessellation, no video decoding. External PNG/AVIF + JSON sprite sheets placed in
 * `public/assets/<kind>.json` automatically override the procedural art.
 *
 * Everything that allocates GPU memory is tracked and released in `destroy()` calls so
 * switching scene modes never leaks textures.
 */
import {
  Assets,
  Container,
  Graphics,
  Rectangle,
  RenderTexture,
  Sprite,
  Spritesheet,
  Text,
  Texture,
  type Renderer,
} from 'pixi.js';

export type ActorKind = 'hero' | 'partner' | 'cat' | 'spirit';

export type AnimName =
  | 'idle'
  | 'walk'
  | 'drink'
  | 'stretch'
  | 'whistle'
  | 'dragged'
  | 'fall'
  | 'collapse'
  | 'sleep'
  | 'wave';

export const ALL_ANIMS: readonly AnimName[] = [
  'idle', 'walk', 'drink', 'stretch', 'whistle', 'dragged', 'fall', 'collapse', 'sleep', 'wave',
];

export interface AnimClip {
  readonly frames: readonly Texture[];
  readonly fps: number;
  readonly loop: boolean;
}

/** Logical (CSS px) size of every character cell. Sprites are anchored bottom-centre. */
export const HUMAN_CELL = { w: 96, h: 128 } as const;
export const PET_CELL = { w: 72, h: 64 } as const;

export function cellFor(kind: ActorKind): { w: number; h: number } {
  return kind === 'hero' || kind === 'partner' ? HUMAN_CELL : PET_CELL;
}

// ---------------------------------------------------------------------------------------------
// Pose tables
// ---------------------------------------------------------------------------------------------

type Eyes = 'open' | 'closed' | 'happy' | 'wide' | 'dizzy';
type Mouth = 'smile' | 'open' | 'o' | 'flat' | 'wavy';
type Prop = 'bottle' | 'bottleUp' | 'whistle' | 'banner' | 'heart' | 'zz';

interface HumanPose {
  /** body vertical offset (negative = up) */
  by: number;
  /** head tilt (radians) */
  tilt: number;
  /** arm angles from hanging-down, positive swings toward facing direction */
  aB: number;
  aF: number;
  /** leg angles */
  lB: number;
  lF: number;
  eyes: Eyes;
  mouth: Mouth;
  prop?: Prop;
  /** whole-body rotation around the feet (collapse / dragged) */
  rot?: number;
  /** vertical squash factor (1 = none) */
  squash?: number;
  blush?: boolean;
  sweat?: boolean;
}

const P = (p: Partial<HumanPose>): HumanPose => ({
  by: 0, tilt: 0, aB: 0.15, aF: -0.15, lB: 0, lF: 0, eyes: 'open', mouth: 'smile', ...p,
});

const HUMAN_ANIMS: Record<AnimName, { fps: number; loop: boolean; poses: HumanPose[] }> = {
  idle: {
    fps: 4, loop: true,
    poses: [
      P({}), P({ by: 1, squash: 0.99 }), P({ by: 1, squash: 0.99, eyes: 'closed' }), P({ by: 0 }),
    ],
  },
  walk: {
    fps: 10, loop: true,
    poses: [
      P({ aB: 0.6, aF: -0.6, lB: -0.45, lF: 0.45 }),
      P({ by: -2, aB: 0.3, aF: -0.3, lB: -0.2, lF: 0.2 }),
      P({ aB: 0, aF: 0, lB: 0, lF: 0 }),
      P({ aB: -0.6, aF: 0.6, lB: 0.45, lF: -0.45 }),
      P({ by: -2, aB: -0.3, aF: 0.3, lB: 0.2, lF: -0.2 }),
      P({ aB: 0, aF: 0, lB: 0, lF: 0 }),
    ],
  },
  drink: {
    fps: 6, loop: true,
    poses: [
      P({ aF: -2.2, prop: 'bottle', eyes: 'happy' }),
      P({ aF: -2.6, tilt: -0.25, prop: 'bottleUp', eyes: 'closed', mouth: 'o' }),
      P({ aF: -2.7, tilt: -0.35, by: -1, prop: 'bottleUp', eyes: 'closed', mouth: 'o' }),
      P({ aF: -2.6, tilt: -0.3, prop: 'bottleUp', eyes: 'closed', mouth: 'o' }),
      P({ aF: -2.1, prop: 'bottle', eyes: 'happy', mouth: 'open', blush: true }),
      P({ aF: -2.1, by: -3, prop: 'bottle', eyes: 'happy', mouth: 'open', blush: true }),
    ],
  },
  stretch: {
    fps: 3, loop: true,
    poses: [
      P({ aB: -2.9, aF: -2.9, by: -3, eyes: 'closed', mouth: 'o', prop: 'banner' }),
      P({ aB: -2.7, aF: -3.05, by: -4, tilt: 0.12, eyes: 'closed', mouth: 'open', prop: 'banner' }),
      P({ aB: -2.9, aF: -2.9, by: -3, eyes: 'happy', mouth: 'open', prop: 'banner' }),
      P({ aB: -3.05, aF: -2.7, by: -4, tilt: -0.12, eyes: 'closed', mouth: 'open', prop: 'banner' }),
    ],
  },
  whistle: {
    fps: 8, loop: true,
    poses: [
      P({ aF: -2.4, eyes: 'wide', mouth: 'o', prop: 'whistle', aB: 0.8 }),
      P({ aF: -2.4, by: -3, eyes: 'closed', mouth: 'o', prop: 'whistle', aB: -0.6 }),
      P({ aF: -2.4, eyes: 'wide', mouth: 'o', prop: 'whistle', aB: 0.8 }),
      P({ aF: -2.4, by: -3, eyes: 'closed', mouth: 'o', prop: 'whistle', aB: -0.6, sweat: true }),
    ],
  },
  dragged: {
    fps: 6, loop: true,
    poses: [
      P({ aB: -2.8, aF: -2.6, lB: 0.4, lF: -0.3, eyes: 'wide', mouth: 'open', sweat: true }),
      P({ aB: -2.6, aF: -2.8, lB: -0.3, lF: 0.4, eyes: 'wide', mouth: 'wavy', sweat: true }),
    ],
  },
  fall: {
    fps: 8, loop: true,
    poses: [
      P({ aB: -1.8, aF: -2.2, lB: 0.5, lF: -0.5, eyes: 'wide', mouth: 'open' }),
      P({ aB: -2.2, aF: -1.8, lB: -0.5, lF: 0.5, eyes: 'wide', mouth: 'open' }),
    ],
  },
  collapse: {
    fps: 6, loop: false,
    poses: [
      P({ eyes: 'dizzy', mouth: 'wavy', sweat: true, tilt: 0.2 }),
      P({ eyes: 'dizzy', mouth: 'wavy', sweat: true, rot: 0.35, squash: 0.95 }),
      P({ eyes: 'dizzy', mouth: 'open', sweat: true, rot: 0.9, squash: 0.92, aF: -1.2 }),
      P({ eyes: 'dizzy', mouth: 'open', rot: 1.45, squash: 0.9, aF: -1.4, aB: -1.2, lF: 0.3 }),
      P({ eyes: 'closed', mouth: 'wavy', rot: 1.52, squash: 0.9, aF: -1.6, aB: -1.3, lF: 0.3, sweat: true }),
    ],
  },
  sleep: {
    fps: 1, loop: true,
    poses: [
      P({ eyes: 'closed', mouth: 'flat', rot: 1.5, squash: 0.92, aF: -0.4, aB: 0.3, prop: 'zz', blush: true }),
      P({ eyes: 'closed', mouth: 'o', rot: 1.5, squash: 0.94, aF: -0.4, aB: 0.3, blush: true }),
    ],
  },
  wave: {
    fps: 6, loop: true,
    poses: [
      P({ aF: -2.6, eyes: 'happy', mouth: 'open', blush: true }),
      P({ aF: -2.2, eyes: 'happy', mouth: 'open', blush: true, by: -2 }),
      P({ aF: -2.6, eyes: 'happy', mouth: 'smile', blush: true, prop: 'heart' }),
      P({ aF: -2.2, eyes: 'happy', mouth: 'open', blush: true, by: -2, prop: 'heart' }),
    ],
  },
};

interface HumanStyle {
  hair: number;
  hairShade: number;
  outfit: number;
  outfitShade: number;
  eye: number;
  longHair: boolean;
  accessory: 'ribbon' | 'ahoge';
}

const STYLES: Record<'hero' | 'partner', HumanStyle> = {
  hero: {
    hair: 0xff8fc1, hairShade: 0xd9649c, outfit: 0x4f6df5, outfitShade: 0x3a51c4,
    eye: 0x5b3cc4, longHair: true, accessory: 'ribbon',
  },
  partner: {
    hair: 0x343a5e, hairShade: 0x1f2340, outfit: 0xf4a640, outfitShade: 0xc9822a,
    eye: 0x2a7fd4, longHair: false, accessory: 'ahoge',
  },
};

const SKIN = 0xffe3d0;
const SKIN_SHADE = 0xf3c4ab;
const LINE = 0x2b2440;

// ---------------------------------------------------------------------------------------------
// Procedural drawing (only runs during atlas build)
// ---------------------------------------------------------------------------------------------

function limb(g: Graphics, x: number, y: number, angle: number, len: number, width: number, color: number, endR: number, endColor: number): void {
  const ex = x + Math.sin(angle) * len;
  const ey = y + Math.cos(angle) * len;
  g.moveTo(x, y).lineTo(ex, ey).stroke({ width, color, cap: 'round' });
  g.circle(ex, ey, endR).fill(endColor);
}

function handPos(x: number, y: number, angle: number, len: number): [number, number] {
  return [x + Math.sin(angle) * len, y + Math.cos(angle) * len];
}

function drawHuman(g: Graphics, s: HumanStyle, p: HumanPose): void {
  const W = HUMAN_CELL.w;
  const cx = W / 2;
  const ground = HUMAN_CELL.h - 6;
  const hipY = ground - 24 + p.by;
  const shoulderY = hipY - 24;
  const headX = cx + 1;
  const headY = shoulderY - 21;
  const R = 21;
  const armLen = 20;

  // Ground shadow (stays on the floor even when body bobs).
  if (!p.rot) g.ellipse(cx, ground + 2, 18, 4).fill({ color: 0x000000, alpha: 0.18 });

  // Long hair behind body.
  if (s.longHair) {
    g.roundRect(headX - R + 1, headY - 4, 2 * R - 2, 40, 14).fill(s.hairShade);
  }

  // Back limbs.
  limb(g, cx - 5, hipY - 2, p.lB, 22, 7, SKIN_SHADE, 4.5, LINE);
  limb(g, cx - 7, shoulderY + 3, p.aB, armLen, 6, SKIN_SHADE, 3.5, SKIN_SHADE);

  // Torso / dress.
  g.poly([cx - 10, shoulderY, cx + 10, shoulderY, cx + 15, hipY + 4, cx - 15, hipY + 4]).fill(s.outfit);
  g.poly([cx - 15, hipY + 4, cx + 15, hipY + 4, cx + 13, hipY - 2, cx - 13, hipY - 2]).fill(s.outfitShade);
  g.poly([cx - 4, shoulderY, cx + 4, shoulderY, cx, shoulderY + 7]).fill(0xffffff);

  // Front leg.
  limb(g, cx + 5, hipY - 2, p.lF, 22, 7, SKIN, 4.5, LINE);

  // Head.
  const tilt = p.tilt;
  const tx = (dx: number, dy: number): [number, number] => [
    headX + dx * Math.cos(tilt) - dy * Math.sin(tilt),
    headY + dx * Math.sin(tilt) + dy * Math.cos(tilt),
  ];
  const [hx, hy] = tx(0, 0);
  g.circle(hx, hy, R + 2).fill(s.hair);
  g.circle(hx, hy + 2, R - 2).fill(SKIN);

  // Bangs.
  const bang: number[] = [];
  const pts: Array<[number, number]> = [[-R, -2], [-R + 2, -R + 4], [0, -R - 3], [R - 2, -R + 4], [R, -2], [R - 5, -8], [R - 9, 1], [R - 14, -9], [3, 0], [-4, -10], [-10, 1], [-15, -8], [-R + 2, 3]];
  for (const [dx, dy] of pts) bang.push(...tx(dx, dy));
  g.poly(bang).fill(s.hair);
  const [sx, sy] = tx(-8, -R + 2);
  g.ellipse(sx, sy, 6, 2).fill({ color: 0xffffff, alpha: 0.35 });

  // Accessory.
  if (s.accessory === 'ribbon') {
    const [rx, ry] = tx(-R + 4, -R + 8);
    g.poly([rx, ry, rx - 9, ry - 7, rx - 9, ry + 7]).fill(0xff3d6e);
    g.poly([rx, ry, rx + 9, ry - 7, rx + 9, ry + 7]).fill(0xff3d6e);
    g.circle(rx, ry, 3).fill(0xffd1de);
  } else {
    const [ax, ay] = tx(2, -R - 2);
    g.moveTo(ax, ay).quadraticCurveTo(ax + 10, ay - 14, ax + 2, ay - 16).stroke({ width: 3, color: s.hair, cap: 'round' });
  }

  // Eyes.
  for (const side of [-1, 1] as const) {
    const [ex, ey] = tx(side * 8 + 3, 4);
    switch (p.eyes) {
      case 'open':
      case 'wide': {
        const big = p.eyes === 'wide';
        g.ellipse(ex, ey, big ? 5 : 4.2, big ? 6.5 : 5.8).fill(big ? 0xffffff : s.eye);
        if (big) g.circle(ex, ey + 1, 2.4).fill(s.eye);
        else g.ellipse(ex, ey + 2, 3, 2.5).fill({ color: 0xffffff, alpha: 0.25 });
        g.circle(ex - 1.4, ey - 2, 1.7).fill(0xffffff);
        g.moveTo(ex - 5, ey - 6).lineTo(ex + 5, ey - 6.5).stroke({ width: 1.5, color: LINE, cap: 'round' });
        break;
      }
      case 'closed':
        g.moveTo(ex - 4, ey + 1).quadraticCurveTo(ex, ey + 4, ex + 4, ey + 1).stroke({ width: 1.8, color: LINE, cap: 'round' });
        break;
      case 'happy':
        g.moveTo(ex - 4, ey + 2).quadraticCurveTo(ex, ey - 4, ex + 4, ey + 2).stroke({ width: 1.8, color: LINE, cap: 'round' });
        break;
      case 'dizzy':
        g.moveTo(ex - 3, ey - 3).lineTo(ex + 3, ey + 3).moveTo(ex + 3, ey - 3).lineTo(ex - 3, ey + 3).stroke({ width: 1.8, color: LINE, cap: 'round' });
        break;
    }
  }

  if (p.blush) {
    for (const side of [-1, 1]) {
      const [bx, by] = tx(side * 12 + 3, 10);
      g.ellipse(bx, by, 4, 2).fill({ color: 0xff6f91, alpha: 0.45 });
    }
  }

  // Mouth.
  const [mx, my] = tx(3, 12);
  switch (p.mouth) {
    case 'smile':
      g.moveTo(mx - 3, my).quadraticCurveTo(mx, my + 3, mx + 3, my).stroke({ width: 1.5, color: LINE, cap: 'round' });
      break;
    case 'open':
      g.ellipse(mx, my + 1, 3.5, 3).fill(0xc2334d);
      break;
    case 'o':
      g.circle(mx, my + 1, 2).fill(0xc2334d);
      break;
    case 'flat':
      g.moveTo(mx - 2.5, my + 1).lineTo(mx + 2.5, my + 1).stroke({ width: 1.5, color: LINE, cap: 'round' });
      break;
    case 'wavy':
      g.moveTo(mx - 4, my + 1).quadraticCurveTo(mx - 2, my - 1, mx, my + 1).quadraticCurveTo(mx + 2, my + 3, mx + 4, my + 1).stroke({ width: 1.5, color: LINE, cap: 'round' });
      break;
  }

  if (p.sweat) {
    const [dx, dy] = tx(R - 2, -6);
    g.poly([dx, dy - 6, dx - 3, dy, dx + 3, dy]).fill(0x8fd3ff);
    g.circle(dx, dy, 3).fill(0x8fd3ff);
  }

  // Front arm + held prop.
  const shX = cx + 7;
  const shY = shoulderY + 3;
  limb(g, shX, shY, p.aF, armLen, 6, SKIN, 3.5, SKIN);
  const [hdx, hdy] = handPos(shX, shY, p.aF, armLen);

  switch (p.prop) {
    case 'bottle':
    case 'bottleUp': {
      const up = p.prop === 'bottleUp';
      const bw = 10;
      const bh = 20;
      const bx = up ? hx + 8 : hdx - bw / 2;
      const byy = up ? hy - 8 : hdy - bh + 4;
      g.roundRect(bx, byy, bw, bh, 3).fill(0x9ddcff);
      g.roundRect(bx + 1.5, byy + bh * 0.4, bw - 3, bh * 0.55, 2).fill(0x3fa9f5);
      g.rect(bx + 2, byy - 4, bw - 4, 4).fill(0x2b6cb0);
      g.rect(bx + 2, byy + 3, 2, bh - 8).fill({ color: 0xffffff, alpha: 0.6 });
      break;
    }
    case 'whistle': {
      g.roundRect(mx + 2, my - 2, 10, 6, 3).fill(0xffd23f);
      g.circle(mx + 11, my + 1, 3).fill(0xf0a500);
      g.moveTo(mx + 2, my + 3).lineTo(cx, shoulderY + 6).stroke({ width: 1, color: 0xff3d6e });
      for (let i = 0; i < 3; i++) {
        g.moveTo(mx + 16 + i * 2, my - 6 + i * 5).lineTo(mx + 21 + i * 2, my - 8 + i * 5).stroke({ width: 1.5, color: 0xffd23f, cap: 'round' });
      }
      break;
    }
    case 'heart': {
      const hx2 = hx + 16;
      const hy2 = hy - R - 6;
      g.circle(hx2 - 3, hy2, 3.5).fill(0xff4d7d);
      g.circle(hx2 + 3, hy2, 3.5).fill(0xff4d7d);
      g.poly([hx2 - 6.5, hy2 + 1, hx2 + 6.5, hy2 + 1, hx2, hy2 + 8]).fill(0xff4d7d);
      break;
    }
    case 'zz': {
      // Drawn in un-rotated space by the caller via drawZz; nothing here.
      break;
    }
    case 'banner':
      // Banner is a separate atlas texture held above the head (see BANNER_FRAME).
      break;
    case undefined:
      break;
  }
}

function drawZz(g: Graphics, x: number, y: number): void {
  const z = (zx: number, zy: number, s: number) =>
    g.moveTo(zx, zy).lineTo(zx + s, zy).lineTo(zx, zy + s).lineTo(zx + s, zy + s).stroke({ width: 2, color: 0x8ab4ff, cap: 'round', join: 'round' });
  z(x, y, 7);
  z(x + 10, y - 10, 5);
}

type PetPose = { by: number; tail: number; legs: number; eyes: Eyes; rot?: number; sparkle?: boolean };

const PET_ANIMS: Record<AnimName, { fps: number; loop: boolean; poses: PetPose[] }> = {
  idle: { fps: 4, loop: true, poses: [{ by: 0, tail: 0.3, legs: 0, eyes: 'open' }, { by: 0, tail: 0.6, legs: 0, eyes: 'open' }, { by: 0, tail: 0.3, legs: 0, eyes: 'closed' }, { by: 0, tail: 0, legs: 0, eyes: 'open' }] },
  walk: { fps: 10, loop: true, poses: [{ by: 0, tail: 0.5, legs: 1, eyes: 'open' }, { by: -1, tail: 0.3, legs: 0, eyes: 'open' }, { by: 0, tail: 0.5, legs: -1, eyes: 'open' }, { by: -1, tail: 0.7, legs: 0, eyes: 'open' }] },
  drink: { fps: 4, loop: true, poses: [{ by: 0, tail: 0.6, legs: 0, eyes: 'happy' }, { by: -2, tail: 0.9, legs: 0, eyes: 'happy', sparkle: true }] },
  stretch: { fps: 4, loop: true, poses: [{ by: 2, tail: 1.2, legs: 1, eyes: 'closed' }, { by: 3, tail: 1.4, legs: 1, eyes: 'happy' }] },
  whistle: { fps: 6, loop: true, poses: [{ by: 0, tail: 1.0, legs: 0, eyes: 'wide' }, { by: -3, tail: 1.2, legs: 0, eyes: 'wide' }] },
  dragged: { fps: 6, loop: true, poses: [{ by: 0, tail: -0.6, legs: 1, eyes: 'wide' }, { by: 0, tail: -0.9, legs: -1, eyes: 'wide' }] },
  fall: { fps: 8, loop: true, poses: [{ by: 0, tail: 1.3, legs: 1, eyes: 'wide' }, { by: 0, tail: 1.5, legs: -1, eyes: 'wide' }] },
  collapse: { fps: 4, loop: false, poses: [{ by: 0, tail: 0.2, legs: 0, eyes: 'dizzy' }, { by: 2, tail: 0, legs: 0, eyes: 'dizzy', rot: 0.4 }] },
  sleep: { fps: 1, loop: true, poses: [{ by: 6, tail: -0.2, legs: 0, eyes: 'closed' }, { by: 5, tail: -0.1, legs: 0, eyes: 'closed' }] },
  wave: { fps: 6, loop: true, poses: [{ by: -4, tail: 1.2, legs: 1, eyes: 'happy', sparkle: true }, { by: 0, tail: 0.8, legs: -1, eyes: 'happy' }] },
};

function drawCat(g: Graphics, p: PetPose, frameIdx: number): void {
  const cx = PET_CELL.w / 2;
  const ground = PET_CELL.h - 4;
  const body = 0xf6a15b;
  const shade = 0xd97e3a;
  const by = ground - 16 + p.by;
  const sleeping = p.by >= 5;

  g.ellipse(cx, ground + 1, 18, 3).fill({ color: 0x000000, alpha: 0.15 });
  // Tail.
  const tx = cx - 18;
  g.moveTo(tx, by).quadraticCurveTo(tx - 10, by - 12 * p.tail, tx - 4, by - 20 * p.tail - 2).stroke({ width: 5, color: shade, cap: 'round' });
  // Legs.
  if (!sleeping) {
    for (const [lx, phase] of [[cx - 10, 1], [cx - 4, -1], [cx + 6, 1], [cx + 12, -1]] as const) {
      g.moveTo(lx, by + 4).lineTo(lx + p.legs * phase * 3, ground).stroke({ width: 4.5, color: lx < cx ? shade : body, cap: 'round' });
    }
  }
  g.ellipse(cx, by, 18, sleeping ? 9 : 10).fill(body);
  g.ellipse(cx - 6, by - 4, 6, 3).fill({ color: 0xffffff, alpha: 0.25 });
  // Head.
  const hx = cx + 14;
  const hy = by - (sleeping ? 2 : 10);
  g.poly([hx - 10, hy - 4, hx - 7, hy - 16, hx - 1, hy - 7]).fill(body);
  g.poly([hx + 1, hy - 7, hx + 7, hy - 16, hx + 10, hy - 4]).fill(body);
  g.poly([hx - 8, hy - 6, hx - 6.5, hy - 12, hx - 3, hy - 7]).fill(0xffb3c7);
  g.circle(hx, hy, 11).fill(body);
  g.ellipse(hx + 2, hy + 4, 5, 3.5).fill(0xfff1e0);
  for (const side of [-1, 1]) {
    const ex = hx + side * 4.5 + 1;
    const ey = hy - 1;
    if (p.eyes === 'open' || p.eyes === 'wide') {
      g.ellipse(ex, ey, 2, p.eyes === 'wide' ? 3.5 : 3).fill(0x2b2440);
      g.circle(ex - 0.6, ey - 1.2, 0.8).fill(0xffffff);
    } else if (p.eyes === 'dizzy') {
      g.moveTo(ex - 2, ey - 2).lineTo(ex + 2, ey + 2).moveTo(ex + 2, ey - 2).lineTo(ex - 2, ey + 2).stroke({ width: 1.3, color: LINE });
    } else {
      const up = p.eyes === 'happy' ? -1 : 1;
      g.moveTo(ex - 2.5, ey).quadraticCurveTo(ex, ey + 2.5 * up, ex + 2.5, ey).stroke({ width: 1.3, color: LINE, cap: 'round' });
    }
  }
  g.circle(hx + 2, hy + 2.5, 1.2).fill(0xff6f91);
  for (const dy of [-1, 2]) {
    g.moveTo(hx + 8, hy + 3 + dy).lineTo(hx + 15, hy + 2 + dy * 1.5).stroke({ width: 0.8, color: 0x7a5a48 });
  }
  if (sleeping && frameIdx === 0) drawZz(g, hx + 6, hy - 18);
  if (p.sparkle) sparkle(g, hx + 14, hy - 14);
}

function sparkle(g: Graphics, x: number, y: number): void {
  g.poly([x, y - 6, x + 1.5, y - 1.5, x + 6, y, x + 1.5, y + 1.5, x, y + 6, x - 1.5, y + 1.5, x - 6, y, x - 1.5, y - 1.5]).fill(0xfff38a);
}

function drawSpirit(g: Graphics, p: PetPose, frameIdx: number): void {
  const cx = PET_CELL.w / 2;
  const cy = PET_CELL.h / 2 - 2 + p.by;
  const glow = 0x9be7ff;
  g.circle(cx, cy, 22).fill({ color: glow, alpha: 0.12 });
  g.circle(cx, cy, 16).fill({ color: glow, alpha: 0.22 });
  // Teardrop body with wispy tail swaying with `tail`.
  const sway = p.tail * 6;
  g.moveTo(cx - 13, cy)
    .quadraticCurveTo(cx - 14, cy - 15, cx, cy - 15)
    .quadraticCurveTo(cx + 14, cy - 15, cx + 13, cy)
    .quadraticCurveTo(cx + 10, cy + 12, cx + sway, cy + 20)
    .quadraticCurveTo(cx - 6, cy + 10, cx - 13, cy)
    .fill(0xe6fbff);
  g.ellipse(cx - 4, cy - 8, 4, 2.5).fill({ color: 0xffffff, alpha: 0.9 });
  for (const side of [-1, 1]) {
    const ex = cx + side * 5;
    const ey = cy - 2;
    if (p.eyes === 'closed' || p.eyes === 'happy') {
      const up = p.eyes === 'happy' ? -1 : 1;
      g.moveTo(ex - 2.5, ey).quadraticCurveTo(ex, ey + 2.5 * up, ex + 2.5, ey).stroke({ width: 1.4, color: 0x3a5a8c, cap: 'round' });
    } else {
      g.ellipse(ex, ey, 2, p.eyes === 'wide' ? 3.4 : 2.8).fill(0x3a5a8c);
      g.circle(ex - 0.6, ey - 1, 0.8).fill(0xffffff);
    }
  }
  g.ellipse(cx - 9, cy + 2, 2.5, 1.3).fill({ color: 0xff8fb1, alpha: 0.6 });
  g.ellipse(cx + 9, cy + 2, 2.5, 1.3).fill({ color: 0xff8fb1, alpha: 0.6 });
  if (p.sparkle || frameIdx % 2 === 1) sparkle(g, cx + 16, cy - 16);
  if (p.by >= 5 && frameIdx === 0) drawZz(g, cx + 10, cy - 22);
}

// ---------------------------------------------------------------------------------------------
// Atlas packing / building
// ---------------------------------------------------------------------------------------------

interface CellRequest {
  key: string;
  w: number;
  h: number;
  paint: (holder: Container) => void;
}

interface Placed extends CellRequest {
  x: number;
  y: number;
}

/** Simple shelf packer; good enough for a few dozen uniformly sized cells. */
function shelfPack(cells: CellRequest[], maxWidth: number, pad: number): { placed: Placed[]; width: number; height: number } {
  const sorted = [...cells].sort((a, b) => b.h - a.h);
  const placed: Placed[] = [];
  let x = pad;
  let y = pad;
  let shelfH = 0;
  let width = 0;
  for (const c of sorted) {
    if (x + c.w + pad > maxWidth) {
      x = pad;
      y += shelfH + pad;
      shelfH = 0;
    }
    placed.push({ ...c, x, y });
    x += c.w + pad;
    width = Math.max(width, x);
    shelfH = Math.max(shelfH, c.h);
  }
  return { placed, width: Math.ceil(width), height: Math.ceil(y + shelfH + pad) };
}

export const BANNER_KEY = 'fx:banner';
export const DROPLET_KEY = 'fx:droplet';
export const STAR_KEY = 'fx:star';

/**
 * Owns every GPU resource of the current scene: the packed atlas RenderTexture, the frame
 * sub-textures, and any external spritesheets. `destroy()` frees all of it.
 */
export class ClipLibrary {
  private readonly clips = new Map<string, AnimClip>();
  private readonly fx = new Map<string, Texture>();
  private readonly frameTextures: Texture[] = [];
  private atlas: RenderTexture | null = null;
  private readonly externalUrls: string[] = [];

  static async build(renderer: Renderer, kinds: readonly ActorKind[]): Promise<ClipLibrary> {
    const lib = new ClipLibrary();
    const procedural: ActorKind[] = [];
    for (const kind of new Set(kinds)) {
      if (!(await lib.tryLoadExternal(kind))) procedural.push(kind);
    }
    lib.buildProcedural(renderer, procedural);
    return lib;
  }

  get(kind: ActorKind, anim: AnimName): AnimClip {
    const clip = this.clips.get(`${kind}:${anim}`) ?? this.clips.get(`${kind}:idle`);
    if (!clip) throw new Error(`No clips for ${kind}`);
    return clip;
  }

  effect(key: string): Texture {
    return this.fx.get(key) ?? Texture.WHITE;
  }

  /** External sheet: `assets/<kind>.json` (TexturePacker / Aseprite JSON with `animations`). */
  private async tryLoadExternal(kind: ActorKind): Promise<boolean> {
    const url = `assets/${kind}.json`;
    try {
      const head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      const type = head.headers.get('content-type') ?? '';
      if (!head.ok || !type.includes('json')) return false;
      const sheet = await Assets.load<Spritesheet>(url);
      if (!sheet?.animations) return false;
      this.externalUrls.push(url);
      for (const anim of ALL_ANIMS) {
        const frames = sheet.animations[anim];
        if (frames?.length) {
          const def = (kind === 'hero' || kind === 'partner' ? HUMAN_ANIMS : PET_ANIMS)[anim];
          this.clips.set(`${kind}:${anim}`, { frames, fps: def.fps, loop: def.loop });
        }
      }
      return this.clips.has(`${kind}:idle`);
    } catch {
      return false;
    }
  }

  private buildProcedural(renderer: Renderer, kinds: ActorKind[]): void {
    const requests: CellRequest[] = [];
    const clipKeys: Array<{ key: string; frameKeys: string[]; fps: number; loop: boolean }> = [];

    for (const kind of kinds) {
      const cell = cellFor(kind);
      for (const anim of ALL_ANIMS) {
        const frameKeys: string[] = [];
        if (kind === 'hero' || kind === 'partner') {
          const def = HUMAN_ANIMS[anim];
          const style = STYLES[kind];
          def.poses.forEach((pose, i) => {
            const key = `${kind}:${anim}:${i}`;
            frameKeys.push(key);
            requests.push({ key, w: cell.w, h: cell.h, paint: (holder) => paintHuman(holder, style, pose) });
          });
          clipKeys.push({ key: `${kind}:${anim}`, frameKeys, fps: def.fps, loop: def.loop });
        } else {
          const def = PET_ANIMS[anim];
          def.poses.forEach((pose, i) => {
            const key = `${kind}:${anim}:${i}`;
            frameKeys.push(key);
            requests.push({ key, w: cell.w, h: cell.h, paint: (holder) => paintPet(holder, kind, pose, i) });
          });
          clipKeys.push({ key: `${kind}:${anim}`, frameKeys, fps: def.fps, loop: def.loop });
        }
      }
    }

    requests.push({ key: BANNER_KEY, w: 168, h: 46, paint: paintBanner });
    requests.push({ key: DROPLET_KEY, w: 12, h: 16, paint: paintDroplet });
    requests.push({ key: STAR_KEY, w: 14, h: 14, paint: (h) => { const g = new Graphics(); sparkle(g, 7, 7); h.addChild(g); } });

    const resolution = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
    const maxW = Math.floor(2048 / resolution);
    const { placed, width, height } = shelfPack(requests, maxW, 2);

    const root = new Container();
    for (const cell of placed) {
      const holder = new Container();
      holder.position.set(cell.x, cell.y);
      cell.paint(holder);
      root.addChild(holder);
    }

    const atlas = RenderTexture.create({ width, height, resolution, antialias: true });
    renderer.render({ container: root, target: atlas, clear: true, clearColor: [0, 0, 0, 0] });
    // The vector geometry is no longer needed once rasterised: free it immediately.
    root.destroy({ children: true, texture: true, textureSource: true });
    this.atlas = atlas;

    const byKey = new Map<string, Texture>();
    for (const cell of placed) {
      const tex = new Texture({ source: atlas.source, frame: new Rectangle(cell.x, cell.y, cell.w, cell.h) });
      this.frameTextures.push(tex);
      byKey.set(cell.key, tex);
    }
    for (const c of clipKeys) {
      const frames = c.frameKeys.map((k) => byKey.get(k)).filter((t): t is Texture => !!t);
      this.clips.set(c.key, { frames, fps: c.fps, loop: c.loop });
    }
    for (const k of [BANNER_KEY, DROPLET_KEY, STAR_KEY]) {
      const t = byKey.get(k);
      if (t) this.fx.set(k, t);
    }
  }

  destroy(): void {
    for (const t of this.frameTextures) t.destroy(false);
    this.frameTextures.length = 0;
    this.atlas?.destroy(true);
    this.atlas = null;
    for (const url of this.externalUrls) void Assets.unload(url);
    this.externalUrls.length = 0;
    this.clips.clear();
    this.fx.clear();
  }
}

function paintHuman(holder: Container, style: HumanStyle, pose: HumanPose): void {
  const g = new Graphics();
  drawHuman(g, style, pose);
  const footX = HUMAN_CELL.w / 2;
  const footY = HUMAN_CELL.h - 6;
  const squash = pose.squash ?? 1;
  g.pivot.set(footX, footY);
  g.position.set(footX, footY);
  g.scale.set(1, squash);
  if (pose.rot) {
    // Lying down: rotate around the feet and shift so the body stays inside the cell.
    g.rotation = -pose.rot;
    g.position.set(footX + 30 * Math.min(1, pose.rot), footY);
    g.scale.set(0.82, 0.82 * squash);
  }
  holder.addChild(g);
  if (pose.prop === 'zz') {
    const z = new Graphics();
    drawZz(z, HUMAN_CELL.w / 2 - 20, HUMAN_CELL.h - 52);
    holder.addChild(z);
  }
}

function paintPet(holder: Container, kind: ActorKind, pose: PetPose, frameIdx: number): void {
  const g = new Graphics();
  if (kind === 'cat') drawCat(g, pose, frameIdx);
  else drawSpirit(g, pose, frameIdx);
  if (pose.rot) {
    g.pivot.set(PET_CELL.w / 2, PET_CELL.h - 4);
    g.position.set(PET_CELL.w / 2, PET_CELL.h - 4);
    g.rotation = pose.rot;
    g.scale.set(0.9);
  }
  holder.addChild(g);
}

function paintBanner(holder: Container): void {
  const g = new Graphics();
  g.moveTo(6, 0).lineTo(6, 46).moveTo(162, 0).lineTo(162, 46).stroke({ width: 3, color: 0x8b5a2b, cap: 'round' });
  g.roundRect(6, 4, 156, 32, 6).fill(0xfff4d6).stroke({ width: 2.5, color: 0xff6f3c });
  holder.addChild(g);
  const label = new Text({
    text: 'STAND UP & STRETCH!',
    style: { fontFamily: 'system-ui, Segoe UI, sans-serif', fontSize: 14, fontWeight: '800', fill: 0xff4d3c, letterSpacing: 0.5 },
  });
  label.anchor.set(0.5);
  label.position.set(84, 20);
  holder.addChild(label);
}

function paintDroplet(holder: Container): void {
  const g = new Graphics();
  g.poly([6, 0, 1, 9, 11, 9]).fill(0x5ec2ff);
  g.circle(6, 10, 5).fill(0x5ec2ff);
  g.circle(4, 9, 1.6).fill({ color: 0xffffff, alpha: 0.8 });
  holder.addChild(g);
}

// ---------------------------------------------------------------------------------------------
// Runtime views
// ---------------------------------------------------------------------------------------------

/**
 * A character sprite that plays clips by swapping atlas sub-textures. `advance()` reports
 * whether the visible frame changed so the frame scheduler can skip redundant GPU work.
 */
export class ActorView {
  readonly root = new Container();
  readonly sprite: Sprite;
  private readonly banner: Sprite;
  private clip: AnimClip;
  private anim: AnimName = 'idle';
  private frame = 0;
  private accMs = 0;
  private finished = false;

  constructor(readonly kind: ActorKind, private readonly lib: ClipLibrary, scale = 1) {
    this.clip = lib.get(kind, 'idle');
    this.sprite = new Sprite(this.clip.frames[0]);
    this.sprite.anchor.set(0.5, 1);
    this.root.addChild(this.sprite);
    this.root.scale.set(scale);

    this.banner = new Sprite(lib.effect(BANNER_KEY));
    this.banner.anchor.set(0.5, 1);
    this.banner.position.set(0, -cellFor(kind).h + 6);
    this.banner.visible = false;
    this.root.addChild(this.banner);
  }

  get current(): AnimName {
    return this.anim;
  }

  /** True once a non-looping clip has reached its last frame. */
  get done(): boolean {
    return this.finished;
  }

  get fps(): number {
    return this.clip.fps;
  }

  play(anim: AnimName, restart = false): boolean {
    if (anim === this.anim && !restart) return false;
    this.anim = anim;
    this.clip = this.lib.get(this.kind, anim);
    this.frame = 0;
    this.accMs = 0;
    this.finished = false;
    this.sprite.texture = this.clip.frames[0];
    this.banner.visible = anim === 'stretch' && (this.kind === 'hero' || this.kind === 'partner');
    return true;
  }

  setFacing(dir: 1 | -1): boolean {
    const want = Math.abs(this.sprite.scale.x) * dir;
    if (this.sprite.scale.x === want) return false;
    this.sprite.scale.x = want;
    return true;
  }

  advance(dtMs: number): boolean {
    if (this.finished || this.clip.frames.length < 2) return false;
    this.accMs += dtMs;
    const step = 1000 / this.clip.fps;
    if (this.accMs < step) return false;
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
    if (next === this.frame) return false;
    this.frame = next;
    this.sprite.texture = this.clip.frames[next];
    return true;
  }

  /** Milliseconds until the next frame flip (Infinity when static). */
  msUntilNextFrame(): number {
    if (this.finished || this.clip.frames.length < 2) return Infinity;
    return Math.max(0, 1000 / this.clip.fps - this.accMs);
  }

  destroy(): void {
    // Textures belong to the ClipLibrary; only destroy the display objects.
    this.root.destroy({ children: true, texture: false, textureSource: false });
  }
}

interface Particle {
  sprite: Sprite;
  vx: number;
  vy: number;
  life: number;
}

/** Fixed-size particle pool for splash/sparkle effects: zero allocations after construction. */
export class ParticlePool {
  readonly root = new Container();
  private readonly items: Particle[] = [];
  private active = 0;

  constructor(lib: ClipLibrary, size = 28) {
    for (let i = 0; i < size; i++) {
      const sprite = new Sprite(lib.effect(i % 4 === 0 ? STAR_KEY : DROPLET_KEY));
      sprite.anchor.set(0.5);
      sprite.visible = false;
      this.root.addChild(sprite);
      this.items.push({ sprite, vx: 0, vy: 0, life: 0 });
    }
  }

  get busy(): boolean {
    return this.active > 0;
  }

  burst(x: number, y: number, count: number, spread = 1): void {
    let spawned = 0;
    for (const p of this.items) {
      if (spawned >= count) break;
      if (p.life > 0) continue;
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * spread;
      const speed = 160 + Math.random() * 260;
      p.vx = Math.cos(a) * speed;
      p.vy = Math.sin(a) * speed;
      p.life = 0.9 + Math.random() * 0.5;
      p.sprite.position.set(x, y);
      p.sprite.alpha = 1;
      p.sprite.scale.set(0.7 + Math.random() * 0.6);
      p.sprite.visible = true;
      spawned++;
      this.active++;
    }
  }

  /** Returns true while anything is still moving (caller must keep rendering). */
  update(dt: number, floor: number): boolean {
    if (this.active === 0) return false;
    for (const p of this.items) {
      if (p.life <= 0) continue;
      p.life -= dt;
      p.vy += 900 * dt;
      p.sprite.x += p.vx * dt;
      p.sprite.y = Math.min(floor - 4, p.sprite.y + p.vy * dt);
      p.sprite.alpha = Math.max(0, Math.min(1, p.life * 2));
      if (p.life <= 0) {
        p.sprite.visible = false;
        this.active--;
      }
    }
    return this.active > 0;
  }

  destroy(): void {
    this.root.destroy({ children: true, texture: false, textureSource: false });
    this.items.length = 0;
    this.active = 0;
  }
}
