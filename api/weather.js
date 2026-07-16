// Weather for a trip stop.
// Uses Open-Meteo, which needs no API key.
//
// Forecast only reaches ~16 days out. For trips beyond that, we fall back to
// the historical archive: the same calendar window averaged over the last 5
// years, which is a reasonable "what's it usually like then" answer.
//
// Frontend calls:  /api/weather?lat=41.9&lon=12.5&start=2026-09-28&end=2026-09-30
// Returns:         { source: 'forecast' | 'seasonal', days: [{ date, hi, lo, code }] }

const FORECAST_HORIZON_DAYS = 16;
const SEASONAL_YEARS = 5;

function daysFromNow(dateStr) {
  const target = new Date(dateStr + "T00:00:00Z");
  const now = new Date();
  return Math.round((target - now) / 86400000);
}

// Open-Meteo WMO weather codes -> the four icons the app already has.
function codeToIcon(code) {
  if (code === 0) return "sun";
  if (code === 1 || code === 2) return "partly";
  if (code === 3 || (code >= 45 && code <= 48)) return "cloud";
  return "rain"; // drizzle, rain, snow, thunderstorm
}

async function fetchForecast(lat, lon, start, end) {
  const url =
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}&longitude=${lon}` +
    "&daily=temperature_2m_max,temperature_2m_min,weather_code" +
    `&start_date=${start}&end_date=${end}` +
    "&timezone=auto";
  const r = await fetch(url);
  if (!r.ok) throw new Error(`forecast ${r.status}`);
  const d = await r.json();
  if (!d.daily?.time) throw new Error("unexpected forecast shape");
  return d.daily.time.map((date, i) => ({
    date,
    hi: Math.round(d.daily.temperature_2m_max[i]),
    lo: Math.round(d.daily.temperature_2m_min[i]),
    icon: codeToIcon(d.daily.weather_code[i]),
  }));
}

// Averages the same calendar dates across the last N years.
async function fetchSeasonal(lat, lon, start, end) {
  const startMD = start.slice(5); // MM-DD
  const endMD = end.slice(5);
  const thisYear = new Date().getUTCFullYear();

  const years = [];
  for (let i = 1; i <= SEASONAL_YEARS; i++) years.push(thisYear - i);

  const perYear = await Promise.all(
    years.map(async (y) => {
      const url =
        "https://archive-api.open-meteo.com/v1/archive" +
        `?latitude=${lat}&longitude=${lon}` +
        `&start_date=${y}-${startMD}&end_date=${y}-${endMD}` +
        "&daily=temperature_2m_max,temperature_2m_min,weather_code" +
        "&timezone=auto";
      try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const d = await r.json();
        return d.daily?.time ? d.daily : null;
      } catch {
        return null;
      }
    })
  );

  const valid = perYear.filter(Boolean);
  if (valid.length === 0) throw new Error("no historical data available");

  // Average across years, day by day.
  const dayCount = valid[0].time.length;
  const days = [];
  for (let i = 0; i < dayCount; i++) {
    const his = valid.map((y) => y.temperature_2m_max?.[i]).filter((v) => v != null);
    const los = valid.map((y) => y.temperature_2m_min?.[i]).filter((v) => v != null);
    const codes = valid.map((y) => y.weather_code?.[i]).filter((v) => v != null);
    if (his.length === 0) continue;

    // Most common weather code across those years for that day.
    const tally = {};
    codes.forEach((c) => { tally[c] = (tally[c] || 0) + 1; });
    const modeCode = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];

    days.push({
      date: `${new Date().getUTCFullYear()}-${valid[0].time[i].slice(5)}`,
      hi: Math.round(his.reduce((a, b) => a + b, 0) / his.length),
      lo: Math.round(los.reduce((a, b) => a + b, 0) / los.length),
      icon: codeToIcon(Number(modeCode)),
    });
  }
  return days;
}

export default async function handler(req, res) {
  const { lat, lon, start, end } = req.query;

  if (!lat || !lon || !start || !end) {
    res.status(400).json({ error: "Requires lat, lon, start, end (YYYY-MM-DD)." });
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    res.status(400).json({ error: "Dates must be YYYY-MM-DD." });
    return;
  }

  const out = daysFromNow(start);
  const useForecast = out <= FORECAST_HORIZON_DAYS;

  try {
    let days;
    let source;
    if (useForecast) {
      try {
        days = await fetchForecast(lat, lon, start, end);
        source = "forecast";
      } catch {
        // Forecast failed — seasonal is better than nothing.
        days = await fetchSeasonal(lat, lon, start, end);
        source = "seasonal";
      }
    } else {
      days = await fetchSeasonal(lat, lon, start, end);
      source = "seasonal";
    }

    res.setHeader("Cache-Control", "public, max-age=10800"); // 3h
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({ source, days });
  } catch (err) {
    res.status(502).json({ error: `Weather lookup failed: ${err.message}` });
  }
}
