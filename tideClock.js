/**
 * tideClock.js
 *
 * Implements the "Tide Clock" drawing engine:
 * - A REAL functional 12-hour analog clock face: fixed numerals 12,1..11,
 *   hour/minute ticks, and actual moving hour + minute hands showing "now".
 * - Tide height is plotted around that same fixed face, at each sample's
 *   true time-of-day position (mod 12h) - so the ring doesn't spin, only
 *   the hands (and the visibility window) move with real time.
 * - Tide height mapped to a radial line drawn INWARD from the perimeter.
 *   - lowest tide -> penetrates 10% of R inward
 *   - highest tide -> penetrates at most 50% of R inward (never reaches center)
 * - Opacity fade: full for 0..+12h relative to now (entire 12-hour clock
 *   face is always fully visible; no fade-out).
 */

class TideClock {
  /**
   * @param {HTMLCanvasElement} faceCanvas - static-ish layer: rim, ticks, numerals, tide ring.
   * @param {HTMLCanvasElement} handsCanvas - fast-updating transparent overlay: hour/min/sec hands.
   */
  constructor(faceCanvas, handsCanvas) {
    this.faceCanvas = faceCanvas;
    this.faceCtx = faceCanvas.getContext("2d");
    this.handsCanvas = handsCanvas;
    this.handsCtx = handsCanvas.getContext("2d");
  }

  /**
   * Draws the tide ring + clock face markings (rim, ticks, numerals).
   * Call this on a slower interval (e.g. every 10s) since tide data
   * doesn't change meaningfully second-to-second.
   *
   * @param {Array<{time: Date, height: number}>} samples - dense tide samples
   *   (e.g. every 6 minutes), spanning at least [now, now+11h].
   * @param {Date} now - the reference "now" time.
   * @param {Object} [opts]
   * @param {number} [opts.hMin] - override min height for normalization
   * @param {number} [opts.hMax] - override max height for normalization
   */
  drawFace(samples, now, opts = {}) {
    const ctx = this.faceCtx;
    const canvas = this.faceCanvas;
    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) * 0.38;

    ctx.clearRect(0, 0, W, H);

    // Filter to the visible window: now through +12h (never look backward).
    const visible = samples
      .map((s) => {
        const dt = TideClock.hoursBetween(now, s.time);
        return { ...s, dt };
      })
      .filter((s) => s.dt >= 0 && s.dt <= 12);

    // Determine height range for normalization (use provided override, or data range).
    const heights = (visible.length ? visible : samples).map((s) => s.height);
    const hMin = opts.hMin !== undefined ? opts.hMin : Math.min(...heights);
    const hMax = opts.hMax !== undefined ? opts.hMax : Math.max(...heights);

    // --- Draw base clock face (outer rim + inner dead-zone guide) ---
    this._drawFace(cx, cy, R);

    // --- Draw foot gridlines (concentric rings) so tide height is readable ---
    this._drawFtGridlines(cx, cy, R, hMin, hMax, now);

    // --- Draw the continuous tide curve as a filled ring, fixed to time-of-day ---
    this._drawTideRing(cx, cy, R, visible, hMin, hMax);

    // --- Mark local high/low tide points along the visible curve ---
    this._drawHighLowMarkers(cx, cy, R, visible, hMin, hMax);

