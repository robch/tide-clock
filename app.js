/**
 * app.js
 *
 * Wires up the UI: fetches NOAA tide prediction data (6-minute interval
 * predictions, which gives us a dense, already-continuous curve) and
 * feeds it into the TideClock renderer.
 *
 * Data source: NOAA CO-OPS Tides & Currents API (public, CORS-enabled).
 * https://api.tidesandcurrents.noaa.gov/api/prod/
 */

const faceCanvas = document.getElementById("clockFace");
const handsCanvas = document.getElementById("clockHands");
const tideClock = new TideClock(faceCanvas, handsCanvas);

const particleCanvas = document.getElementById("particleCanvas");
const particleField = new ParticleField(particleCanvas);
const clockStackEl = document.querySelector(".canvas-stack");
const modeLabelEl = document.getElementById("modeLabel");
const PARTICLE_MODES = ["none", "bubbles", "plankton", "pulse", "bokeh"];
const PARTICLE_MODE_NAMES = {
  none: "None",
  bubbles: "Bubbles",
  plankton: "Plankton",
  pulse: "Pulse",
  bokeh: "Bokeh",
};

// How often to redraw the tide ring/face (ms). Tide data changes slowly,
// so this can be much less frequent than the hands tick.
const TIDE_REDRAW_INTERVAL_MS = 10 * 1000;
// How often to redraw the analog hands (ms) - keep this near 1000 for a
// smoothly ticking second hand.
const HANDS_REDRAW_INTERVAL_MS = 1000;

const stationIdInput = document.getElementById("stationId");
const stationNameEl = document.getElementById("stationName");
const loadBtn = document.getElementById("loadBtn");
const statusEl = document.getElementById("status");
const settingsPanel = document.getElementById("settingsPanel");
const settingsBtn = document.getElementById("settingsBtn");
const closeSettingsBtn = document.getElementById("closeSettingsBtn");
const appEl = document.getElementById("app");
const useLocationBtn = document.getElementById("useLocationBtn");
const invertTideCheckbox = document.getElementById("invertTide");
const particleModeSelect = document.getElementById("particleMode");
const showHourHandCheckbox = document.getElementById("showHourHand");
const showMinuteHandCheckbox = document.getElementById("showMinuteHand");
const showSecondHandCheckbox = document.getElementById("showSecondHand");
const showDateTimeCheckbox = document.getElementById("showDateTime");
const bobModeBtn = document.getElementById("bobModeBtn");
const dateTimeDisplayEl = document.getElementById("dateTimeDisplay");
const tideHeightDisplayEl = document.getElementById("tideHeightDisplay");
const tidePredictionsHighEl = document.getElementById("tidePredictionsHigh");
const tidePredictionsLowEl = document.getElementById("tidePredictionsLow");
const rewindBtn = document.getElementById("rewindBtn");
const pauseResetBtn = document.getElementById("pauseResetBtn");
const fastForwardBtn = document.getElementById("fastForwardBtn");
const jumpToHighBtn = document.getElementById("jumpToHighBtn");
const jumpToLowBtn = document.getElementById("jumpToLowBtn");

let redrawTimer = null;
let currentSamples = null;
let currentHeightRange = { hMin: -2, hMax: 10 };

// Time simulation state
let simulatedTime = null; // null = use real time, Date object = simulated time
let timeMultiplier = 1.0; // -86400.0 to +86400.0 (negative = reverse, positive = forward, 86400 = 24hr/sec)
let lastUpdateTime = Date.now();
let heldKeys = {}; // Track which keys are being held
let targetTime = null; // When jumping to a specific time, this is the target

// Restore the "flip tide direction" preference from localStorage.
invertTideCheckbox.checked = localStorage.getItem("invertTide") === "true";

// Restore clock hand visibility preferences from localStorage (default: all hidden).
showHourHandCheckbox.checked = localStorage.getItem("showHourHand") === "true";
showMinuteHandCheckbox.checked = localStorage.getItem("showMinuteHand") === "true";
showSecondHandCheckbox.checked = localStorage.getItem("showSecondHand") === "true";

// Restore date/time display preference from localStorage.
showDateTimeCheckbox.checked = localStorage.getItem("showDateTime") !== "false"; // default true

// Update date/time display visibility
function updateDateTimeDisplay() {
  if (showDateTimeCheckbox.checked) {
    dateTimeDisplayEl.classList.remove("hidden");
  } else {
    dateTimeDisplayEl.classList.add("hidden");
  }
}
updateDateTimeDisplay();

// Get current time (either real or simulated)
function getCurrentTime() {
  return simulatedTime || new Date();
}

// Format date/time for display (single line)
function formatDateTime(date) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  
  const dayName = days[date.getDay()];
  const monthName = months[date.getMonth()];
  const day = date.getDate();
  
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  
  return `${dayName}, ${monthName} ${day}  ${hours}:${mm}:${ss} ${ampm}`;
}

