/**
 * Hydration + sedentary reminder logic and the non-blocking notification UI.
 *
 * The toasts are a handful of absolutely positioned DOM nodes (no framework, no layout
 * thrash: position is applied with a single `transform` write per rendered frame and only
 * when it changed). Their screen rectangles are published as hit boxes so they stay
 * clickable while the rest of the overlay is click-through.
 */

export interface HydrationSettings {
  intervalMinutes: number;
  dailyGoal: number;
}

interface HydrationPersisted {
  day: string;
  glasses: number;
  lastDrinkAt: number;
  snoozeUntil: number;
  settings: HydrationSettings;
}

const STORAGE_KEY = 'sip-duck:hydration:v1';
const DEFAULT_SETTINGS: HydrationSettings = { intervalMinutes: 45, dailyGoal: 8 };

function localDayKey(d = new Date()): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function readStorage(): HydrationPersisted | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<HydrationPersisted>;
    if (typeof parsed.glasses !== 'number' || typeof parsed.day !== 'string') return null;
    return {
      day: parsed.day,
      glasses: parsed.glasses,
      lastDrinkAt: typeof parsed.lastDrinkAt === 'number' ? parsed.lastDrinkAt : Date.now(),
      snoozeUntil: typeof parsed.snoozeUntil === 'number' ? parsed.snoozeUntil : 0,
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
    };
  } catch {
    return null;
  }
}

/** Interval-driven hydration reminder with daily counter, persisted locally. */
export class HydrationTracker {
  private data: HydrationPersisted;
  private due = false;

  constructor() {
    const now = Date.now();
    this.data = readStorage() ?? { day: localDayKey(), glasses: 0, lastDrinkAt: now, snoozeUntil: 0, settings: { ...DEFAULT_SETTINGS } };
    this.rollDay();
    // Never fire immediately on launch: give a fresh interval from start-up at most.
    this.data.lastDrinkAt = Math.max(this.data.lastDrinkAt, now - this.intervalMs + 60_000);
    this.save();
  }

  get glasses(): number {
    return this.data.glasses;
  }

  get goal(): number {
    return this.data.settings.dailyGoal;
  }

  get settings(): HydrationSettings {
    return { ...this.data.settings };
  }

  get isDue(): boolean {
    return this.due;
  }

  private get intervalMs(): number {
    return this.data.settings.intervalMinutes * 60_000;
  }

  msUntilDue(now = Date.now()): number {
    return Math.max(this.data.lastDrinkAt + this.intervalMs, this.data.snoozeUntil) - now;
  }

  /** Called from the 1 Hz heartbeat. Returns true exactly once when a reminder becomes due. */
  check(now = Date.now()): boolean {
    this.rollDay();
    if (this.due) return false;
    if (this.msUntilDue(now) <= 0) {
      this.due = true;
      return true;
    }
    return false;
  }

  /** Force a reminder now (tray / hotkey). */
  forceDue(): boolean {
    if (this.due) return false;
    this.due = true;
    return true;
  }

  logGlass(): void {
    this.rollDay();
    this.data.glasses += 1;
    this.data.lastDrinkAt = Date.now();
    this.data.snoozeUntil = 0;
    this.due = false;
    this.save();
  }

  snooze(minutes: number): void {
    this.data.snoozeUntil = Date.now() + minutes * 60_000;
    this.due = false;
    this.save();
  }

  updateSettings(patch: Partial<HydrationSettings>): void {
    const s = { ...this.data.settings, ...patch };
    s.intervalMinutes = Math.min(240, Math.max(5, Math.round(s.intervalMinutes)));
    s.dailyGoal = Math.min(30, Math.max(1, Math.round(s.dailyGoal)));
    this.data.settings = s;
    this.save();
  }