    // --- Draw fixed clock numerals (12, 1 .. 11) + minute ticks ---
    this._drawNumeralsAndTicks(cx, cy, R);
  }

  /**
   * Draws the analog hour/minute/second hands for "now" onto the
   * transparent hands overlay canvas. Call this frequently (e.g. every 1s)
   * for a smoothly ticking clock without redrawing the whole tide ring.
   *
   * @param {Date} now
   */
  drawHands(now) {
    const ctx = this.handsCtx;
    const canvas = this.handsCanvas;
    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) * 0.38;

    ctx.clearRect(0, 0, W, H);
    this._drawHands(cx, cy, R, now);
  }


  /** Draws concentric "ft" gridlines every 2 ft between hMin and hMax, using
   *  the same radial mapping as the tide ring, with small labels placed just
   *  clockwise of the current-time position (near "now" but offset so the
   *  hour/minute/second hands don't sit on top of the labels). */
  _drawFtGridlines(cx, cy, R, hMin, hMax, now) {
    const ctx = this.faceCtx;

    const step = 2;
    const EPS = 1e-6;
    const start = Math.ceil(hMin / step - EPS) * step;
    const end = Math.floor(hMax / step + EPS) * step;

    // Offset labels ~18 degrees clockwise from "now" so the hands (which
    // point exactly at "now") never overlap the labels.
    const nowTheta = TideClock.angleForTime(now);
    const labelOffset = (18 * Math.PI) / 180;
    const labelTheta = nowTheta + labelOffset;

    for (let ft = start; ft <= end + EPS; ft += step) {
      const r = TideClock.radiusForHeight(R, ft, hMin, hMax);

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(200, 230, 240, 0.22)";
      ctx.setLineDash([3, 5]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);

      const x = cx + r * Math.sin(labelTheta);
      const y = cy - r * Math.cos(labelTheta);

      // Small pill background behind the label so it stays legible over
      // the tide fill / other rings regardless of position.
      const text = `${Math.round(ft)}ft`;
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = "rgba(4, 8, 12, 0.65)";
      ctx.fillRect(x - tw / 2 - 3, y - 7, tw + 6, 14);

      ctx.fillStyle = "rgba(150, 165, 175, 0.85)";
      ctx.fillText(text, x, y);
    }
  }

  /** Finds local high/low tide extrema within the visible samples and draws
   *  a marker dot (plus small height label) at each one. */
  _drawHighLowMarkers(cx, cy, R, visible, hMin, hMax) {
    const ctx = this.faceCtx;
    if (visible.length < 3) return;

    for (let i = 1; i < visible.length - 1; i++) {
      const prev = visible[i - 1];
      const cur = visible[i];
      const next = visible[i + 1];

      const isHigh = cur.height >= prev.height && cur.height >= next.height;
      const isLow = cur.height <= prev.height && cur.height <= next.height;
      if (!isHigh && !isLow) continue;
      // Skip flat runs where neighbors are exactly equal (avoid duplicate markers).
      if (cur.height === prev.height && cur.height === next.height) continue;

      const alpha = TideClock.opacityForDeltaT(cur.dt);
      if (alpha <= 0) continue;

      const theta = TideClock.angleForTime(cur.time);
      const r = TideClock.radiusForHeight(R, cur.height, hMin, hMax);
      const x = cx + r * Math.sin(theta);
      const y = cy - r * Math.cos(theta);

      // Both high and low markers share one color; high tide = solid filled
      // dot, low tide = hollow/open ring, so the shape (not color) tells
      // them apart and neither is confused with the hands (red) or the
      // tide curve itself (cyan).
      const color = "#ffd166";

      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.globalAlpha = alpha;
      if (isHigh) {
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = "#0e1b24";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.fillStyle = "#0e1b24";
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Label: height + H/L, placed slightly further out along the same ray.
      const labelR = r + (isHigh ? -16 : 16);
      const lx = cx + labelR * Math.sin(theta);
      const ly = cy - labelR * Math.cos(theta);

      ctx.font = "bold 11px sans-serif";
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.globalAlpha = alpha;
      ctx.fillText(`${cur.height.toFixed(1)}${isHigh ? "H" : "L"}`, lx, ly);
      ctx.globalAlpha = 1;
    }
  }

  _drawFace(cx, cy, R) {
    const ctx = this.faceCtx;

    // Outer perimeter.
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(127, 168, 189, 0.6)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Inner "dead zone" guide (10% radius) - tide never crosses inward of this.
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.1, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(127, 168, 189, 0.25)";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // Outer "low tide" guide (90% radius).
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.9, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(127, 168, 189, 0.15)";
    ctx.setLineDash([2, 6]);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Draws the fixed 12/1/2../11 numerals and 60 minute tick marks, like a real clock. */
  _drawNumeralsAndTicks(cx, cy, R) {
    const ctx = this.faceCtx;

    // 60 minute ticks (every 5th is an hour tick, drawn thicker/longer).
    for (let m = 0; m < 60; m++) {
      const theta = (2 * Math.PI * m) / 60;
      const isHourTick = m % 5 === 0;
      const rOuter = R + 4;
      const rInner = isHourTick ? R - 12 : R - 6;

      const xO = cx + rOuter * Math.sin(theta);
      const yO = cy - rOuter * Math.cos(theta);
      const xI = cx + rInner * Math.sin(theta);
      const yI = cy - rInner * Math.cos(theta);

      ctx.beginPath();
      ctx.moveTo(xO, yO);
      ctx.lineTo(xI, yI);
      ctx.strokeStyle = isHourTick ? "rgba(220, 240, 248, 0.85)" : "rgba(160, 200, 215, 0.4)";
      ctx.lineWidth = isHourTick ? 2.5 : 1;
      ctx.stroke();
    }

    // Numerals 12, 1, 2, .. 11 just outside the rim (fixed positions, always visible).
    for (let hr = 0; hr < 12; hr++) {
      const theta = (2 * Math.PI * hr) / 12;
      const label = hr === 0 ? "12" : String(hr);
      const rLabel = R + 28;
      const x = cx + rLabel * Math.sin(theta);
      const y = cy - rLabel * Math.cos(theta);

      ctx.font = "bold 18px sans-serif";
      ctx.fillStyle = "rgba(232, 241, 245, 0.95)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, x, y);
    }
  }

  /** Draws real analog hour + minute + second hands pointing at "now". */
  _drawHands(cx, cy, R, now) {
    const ctx = this.handsCtx;

    const seconds = now.getSeconds() + now.getMilliseconds() / 1000;
    const minutes = now.getMinutes() + seconds / 60;
    const hours12 = (now.getHours() % 12) + minutes / 60;

    const hourTheta = (2 * Math.PI * hours12) / 12;
    const minuteTheta = (2 * Math.PI * minutes) / 60;
    const secondTheta = (2 * Math.PI * seconds) / 60;

    // Hour hand.
    const hourLen = R * 0.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + hourLen * Math.sin(hourTheta), cy - hourLen * Math.cos(hourTheta));
    ctx.strokeStyle = "#e8f1f5";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.stroke();

    // Minute hand.
    const minLen = R * 0.75;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + minLen * Math.sin(minuteTheta), cy - minLen * Math.cos(minuteTheta));
    ctx.strokeStyle = "#e05252";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.stroke();

    // Second hand (thin, with a small tail past center like a real clock).
    const secLen = R * 0.85;
    const secTailLen = R * 0.12;
    ctx.beginPath();
    ctx.moveTo(cx - secTailLen * Math.sin(secondTheta), cy + secTailLen * Math.cos(secondTheta));
    ctx.lineTo(cx + secLen * Math.sin(secondTheta), cy - secLen * Math.cos(secondTheta));
    ctx.strokeStyle = "#ff6b6b";
    ctx.lineWidth = 1.5;
    ctx.lineCap = "round";
    ctx.stroke();

    // Center pivot.
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#e05252";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Small red center dot on top (classic second-hand pivot look).
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#ff6b6b";
    ctx.fill();
  }

  _drawTideRing(cx, cy, R, visible, hMin, hMax) {
    const ctx = this.faceCtx;

    // Draw filled area between outer rim and the tide curve, per-segment opacity.
    for (let i = 0; i < visible.length - 1; i++) {
      const a = visible[i];
      const b = visible[i + 1];

      const alphaA = TideClock.opacityForDeltaT(a.dt);
      const alphaB = TideClock.opacityForDeltaT(b.dt);
      if (alphaA <= 0 && alphaB <= 0) continue;
      const alpha = (alphaA + alphaB) / 2;
      if (alpha <= 0) continue;

      const thetaA = TideClock.angleForTime(a.time);
      const thetaB = TideClock.angleForTime(b.time);

      const rA = TideClock.radiusForHeight(R, a.height, hMin, hMax);
      const rB = TideClock.radiusForHeight(R, b.height, hMin, hMax);

      const pOuterA = { x: cx + R * Math.sin(thetaA), y: cy - R * Math.cos(thetaA) };
      const pOuterB = { x: cx + R * Math.sin(thetaB), y: cy - R * Math.cos(thetaB) };
      const pInnerA = { x: cx + rA * Math.sin(thetaA), y: cy - rA * Math.cos(thetaA) };
      const pInnerB = { x: cx + rB * Math.sin(thetaB), y: cy - rB * Math.cos(thetaB) };

      ctx.beginPath();
      ctx.moveTo(pOuterA.x, pOuterA.y);
      ctx.lineTo(pOuterB.x, pOuterB.y);
      ctx.lineTo(pInnerB.x, pInnerB.y);
      ctx.lineTo(pInnerA.x, pInnerA.y);
      ctx.closePath();
      ctx.fillStyle = `rgba(45, 170, 214, ${0.35 * alpha})`;
      ctx.fill();
    }

    // Draw the tide curve line itself (the inner boundary).
    for (let i = 0; i < visible.length - 1; i++) {
      const a = visible[i];
      const b = visible[i + 1];

      const alphaA = TideClock.opacityForDeltaT(a.dt);
      const alphaB = TideClock.opacityForDeltaT(b.dt);
      const alpha = (alphaA + alphaB) / 2;
      if (alpha <= 0) continue;

      const thetaA = TideClock.angleForTime(a.time);
      const thetaB = TideClock.angleForTime(b.time);

      const rA = TideClock.radiusForHeight(R, a.height, hMin, hMax);
      const rB = TideClock.radiusForHeight(R, b.height, hMin, hMax);

      const pA = { x: cx + rA * Math.sin(thetaA), y: cy - rA * Math.cos(thetaA) };
      const pB = { x: cx + rB * Math.sin(thetaB), y: cy - rB * Math.cos(thetaB) };

      ctx.beginPath();
      ctx.moveTo(pA.x, pA.y);
      ctx.lineTo(pB.x, pB.y);
      ctx.strokeStyle = `rgba(79, 214, 255, ${alpha})`;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
  }

  // ---------- Static math helpers ----------

  /**
   * Angle in radians for a sample's absolute time-of-day, mod 12h.
   * 0 = top (12 o'clock), increasing clockwise - matches real clock hands.
   */
  static angleForTime(date) {
    const hours12 = (date.getHours() % 12) + date.getMinutes() / 60 + date.getSeconds() / 3600;
    return (2 * Math.PI * hours12) / 12;
  }

  /** Normalize height into [0,1], clamped. */
  static normalizeHeight(h, hMin, hMax) {
    if (hMax === hMin) return 0.5;
    const n = (h - hMin) / (hMax - hMin);
    return Math.min(1, Math.max(0, n));
  }

  /** Radius from center for a given tide height (10%-90% inward band). */
  static radiusForHeight(R, h, hMin, hMax) {
    const n = TideClock.normalizeHeight(h, hMin, hMax);
    return 0.9 * R - 0.8 * R * n;
  }

  /** Opacity for a given delta-t (hours ahead of now). Always fully visible
   *  across the whole 12-hour clock face. */
  static opacityForDeltaT(dt) {
    if (dt < 0 || dt > 12) return 0;
    return 1;
  }

  /** Hours between two Date objects (b - a), as a decimal. */
  static hoursBetween(a, b) {
    return (b.getTime() - a.getTime()) / (3600 * 1000);
  }

  static formatTime(date) {
    let h = date.getHours();
    const m = date.getMinutes();
    const ampm = h >= 12 ? "pm" : "am";
    h = h % 12;
    if (h === 0) h = 12;
    const mm = m.toString().padStart(2, "0");
    return `${h}:${mm}${ampm}`;
  }
}

// Export for both browser global and (optional) module usage.
if (typeof module !== "undefined" && module.exports) {
  module.exports = TideClock;
}