// Format time only (for tide predictions)
function formatTimeOnly(date) {
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = date.getSeconds();
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  
  return `${hours}:${mm}:${ss} ${ampm}`;
}

// Format date only (for tide predictions)
function formatDateOnly(date) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  
  const dayName = days[date.getDay()];
  const monthName = months[date.getMonth()];
  const day = date.getDate();
  
  return `${dayName}, ${monthName} ${day}`;
}

// Update the date/time display element
function updateDateTimeDisplayText() {
  const now = getCurrentTime();
  const timeStr = formatTimeOnly(now);
  const dateStr = formatDateOnly(now);
  
  // Update tide height display
  if (currentSamples && currentSamples.length > 0) {
    const nearest = currentSamples.reduce((best, s) => {
      const d = Math.abs(s.time - now);
      return !best || d < Math.abs(best.time - now) ? s : best;
    }, null);
    
    if (nearest) {
      // Put all 3 lines together in one element, just like high/low
      dateTimeDisplayEl.innerHTML = `${timeStr}<br>${dateStr}<br><span class="tide-marker-current">●</span> Tide: ${nearest.height.toFixed(1)} ft`;
    }
    
    // Update next high/low tide predictions
    updateTidePredictions(now);
  }
  
  // Update pause/reset button state
  updatePauseResetButton();
}

// Update the middle transport button based on state
function updatePauseResetButton() {
  const atCurrentTime = (simulatedTime === null);
  const isMoving = (Math.abs(timeMultiplier) > 1.0);
  
  if (atCurrentTime) {
    // At current time - button is disabled and shows reset icon
    pauseResetBtn.textContent = "↻";
    pauseResetBtn.disabled = true;
  } else if (isMoving) {
    // Not at current time and moving - show pause
    pauseResetBtn.textContent = "❚❚";
    pauseResetBtn.disabled = false;
  } else {
    // Not at current time but paused - show reset
    pauseResetBtn.textContent = "↻";
    pauseResetBtn.disabled = false;
  }
}

// Find and display next high and low tides
function updateTidePredictions(now) {
  if (bobModeBtn.classList.contains("active")) {
    tidePredictionsHighEl.innerHTML = '';
    tidePredictionsLowEl.innerHTML = '';
    return;
  }

  if (!currentSamples || currentSamples.length < 3) {
    tidePredictionsHighEl.innerHTML = '';
    tidePredictionsLowEl.innerHTML = '';
    return;
  }
  
  // Find all high/low tide points after 'now'
  const extrema = [];
  for (let i = 1; i < currentSamples.length - 1; i++) {
    const prev = currentSamples[i - 1];
    const cur = currentSamples[i];
    const next = currentSamples[i + 1];
    
    const isHigh = cur.height >= prev.height && cur.height >= next.height;
    const isLow = cur.height <= prev.height && cur.height <= next.height;
    
    if ((isHigh || isLow) && cur.time > now) {
      // Skip flat runs
      if (cur.height === prev.height && cur.height === next.height) continue;
      extrema.push({ time: cur.time, height: cur.height, isHigh });
    }
  }
  
  // Find next high and next low
  const nextHigh = extrema.find(e => e.isHigh);
  const nextLow = extrema.find(e => !e.isHigh);
  
  if (nextHigh) {
    const timeStr = formatTimeOnly(nextHigh.time);
    const dateStr = formatDateOnly(nextHigh.time);
    
    tidePredictionsHighEl.innerHTML = `${timeStr}<br>${dateStr}<br>High: ${nextHigh.height.toFixed(1)} ft <span class="tide-marker-high">●</span>`;
  } else {
    tidePredictionsHighEl.innerHTML = '';
  }
  
  if (nextLow) {
    const timeStr = formatTimeOnly(nextLow.time);
    const dateStr = formatDateOnly(nextLow.time);
    
    tidePredictionsLowEl.innerHTML = `${timeStr}<br>${dateStr}<br>Low: ${nextLow.height.toFixed(1)} ft <span class="tide-marker-low">○</span>`;
  } else {
    tidePredictionsLowEl.innerHTML = '';
  }
}

// Restore the background animation preference from localStorage.
let currentParticleMode = localStorage.getItem("particleMode") || "none";
if (!PARTICLE_MODES.includes(currentParticleMode)) currentParticleMode = "none";
particleModeSelect.value = currentParticleMode;

function setParticleMode(mode, showLabel = true) {
  currentParticleMode = mode;
  localStorage.setItem("particleMode", mode);
  particleModeSelect.value = mode;
  particleField.setMode(mode);
  if (showLabel) showModeLabel(PARTICLE_MODE_NAMES[mode] || mode);
}

