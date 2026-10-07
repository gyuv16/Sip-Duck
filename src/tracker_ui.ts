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
  /** curved arc gauge (e.g. glasses logged / goal); omitted = none */
  gauge?: { value: number; max: number; label: string };
  /** HUD icon */
  icon?: 'clock' | 'drop' | 'spark';
  /** 'anchor' follows the main character; 'corner' docks top-right like a cinema HUD */
  dock?: 'anchor' | 'corner';
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
  dock: 'anchor' | 'corner';
  el: HTMLDivElement;
  timer: number | null;
  ac: AbortController;
}

const STYLE = `
.sd-toast-layer{position:fixed;inset:0;pointer-events:none;z-index:10;contain:strict}
.sd-toast{position:absolute;left:0;top:0;width:290px;padding:14px 16px 14px;border-radius:18px;
  background:linear-gradient(145deg,rgba(22,24,44,.62),rgba(12,14,28,.48));
  -webkit-backdrop-filter:blur(14px) saturate(1.4);backdrop-filter:blur(14px) saturate(1.4);
  color:#eef1ff;font:12.5px/1.4 "Segoe UI",system-ui,sans-serif;
  border:1px solid color-mix(in srgb,var(--sd-accent) 65%,transparent);
  box-shadow:0 0 0 1px rgba(255,255,255,.05) inset,0 0 26px color-mix(in srgb,var(--sd-accent) 45%,transparent),0 10px 30px rgba(0,0,0,.35);
  pointer-events:auto;will-change:transform;opacity:0;transition:opacity .22s ease-out}
.sd-toast.sd-in{opacity:1}
.sd-toast::before{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--sd-accent) 18%,transparent),transparent);
  mask:linear-gradient(#000,transparent 40%)}
.sd-toast[data-kind=hydration]{--sd-accent:#3fb6ff}
.sd-toast[data-kind=sedentary]{--sd-accent:#ff8a3c}
.sd-toast[data-kind=info]{--sd-accent:#b69cff}
.sd-head{display:flex;align-items:center;gap:10px;margin:0 0 6px}
.sd-icon{flex:none;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;
  background:color-mix(in srgb,var(--sd-accent) 22%,transparent);box-shadow:0 0 14px color-mix(in srgb,var(--sd-accent) 60%,transparent)}
.sd-icon svg{width:22px;height:22px;stroke:var(--sd-accent);fill:none;stroke-width:2;stroke-linecap:round}
.sd-hand{transform-origin:12px 12px;animation:sd-spin 2s linear infinite}
@keyframes sd-spin{to{transform:rotate(360deg)}}
.sd-toast h3{margin:0;font:800 13px/1.15 "Segoe UI",system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;
  color:var(--sd-accent);text-shadow:0 0 12px color-mix(in srgb,var(--sd-accent) 70%,transparent)}
.sd-toast p{margin:0 0 10px;color:#d5d9f2;font-weight:600;letter-spacing:.02em}
.sd-gauge{display:flex;align-items:center;gap:12px;margin:2px 0 10px}
.sd-gauge svg{flex:none;width:96px;height:56px;overflow:visible}
.sd-gauge .sd-track{stroke:rgba(255,255,255,.14)}
.sd-gauge .sd-fill{stroke:var(--sd-accent);filter:drop-shadow(0 0 5px var(--sd-accent))}
.sd-gauge b{display:block;font:800 20px/1 "Segoe UI",system-ui,sans-serif;color:#fff}
.sd-gauge span{font-size:11px;color:#aab3d6;letter-spacing:.06em;text-transform:uppercase}
.sd-actions{display:flex;gap:6px}
.sd-actions button{flex:1;border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:7px 8px;
  font:700 11.5px "Segoe UI",system-ui,sans-serif;letter-spacing:.04em;cursor:pointer;background:rgba(255,255,255,.07);color:#e7eaff}
.sd-actions button.sd-primary{background:color-mix(in srgb,var(--sd-accent) 75%,transparent);border-color:transparent;color:#fff;
  box-shadow:0 0 14px color-mix(in srgb,var(--sd-accent) 55%,transparent)}
.sd-actions button:hover{filter:brightness(1.15)}
.sd-close{position:absolute;top:8px;right:10px;border:0;background:none;font-size:15px;color:#8f97bd;cursor:pointer}
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

    const head = document.createElement('div');
    head.className = 'sd-head';
    if (opts.icon) {
      const icon = document.createElement('div');
      icon.className = 'sd-icon';
      icon.innerHTML = ICONS[opts.icon];
      head.appendChild(icon);
    }
    const h = document.createElement('h3');
    h.textContent = opts.title;
    head.appendChild(h);
    el.appendChild(head);
    const p = document.createElement('p');
    p.textContent = opts.body;
    el.appendChild(p);

    if (opts.gauge) el.appendChild(arcGauge(opts.gauge.value, opts.gauge.max, opts.gauge.label));

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
    this.toasts.push({ id, kind: opts.kind, dock: opts.dock ?? 'anchor', el, timer, ac });
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
    const key = `${this.anchor.x},${this.anchor.y},${this.toasts.length},${window.innerWidth}`;
    if (key === this.lastLayoutKey) return;
    this.lastLayoutKey = key;
    const vw = window.innerWidth;
    let anchorY = this.anchor.y;
    let cornerY = 16;
    // Corner HUDs stack downward from the top-right; anchored ones stack upward from the anchor.
    for (const t of this.toasts) {
      if (t.dock !== 'corner') continue;
      const w = t.el.offsetWidth || 290;
      const x = vw - w - 16;
      this.place(t.el, x, cornerY);
      cornerY += (t.el.offsetHeight || 110) + 10;
    }
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      if (t.dock === 'corner') continue;
      const w = t.el.offsetWidth || 290;
      const h = t.el.offsetHeight || 110;
      anchorY -= h + 10;
      const x = Math.min(vw - w - 8, Math.max(8, this.anchor.x - w / 2));
      this.place(t.el, x, Math.max(cornerY, anchorY));
    }
    this.rectsDirty = true;
    this.onChange();
  }

  private place(el: HTMLElement, x: number, y: number): void {
    el.style.transform = `translate3d(${x}px,${y}px,0)`;
    el.dataset.x = String(x);
    el.dataset.y = String(y);
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

const ICONS: Record<'clock' | 'drop' | 'spark', string> = {
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 12V7"/><path class="sd-hand" d="M12 12l4 2"/></svg>',
  drop: '<svg viewBox="0 0 24 24"><path d="M12 3c3.5 4.4 6 7.6 6 10.5a6 6 0 0 1-12 0C6 10.6 8.5 7.4 12 3z"/><path d="M9.5 14.5a2.5 2.5 0 0 0 2.5 2.5"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3v5M12 16v5M3 12h5M16 12h5M6 6l3 3M15 15l3 3M18 6l-3 3M9 15l-3 3"/></svg>',
};

/** Curved (semi-circular) arc gauge built with SVG — no canvas, no layout thrash. */
function arcGauge(value: number, max: number, label: string): HTMLDivElement {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const r = 40;
  const arcLen = Math.PI * r;
  const wrap = document.createElement('div');
  wrap.className = 'sd-gauge';
  wrap.innerHTML =
    `<svg viewBox="0 0 96 56" role="img" aria-label="${value} of ${max}">` +
    `<path class="sd-track" d="M8 50 A40 40 0 0 1 88 50" stroke-width="8" fill="none" stroke-linecap="round"/>` +
    `<path class="sd-fill" d="M8 50 A40 40 0 0 1 88 50" stroke-width="8" fill="none" stroke-linecap="round" ` +
    `stroke-dasharray="${arcLen.toFixed(1)}" stroke-dashoffset="${(arcLen * (1 - ratio)).toFixed(1)}"/></svg>`;
  const text = document.createElement('div');
  const big = document.createElement('b');
  big.textContent = `${value} / ${max}`;
  const small = document.createElement('span');
  small.textContent = label;
  text.append(big, small);
  wrap.appendChild(text);
  return wrap;
}

export function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}
