/* ============================================================================
   RGB_OS — the portfolio animation engine.
   Ported from the original Claude Design "DC" React component to a framework-free
   module. Behaviour is preserved 1:1; React refs became [data-*] queries and
   this.state became a plain object. Init is deferred to idle so it never blocks
   first paint, and the rAF loop pauses when the tab is hidden.

   DOM contract (set in the page markup):
     [data-root]            root; theme vars + data-calm/data-pinned live here
     [data-hero-canvas]     hero LED dot-matrix canvas (data-line1/data-line2 text)
     [data-grid-canvas]     the Stack-section "LIVE RGB MATRIX" canvas (8 patterns)
     [data-cursor] [data-ring]   custom cursor dot + trailing ring
     [data-boot] [data-boot-log] [data-boot-bar]   boot overlay pieces
     [data-strip]           addressable RGB strip canvases (header + boot)
     [data-header]          fixed top bar (for sticky math)
     [data-marquee]         sticky ticker
     [data-logo-dots]       3 logo LEDs (pride-flag cycling)
     [data-personal] [data-portrait]   personal section + glitch-in portrait
     [data-clock]           live clock text
     [data-calm-toggle] [data-calm-label] [data-calm-knob]   reduce-motion control
     [data-skip-boot]       skip-boot button
     [data-gallery] > [data-slide] [data-dot] [data-gprev] [data-gnext]   work carousels
     [data-reveal]          scroll-reveal targets
     [data-click]           elements that emit a UI blip on click (sound off by default)
   ========================================================================== */

type Dir = 'RGB' | 'RED';
interface State {
  direction: Dir;
  soundOn: boolean;
  calm: boolean;
}

const qs = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel);
const qsa = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T>(sel));

class RgbOS {
  state: State;
  root: HTMLElement | null;
  heroCv: HTMLCanvasElement | null;
  gridCv: HTMLCanvasElement | null;

  _mouse = { x: -9999, y: -9999 };
  _ring = { x: -9999, y: -9999 };
  _heroRect: DOMRect | null = null;
  _gridRect: DOMRect | null = null;
  _font: Record<string, number[][]>;
  _heroDots: { dots: HeroDot[]; pitch: number; cols: number; rows: number; W: number; H: number } | null =
    null;
  _strips: (HTMLCanvasElement & { _phase?: number })[] = [];
  _animTime = 0;
  _lastTs: number | null = null;
  _galleries: { idx: number; timer: number | null }[] = [];
  _galleriesReady = false;
  _goggOn = false;
  _raf = 0;
  _paused = false;
  _reduce = false;
  _running = false;
  _heroVisible = true;
  _gridVisible = true;

  _onMove!: (e: MouseEvent) => void;
  _onResize!: () => void;
  _onScroll!: () => void;
  _clockIv = 0;
  _logoT = 0;
  _logoT2 = 0;
  _bootT = 0;
  _actx: AudioContext | null = null;

  constructor() {
    const reduce =
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._reduce = !!reduce;
    const mode: Dir = this.root?.dataset.mode === 'RED' ? 'RED' : 'RGB';
    this.state = { direction: mode, soundOn: false, calm: !!reduce };
    this.root = qs('[data-root]');
    this.heroCv = qs<HTMLCanvasElement>('[data-hero-canvas]');
    this.gridCv = qs<HTMLCanvasElement>('[data-grid-canvas]');
    this._font = this.buildFont();
  }

  /* ---------- theme ---------- */
  themes(): Record<Dir, Record<string, string>> {
    return {
      RGB: { '--bg': '#070709', '--panel': '#0c0d11', '--panel2': '#101218', '--line': '#23242e', '--ink': '#f3f4f8', '--muted': '#7c7e8a', '--ledoff': '#15161d', '--scan': '.32', '--grid': '1', '--red': '#ff2a45' },
      RED: { '--bg': '#0a0506', '--panel': '#100a0c', '--panel2': '#140c0f', '--line': '#33222a', '--ink': '#fbeef0', '--muted': '#9a7d84', '--ledoff': '#1c1013', '--scan': '.5', '--grid': '1', '--red': '#ff2a45' },
    };
  }

  applyTheme() {
    const el = this.root;
    if (!el) return;
    const t = this.themes()[this.state.direction];
    for (const k in t) el.style.setProperty(k, t[k]);
    el.setAttribute('data-calm', this.state.calm ? '1' : '0');
    const lbl = qs('[data-calm-label]');
    if (lbl) lbl.textContent = this.state.calm ? 'CALM' : 'FULL';
    const knob = qs('[data-calm-knob]');
    if (knob) knob.style.transform = this.state.calm ? 'translateX(16px)' : 'translateX(0)';
    const btn = qs('[data-calm-toggle]');
    if (btn) btn.setAttribute('aria-pressed', this.state.calm ? 'true' : 'false');
  }