  private rollDay(): void {
    const today = localDayKey();
    if (this.data.day !== today) {
      this.data.day = today;
      this.data.glasses = 0;
      this.save();
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      /* storage full or disabled: reminders still work in-memory */
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Toast UI
// ---------------------------------------------------------------------------------------------

export type ToastKind = 'hydration' | 'sedentary' | 'info';

export interface ToastAction {
  label: string;
  primary?: boolean;
  run: () => void;
}

export interface ToastOptions {
  kind: ToastKind;
  title: string;
  body: string;
  actions: ToastAction[];
  /** 0..1 progress (e.g. glasses / goal); omitted = no bar */
  progress?: number;
  /** auto dismiss after ms; omitted = sticky */
  ttlMs?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ToastEntry {
  id: number;
  kind: ToastKind;
  el: HTMLDivElement;
  timer: number | null;
  ac: AbortController;
}

const STYLE = `
.sd-toast-layer{position:fixed;inset:0;pointer-events:none;z-index:10;contain:strict}
.sd-toast{position:absolute;left:0;top:0;min-width:220px;max-width:280px;padding:12px 14px 12px;border-radius:16px;
  background:rgba(255,255,255,.94);color:#2b2440;font:13px/1.35 system-ui,"Segoe UI",sans-serif;
  box-shadow:0 8px 28px rgba(43,36,64,.28);pointer-events:auto;will-change:transform;
  border:2px solid var(--sd-accent);opacity:0;transition:opacity .18s ease-out}
.sd-toast.sd-in{opacity:1}
.sd-toast[data-kind=hydration]{--sd-accent:#3fa9f5}
.sd-toast[data-kind=sedentary]{--sd-accent:#ff6f3c}
.sd-toast[data-kind=info]{--sd-accent:#a78bfa}
.sd-toast h3{margin:0 0 4px;font-size:14px;font-weight:800;color:var(--sd-accent)}
.sd-toast p{margin:0 0 10px}
.sd-bar{height:6px;border-radius:3px;background:#e7ecf5;margin:0 0 10px;overflow:hidden}
.sd-bar>i{display:block;height:100%;background:var(--sd-accent);border-radius:3px}
.sd-actions{display:flex;gap:6px;flex-wrap:wrap}
.sd-actions button{flex:1;border:0;border-radius:10px;padding:7px 8px;font:600 12px system-ui,sans-serif;cursor:pointer;
  background:#eef1f8;color:#2b2440}
.sd-actions button.sd-primary{background:var(--sd-accent);color:#fff}
.sd-actions button:hover{filter:brightness(.95)}
.sd-close{position:absolute;top:6px;right:8px;border:0;background:none;font-size:15px;color:#8a84a3;cursor:pointer}
`;

/**
 * Minimal toast manager. Toasts follow an anchor point (the character's head) supplied by
 * the renderer; positions are written only when they actually change.
 */
export class ToastUI {
  private readonly layer: HTMLDivElement;
  private readonly styleEl: HTMLStyleElement;
  private readonly toasts: ToastEntry[] = [];
  private nextId = 1;
  private anchor = { x: 0, y: 0 };
  private lastLayoutKey = '';
  private rectsCache: Rect[] = [];
  private rectsDirty = true;

  constructor(private readonly onChange: () => void) {
    this.styleEl = document.createElement('style');
    this.styleEl.textContent = STYLE;
    document.head.appendChild(this.styleEl);
    this.layer = document.createElement('div');
    this.layer.className = 'sd-toast-layer';
    document.body.appendChild(this.layer);
  }

  get count(): number {
    return this.toasts.length;
  }

  has(kind: ToastKind): boolean {
    return this.toasts.some((t) => t.kind === kind);
  }

  show(opts: ToastOptions): number {
    // One toast per kind: replace the old one in place.
    for (const t of this.toasts.filter((x) => x.kind === opts.kind)) this.dismiss(t.id);

    const id = this.nextId++;
    const ac = new AbortController();
    const el = document.createElement('div');
    el.className = 'sd-toast';
    el.dataset.kind = opts.kind;
    el.setAttribute('role', 'status');

    const close = document.createElement('button');
    close.className = 'sd-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    close.addEventListener('click', () => this.dismiss(id), { signal: ac.signal });
    el.appendChild(close);

    const h = document.createElement('h3');
    h.textContent = opts.title;
    el.appendChild(h);
    const p = document.createElement('p');
    p.textContent = opts.body;
    el.appendChild(p);

    if (opts.progress !== undefined) {
      const bar = document.createElement('div');
      bar.className = 'sd-bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.round(Math.min(1, Math.max(0, opts.progress)) * 100)}%`;
      bar.appendChild(fill);
      el.appendChild(bar);
    }

    const actions = document.createElement('div');
    actions.className = 'sd-actions';
    for (const action of opts.actions) {
      const b = document.createElement('button');
      b.textContent = action.label;
      if (action.primary) b.className = 'sd-primary';
      b.addEventListener('click', () => {
        this.dismiss(id);
        action.run();
      }, { signal: ac.signal });
      actions.appendChild(b);
    }
    el.appendChild(actions);

    this.layer.appendChild(el);
    const timer = opts.ttlMs ? window.setTimeout(() => this.dismiss(id), opts.ttlMs) : null;
    this.toasts.push({ id, kind: opts.kind, el, timer, ac });
    requestAnimationFrame(() => el.classList.add('sd-in'));
    this.lastLayoutKey = '';
    this.layout();
    return id;
  }

  dismiss(id: number): void {
    const i = this.toasts.findIndex((t) => t.id === id);
    if (i < 0) return;
    const [t] = this.toasts.splice(i, 1);
    if (t.timer !== null) clearTimeout(t.timer);
    t.ac.abort();
    t.el.remove();
    this.lastLayoutKey = '';
    this.layout();
  }

  dismissKind(kind: ToastKind): void {
    for (const t of this.toasts.filter((x) => x.kind === kind)) this.dismiss(t.id);
  }

  /** Anchor = point above the main character (CSS px). Cheap no-op when unchanged. */
  setAnchor(x: number, y: number): void {
    const rx = Math.round(x);
    const ry = Math.round(y);
    if (rx === this.anchor.x && ry === this.anchor.y) return;
    this.anchor = { x: rx, y: ry };
    this.layout();
  }

  private layout(): void {
    const key = `${this.anchor.x},${this.anchor.y},${this.toasts.length}`;
    if (key === this.lastLayoutKey) return;
    this.lastLayoutKey = key;
    const vw = window.innerWidth;
    let y = this.anchor.y;
    // Stack upwards from the anchor; clamp inside the viewport.
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const el = this.toasts[i].el;
      const w = el.offsetWidth || 240;
      const h = el.offsetHeight || 110;
      y -= h + 8;
      const x = Math.min(vw - w - 8, Math.max(8, this.anchor.x - w / 2));
      const top = Math.max(8, y);
      el.style.transform = `translate3d(${x}px,${top}px,0)`;
      el.dataset.x = String(x);
      el.dataset.y = String(top);
    }
    this.rectsDirty = true;
    this.onChange();
  }

  /** Toast rectangles in CSS px for hit-testing (cached until the layout changes). */
  rects(): Rect[] {
    if (!this.rectsDirty) return this.rectsCache;
    this.rectsCache = this.toasts.map((t) => ({
      x: Number(t.el.dataset.x ?? 0),
      y: Number(t.el.dataset.y ?? 0),
      w: t.el.offsetWidth,
      h: t.el.offsetHeight,
    }));
    this.rectsDirty = false;
    return this.rectsCache;
  }

  destroy(): void {
    for (const t of [...this.toasts]) this.dismiss(t.id);
    this.layer.remove();
    this.styleEl.remove();
  }
}

export function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}