let modeLabelFadeTimer = null;
function showModeLabel(text) {
  clearTimeout(modeLabelFadeTimer);
  modeLabelEl.textContent = text;
  // Reset to fully visible immediately (interrupt any in-flight fade).
  modeLabelEl.style.transition = "none";
  modeLabelEl.style.opacity = "1";
  // Force reflow so the transition re-applies cleanly next time we fade.
  void modeLabelEl.offsetHeight;
  modeLabelEl.style.transition = "opacity 1.2s ease";
  modeLabelFadeTimer = setTimeout(() => {
    modeLabelEl.style.opacity = "0";
  }, 300);
}

function resizeParticleCanvas() {
  particleField.resize();
  particleField.updateClockGeometry(clockStackEl);
}
window.addEventListener("resize", resizeParticleCanvas);
resizeParticleCanvas();

particleModeSelect.addEventListener("change", () => {
  setParticleMode(particleModeSelect.value);
});

particleField.setMode(currentParticleMode);
particleField.start();

// Updates the second hand checkbox's enabled state based on hour/minute hand visibility
// (second hand can only be shown if both hour and minute hands are shown).
function updateSecondHandCheckboxState() {
  const canShowSecondHand = showHourHandCheckbox.checked && showMinuteHandCheckbox.checked;
  showSecondHandCheckbox.disabled = !canShowSecondHand;
  if (!canShowSecondHand && showSecondHandCheckbox.checked) {
    showSecondHandCheckbox.checked = false;
    localStorage.setItem("showSecondHand", "false");
  }
}

// Initial state update
updateSecondHandCheckboxState();

// Restore intensity preference (0.25 .. 3.0, default 1.0).
let currentIntensity = parseFloat(localStorage.getItem("particleIntensity")) || 1.0;
particleField.setIntensity(currentIntensity);

function setIntensity(value) {
  currentIntensity = Math.min(3.0, Math.max(0.25, Math.round(value * 4) / 4));
  localStorage.setItem("particleIntensity", currentIntensity);
  particleField.setIntensity(currentIntensity);
  showModeLabel(`${PARTICLE_MODE_NAMES[currentParticleMode] || currentParticleMode} \u00d7${currentIntensity.toFixed(2).replace(/\.?0+$/, "") || "1"}`);
}

/** Computes a stable hMin/hMax from a full sample set, rounded outward to
 *  the nearest 2ft gridline boundary, so the outermost gridline ring always
 *  encloses the actual data (e.g. a -2.3ft low always gets a -4ft ring,
 *  not just -2ft) and the radial scale doesn't jump as the visible window slides. */
function computeHeightRange(samples) {
  const GRID_STEP = 2;
  const heights = samples.map((s) => s.height);
  const rawMin = Math.min(...heights);
  const rawMax = Math.max(...heights);
  const hMin = Math.floor(rawMin / GRID_STEP) * GRID_STEP;
  const hMax = Math.ceil(rawMax / GRID_STEP) * GRID_STEP;
  return { hMin, hMax };
}

async function fetchStationName(stationId) {
  try {
    const url = `https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/${stationId}.json`;
    const res = await fetch(url);
    if (!res.ok) return stationId;
    const json = await res.json();
    const st = json.stations && json.stations[0];
    return st ? `${st.name}, ${st.state}` : stationId;
  } catch (e) {
    return stationId;
  }
}

/** Haversine distance in km between two lat/lon points. */
function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

let _noaaStationsCache = null;

/** Fetch (and cache) the full list of NOAA tide prediction stations. */
async function fetchNoaaStations() {
  if (_noaaStationsCache) return _noaaStationsCache;
  const res = await fetch(
    "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions",
  );
  if (!res.ok) throw new Error(`NOAA station list error: ${res.status}`);
  const json = await res.json();
  _noaaStationsCache = json.stations ?? [];
  return _noaaStationsCache;
}

