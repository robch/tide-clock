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
const fullscreenBtn = document.getElementById("fullscreenBtn");
const appEl = document.getElementById("app");
const tapMenu = document.getElementById("tapMenu");
const useLocationBtn = document.getElementById("useLocationBtn");
const invertTideCheckbox = document.getElementById("invertTide");

let redrawTimer = null;
let currentSamples = null;
let currentHeightRange = { hMin: -2, hMax: 10 };

// Restore the "flip tide direction" preference from localStorage.
invertTideCheckbox.checked = localStorage.getItem("invertTide") === "true";

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
 * yesterday 12:00 through tomorrow 12:00 (comfortably covers any
 * "now .. now + 11h" window regardless of when you load the page).
 * Tries the MLLW datum first (matches NOAA tide tables); falls back to
 * STND for stations that don't publish MLLW.
 */
async function fetchTidePredictions(stationId) {
  const today = new Date();
  const begin = new Date(today);
  begin.setDate(begin.getDate() - 1);
  const end = new Date(today);
  end.setDate(end.getDate() + 1);

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
  const now = new Date();
  const opts = { ...currentHeightRange, invertTide: invertTideCheckbox.checked };
  tideClock.drawFace(currentSamples, now, opts);
}

function renderHands() {
  tideClock.drawHands(new Date());
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

settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  tapMenu.classList.add("hidden");
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

// Escape key dismisses the settings panel (and the tap menu, if open).
// 'f' toggles full screen and 's' opens settings, both from anywhere on the
// main screen (but not while typing into an input field).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!settingsPanel.classList.contains("hidden")) {
      settingsPanel.classList.add("hidden");
    } else if (!tapMenu.classList.contains("hidden")) {
      tapMenu.classList.add("hidden");
    }
    return;
  }

  // Don't hijack keys while the user is typing in a text field.
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;

  if (e.key === "f" || e.key === "F") {
    tapMenu.classList.add("hidden");
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch((err) => {
        console.error("Failed to enter fullscreen:", err);
      });
    } else {
      document.exitFullscreen();
    }
  } else if (e.key === "s" || e.key === "S") {
    tapMenu.classList.add("hidden");
    settingsPanel.classList.remove("hidden");
  } else if (e.key === " " || e.key === "Spacebar") {
    e.preventDefault();
    invertTideCheckbox.checked = !invertTideCheckbox.checked;
    localStorage.setItem("invertTide", invertTideCheckbox.checked);
    renderFace();
  }
});

fullscreenBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  tapMenu.classList.add("hidden");
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch((err) => {
      console.error("Failed to enter fullscreen:", err);
    });
  } else {
    document.exitFullscreen();
  }
});

// Clicking anywhere on the app (but not on the menu or settings panel
// itself) toggles the floating "Settings" / "Full Screen" tap menu.
appEl.addEventListener("click", (e) => {
  if (settingsPanel.contains(e.target) || tapMenu.contains(e.target)) return;
  tapMenu.classList.toggle("hidden");
});

// Redraw the tide face on its own (parameterized) interval, and the hands
// on a fast interval for smooth ticking, independently of each other.
setInterval(renderFace, TIDE_REDRAW_INTERVAL_MS);
setInterval(renderHands, HANDS_REDRAW_INTERVAL_MS);
setInterval(loadTides, 10 * 60 * 1000);

// Initial load.
loadTides();
