/**
 * particles.js
 *
 * Ambient background effects layer, rendered on a full-viewport canvas
 * BEHIND the clock (nothing ever renders under the clock face itself -
 * that region is clipped out every frame).
 *
 * Modes: "none" | "bubbles" | "plankton" | "pulse" | "bokeh"
 *
 * - bubbles: upward-drifting circles; speed/density react to current tide
 *   height (more/faster near high tide, fewer/slower near low tide).
 * - plankton: tiny twinkling specks, ambient (not tide-reactive).
 * - pulse: rings that expand outward starting at the clock's outer edge,
 *   fading as they grow. Ambient, periodic.
 * - bokeh: a handful of large, soft, slowly-drifting blurred blobs.
 */

class ParticleField {
  /** @param {HTMLCanvasElement} canvas - full-viewport canvas, behind the clock. */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.mode = "none";
    this.particles = [];
    this.pulseRings = [];
    this.pulseTimer = 0;

    // Global intensity dial (0.25 .. 3.0), user-controlled via < / > keys.
    // Scales count/speed/density for whichever effect is active.
    this.intensity = 1.0;

    this.tideInfo = { norm: 0.5, rising: true };

    this.clockCenter = { x: 0, y: 0 };
    this.clockRadius = 0;

    this._rafId = null;
    this._lastT = null;

