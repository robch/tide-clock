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
   * @param {boolean} [opts.showHourHand] - whether hour hand will be shown
   * @param {boolean} [opts.showMinuteHand] - whether minute hand will be shown
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
    const withDt = samples.map((s) => ({ ...s, dt: TideClock.hoursBetween(now, s.time) }));
    const visible = withDt.filter((s) => s.dt >= 0 && s.dt <= 12);

    // The 6-minute samples almost never land exactly on dt=0 ("now") or
    // dt=12 ("now + 12h"), which left tiny unfilled wedges right at the
    // hour-hand position (looked like a "column"/gap). Fix: splice in
    // precisely-interpolated boundary points at exactly dt=0 and dt=12,
    // using the surrounding real samples (which cover a wider range than
    // just the visible window), so the ring's fill/stroke reach exactly to
    // both edges - with no gap and no fake connecting line between them
    // (they're still only adjacent to their own end of the array).
    const startBoundary = TideClock.interpolateAt(withDt, 0);
    const endBoundary = TideClock.interpolateAt(withDt, 12);
    if (startBoundary && (!visible.length || visible[0].dt > 0)) visible.unshift(startBoundary);
    if (endBoundary && (!visible.length || visible[visible.length - 1].dt < 12)) visible.push(endBoundary);

    // Determine height range for normalization (use provided override, or data range).
    const heights = (visible.length ? visible : samples).map((s) => s.height);
    const hMin = opts.hMin !== undefined ? opts.hMin : Math.min(...heights);
    const hMax = opts.hMax !== undefined ? opts.hMax : Math.max(...heights);
    const invert = !!opts.invertTide;

    // --- Draw base clock face (outer rim + inner dead-zone guide) ---
    this._drawFace(cx, cy, R);

    // Determine label offset for gridlines: if hands are visible, offset ~18 degrees
    // so hands don't overlap labels; if hands are hidden, put labels at 0 degrees (right at "now").
    const showingHands = (opts.showHourHand !== false || opts.showMinuteHand !== false);
    const labelOffset = showingHands ? (18 * Math.PI) / 180 : 0;

    // --- Draw foot gridlines (concentric rings) so tide height is readable ---
    this._drawFtGridlines(cx, cy, R, hMin, hMax, now, invert, labelOffset);

    // --- Draw the continuous tide curve as a filled ring, fixed to time-of-day ---
    this._drawTideRing(cx, cy, R, visible, hMin, hMax, invert);

    // --- Mark local high/low tide points along the visible curve ---
    this._drawHighLowMarkers(cx, cy, R, visible, withDt, hMin, hMax, invert);

    // --- Draw fixed clock numerals (12, 1 .. 11) + minute ticks ---
    this._drawNumeralsAndTicks(cx, cy, R);

    // --- Draw the trailing "past 6h" and leading "next 6h" tide trace
    // lines LAST, on top of absolutely everything (ring, markers, ticks,
    // numerals) so they never get visually merged/muted by anything drawn
    // underneath. True backward/forward extensions of the tide curve (same
    // radial height mapping, correct time-of-day angle), just a thinner
    // line (no fill) in the same blue family as the main curve, fading with
    // distance since it's context, not "current" data. ---
    this._drawPastTideLine(cx, cy, R, withDt, hMin, hMax, invert, 6);
    this._drawFutureTideLine(cx, cy, R, withDt, hMin, hMax, invert, 6);

    // --- Mark local high/low tide points along the dim past/future trace
    // lines too (same lighter blue family, not the bright yellow used for
    // the main 12h window), also drawn last/on top. ---
    this._drawDimHighLowMarkers(cx, cy, R, withDt, hMin, hMax, invert, -6, 0);
    this._drawDimHighLowMarkers(cx, cy, R, withDt, hMin, hMax, invert, 12, 18);

    // --- Draw the "now" indicator hand (rail track) when clock hands are hidden ---
    if (!showingHands) {
      this._drawNowIndicator(cx, cy, R, now, visible, hMin, hMax, invert);
    }

    // NOTE: the current-tide-height dot is drawn on the HANDS canvas (see
    // drawHands/_drawCurrentTideDot below), not here on the face canvas.
    // `clockHands` is a separate <canvas> stacked on top of `clockFace` via
    // CSS (position: absolute) - draw order *within* this method can never
    // put anything above the hands, since the hands canvas always
    // composites on top regardless. So we cache the tide-height inputs
    // needed to draw the dot, and draw it from drawHands() instead - that
    // also means it moves with the hands overlay and stays on top of them.
    this._lastTideDotInputs = { visible, hMin, hMax, invert };
  }

  /**
   * Draws the analog hour/minute/second hands for "now" onto the
   * transparent hands overlay canvas. Call this frequently (e.g. every 1s)
   * for a smoothly ticking clock without redrawing the whole tide ring.
   *
   * @param {Date} now
   * @param {Object} [opts]
   * @param {boolean} [opts.showHourHand] - whether to draw the hour hand
   * @param {boolean} [opts.showMinuteHand] - whether to draw the minute hand
   * @param {boolean} [opts.showSecondHand] - whether to draw the second hand
   */
  drawHands(now, opts = {}) {
    const ctx = this.handsCtx;
    const canvas = this.handsCanvas;
    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H) * 0.38;

    ctx.clearRect(0, 0, W, H);
    this._drawHands(cx, cy, R, now, opts);

    // Draw the current-tide-height dot LAST, on top of the hands themselves
    // (this canvas is stacked above the face canvas, so anything drawn here
    // is guaranteed to be on top of everything - ring, markers, rail
    // indicator, AND the hands). Uses the tide data cached by the most
    // recent drawFace() call; tide height changes slowly enough that being
    // very slightly stale between face redraws is not noticeable, while
    // `now` itself is always fresh so the dot's angle stays accurate every
    // tick. ---
    if (this._lastTideDotInputs) {
      const { visible, hMin, hMax, invert } = this._lastTideDotInputs;
      this._drawCurrentTideDot(ctx, cx, cy, R, now, visible, hMin, hMax, invert);
    }
  }


  /** Draws concentric "ft" gridlines every 2 ft between hMin and hMax, using
   *  the same radial mapping as the tide ring, with small labels placed at an
   *  offset from the current-time position. If clock hands are visible, offset
   *  clockwise so hands don't overlap labels; if hidden, place at 0 offset. */
  _drawFtGridlines(cx, cy, R, hMin, hMax, now, invert = false, labelOffset = 0) {
    const ctx = this.faceCtx;

    const step = 2;
    const EPS = 1e-6;
    const start = Math.ceil(hMin / step - EPS) * step;
    const end = Math.floor(hMax / step + EPS) * step;

    // Use the provided labelOffset (0 if hands are hidden, ~18 degrees if hands are visible).
    const nowTheta = TideClock.angleForTime(now);
    const labelTheta = nowTheta + labelOffset;

    for (let ft = start; ft <= end + EPS; ft += step) {
      const r = TideClock.radiusForHeight(R, ft, hMin, hMax, invert);

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(200, 230, 240, 0.12)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    
    // Draw labels
    for (let ft = start; ft <= end + EPS; ft += step) {
      const r = TideClock.radiusForHeight(R, ft, hMin, hMax, invert);
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

  /** Draws a wide hand-like "now" indicator when clock hands are hidden, showing
   *  the current time position with a hollow white stroke from center to edge. */
  _drawNowIndicator(cx, cy, R, now, visible, hMin, hMax, invert) {
    const ctx = this.faceCtx;
    const nowTheta = TideClock.angleForTime(now);
    
    const outerWidth = 36;
    const innerWidth = 24;
    const borderWidth = 6; // (36 - 24) / 2
    
    // Calculate arc radius (used for shortening the rails)
    const arcRadius = outerWidth / 2 - borderWidth / 2;
    
    // Shorten the rails by the arc radius
    const handLen = R - arcRadius;
    
    // Calculate the perpendicular direction (90 degrees from the hand direction)
    const perpX = -Math.cos(nowTheta);
    const perpY = -Math.sin(nowTheta);
    
    const endX = cx + handLen * Math.sin(nowTheta);
    const endY = cy - handLen * Math.cos(nowTheta);
    
    // Draw left rail - just a rectangle from center extending outward
    const leftInnerOffset = innerWidth / 2;
    const leftOuterOffset = outerWidth / 2;
    
    ctx.beginPath();
    ctx.moveTo(cx + perpX * leftInnerOffset, cy + perpY * leftInnerOffset);
    ctx.lineTo(endX + perpX * leftInnerOffset, endY + perpY * leftInnerOffset);
    ctx.lineTo(endX + perpX * leftOuterOffset, endY + perpY * leftOuterOffset);
    ctx.lineTo(cx + perpX * leftOuterOffset, cy + perpY * leftOuterOffset);
    ctx.closePath();
    ctx.fillStyle = "#e8f1f5";
    ctx.fill();
    
    // Draw right rail
    ctx.beginPath();
    ctx.moveTo(cx - perpX * leftInnerOffset, cy - perpY * leftInnerOffset);
    ctx.lineTo(endX - perpX * leftInnerOffset, endY - perpY * leftInnerOffset);
    ctx.lineTo(endX - perpX * leftOuterOffset, endY - perpY * leftOuterOffset);
    ctx.lineTo(cx - perpX * leftOuterOffset, cy - perpY * leftOuterOffset);
    ctx.closePath();
    ctx.fillStyle = "#e8f1f5";
    ctx.fill();
    
    // Draw arc connecting the outer ends of the two rails (just the curved line, not filled)
    ctx.beginPath();
    // Rotate 90 degrees clockwise: add PI/2 to both angles
    const startAngle = nowTheta + Math.PI;
    const endAngle = nowTheta;
    // Reduce radius by half the stroke width so it connects to the rails properly
    ctx.arc(endX, endY, arcRadius, startAngle, endAngle, false);
    ctx.strokeStyle = "#e8f1f5";
    ctx.lineWidth = borderWidth;
    ctx.stroke();
    
    // Draw arc at the center (inner end), rotated 180 degrees from the outer arc
    ctx.beginPath();
    const centerStartAngle = nowTheta;
    const centerEndAngle = nowTheta + Math.PI;
    const centerArcRadius = innerWidth / 2 + borderWidth * 0.5;
    ctx.arc(cx, cy, centerArcRadius, centerStartAngle, centerEndAngle, false);
    ctx.strokeStyle = "#e8f1f5";
    ctx.lineWidth = borderWidth;
    ctx.stroke();
  }

  /** Draws the small filled cyan dot marking the current tide height at
   *  "now", plus a slightly larger hollow ring around it for visibility,
   *  along the "now" angle. Always drawn - regardless of whether clock
   *  hands are shown or the hollow "now" rail indicator is shown - and
   *  drawn onto the HANDS canvas (see drawHands) so it's always on top,
   *  including on top of the hour/minute/second hands themselves.
   *  Deliberately does NOT skip drawing when it coincides with a bright
   *  yellow high/low marker (dt=0 exactly); it's fine for the dot to sit on
   *  top of that marker's small circle, since the marker's text label is
   *  offset further out along the same ray and is unaffected.
   *  `ctx` is passed explicitly since this can be drawn onto either the
   *  face or hands canvas context. */
  _drawCurrentTideDot(ctx, cx, cy, R, now, visible, hMin, hMax, invert) {
    if (!visible || visible.length === 0) return;

    const nowTheta = TideClock.angleForTime(now);

    // Find the sample closest to "now" (dt closest to 0)
    const nowSample = visible.reduce((closest, s) => {
      return Math.abs(s.dt) < Math.abs(closest.dt) ? s : closest;
    });

    // Calculate the radius for the current tide height
    const tideRadius = TideClock.radiusForHeight(R, nowSample.height, hMin, hMax, invert);

    // Position the circle along the "now" angle at the tide height radius
    const tideX = cx + tideRadius * Math.sin(nowTheta);
    const tideY = cy - tideRadius * Math.cos(nowTheta);

    // Outer hollow ring first (so the filled dot sits on top, crisp center).
    const outerRingRadius = 9;
    ctx.beginPath();
    ctx.arc(tideX, tideY, outerRingRadius, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(79, 214, 255, 0.9)";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Draw filled circle (blue, matching the tide line color)
    const innerCircleRadius = 5; // Same size as low tide marker
    ctx.beginPath();
    ctx.arc(tideX, tideY, innerCircleRadius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(79, 214, 255, 1)"; // Same as the tide curve line color
    ctx.fill();
  }


  /** Finds local high/low tide extrema within the visible samples and draws
   *  a marker dot (plus small height label) at each one.
   *
   *  IMPORTANT: neighbor lookups use the FULL `withDt` dataset (not just
   *  `visible`), so the very first/last entries of `visible` (dt===0 or
   *  dt===12) can still be correctly classified as a high/low extremum by
   *  looking just outside the clipped window. Without this, a tide peak
   *  that lands exactly at "now" (e.g. right after seeking forward to it,
   *  since simulatedTime is set to the target's exact timestamp) would sit
   *  at visible[0] and - if the loop only ever compared interior points -
   *  would never be evaluated as `cur`, silently never getting a marker. */
  _drawHighLowMarkers(cx, cy, R, visible, withDt, hMin, hMax, invert = false) {
    const ctx = this.faceCtx;
    if (visible.length < 1) return;

    for (let i = 0; i < visible.length; i++) {
      const cur = visible[i];
      const prev = i > 0 ? visible[i - 1] : TideClock.nearestBefore(withDt, cur.dt);
      const next = i < visible.length - 1 ? visible[i + 1] : TideClock.nearestAfter(withDt, cur.dt);
      if (!prev || !next) continue;

      const isHigh = cur.height >= prev.height && cur.height >= next.height;
      const isLow = cur.height <= prev.height && cur.height <= next.height;
      if (!isHigh && !isLow) continue;
      // Skip flat runs where neighbors are exactly equal (avoid duplicate markers).
      if (cur.height === prev.height && cur.height === next.height) continue;

      const alpha = TideClock.opacityForDeltaT(cur.dt);
      if (alpha <= 0) continue;

      const theta = TideClock.angleForTime(cur.time);
      const r = TideClock.radiusForHeight(R, cur.height, hMin, hMax, invert);
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

  /** Like `_drawHighLowMarkers`, but for the dim past/future trace segments
   *  (outside the main 12h window). Uses the same faint dark-blue as the
   *  trace lines (not the bright yellow used for the main window's
   *  high/low markers) and fades with distance from the main window's edge,
   *  matching `_drawPastTideLine` / `_drawFutureTideLine`'s fade curve, so
   *  markers never look "brighter" than the line they sit on.
   *  `dtLo`/`dtHi` bound the segment (e.g. -6..0 for past, 12..18 for future). */
  _drawDimHighLowMarkers(cx, cy, R, withDt, hMin, hMax, invert, dtLo, dtHi) {
    const ctx = this.faceCtx;

    // The shared boundary with the main 12h window (dt=0 for the past
    // segment, dt=12 for the future segment) is excluded here - that exact
    // sample already gets a bright yellow marker+label from
    // `_drawHighLowMarkers`, and since this dim version is drawn later (on
    // top), an inclusive boundary would silently overwrite that bright
    // label with a duller gray one at the identical (x,y) whenever a hi/lo
    // tide happens to land precisely on "now" (e.g. right after seeking to
    // it) or precisely on "now + 12h".
    const isPast = dtHi <= 0; // past segment fades toward dtLo; future fades toward dtHi.
    let segment = withDt.filter((s) => (isPast ? s.dt >= dtLo && s.dt < dtHi : s.dt > dtLo && s.dt <= dtHi));
    const startBoundary = TideClock.interpolateAt(withDt, dtLo);
    const endBoundary = TideClock.interpolateAt(withDt, dtHi);
    if (!isPast && startBoundary && (!segment.length || segment[0].dt > dtLo)) segment.unshift(startBoundary);
    if (isPast && endBoundary && (!segment.length || segment[segment.length - 1].dt < dtHi)) segment.push(endBoundary);

    if (segment.length < 3) return;
    const span = dtHi - dtLo;
    const MAX_ALPHA = 0.85;
    const color = "rgba(150, 150, 155,"; // same base color as the trace lines.

    const alphaForDt = (dt) => {
      if (isPast) return MAX_ALPHA * (1 - Math.min(1, Math.max(0, (0 - dt) / span)));
      return MAX_ALPHA * (1 - Math.min(1, Math.max(0, (dt - 12) / span)));
    };

    for (let i = 1; i < segment.length - 1; i++) {
      const prev = segment[i - 1];
      const cur = segment[i];
      const next = segment[i + 1];

      const isHigh = cur.height >= prev.height && cur.height >= next.height;
      const isLow = cur.height <= prev.height && cur.height <= next.height;
      if (!isHigh && !isLow) continue;
      if (cur.height === prev.height && cur.height === next.height) continue;

      const alpha = alphaForDt(cur.dt);
      if (alpha <= 0.02) continue;

      const theta = TideClock.angleForTime(cur.time);
      const r = TideClock.radiusForHeight(R, cur.height, hMin, hMax, invert);
      const x = cx + r * Math.sin(theta);
      const y = cy - r * Math.cos(theta);

      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      if (isHigh) {
        ctx.fillStyle = `${color} ${alpha})`;
        ctx.fill();
      } else {
        ctx.fillStyle = "rgba(4, 8, 12, 0.65)";
        ctx.fill();
        ctx.strokeStyle = `${color} ${alpha})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      const labelR = r + (isHigh ? -14 : 14);
      const lx = cx + labelR * Math.sin(theta);
      const ly = cy - labelR * Math.cos(theta);

      ctx.font = "10px sans-serif";
      ctx.fillStyle = `${color} ${alpha})`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${cur.height.toFixed(1)}${isHigh ? "H" : "L"}`, lx, ly);
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
  _drawHands(cx, cy, R, now, opts = {}) {
    const ctx = this.handsCtx;

    // Default all hands to visible unless explicitly disabled
    const showHourHand = opts.showHourHand !== false;
    const showMinuteHand = opts.showMinuteHand !== false;
    // Second hand can only show if both hour and minute hands are shown
    const showSecondHand = opts.showSecondHand === true && showHourHand && showMinuteHand;

    const seconds = now.getSeconds() + now.getMilliseconds() / 1000;
    const minutes = now.getMinutes() + seconds / 60;
    const hours12 = (now.getHours() % 12) + minutes / 60;

    const hourTheta = (2 * Math.PI * hours12) / 12;
    const minuteTheta = (2 * Math.PI * minutes) / 60;
    const secondTheta = (2 * Math.PI * seconds) / 60;

    // Hour hand.
    if (showHourHand) {
      const hourLen = R * 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + hourLen * Math.sin(hourTheta), cy - hourLen * Math.cos(hourTheta));
      ctx.strokeStyle = "#e8f1f5";
      ctx.lineWidth = 5;
      ctx.lineCap = "round";
      ctx.stroke();
    }

    // Minute hand.
    if (showMinuteHand) {
      const minLen = R * 0.75;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + minLen * Math.sin(minuteTheta), cy - minLen * Math.cos(minuteTheta));
      ctx.strokeStyle = "#e8f1f5";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.stroke();
    }

    // Second hand (thin, with a small tail past center like a real clock).
    if (showSecondHand) {
      const secLen = R * 0.85;
      const secTailLen = R * 0.12;
      ctx.beginPath();
      ctx.moveTo(cx - secTailLen * Math.sin(secondTheta), cy + secTailLen * Math.cos(secondTheta));
      ctx.lineTo(cx + secLen * Math.sin(secondTheta), cy - secLen * Math.cos(secondTheta));
      ctx.strokeStyle = "#ff6b6b";
      ctx.lineWidth = 1.5;
      ctx.lineCap = "round";
      ctx.stroke();
    }

    // Center pivot (only draw if at least one hand is showing).
    if (showHourHand || showMinuteHand || showSecondHand) {
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
  }

  /** Draws the trailing "past" tide line: a true backward extension of the
   *  main tide curve, using the SAME radial height mapping (`radiusForHeight`,
   *  honoring `invert`) and time-of-day angle as the forward ring - so it
   *  reads as one continuous line bending backward from "now", not a
   *  separate element. Covers the last `hoursBack` hours before "now", with
   *  no fill (just a stroked line, thinner and darker-blue than the main
   *  curve), fading from fully transparent at the oldest point up to a
   *  modest max opacity right at "now".
   *
   *  Must be drawn AFTER `_drawTideRing` (the forward ring's fill is a wide
   *  wedge from the rim to the curve at each angle; drawing the past line
   *  first would let that fill paint over it even though the past line sits
   *  at a different radius - different height, but still often inside that
   *  wedge). Drawing on top guarantees it's always visible. */
  _drawPastTideLine(cx, cy, R, withDt, hMin, hMax, invert = false, hoursBack = 3) {
    const ctx = this.faceCtx;

    let past = withDt.filter((s) => s.dt >= -hoursBack && s.dt <= 0);

    const startBoundary = TideClock.interpolateAt(withDt, -hoursBack);
    const endBoundary = TideClock.interpolateAt(withDt, 0);
    if (startBoundary && (!past.length || past[0].dt > -hoursBack)) past.unshift(startBoundary);
    if (endBoundary && (!past.length || past[past.length - 1].dt < 0)) past.push(endBoundary);

    if (past.length < 2) return;

    const MAX_ALPHA = 0.85;

    for (let i = 0; i < past.length - 1; i++) {
      const a = past[i];
      const b = past[i + 1];

      // Fade from 0 at dt=-hoursBack to MAX_ALPHA at dt=0.
      const alphaA = MAX_ALPHA * (1 - Math.min(1, Math.max(0, -a.dt / hoursBack)));
      const alphaB = MAX_ALPHA * (1 - Math.min(1, Math.max(0, -b.dt / hoursBack)));
      const alpha = (alphaA + alphaB) / 2;
      if (alpha <= 0) continue;

      const thetaA = TideClock.angleForTime(a.time);
      const thetaB = TideClock.angleForTime(b.time);

      const rA = TideClock.radiusForHeight(R, a.height, hMin, hMax, invert);
      const rB = TideClock.radiusForHeight(R, b.height, hMin, hMax, invert);

      const pA = { x: cx + rA * Math.sin(thetaA), y: cy - rA * Math.cos(thetaA) };
      const pB = { x: cx + rB * Math.sin(thetaB), y: cy - rB * Math.cos(thetaB) };

      ctx.beginPath();
      ctx.moveTo(pA.x, pA.y);
      ctx.lineTo(pB.x, pB.y);
      ctx.strokeStyle = `rgba(150, 150, 155, ${alpha})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  /** Draws the leading "future" tide line beyond the main +12h window: a
   *  forward extension of the tide curve, using the SAME radial height
   *  mapping and time-of-day angle as the forward ring, covering the
   *  `hoursForward` hours after +12h (i.e. dt in [12, 12+hoursForward]).
   *  Same visual style as `_drawPastTideLine` (no fill, darker blue, thinner
   *  line), but fading the opposite direction: full opacity right at +12h
   *  (continuing seamlessly from where the main ring ends), fading to
   *  nothing at the far end. Must be drawn AFTER `_drawTideRing` so it's
   *  never hidden under the forward ring's fill wedge. */
  _drawFutureTideLine(cx, cy, R, withDt, hMin, hMax, invert = false, hoursForward = 3) {
    const ctx = this.faceCtx;

    const endDt = 12 + hoursForward;
    let future = withDt.filter((s) => s.dt >= 12 && s.dt <= endDt);

    const startBoundary = TideClock.interpolateAt(withDt, 12);
    const endBoundary = TideClock.interpolateAt(withDt, endDt);
    if (startBoundary && (!future.length || future[0].dt > 12)) future.unshift(startBoundary);
    if (endBoundary && (!future.length || future[future.length - 1].dt < endDt)) future.push(endBoundary);

    if (future.length < 2) return;

    const MAX_ALPHA = 0.85;

    for (let i = 0; i < future.length - 1; i++) {
      const a = future[i];
      const b = future[i + 1];

      // Fade from MAX_ALPHA at dt=12 to 0 at dt=12+hoursForward.
      const alphaA = MAX_ALPHA * (1 - Math.min(1, Math.max(0, (a.dt - 12) / hoursForward)));
      const alphaB = MAX_ALPHA * (1 - Math.min(1, Math.max(0, (b.dt - 12) / hoursForward)));
      const alpha = (alphaA + alphaB) / 2;
      if (alpha <= 0) continue;

      const thetaA = TideClock.angleForTime(a.time);
      const thetaB = TideClock.angleForTime(b.time);

      const rA = TideClock.radiusForHeight(R, a.height, hMin, hMax, invert);
      const rB = TideClock.radiusForHeight(R, b.height, hMin, hMax, invert);

      const pA = { x: cx + rA * Math.sin(thetaA), y: cy - rA * Math.cos(thetaA) };
      const pB = { x: cx + rB * Math.sin(thetaB), y: cy - rB * Math.cos(thetaB) };

      ctx.beginPath();
      ctx.moveTo(pA.x, pA.y);
      ctx.lineTo(pB.x, pB.y);
      ctx.strokeStyle = `rgba(150, 150, 155, ${alpha})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  _drawTideRing(cx, cy, R, visible, hMin, hMax, invert = false) {
    const ctx = this.faceCtx;

    // Draw filled area between the "far" boundary and the tide curve, per-segment
    // opacity. In normal mode the far boundary is the outer rim (fill grows inward
    // from the perimeter as tide rises). In inverted mode the far boundary is the
    // center-ish dead zone (fill grows outward from the middle as tide rises).
    const farBoundaryR = invert ? R * 0.1 : R;

    // `visible` already includes precisely-interpolated boundary points at
    // dt=0 ("now") and dt=12 ("now + 12h") - see drawFace - so the ring
    // fill/stroke reach exactly to both edges with no missing sliver and
    // no fake connecting line between the two ends.

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

      const rA = TideClock.radiusForHeight(R, a.height, hMin, hMax, invert);
      const rB = TideClock.radiusForHeight(R, b.height, hMin, hMax, invert);

      const pFarA = { x: cx + farBoundaryR * Math.sin(thetaA), y: cy - farBoundaryR * Math.cos(thetaA) };
      const pFarB = { x: cx + farBoundaryR * Math.sin(thetaB), y: cy - farBoundaryR * Math.cos(thetaB) };
      const pCurveA = { x: cx + rA * Math.sin(thetaA), y: cy - rA * Math.cos(thetaA) };
      const pCurveB = { x: cx + rB * Math.sin(thetaB), y: cy - rB * Math.cos(thetaB) };

      ctx.beginPath();
      ctx.moveTo(pFarA.x, pFarA.y);
      ctx.lineTo(pFarB.x, pFarB.y);
      ctx.lineTo(pCurveB.x, pCurveB.y);
      ctx.lineTo(pCurveA.x, pCurveA.y);
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

      const rA = TideClock.radiusForHeight(R, a.height, hMin, hMax, invert);
      const rB = TideClock.radiusForHeight(R, b.height, hMin, hMax, invert);

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

  /** Radius from center for a given tide height (10%-90% inward band).
   *  When `inverted` is true, the mapping flips: low tide sits near the
   *  center and high tide sits near the rim (instead of the default where
   *  low tide is near the rim and high tide is near the center). */
  static radiusForHeight(R, h, hMin, hMax, inverted = false) {
    const n = TideClock.normalizeHeight(h, hMin, hMax);
    return inverted ? 0.1 * R + 0.8 * R * n : 0.9 * R - 0.8 * R * n;
  }

  /** Opacity for a given delta-t (hours ahead of now). Always fully visible
   *  across the whole 12-hour clock face. The ring's start/end boundaries
   *  are closed precisely (see drawFace's boundary interpolation), so no
   *  fade-out is needed here. */
  static opacityForDeltaT(dt) {
    if (dt < 0 || dt > 12) return 0;
    return 1;
  }

  /** Hours between two Date objects (b - a), as a decimal. */
  static hoursBetween(a, b) {
    return (b.getTime() - a.getTime()) / (3600 * 1000);
  }

  /** Nearest real sample strictly before the given dt (largest dt < targetDt). */
  static nearestBefore(withDt, targetDt) {
    let best = null;
    for (const s of withDt) {
      if (s.dt < targetDt && (!best || s.dt > best.dt)) best = s;
    }
    return best;
  }

  /** Nearest real sample strictly after the given dt (smallest dt > targetDt). */
  static nearestAfter(withDt, targetDt) {
    let best = null;
    for (const s of withDt) {
      if (s.dt > targetDt && (!best || s.dt < best.dt)) best = s;
    }
    return best;
  }

  /** Given samples with a `.dt` field (hours relative to "now"), linearly
   *  interpolate the height at an exact target dt (e.g. 0 or 12), using the
   *  two real samples straddling it. Returns null if there isn't a sample
   *  on each side to interpolate between. Used to close the tide ring
   *  precisely at the "now" and "now + 12h" boundaries instead of leaving
   *  a gap at whatever dt the nearest real sample happens to fall on. */
  static interpolateAt(withDt, targetDt) {
    let before = null;
    let after = null;
    for (const s of withDt) {
      if (s.dt <= targetDt && (!before || s.dt > before.dt)) before = s;
      if (s.dt >= targetDt && (!after || s.dt < after.dt)) after = s;
    }
    if (!before || !after) return null;
    if (before === after) return { time: before.time, height: before.height, dt: targetDt };

    const span = after.dt - before.dt;
    const frac = span === 0 ? 0 : (targetDt - before.dt) / span;
    const height = before.height + (after.height - before.height) * frac;
    const time = new Date(before.time.getTime() + frac * (after.time.getTime() - before.time.getTime()));
    return { time, height, dt: targetDt };
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