  /* ---------- lifecycle ---------- */
  init() {
    this.applyTheme();
    this.collectStrips();
    this.setupMouse();
    this.setupHero();
    this.setupGrid();
    this.setupReveals();
    this.setupGalleries();
    this.positionSticky();
    this.startClock();
    this.startLogoDots();
    this.wireControls();
    this.runBoot();
    // Always paint one static frame so nothing is blank even when parked.
    this.drawHero(0);
    this.drawGrid(0);
    for (let i = 0; i < this._strips.length; i++) this.drawStrip(this._strips[i], 0);
    this.observeCanvases();
    document.addEventListener('visibilitychange', () => {
      this._paused = document.hidden;
      this.syncLoop();
    });
    this.syncLoop();
  }

  /* Pause the per-canvas draw work when the hero / grid canvases scroll out of
     view (the grid is only in the Stack section, the hero only at the top). */
  observeCanvases() {
    if (!('IntersectionObserver' in window)) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.target === this.heroCv) this._heroVisible = e.isIntersecting;
          if (e.target === this.gridCv) this._gridVisible = e.isIntersecting;
        }
      },
      { rootMargin: '120px' }
    );
    if (this.heroCv) io.observe(this.heroCv);
    if (this.gridCv) io.observe(this.gridCv);
  }

  /* Decide whether the rAF loop should run. It runs unless the tab is hidden,
     or the user has both Calm on AND an OS reduced-motion preference (in which
     case we honor "no motion" by parking on a static frame). */
  syncLoop() {
    const shouldRun = !this._paused && !(this.state.calm && this._reduce);
    if (shouldRun) this.startLoop();
    else this.stopLoop();
  }
  startLoop() {
    if (this._running) return;
    this._running = true;
    this._lastTs = null;
    if (window.matchMedia('(pointer:fine)').matches && document.body && !this._reduce)
      document.body.style.cursor = 'none';
    this._raf = requestAnimationFrame(this.loop);
  }
  stopLoop() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    if (document.body) document.body.style.cursor = '';
  }

  wireControls() {
    const calm = qs('[data-calm-toggle]');
    if (calm) calm.addEventListener('click', this.toggleCalm);
    const skip = qs('[data-skip-boot]');
    if (skip) skip.addEventListener('click', this.skipBoot);
    // Delegated UI blip for any [data-click] element (sound is off by default).
    document.addEventListener('click', (e) => {
      const t = e.target as Element | null;
      if (t && t.closest('[data-click]')) this.playClick();
    });
  }

  /* ---------- logo pride-flag dots ---------- */
  startLogoDots() {
    const wrap = qs('[data-logo-dots]');
    if (!wrap) return;
    const dots = Array.from(wrap.children) as HTMLElement[];
    if (dots.length < 3) return;
    const DEF = ['#ff2a45', '#15e0a0', '#2a9dff'];
    const TRANS = ['#5BCEFA', '#F5A9B8', '#FFFFFF'];
    const LESBIAN = ['#FF9A56', '#FFFFFF', '#D362A4'];
    const apply = (cols: string[]) => {
      dots.forEach((d, i) => {
        d.style.background = cols[i];
        d.style.color = cols[i];
      });
    };
    apply(DEF);
    const schedule = () => {
      const wait = 11000 + Math.random() * 19000;
      this._logoT = window.setTimeout(() => {
        apply(Math.random() < 0.5 ? TRANS : LESBIAN);
        this._logoT2 = window.setTimeout(() => {
          apply(DEF);
          schedule();
        }, 2600 + Math.random() * 1600);
      }, wait);
    };
    schedule();
  }

  /* ---------- glitch-in portrait ---------- */
  updatePortrait() {
    const img = qs<HTMLImageElement>('[data-portrait]');
    const sec = qs('[data-personal]');
    if (!img || !sec) return;
    const r = sec.getBoundingClientRect();
    if (r.height === 0) return;
    const vh = window.innerHeight || 1;
    const center = r.top + r.height / 2;
    const dist = Math.abs(center - vh / 2) / (vh / 2);
    const inMid = dist < 0.26;
    if (inMid && !this._goggOn) {
      this._goggOn = true;
      if (this.state.calm) {
        img.style.animation = 'none';
        img.style.opacity = '1';
      } else {
        img.style.animation = 'none';
        void img.offsetWidth;
        img.style.animation = 'glitchIn .52s linear forwards';
        img.style.opacity = '1';
      }
    } else if (!inMid && this._goggOn) {
      this._goggOn = false;
      img.style.animation = 'none';
      img.style.opacity = '0';
    }
  }

  /* ---------- sticky marquee math ---------- */
  positionSticky() {
    const h = qs('[data-header]');
    const root = this.root;
    if (h && root) root.style.setProperty('--mtop', h.offsetHeight - 1 + 'px');
    this.updatePinned();
  }
  updatePinned() {
    const m = qs('[data-marquee]');
    const h = qs('[data-header]');
    const root = this.root;
    if (!m || !h || !root) return;
    const pinned = m.getBoundingClientRect().top <= h.offsetHeight + 1;
    root.setAttribute('data-pinned', pinned ? '1' : '0');
  }

  /* ---------- work-card carousels ---------- */
  setupGalleries() {
    if (this._galleriesReady) return;
    const gs = qsa('[data-gallery]');
    if (!gs.length) return;
    this._galleriesReady = true;
    gs.forEach((g) => {
      const slides = qsa('[data-slide]', g);
      const dots = qsa('[data-dot]', g);
      if (slides.length < 2) return;
      const rec: { idx: number; timer: number | null } = { idx: 0, timer: null };
      const show = (n: number) => {
        rec.idx = (n + slides.length) % slides.length;
        slides.forEach((s, i) => {
          s.style.opacity = i === rec.idx ? '1' : '0';
          s.style.pointerEvents = i === rec.idx ? 'auto' : 'none';
        });
        dots.forEach((d, i) => {
          const on = i === rec.idx;
          d.style.background = on ? 'var(--red,#ff2a45)' : 'var(--ledoff,#15161d)';
          d.style.boxShadow = on ? '0 0 7px var(--red,#ff2a45)' : 'none';
        });
      };
      const reset = () => {
        if (rec.timer) clearInterval(rec.timer);
        rec.timer = window.setInterval(() => show(rec.idx + 1), this.state.calm ? 9000 : 4600);
      };
      const stop = (e: Event) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
      };
      const prev = qs('[data-gprev]', g);
      const next = qs('[data-gnext]', g);
      if (prev) prev.addEventListener('click', (e) => { stop(e); show(rec.idx - 1); reset(); });
      if (next) next.addEventListener('click', (e) => { stop(e); show(rec.idx + 1); reset(); });
      dots.forEach((d, i) => d.addEventListener('click', (e) => { stop(e); show(i); reset(); }));
      g.addEventListener('mouseenter', () => {
        if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
      });
      g.addEventListener('mouseleave', () => reset());
      show(0);
      reset();
      this._galleries.push(rec);
    });
  }

  collectStrips() {
    this._strips = qsa<HTMLCanvasElement>('[data-strip]');
    this._strips.forEach((cv) => {
      cv._phase = parseFloat(cv.getAttribute('data-phase') || '0') || 0;
      this.sizeCanvas(cv);
    });
  }

  /* ---------- input ---------- */
  setupMouse() {
    // Cursor hiding is handled by startLoop()/stopLoop() so it respects
    // reduced-motion and the parked state.
    this._onMove = (e) => {
      this._mouse.x = e.clientX;
      this._mouse.y = e.clientY;
    };
    this._onResize = () => {
      this.sizeCanvas(this.heroCv);
      this.sizeCanvas(this.gridCv);
      this._strips.forEach((cv) => this.sizeCanvas(cv));
      this._heroDots = null;
      this.cacheRects();
      this.positionSticky();
    };
    this._onScroll = () => {
      this.cacheRects();
      this.updatePinned();
    };
    window.addEventListener('mousemove', this._onMove);
    window.addEventListener('resize', this._onResize);
    window.addEventListener('scroll', this._onScroll, true);
    this.cacheRects();
  }
  cacheRects() {
    if (this.heroCv) this._heroRect = this.heroCv.getBoundingClientRect();
    if (this.gridCv) this._gridRect = this.gridCv.getBoundingClientRect();
  }

  /* ---------- canvas sizing ---------- */
  sizeCanvas(cv: HTMLCanvasElement | null) {
    if (!cv) return undefined;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth,
      h = cv.clientHeight;
    if (!w || !h) return undefined;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }
  setupHero() {
    this.sizeCanvas(this.heroCv);
    this.cacheRects();
  }
  setupGrid() {
    this.sizeCanvas(this.gridCv);
    this.cacheRects();
  }

  /* ---------- color helpers ---------- */
  rgbAt(h: number, light: number, alpha: number) {
    return 'hsla(' + (((h % 360) + 360) % 360) + ',92%,' + light + '%,' + alpha + ')';
  }
  lerpHue(a: number, b: number, t: number) {
    const d = (((b - a + 540) % 360) - 180);
    return a + d * t;
  }

  /* ---------- addressable-LED strip effects ---------- */
  stripPixel(e: number, i: number, n: number, t: number): [number, number] {
    switch (e) {
      case 0: {
        const head = ((t * 0.02) % (n + 30)) - 15;
        const d = Math.abs(i - head);
        const c = d < 7 ? Math.pow(1 - d / 7, 2) : 0;
        const base = 0.32 + 0.14 * Math.sin(t * 0.004 + i * 0.5);
        return [Math.max(base, c), c > 0.12 ? 352 : i * 9 - t * 0.05];
      }
      case 1: {
        const step = Math.floor(t * 0.006);
        const on = (i + step) % 3 === 0;
        return [on ? 1 : 0.1, i * 14 - t * 0.04];
      }
      case 2: {
        const cyc = (t * 0.00018) % 1;
        const fillTo = (cyc < 0.5 ? cyc * 2 : 1) * n;
        const clearFrom = (cyc > 0.5 ? (cyc - 0.5) * 2 : 0) * n;
        const on = i < fillTo && i >= clearFrom;
        return [on ? 0.95 : 0.08, t * 0.03 + cyc * 140];
      }
      case 3: {
        const span = Math.max(1, n - 1);
        const tri = Math.abs(((t * 0.02) % (2 * span)) - span);
        const d = Math.abs(i - tri);
        const b = d < 6 ? Math.pow(1 - d / 6, 1.8) : 0;
        return [Math.max(0.07, b), 352];
      }
      case 4: {
        return [0.82, i * 10 - t * 0.08];
      }
      default: {
        let s = Math.sin(i * 92.13 + Math.floor(t * 0.0045) * 51.7) * 43758.5;
        s -= Math.floor(s);
        const b = Math.pow(0.5 + 0.5 * Math.sin(t * 0.0045 + s * 6.283), 8);
        return [Math.max(0.07, b), s * 360];
      }
    }
  }

  drawStrip(cv: (HTMLCanvasElement & { _phase?: number }) | null, t: number) {
    if (!cv) return;
    const ctx = cv.getContext('2d')!;
    const W = cv.clientWidth,
      H = cv.clientHeight;
    if (!W || !H) return;
    const pitch = 13;
    const n = Math.max(1, Math.floor(W / pitch));
    const ox = (W - n * pitch) / 2 + pitch / 2;
    const cy = H / 2;
    const R = Math.min(pitch * 0.3, H * 0.34);
    const red = this.state.direction === 'RED';

    const EFF = 6,
      period = 5200,
      fade = 1900;
    const tp = t / period;
    const e = Math.floor(tp) % EFF,
      ne = (e + 1) % EFF;
    const frac = tp - Math.floor(tp);
    let blend = frac > 1 - fade / period ? (frac - (1 - fade / period)) / (fade / period) : 0;
    blend = blend * blend * blend * (blend * (blend * 6 - 15) + 10);

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(0, 0, W, H);

    for (let i = 0; i < n; i++) {
      const x = ox + i * pitch;
      const pa = this.stripPixel(e, i, n, t);
      let b = pa[0],
        hue = pa[1];
      if (blend > 0) {
        const pb = this.stripPixel(ne, i, n, t);
        b = b * (1 - blend) + pb[0] * blend;
        hue = this.lerpHue(hue, pb[1], blend);
      }
      if (b < 0) b = 0;
      if (b > 1) b = 1;
      let h: number, light: number, a: number;
      if (red) {
        h = 350;
        light = 26 + b * 30;
        a = 0.22 + b * 0.72;
      } else {
        h = hue;
        light = 46 + b * 12;
        a = 0.2 + b * 0.74;
      }
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath();
      ctx.arc(x, cy, R * 1.5, 0, 6.2832);
      ctx.fill();
      const bloomR = R * 2.6 * (0.55 + b * 0.95);
      const g = ctx.createRadialGradient(x, cy, 0, x, cy, bloomR);
      g.addColorStop(0, this.rgbAt(h, light, a * 0.6));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, cy, bloomR, 0, 6.2832);
      ctx.fill();
      ctx.fillStyle = this.rgbAt(h, light, a);
      ctx.beginPath();
      ctx.arc(x, cy, R * (0.72 + b * 0.38), 0, 6.2832);
      ctx.fill();
      if (b > 0.6) {
        ctx.fillStyle = 'rgba(255,255,255,' + (b - 0.6) * 0.7 + ')';
        ctx.beginPath();
        ctx.arc(x, cy, R * 0.4, 0, 6.2832);
        ctx.fill();
      }
    }
  }

  /* ---------- 5x7 LED font ---------- */
  buildFont(): Record<string, number[][]> {
    const F: Record<string, string> = {
      A: '01110,10001,10001,11111,10001,10001,10001', B: '11110,10001,10001,11110,10001,10001,11110',
      C: '01110,10001,10000,10000,10000,10001,01110', D: '11110,10001,10001,10001,10001,10001,11110',
      E: '11111,10000,10000,11110,10000,10000,11111', F: '11111,10000,10000,11110,10000,10000,10000',
      G: '01110,10001,10000,10111,10001,10001,01111', H: '10001,10001,10001,11111,10001,10001,10001',
      I: '11111,00100,00100,00100,00100,00100,11111', J: '00111,00010,00010,00010,00010,10010,01100',
      K: '10001,10010,10100,11000,10100,10010,10001', L: '10000,10000,10000,10000,10000,10000,11111',
      M: '10001,11011,10101,10101,10001,10001,10001', N: '10001,11001,10101,10011,10001,10001,10001',
      O: '01110,10001,10001,10001,10001,10001,01110', P: '11110,10001,10001,11110,10000,10000,10000',
      Q: '01110,10001,10001,10001,10101,10010,01101', R: '11110,10001,10001,11110,10100,10010,10001',
      S: '01111,10000,10000,01110,00001,00001,11110', T: '11111,00100,00100,00100,00100,00100,00100',
      U: '10001,10001,10001,10001,10001,10001,01110', V: '10001,10001,10001,10001,10001,01010,00100',
      W: '10001,10001,10001,10101,10101,11011,10001', X: '10001,10001,01010,00100,01010,10001,10001',
      Y: '10001,10001,01010,00100,00100,00100,00100', Z: '11111,00001,00010,00100,01000,10000,11111',
      '0': '01110,10001,10011,10101,11001,10001,01110', '1': '00100,01100,00100,00100,00100,00100,01110',
      '2': '01110,10001,00001,00110,01000,10000,11111', '3': '11111,00010,00100,00010,00001,10001,01110',
      '4': '00010,00110,01010,10010,11111,00010,00010', '5': '11111,10000,11110,00001,00001,10001,01110',
      '6': '00110,01000,10000,11110,10001,10001,01110', '7': '11111,00001,00010,00100,01000,01000,01000',
      '8': '01110,10001,10001,01110,10001,10001,01110', '9': '01110,10001,10001,01111,00001,00010,01100',
      '-': '00000,00000,00000,11111,00000,00000,00000', _: '00000,00000,00000,00000,00000,00000,11111',
      '/': '00001,00010,00010,00100,01000,01000,10000', ' ': '00000,00000,00000,00000,00000,00000,00000',
    };
    const out: Record<string, number[][]> = {};
    for (const k in F) out[k] = F[k].split(',').map((r) => r.split('').map(Number));
    return out;
  }

  buildHeroDots(W: number, H: number) {
    const t1 = (this.root?.dataset.line1 || 'CREATIVE').toUpperCase();
    const t2 = (this.root?.dataset.line2 || 'TECHNOLOGIST').toUpperCase();
    const lines = t2 ? [t1, t2] : [t1];
    const charW = 5,
      charH = 7,
      gap = 1,
      lineGap = 2;
    const cols = Math.max(...lines.map((l) => l.length * (charW + gap) - gap));
    const rows = lines.length * charH + (lines.length - 1) * lineGap;
    const pitch = Math.min((W * 0.94) / cols, (H * 0.9) / rows);
    const gridW = cols * pitch,
      gridH = rows * pitch;
    const ox = (W - gridW) / 2,
      oy = (H - gridH) / 2;
    const lit: Record<string, boolean> = {};
    lines.forEach((line, li) => {
      const lineCols = line.length * (charW + gap) - gap;
      const startCol = Math.floor((cols - lineCols) / 2);
      const rowStart = li * (charH + lineGap);
      for (let ci = 0; ci < line.length; ci++) {
        const g = this._font[line[ci]] || this._font[' '];
        const baseCol = startCol + ci * (charW + gap);
        for (let r = 0; r < charH; r++)
          for (let c = 0; c < charW; c++) if (g[r][c]) lit[rowStart + r + ',' + (baseCol + c)] = true;
      }
    });
    const dots: HeroDot[] = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        dots.push({ x: ox + c * pitch + pitch / 2, y: oy + r * pitch + pitch / 2, c, r, lit: !!lit[r + ',' + c] });
      }
    return { dots, pitch, cols, rows };
  }

  drawHero(t: number) {
    const cv = this.heroCv;
    if (!cv) return;
    const ctx = cv.getContext('2d')!;
    const W = cv.clientWidth,
      H = cv.clientHeight;
    if (!W || !H) return;
    if (!this._heroDots || this._heroDots.W !== W || this._heroDots.H !== H) {
      const built = this.buildHeroDots(W, H) as typeof this._heroDots & object;
      (built as any).W = W;
      (built as any).H = H;
      this._heroDots = built as any;
    }
    const { dots, pitch, cols } = this._heroDots!;
    const R = pitch * 0.4;
    const rect = this._heroRect;
    let mx = -9999,
      my = -9999;
    if (
      rect &&
      this._mouse.x > rect.left - 60 &&
      this._mouse.x < rect.right + 60 &&
      this._mouse.y > rect.top - 60 &&
      this._mouse.y < rect.bottom + 60
    ) {
      mx = this._mouse.x - rect.left;
      my = this._mouse.y - rect.top;
    }
    const red = this.state.direction === 'RED';
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < dots.length; i++) {
      const d = dots[i];
      let b = d.lit ? 0.85 : 0.045;
      b += 0.05 * Math.sin(t * 0.0021 + d.x * 0.02 + d.y * 0.05);
      if (mx > -9000) {
        const dx = d.x - mx,
          dy = d.y - my,
          dist = Math.sqrt(dx * dx + dy * dy);
        const falloff = 1 - dist / 360;
        if (falloff > 0) {
          const ring = Math.sin(dist * 0.055 - t * 0.013);
          if (ring > 0) b += ring * ring * falloff * (d.lit ? 0.55 : 0.85);
        }
      }
      if (b <= 0.04) continue;
      if (b > 1) b = 1;
      let hue: number, light: number;
      if (red) {
        hue = 350;
        light = 34 + b * 22;
      } else {
        hue = (d.c / cols) * 200 + d.r * 8 + t * 0.05;
        light = 46 + b * 16;
      }
      const col = this.rgbAt(hue, light, Math.min(1, b + 0.12));
      if (b > 0.55) {
        ctx.fillStyle = this.rgbAt(hue, light, 0.16);
        ctx.beginPath();
        ctx.arc(d.x, d.y, R * 2.2, 0, 6.2832);
        ctx.fill();
      }
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(d.x, d.y, R, 0, 6.2832);
      ctx.fill();
      if (b > 0.7) {
        ctx.fillStyle = 'rgba(255,255,255,' + (b - 0.7) * 0.8 + ')';
        ctx.beginPath();
        ctx.arc(d.x, d.y, R * 0.42, 0, 6.2832);
        ctx.fill();
      }
    }
  }

  hsl2rgb(h: number, s: number, l: number): [number, number, number] {
    h = (((h % 360) + 360) % 360) / 360;
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + h * 12) % 12;
      return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    };
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
  }
  resolveCol(p: [number, number, [number, number, number]?], red: boolean): [number, number, number] {
    if (red) return [255, 42, 69];
    if (p[2]) return p[2];
    return this.hsl2rgb(p[1], 90, 56);
  }

  softFlag(
    PAL: [number, number, number][],
    c: number,
    r: number,
    rows: number,
    t: number
  ): [number, number, [number, number, number]] {
    let fp = r / Math.max(1, rows - 1) + 0.045 * Math.sin(t * 0.0011 + c * 0.28);
    if (fp < 0) fp = 0;
    if (fp > 1) fp = 1;
    const sf = fp * 4,
      i0 = Math.floor(sf),
      i1 = Math.min(4, i0 + 1),
      ft = sf - i0;
    const a0 = PAL[i0],
      a1 = PAL[i1];
    const rr = a0[0] + (a1[0] - a0[0]) * ft,
      gg = a0[1] + (a1[1] - a0[1]) * ft,
      bb = a0[2] + (a1[2] - a0[2]) * ft;
    const b = 0.7 + 0.24 * Math.sin(c * 0.45 - t * 0.0038 + r * 0.22);
    return [b, 0, [rr, gg, bb]];
  }

  gridPattern(
    name: string,
    c: number,
    r: number,
    cols: number,
    rows: number,
    t: number,
    cx: number,
    cy: number
  ): [number, number, [number, number, number]?] {
    switch (name) {
      case 'PLASMA': {
        let v = 0.5 + 0.5 * Math.sin(c * 0.42 + t * 0.0022);
        v += 0.5 + 0.5 * Math.sin(r * 0.34 - t * 0.0018);
        v += 0.5 + 0.5 * Math.sin((c + r) * 0.3 + t * 0.0026);
        v += 0.5 + 0.5 * Math.sin(Math.hypot(c - cx, r - cy) * 0.5 - t * 0.0032);
        v /= 4;
        return [Math.pow(v, 1.3), v * 150 + t * 0.05];
      }
      case 'RIPPLE': {
        const d = Math.hypot(c - cx, r - cy);
        const b = Math.pow(Math.max(0, Math.sin(d * 0.7 - t * 0.006)), 2.2);
        return [b, d * 18 + t * 0.07];
      }
      case 'SPIRAL': {
        const ang = Math.atan2(r - cy, c - cx),
          d = Math.hypot(c - cx, r - cy);
        const b = Math.pow(0.5 + 0.5 * Math.sin(ang * 3 + d * 0.55 - t * 0.005), 1.7);
        return [b, ang * 57 + d * 10 + t * 0.08];
      }
      case 'WAVES': {
        const b = Math.pow(0.5 + 0.5 * Math.sin((c + r) * 0.55 - t * 0.006), 2.1);
        return [b, (c + r) * 9 + t * 0.05];
      }
      case 'LED RAIN': {
        const speed = 0.009 + ((c * 13) % 7) * 0.0016;
        const head = (t * speed + ((c * 53) % (rows + 6))) % (rows + 8);
        const dist = head - r;
        const b = dist >= 0 && dist < 6 ? Math.pow(1 - dist / 6, 1.4) : 0;
        return [b, 135 + c * 6 + t * 0.04];
      }
      case 'STRONG':
        return this.softFlag(
          [[91, 206, 250], [245, 169, 184], [255, 255, 255], [245, 169, 184], [91, 206, 250]],
          c, r, rows, t
        );
      case 'LOVE':
        return this.softFlag(
          [[213, 45, 0], [255, 154, 86], [255, 255, 255], [211, 98, 164], [163, 2, 98]],
          c, r, rows, t
        );
      default: {
        let seed = Math.sin(c * 127.1 + r * 311.7) * 43758.5453;
        seed -= Math.floor(seed);
        const b = Math.pow(0.5 + 0.5 * Math.sin(t * 0.0032 + seed * 6.283), 7);
        return [b, seed * 360 + t * 0.04];
      }
    }
  }

  drawGrid(t: number) {
    const cv = this.gridCv;
    if (!cv) return;
    const ctx = cv.getContext('2d')!;
    const W = cv.clientWidth,
      H = cv.clientHeight;
    if (!W || !H) return;
    const cell = 12,
      R = 3.2;
    const cols = Math.floor(W / cell),
      rows = Math.floor(H / cell);
    const ox = (W - cols * cell) / 2 + cell / 2,
      oy = (H - rows * cell) / 2 + cell / 2;
    const cx = (cols - 1) / 2,
      cy = (rows - 1) / 2;
    const red = this.state.direction === 'RED';
    const rect = this._gridRect;
    let mx = -9999,
      my = -9999;
    if (
      rect &&
      this._mouse.x > rect.left &&
      this._mouse.x < rect.right &&
      this._mouse.y > rect.top &&
      this._mouse.y < rect.bottom
    ) {
      mx = this._mouse.x - rect.left;
      my = this._mouse.y - rect.top;
    }

    const NAMES = ['PLASMA', 'STRONG', 'RIPPLE', 'SPIRAL', 'LOVE', 'WAVES', 'LED RAIN', 'TWINKLE'];
    const N = NAMES.length,
      period = 4200,
      fade = 950;
    const tp = t / period;
    const idx = Math.floor(tp) % N;
    const nidx = (idx + 1) % N;
    const frac = tp - Math.floor(tp);
    const blend = frac > 1 - fade / period ? (frac - (1 - fade / period)) / (fade / period) : 0;

    ctx.clearRect(0, 0, W, H);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const x = ox + c * cell,
          y = oy + r * cell;
        const pa = this.gridPattern(NAMES[idx], c, r, cols, rows, t, cx, cy);
        const ca = this.resolveCol(pa, red);
        let b = pa[0],
          cr = ca[0],
          cg = ca[1],
          cbl = ca[2];
        if (blend > 0) {
          const pb = this.gridPattern(NAMES[nidx], c, r, cols, rows, t, cx, cy);
          const cb2 = this.resolveCol(pb, red);
          b = b * (1 - blend) + pb[0] * blend;
          cr = cr * (1 - blend) + cb2[0] * blend;
          cg = cg * (1 - blend) + cb2[1] * blend;
          cbl = cbl * (1 - blend) + cb2[2] * blend;
        }
        b = 0.06 + b * 0.94;
        if (mx > -9000) {
          const dist = Math.hypot(x - mx, y - my);
          if (dist < 74) b += (1 - dist / 74) * 0.7;
        }
        if (b > 1) b = 1;
        cr = cr | 0;
        cg = cg | 0;
        cbl = cbl | 0;
        if (b > 0.6) {
          ctx.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cbl + ',' + (b - 0.6) * 0.4 + ')';
          ctx.beginPath();
          ctx.arc(x, y, R * 2.1, 0, 6.2832);
          ctx.fill();
        }
        ctx.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cbl + ',' + b + ')';
        ctx.beginPath();
        ctx.arc(x, y, R, 0, 6.2832);
        ctx.fill();
      }
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = red ? 'rgba(255,42,69,0.9)' : 'rgba(255,42,69,0.85)';
    ctx.fillText('▸ ' + NAMES[idx], 9, H - 7);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.30)';
    ctx.fillText(String(idx + 1).padStart(2, '0') + '/' + String(N).padStart(2, '0'), W - 9, H - 7);
    ctx.textAlign = 'left';
  }

  loop = (ts: number) => {
    if (!this._running) return;
    if (this._lastTs == null) this._lastTs = ts;
    let dt = ts - this._lastTs;
    this._lastTs = ts;
    if (dt < 0) dt = 0;
    if (dt > 100) dt = 100;
    this._animTime += dt * (this.state.calm ? 0.4 : 1);
    const t = this._animTime;
    if (this._heroVisible) this.drawHero(t);
    if (this._gridVisible) this.drawGrid(t);
    for (let i = 0; i < this._strips.length; i++) this.drawStrip(this._strips[i], t);
    this._ring.x += (this._mouse.x - this._ring.x) * 0.18;
    this._ring.y += (this._mouse.y - this._ring.y) * 0.18;
    const cur = qs('[data-cursor]');
    if (cur) cur.style.transform = 'translate(' + (this._mouse.x - 3) + 'px,' + (this._mouse.y - 3) + 'px)';
    const ring = qs('[data-ring]');
    if (ring) ring.style.transform = 'translate(' + (this._ring.x - 15) + 'px,' + (this._ring.y - 15) + 'px)';
    this.updatePortrait();
    this._raf = requestAnimationFrame(this.loop);
  };

  /* ---------- scroll reveals ---------- */
  setupReveals() {
    const els = qsa('[data-reveal]');
    els.forEach((el) => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(26px)';
      el.style.transition =
        'opacity .7s cubic-bezier(.2,.7,.2,1), transform .7s cubic-bezier(.2,.7,.2,1)';
    });
    if (!('IntersectionObserver' in window)) {
      els.forEach((el) => {
        el.style.opacity = '1';
        el.style.transform = 'none';
      });
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            const el = en.target as HTMLElement;
            const sibs = Array.from(
              el.parentElement!.querySelectorAll(':scope > [data-reveal]')
            );
            const idx = sibs.indexOf(el);
            setTimeout(() => {
              el.style.opacity = '1';
              el.style.transform = 'none';
            }, Math.max(0, idx) * 70);
            io.unobserve(el);
          }
        });
      },
      { threshold: 0.12 }
    );
    els.forEach((el) => io.observe(el));
  }

  /* ---------- live clock ---------- */
  startClock() {
    const tick = () => {
      const el = qs('[data-clock]');
      if (!el) return;
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      el.textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    };
    tick();
    this._clockIv = window.setInterval(tick, 1000);
  }

  /* ---------- boot ---------- */
  runBoot() {
    const overlay = qs('[data-boot]');
    const log = qs('[data-boot-log]');
    const bar = qs('[data-boot-bar]');
    if (!overlay) return;
    if (this.root?.dataset.boot === 'false') {
      overlay.style.display = 'none';
      return;
    }
    if (sessionStorage.getItem('agg_booted_v3') === '1') {
      overlay.style.display = 'none';
      return;
    }
    const lines = [
      '> INITIALIZING RGB_OS v3.0 ...',
      '> ADDRESSING WS2812B BUS [4096 px] ... OK',
      '> COLOR CALIBRATION (R / G / B) ... OK',
      '> LOADING MODULES [work about stack] ... OK',
      '> SIGNAL LOCKED — ALL CHANNELS LIVE',
      '> READY_',
    ];
    let i = 0;
    const step = () => {
      if (!log) return;
      log.textContent += (i > 0 ? '\n' : '') + lines[i];
      if (bar) bar.style.width = Math.round(((i + 1) / lines.length) * 100) + '%';
      i++;
      if (i < lines.length) this._bootT = window.setTimeout(step, 330);
      else this._bootT = window.setTimeout(() => this.skipBoot(), 650);
    };
    step();
  }
  skipBoot = () => {
    clearTimeout(this._bootT);
    sessionStorage.setItem('agg_booted_v3', '1');
    const o = qs('[data-boot]');
    if (o) {
      o.style.opacity = '0';
      setTimeout(() => {
        if (o) o.style.display = 'none';
      }, 650);
    }
    this.blip(660);
  };

  /* ---------- sound ---------- */
  ensureAudio() {
    if (!this._actx) {
      try {
        this._actx = new (window.AudioContext || (window as any).webkitAudioContext)();
      } catch {
        /* ignore */
      }
    }
    return this._actx;
  }
  blip(freq?: number) {
    if (!this.state.soundOn) return;
    const ac = this.ensureAudio();
    if (!ac) return;
    if (ac.state === 'suspended') ac.resume();
    const o = ac.createOscillator(),
      g = ac.createGain();
    o.type = 'square';
    o.frequency.value = freq || 520;
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(0.06, ac.currentTime + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.09);
    o.connect(g);
    g.connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + 0.1);
  }
  playClick = () => this.blip(720);

  toggleCalm = () => {
    const calm = !this.state.calm;
    this.state.calm = calm;
    const el = this.root;
    if (el) el.setAttribute('data-calm', calm ? '1' : '0');
    const lbl = qs('[data-calm-label]');
    if (lbl) lbl.textContent = calm ? 'CALM' : 'FULL';
    const knob = qs('[data-calm-knob]');
    if (knob) knob.style.transform = calm ? 'translateX(16px)' : 'translateX(0)';
    const btn = qs('[data-calm-toggle]');
    if (btn) btn.setAttribute('aria-pressed', calm ? 'true' : 'false');
    // Start/park the loop (matters for reduced-motion users opting into motion).
    this.syncLoop();
    this.blip(calm ? 440 : 880);
  };
}

interface HeroDot {
  x: number;
  y: number;
  c: number;
  r: number;
  lit: boolean;
}

function boot() {
  const engine = new RgbOS();
  engine.init();
  (window as any).__rgbos = engine;
}

// Defer to idle so the engine never blocks first paint.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    if ('requestIdleCallback' in window) (window as any).requestIdleCallback(boot, { timeout: 600 });
    else setTimeout(boot, 1);
  });
} else if ('requestIdleCallback' in window) {
  (window as any).requestIdleCallback(boot, { timeout: 600 });
} else {
  setTimeout(boot, 1);
}