    this._boundLoop = this._loop.bind(this);
  }

  /** Resize the canvas to fill the viewport (handles devicePixelRatio for crispness). */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = w;
    this.height = h;
  }

  /**
   * Recompute the on-screen center/radius of the clock face so particles
   * can be clipped out from underneath it. `stackEl` is the `.canvas-stack`
   * element (the square that the two clock canvases live in and scale to).
   */
  updateClockGeometry(stackEl) {
    const rect = stackEl.getBoundingClientRect();
    const scale = rect.width / 600; // clock canvases are 600x600 internally
    this.clockCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    // R = 600*0.38 internally; add padding to clear numerals/ticks (~40px @ 1x scale).
    this.clockRadius = (600 * 0.38 + 40) * scale;
  }

  /** Feed current tide state in for reactive effects (bubbles). */
  setTideInfo(norm, rising) {
    this.tideInfo = { norm: Math.min(1, Math.max(0, norm)), rising: !!rising };
  }

  setMode(mode) {
    this.mode = mode;
    this.particles = [];
    this.pulseRings = [];
    this.pulseTimer = 0;
    this._initParticles();
  }

  /** Set the global intensity multiplier (clamped 0.25..3.0) and rebuild
   *  count-based particle arrays so the change is visible immediately. */
  setIntensity(value) {
    this.intensity = Math.min(3.0, Math.max(0.25, value));
    if (this.mode === "bubbles" || this.mode === "plankton" || this.mode === "bokeh") {
      this.particles = [];
      this._initParticles();
    }
  }

  start() {
    if (this._rafId) return;
    this._lastT = null;
    this._rafId = requestAnimationFrame(this._boundLoop);
  }

  stop() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  _loop(t) {
    if (this._lastT == null) this._lastT = t;
    const dt = Math.min(0.1, (t - this._lastT) / 1000); // seconds, clamp for tab-switch hiccups
    this._lastT = t;

    this._update(dt, t / 1000);
    this._draw();

    this._rafId = requestAnimationFrame(this._boundLoop);
  }

  // ---------- Init ----------

  _initParticles() {
    const w = this.width || window.innerWidth;
    const h = this.height || window.innerHeight;

    if (this.mode === "bubbles") {
      const count = Math.round(40 * this.intensity);
      for (let i = 0; i < count; i++) {
        this.particles.push(this._newBubble(w, h, true));
      }
    } else if (this.mode === "plankton") {
      const count = Math.round(50 * this.intensity);
      for (let i = 0; i < count; i++) {
        this.particles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          r: 1 + Math.random() * 1.8,
          phase: Math.random() * Math.PI * 2,
          twinkleSpeed: (0.3 + Math.random() * 0.6) * this.intensity,
          driftAngle: Math.random() * Math.PI * 2,
          driftSpeed: (2 + Math.random() * 4) * this.intensity,
        });
      }
    } else if (this.mode === "bokeh") {
      const count = Math.max(1, Math.round(5 * this.intensity));
      for (let i = 0; i < count; i++) {
        this.particles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          r: 90 + Math.random() * 90,
          vx: (Math.random() - 0.5) * 6 * this.intensity,
          vy: (Math.random() - 0.5) * 6 * this.intensity,
          hue: [195, 175, 210, 160][i % 4],
          alpha: 0.06 + Math.random() * 0.05,
        });
      }
    }
    // "pulse" and "none" need no initial particle array.
  }

  _newBubble(w, h, randomizeY) {
    const norm = this.tideInfo.norm;
    return {
      x: Math.random() * w,
      y: randomizeY ? Math.random() * h : h + 20,
      r: 3 + Math.random() * 5,
      baseSpeed: 12 + Math.random() * 18,
      speedMul: 0.6 + norm * 1.1,
      wobbleAmp: 8 + Math.random() * 14,
      wobbleFreq: 0.4 + Math.random() * 0.6,
      phase: Math.random() * Math.PI * 2,
      opacity: 0.15 + Math.random() * 0.25,
    };
  }

  // ---------- Update ----------

  _update(dt, tSec) {
    const w = this.width || window.innerWidth;
    const h = this.height || window.innerHeight;
    const mul = this.intensity;

    if (this.mode === "bubbles") {
      const norm = this.tideInfo.norm;
      // Target bubble count breathes with tide height, scaled by intensity.
      const targetCount = Math.round((30 + norm * 26) * mul);
      while (this.particles.length < targetCount) this.particles.push(this._newBubble(w, h, false));
      while (this.particles.length > targetCount) this.particles.pop();

      for (const p of this.particles) {
        const speed = p.baseSpeed * p.speedMul * mul;
        p.y -= speed * dt;
        p.x += Math.sin(tSec * p.wobbleFreq + p.phase) * p.wobbleAmp * dt;
        if (p.y < -20) {
          Object.assign(p, this._newBubble(w, h, false));
          p.y = h + 20;
        }
      }
    } else if (this.mode === "plankton") {
      const targetCount = Math.round(50 * mul);
      while (this.particles.length < targetCount) {
        this.particles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          r: 1 + Math.random() * 1.8,
          phase: Math.random() * Math.PI * 2,
          twinkleSpeed: (0.3 + Math.random() * 0.6) * mul,
          driftAngle: Math.random() * Math.PI * 2,
          driftSpeed: (2 + Math.random() * 4) * mul,
        });
      }
      while (this.particles.length > targetCount) this.particles.pop();

      for (const p of this.particles) {
        p.x += Math.cos(p.driftAngle) * p.driftSpeed * dt;
        p.y += Math.sin(p.driftAngle) * p.driftSpeed * dt;
        if (p.x < -10) p.x = w + 10;
        if (p.x > w + 10) p.x = -10;
        if (p.y < -10) p.y = h + 10;
        if (p.y > h + 10) p.y = -10;
      }
    } else if (this.mode === "bokeh") {
      for (const p of this.particles) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.x < -p.r) p.x = w + p.r;
        if (p.x > w + p.r) p.x = -p.r;
        if (p.y < -p.r) p.y = h + p.r;
        if (p.y > h + p.r) p.y = -p.r;
      }
    } else if (this.mode === "pulse") {
      // Higher intensity = rings spawn more often and grow faster.
      const PULSE_INTERVAL = 3.5 / mul; // seconds between new rings
      const MAX_R = Math.max(w, h) * 0.65;

      this.pulseTimer -= dt;
      if (this.pulseTimer <= 0) {
        this.pulseTimer = PULSE_INTERVAL;
        this.pulseRings.push({ r: this.clockRadius || 0 });
      }

      const growth = 60 * mul; // px/sec
      for (const ring of this.pulseRings) {
        ring.r += growth * dt;
      }
      this.pulseRings = this.pulseRings.filter((ring) => ring.r < MAX_R);
      this._pulseMaxR = MAX_R;
    }
  }

  // ---------- Draw ----------

  _draw() {
    const ctx = this.ctx;
    const w = this.width || window.innerWidth;
    const h = this.height || window.innerHeight;

    ctx.clearRect(0, 0, w, h);
    if (this.mode === "none") return;

    ctx.save();
    // Clip out the circular region under the clock face ("evenodd" rule
    // punches a hole where the two subpaths overlap) so nothing ever
    // renders underneath the clock, regardless of effect.
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    if (this.clockRadius > 0) {
      ctx.moveTo(this.clockCenter.x + this.clockRadius, this.clockCenter.y);
      ctx.arc(this.clockCenter.x, this.clockCenter.y, this.clockRadius, 0, Math.PI * 2);
    }
    ctx.clip("evenodd");

    if (this.mode === "bubbles") this._drawBubbles();
    else if (this.mode === "plankton") this._drawPlankton();
    else if (this.mode === "bokeh") this._drawBokeh();
    else if (this.mode === "pulse") this._drawPulse();

    ctx.restore();
  }

  _drawBubbles() {
    const ctx = this.ctx;
    for (const p of this.particles) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(150, 220, 240, ${p.opacity})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = `rgba(150, 220, 240, ${p.opacity * 0.25})`;
      ctx.fill();
    }
  }

  _drawPlankton() {
    const ctx = this.ctx;
    const t = (this._lastT || 0) / 1000;
    for (const p of this.particles) {
      const twinkle = 0.5 + 0.5 * Math.sin(t * p.twinkleSpeed + p.phase);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(220, 240, 250, ${0.15 + twinkle * 0.5})`;
      ctx.fill();
    }
  }

  _drawBokeh() {
    const ctx = this.ctx;
    for (const p of this.particles) {
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
      grad.addColorStop(0, `hsla(${p.hue}, 70%, 65%, ${p.alpha})`);
      grad.addColorStop(1, `hsla(${p.hue}, 70%, 65%, 0)`);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    }
  }

  _drawPulse() {
    const ctx = this.ctx;
    const maxR = this._pulseMaxR || Math.max(this.width, this.height) * 0.65;
    for (const ring of this.pulseRings) {
      const startR = this.clockRadius || 0;
      const progress = Math.min(1, Math.max(0, (ring.r - startR) / (maxR - startR)));
      const alpha = (1 - progress) * 0.5;
      if (alpha <= 0) continue;
      ctx.beginPath();
      ctx.arc(this.clockCenter.x, this.clockCenter.y, ring.r, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(79, 214, 255, ${alpha})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = ParticleField;
}