/** Given lat/lon, return NOAA tide prediction stations sorted by distance (nearest first). */
async function findNearestStations(latitude, longitude, limit = 8) {
  const stations = await fetchNoaaStations();
  return stations
    .map((s) => ({ ...s, distanceKm: haversineKm(latitude, longitude, s.lat, s.lng) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

/** Ask the browser for the user's real GPS location (with permission prompt). */
function getBrowserLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation is not supported by this browser."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      (err) => reject(new Error(err.message || "Failed to get location.")),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}

async function useMyLocation() {
  useLocationBtn.disabled = true;
  setStatus("Requesting your location...");
  try {
    const { latitude, longitude } = await getBrowserLocation();
    setStatus("Finding nearest tide station...");
    const candidates = await findNearestStations(latitude, longitude);
    if (!candidates.length) {
      setStatus("No nearby tide station found.", true);
      return;
    }

    // Try candidates nearest-first until one actually has prediction data
    // (some stations are listed but publish no usable predictions).
    let lastErr = null;
    for (const candidate of candidates) {
      try {
        setStatus(`Trying station ${candidate.id} (${candidate.distanceKm.toFixed(0)} km away)...`);
        const samples = await fetchTidePredictions(candidate.id);
        stationIdInput.value = candidate.id;
        stationNameEl.textContent =
          `${candidate.name}, ${candidate.state ?? ""} (${candidate.distanceKm.toFixed(0)} km away)`;
        currentSamples = samples;
        currentHeightRange = computeHeightRange(samples);
        renderFace();
        renderHands();
        setStatus(`Loaded ${samples.length} samples from station ${candidate.id} (range ${currentHeightRange.hMin.toFixed(1)}ft to ${currentHeightRange.hMax.toFixed(1)}ft).`);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) {
      setStatus(`No nearby stations had usable data: ${lastErr.message}`, true);
    }
  } catch (err) {
    console.error(err);
    setStatus(`Location error: ${err.message}`, true);
  } finally {
    useLocationBtn.disabled = false;
  }
}

/**
 * Fetch dense (6-minute interval) tide height predictions covering
 * the past 14 days through the next 14 days (28 days total). This gives
 * plenty of data for time-travel both forward and backward at accelerated
 * speeds - at ±86400x speed (24hr/sec), 14 days in either direction = 
 * ~14 seconds of real time to explore.
 * Tries the MLLW datum first (matches NOAA tide tables); falls back to
 * STND for stations that don't publish MLLW.
 */
async function fetchTidePredictions(stationId) {
  const today = new Date();
  const begin = new Date(today);
  begin.setDate(begin.getDate() - 14); // Fetch 14 days back
  begin.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setDate(end.getDate() + 14); // Fetch 14 days ahead
  end.setHours(23, 59, 59, 999);

  const fmt = (d) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

  async function fetchWithDatum(datum) {
    const params = new URLSearchParams({
      product: "predictions",
      application: "tide-clock-demo",
      begin_date: fmt(begin),
      end_date: fmt(end),
      datum,
      station: stationId,
      time_zone: "lst_ldt",
      units: "english",
      interval: "6",
      format: "json",
    });

    const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`NOAA API error: ${res.status}`);
    const json = await res.json();

    if (json.error) {
      throw new Error(json.error.message || "NOAA API returned an error");
    }
    return json.predictions || [];
  }

  let predictions;
  try {
    predictions = await fetchWithDatum("MLLW");
  } catch (e) {
    // Some stations (e.g. river/lake stations) don't publish MLLW - fall
    // back to station datum (STND), which every prediction station has.
    predictions = await fetchWithDatum("STND");
  }

  if (!predictions.length) {
    throw new Error("This station has no tide prediction data available.");
  }

  return predictions.map((p) => ({
    // p.t is "YYYY-MM-DD HH:MM" in station local time.
    time: new Date(p.t.replace(" ", "T")),
    height: parseFloat(p.v),
  }));
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#ff6b6b" : "#7fa8bd";
}

function renderFace() {
  if (!currentSamples) return;
  const now = getCurrentTime();
  const opts = {
    ...currentHeightRange,
    invertTide: invertTideCheckbox.checked,
    showHourHand: showHourHandCheckbox.checked,
    showMinuteHand: showMinuteHandCheckbox.checked,
  };
  tideClock.drawFace(currentSamples, now, opts);

  // Feed current tide height (normalized) + trend into the particle field
  // for tide-reactive effects (e.g. bubbles speed/density).
  const nearest = currentSamples.reduce((best, s) => {
    const d = Math.abs(s.time - now);
    return !best || d < Math.abs(best.time - now) ? s : best;
  }, null);
  if (nearest) {
    const norm = TideClock.normalizeHeight(nearest.height, currentHeightRange.hMin, currentHeightRange.hMax);
    const idx = currentSamples.indexOf(nearest);
    const prev = currentSamples[Math.max(0, idx - 1)];
    const rising = nearest.height >= (prev ? prev.height : nearest.height);
    particleField.setTideInfo(norm, rising);
  }
}

function renderHands() {
  const opts = {
    showHourHand: showHourHandCheckbox.checked,
    showMinuteHand: showMinuteHandCheckbox.checked,
    showSecondHand: showSecondHandCheckbox.checked,
  };
  tideClock.drawHands(getCurrentTime(), opts);
}

async function loadTides() {
  const stationId = stationIdInput.value.trim();
  if (!stationId) {
    setStatus("Please enter a station ID.", true);
    return;
  }

  loadBtn.disabled = true;
  setStatus("Loading tide data...");

  try {
    const [name, samples] = await Promise.all([
      fetchStationName(stationId),
      fetchTidePredictions(stationId),
    ]);

    stationNameEl.textContent = name;
    currentSamples = samples;
    currentHeightRange = computeHeightRange(samples);
    renderFace();
    renderHands();
    setStatus(`Loaded ${samples.length} samples (range ${currentHeightRange.hMin.toFixed(1)}ft to ${currentHeightRange.hMax.toFixed(1)}ft).`);
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load tides: ${err.message}`, true);
  } finally {
    loadBtn.disabled = false;
  }
}

loadBtn.addEventListener("click", loadTides);
useLocationBtn.addEventListener("click", useMyLocation);
invertTideCheckbox.addEventListener("change", () => {
  localStorage.setItem("invertTide", invertTideCheckbox.checked);
  renderFace();
});

showHourHandCheckbox.addEventListener("change", () => {
  localStorage.setItem("showHourHand", showHourHandCheckbox.checked);
  updateSecondHandCheckboxState();
  renderFace(); // Re-render face to update gridline label position
  renderHands();
});

showMinuteHandCheckbox.addEventListener("change", () => {
  localStorage.setItem("showMinuteHand", showMinuteHandCheckbox.checked);
  updateSecondHandCheckboxState();
  renderFace(); // Re-render face to update gridline label position
  renderHands();
});

showSecondHandCheckbox.addEventListener("change", () => {
  localStorage.setItem("showSecondHand", showSecondHandCheckbox.checked);
  renderHands();
});

// "Bob mode": turns on all clock hands and turns off the date/time and
// tide-prediction (high/low) displays, in one click. Toggles back off
// (restoring previous hand/date-time settings) if clicked again.
let bobModePrevState = null;
bobModeBtn.addEventListener("click", () => {
  const isBobActive = bobModeBtn.classList.contains("active");

  if (!isBobActive) {
    // Remember current state so we can restore it when bob mode is turned off.
    bobModePrevState = {
      showHourHand: showHourHandCheckbox.checked,
      showMinuteHand: showMinuteHandCheckbox.checked,
      showSecondHand: showSecondHandCheckbox.checked,
      showDateTime: showDateTimeCheckbox.checked,
    };

    showHourHandCheckbox.checked = true;
    showMinuteHandCheckbox.checked = true;
    showSecondHandCheckbox.checked = true;
    showDateTimeCheckbox.checked = false;

    bobModeBtn.classList.add("active");
  } else {
    // Restore whatever was set before bob mode was enabled.
    if (bobModePrevState) {
      showHourHandCheckbox.checked = bobModePrevState.showHourHand;
      showMinuteHandCheckbox.checked = bobModePrevState.showMinuteHand;
      showSecondHandCheckbox.checked = bobModePrevState.showSecondHand;
      showDateTimeCheckbox.checked = bobModePrevState.showDateTime;
    }
    bobModeBtn.classList.remove("active");
  }

  localStorage.setItem("showHourHand", showHourHandCheckbox.checked);
  localStorage.setItem("showMinuteHand", showMinuteHandCheckbox.checked);
  localStorage.setItem("showSecondHand", showSecondHandCheckbox.checked);
  localStorage.setItem("showDateTime", showDateTimeCheckbox.checked);

  updateSecondHandCheckboxState();
  updateDateTimeDisplay();
  renderFace();
  renderHands();
});

showDateTimeCheckbox.addEventListener("change", () => {
  localStorage.setItem("showDateTime", showDateTimeCheckbox.checked);
  updateDateTimeDisplay();
});

settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  settingsPanel.classList.remove("hidden");
});

closeSettingsBtn.addEventListener("click", () => {
  settingsPanel.classList.add("hidden");
});

settingsPanel.addEventListener("click", (e) => {
  // Click on the dimmed backdrop (not the inner panel) closes it.
  if (e.target === settingsPanel) {
    settingsPanel.classList.add("hidden");
  }
});

// Escape key dismisses the settings panel.
// 'f' toggles full screen and 's' opens settings, both from anywhere on the
// main screen (but not while typing into an input field).
document.addEventListener("keydown", (e) => {
  // Track held keys for continuous acceleration/deceleration
  heldKeys[e.key] = true;

  if (e.key === "Escape") {
    if (!settingsPanel.classList.contains("hidden")) {
      settingsPanel.classList.add("hidden");
      return;
    }
    // If not in settings and not in fullscreen
    if (!document.fullscreenElement) {
      const isMoving = Math.abs(timeMultiplier) > 1.0;
      if (isMoving) {
        // First escape when not fullscreen: stop
        timeMultiplier = 1.0;
        targetTime = null;
      } else if (simulatedTime !== null) {
        // Second escape when stopped: go to now
        simulatedTime = null;
        timeMultiplier = 1.0;
        targetTime = null;
        lastUpdateTime = Date.now();
        renderFace();
        renderHands();
      }
    }
    // If in fullscreen, browser handles it (exits fullscreen)
    return;
  }

  // Don't hijack keys while the user is typing in a text field.
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;

  if (e.key === "Enter") {
    if (!document.fullscreenElement) {
      // Not in fullscreen - enter fullscreen
      document.documentElement.requestFullscreen().catch((err) => {
        console.error("Failed to enter fullscreen:", err);
      });
    } else {
      // In fullscreen
      const isMoving = Math.abs(timeMultiplier) > 1.0;
      if (isMoving) {
        // Moving: stop
        timeMultiplier = 1.0;
        targetTime = null;
      } else {
        // Stopped: seek to next tide
        seekToNextTide();
      }
    }
  } else if (e.key === "f" || e.key === "F") {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch((err) => {
        console.error("Failed to enter fullscreen:", err);
      });
    } else {
      document.exitFullscreen();
    }
  } else if (e.key === "s" || e.key === "S") {
    settingsPanel.classList.remove("hidden");
  } else if (e.key === " " || e.key === "Spacebar") {
    e.preventDefault();
    // Space: if moving, stop; if stopped and not at current time, go to now
    const isMoving = Math.abs(timeMultiplier) > 1.0;
    if (isMoving) {
      // Stop
      timeMultiplier = 1.0;
      targetTime = null;
    } else if (simulatedTime !== null) {
      // Stopped but not at current time - go to now
      simulatedTime = null;
      timeMultiplier = 1.0;
      targetTime = null;
      lastUpdateTime = Date.now();
      renderFace();
      renderHands();
    }
  } else if (e.key === "m" || e.key === "M") {
    // M key: flip tide view (toggle invert mode)
    invertTideCheckbox.checked = !invertTideCheckbox.checked;
    localStorage.setItem("invertTide", invertTideCheckbox.checked);
    renderFace();
  } else if (e.key === "a" || e.key === "A") {
    const idx = PARTICLE_MODES.indexOf(currentParticleMode);
    const next = PARTICLE_MODES[(idx + 1) % PARTICLE_MODES.length];
    setParticleMode(next);
  } else if (e.key === ">" || e.key === ".") {
    setIntensity(currentIntensity + 0.25);
  } else if (e.key === "<" || e.key === ",") {
    setIntensity(currentIntensity - 0.25);
  }
});

document.addEventListener("keyup", (e) => {
  delete heldKeys[e.key];
});

// Recompute clock geometry (for the particle clip circle) whenever the
// layout might have changed size, e.g. entering/exiting full screen.
document.addEventListener("fullscreenchange", () => {
  setTimeout(resizeParticleCanvas, 50);
});

// Clicking anywhere on the app:
// - If not in fullscreen: enter fullscreen
// - If in fullscreen and moving: stop
// - If in fullscreen and stopped: seek to next tide
// Double-click: stop and reset to current time (always)
let lastClickTime = 0;
const DOUBLE_CLICK_DELAY = 300; // ms

appEl.addEventListener("click", (e) => {
  if (settingsPanel.contains(e.target)) return;
  
  const now = Date.now();
  const isDoubleClick = (now - lastClickTime) < DOUBLE_CLICK_DELAY;
  lastClickTime = now;
  
  if (isDoubleClick) {
    // Double-click: stop and reset to current time
    simulatedTime = null;
    timeMultiplier = 1.0;
    targetTime = null;
    lastUpdateTime = Date.now();
    renderFace();
    renderHands();
  } else {
    // Single click
    if (!document.fullscreenElement) {
      // Not in fullscreen - enter fullscreen
      document.documentElement.requestFullscreen().catch((err) => {
        console.error("Failed to enter fullscreen:", err);
      });
    } else {
      // In fullscreen
      const isMoving = Math.abs(timeMultiplier) > 1.0;
      if (isMoving) {
        // Stop
        timeMultiplier = 1.0;
        targetTime = null;
      } else {
        // Seek to next tide
        seekToNextTide();
      }
    }
  }
});

// Redraw the tide face on its own (parameterized) interval, and the hands
// on a fast interval for smooth ticking, independently of each other.
setInterval(renderFace, TIDE_REDRAW_INTERVAL_MS);
setInterval(renderHands, HANDS_REDRAW_INTERVAL_MS);
setInterval(loadTides, 10 * 60 * 1000);

// Continuous update loop for time simulation and display
function updateTimeSimulation() {
  const now = Date.now();
  const elapsedMs = now - lastUpdateTime;
  lastUpdateTime = now;

  // Handle arrow key acceleration/deceleration
  const isRightHeld = heldKeys["ArrowRight"];
  const isLeftHeld = heldKeys["ArrowLeft"];
  
  if (isRightHeld) {
    // Increase speed (go faster forward or slower backward)
    const accelerationRate = 0.05; // 5% change per frame
    
    if (timeMultiplier < 0) {
      // Currently going backward - slow down the reverse (approach 0, then flip to forward)
      timeMultiplier = timeMultiplier * (1 - accelerationRate);
      if (timeMultiplier > -300.0) {
        // When slowing down from backward and crossing under 5 min/sec, treat as real-time then jump to forward
        timeMultiplier = 300.0; // Cross over to forward at 5 min/sec (300x)
      }
    } else if (timeMultiplier === 1.0) {
      // At real-time forward - jump to 5 min/sec to start time travel
      timeMultiplier = 300.0;
    } else {
      // Going forward faster than real-time - speed up
      timeMultiplier = Math.min(86400, timeMultiplier * (1 + accelerationRate)); // 86400 = 24 hours per second
    }
    
    // Initialize simulated time if not already started
    if (!simulatedTime) {
      simulatedTime = new Date();
    }
    
    // Show speed indicator
    const absSpeed = Math.abs(timeMultiplier);
    const direction = timeMultiplier < 0 ? "← " : "→ ";
    const speedText = absSpeed < 60 
      ? `${absSpeed.toFixed(1)}x`
      : absSpeed < 3600
      ? `${(absSpeed / 60).toFixed(1)} min/sec`
      : `${(absSpeed / 3600).toFixed(1)} hr/sec`;
    showModeLabel(`${direction}${speedText}`);
  } else if (isLeftHeld) {
    // Decrease speed (go slower forward or faster backward)
    const decelerationRate = 0.05;
    
    if (timeMultiplier > 0 && timeMultiplier > 1.0) {
      // Currently going forward faster than real-time - slow down (approach real-time, then flip to backward)
      timeMultiplier = timeMultiplier * (1 - decelerationRate);
      if (timeMultiplier < 300.0) {
        // When slowing down from forward and crossing under 5 min/sec, treat as real-time then jump to backward
        timeMultiplier = -300.0; // Cross over to backward at 5 min/sec (300x)
      }
    } else if (timeMultiplier === 1.0) {
      // At real-time forward - jump to backward at 5 min/sec
      timeMultiplier = -300.0;
    } else {
      // Going backward - speed up the reverse
      timeMultiplier = Math.max(-86400, timeMultiplier * (1 + decelerationRate)); // -86400 = -24 hours per second
    }
    
    // Initialize simulated time if not already started
    if (!simulatedTime) {
      simulatedTime = new Date();
    }
    
    // Show speed indicator
    const absSpeed = Math.abs(timeMultiplier);
    const direction = timeMultiplier < 0 ? "← " : "→ ";
    const speedText = absSpeed < 60 
      ? `${absSpeed.toFixed(1)}x`
      : absSpeed < 3600
      ? `${(absSpeed / 60).toFixed(1)} min/sec`
      : `${(absSpeed / 3600).toFixed(1)} hr/sec`;
    showModeLabel(`${direction}${speedText}`);
  }

  // Update simulated time if active
  if (simulatedTime) {
    const simulatedElapsedMs = elapsedMs * timeMultiplier;
    simulatedTime = new Date(simulatedTime.getTime() + simulatedElapsedMs);
    
    // Check if we've reached the target time
    if (targetTime) {
      const reachedTarget = (timeMultiplier > 0 && simulatedTime >= targetTime) ||
                           (timeMultiplier < 0 && simulatedTime <= targetTime);
      if (reachedTarget) {
        simulatedTime = new Date(targetTime.getTime()); // Set exactly to target time
        timeMultiplier = 1.0;
        targetTime = null;
        renderFace(); // Force immediate render at exact target time
        renderHands();
      } else {
        // Accelerate while seeking to target - up to 12600x (3.5 hours per second)
        // But don't decelerate if already going faster
        const absSpeed = Math.abs(timeMultiplier);
        if (absSpeed < 12600) {
          const accelerationRate = 0.03;
          if (timeMultiplier > 0) {
            timeMultiplier = Math.min(12600, timeMultiplier * (1 + accelerationRate));
          } else {
            timeMultiplier = Math.max(-12600, timeMultiplier * (1 + accelerationRate));
          }
        }
        // If already faster than 12600, just maintain current speed
      }
    }
    
    // Render more frequently when time is accelerated (forward or backward)
    if (Math.abs(timeMultiplier) > 1.0) {
      renderFace();
      renderHands();
    }
  }
  
  // Update date/time display
  updateDateTimeDisplayText();
  
  requestAnimationFrame(updateTimeSimulation);
}

// Start the continuous update loop
updateTimeSimulation();

// Permanent transport controls
rewindBtn.addEventListener("mousedown", () => {
  heldKeys["ArrowLeft"] = true;
});
rewindBtn.addEventListener("mouseup", () => {
  delete heldKeys["ArrowLeft"];
});
rewindBtn.addEventListener("mouseleave", () => {
  delete heldKeys["ArrowLeft"];
});

fastForwardBtn.addEventListener("mousedown", () => {
  heldKeys["ArrowRight"] = true;
});
fastForwardBtn.addEventListener("mouseup", () => {
  delete heldKeys["ArrowRight"];
});
fastForwardBtn.addEventListener("mouseleave", () => {
  delete heldKeys["ArrowRight"];
});

pauseResetBtn.addEventListener("click", () => {
  const atCurrentTime = (simulatedTime === null);
  const isMoving = (Math.abs(timeMultiplier) > 1.0);
  
  if (isMoving) {
    // Pause - return to 1x
    timeMultiplier = 1.0;
    targetTime = null; // Clear any target
  } else if (!atCurrentTime) {
    // Reset - return to current time
    simulatedTime = null;
    timeMultiplier = 1.0;
    targetTime = null; // Clear any target
    lastUpdateTime = Date.now();
    renderFace();
    renderHands();
  }
});

// Jump to high/low tide buttons
jumpToHighBtn.addEventListener("click", () => {
  if (!currentSamples || currentSamples.length < 3) return;
  
  const now = getCurrentTime();
  const nextHigh = findNextHighTide(now);
  
  if (nextHigh) {
    targetTime = nextHigh.time;
    if (!simulatedTime) simulatedTime = new Date();
    
    const needsForward = targetTime > simulatedTime;
    const absSpeed = Math.abs(timeMultiplier);
    const goingForward = timeMultiplier > 0;
    const tooSlow = absSpeed < 1000;
    
    // If wrong direction OR too slow, reset to correct direction at current speed (or 300 minimum)
    if ((needsForward && !goingForward) || (!needsForward && goingForward) || tooSlow) {
      const newSpeed = Math.max(300, absSpeed);
      timeMultiplier = needsForward ? newSpeed : -newSpeed;
    }
    // Otherwise keep current speed and direction
  }
});

jumpToLowBtn.addEventListener("click", () => {
  if (!currentSamples || currentSamples.length < 3) return;
  
  const now = getCurrentTime();
  const nextLow = findNextLowTide(now);
  
  if (nextLow) {
    targetTime = nextLow.time;
    if (!simulatedTime) simulatedTime = new Date();
    
    const needsForward = targetTime > simulatedTime;
    const absSpeed = Math.abs(timeMultiplier);
    const goingForward = timeMultiplier > 0;
    const tooSlow = absSpeed < 1000;
    
    // If wrong direction OR too slow, reset to correct direction at current speed (or 300 minimum)
    if ((needsForward && !goingForward) || (!needsForward && goingForward) || tooSlow) {
      const newSpeed = Math.max(300, absSpeed);
      timeMultiplier = needsForward ? newSpeed : -newSpeed;
    }
    // Otherwise keep current speed and direction
  }
});

// Helper function to seek to whichever tide (high or low) is next/closest
function seekToNextTide() {
  if (!currentSamples || currentSamples.length < 3) return;
  
  const now = getCurrentTime();
  const nextHigh = findNextHighTide(now);
  const nextLow = findNextLowTide(now);
  
  // Pick whichever is sooner
  let target = null;
  if (nextHigh && nextLow) {
    target = (nextHigh.time < nextLow.time) ? nextHigh : nextLow;
  } else if (nextHigh) {
    target = nextHigh;
  } else if (nextLow) {
    target = nextLow;
  }
  
  if (target) {
    targetTime = target.time;
    if (!simulatedTime) simulatedTime = new Date();
    
    const needsForward = targetTime > simulatedTime;
    const absSpeed = Math.abs(timeMultiplier);
    const goingForward = timeMultiplier > 0;
    const tooSlow = absSpeed < 1000;
    
    // If wrong direction OR too slow, reset to correct direction at current speed (or 300 minimum)
    if ((needsForward && !goingForward) || (!needsForward && goingForward) || tooSlow) {
      const newSpeed = Math.max(300, absSpeed);
      timeMultiplier = needsForward ? newSpeed : -newSpeed;
    }
  }
}

// Helper functions to find next high/low tides
function findNextHighTide(fromTime) {
  if (!currentSamples || currentSamples.length < 3) return null;
  
  for (let i = 1; i < currentSamples.length - 1; i++) {
    const prev = currentSamples[i - 1];
    const cur = currentSamples[i];
    const next = currentSamples[i + 1];
    
    const isHigh = cur.height >= prev.height && cur.height >= next.height;
    if (isHigh && cur.time > fromTime) {
      if (cur.height === prev.height && cur.height === next.height) continue;
      return cur;
    }
  }
  return null;
}

function findNextLowTide(fromTime) {
  if (!currentSamples || currentSamples.length < 3) return null;
  
  for (let i = 1; i < currentSamples.length - 1; i++) {
    const prev = currentSamples[i - 1];
    const cur = currentSamples[i];
    const next = currentSamples[i + 1];
    
    const isLow = cur.height <= prev.height && cur.height <= next.height;
    if (isLow && cur.time > fromTime) {
      if (cur.height === prev.height && cur.height === next.height) continue;
      return cur;
    }
  }
  return null;
}

// Touch events for mobile
rewindBtn.addEventListener("touchstart", (e) => {
  e.preventDefault();
  heldKeys["ArrowLeft"] = true;
});
rewindBtn.addEventListener("touchend", () => {
  delete heldKeys["ArrowLeft"];
});

fastForwardBtn.addEventListener("touchstart", (e) => {
  e.preventDefault();
  heldKeys["ArrowRight"] = true;
});
fastForwardBtn.addEventListener("touchend", () => {
  delete heldKeys["ArrowRight"];
});


// Initial load.
loadTides();
