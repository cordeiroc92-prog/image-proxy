// Places autocomplete proxy.
// Keeps the Geoapify key server-side — it must never appear in frontend code,
// where anyone could read it out of the bundle and burn through the quota.
//
// Frontend calls:  /api/places?q=lisb
// Returns:         [{ id, name, country, lat, lon, label }]
//
// Requires env var GEOAPIFY_KEY set in the Vercel project settings.

export default async function handler(req, res) {
  const q = (req.query.q || "").trim();

  if (q.length < 2) {
    // Too short to be a useful search — don't waste an API call.
    res.status(200).json([]);
    return;
  }

  const key = process.env.GEOAPIFY_KEY;
  if (!key) {
    res.status(500).json({ error: "GEOAPIFY_KEY is not configured on the server." });
    return;
  }

  try {
    const url =
      "https://api.geoapify.com/v1/geocode/autocomplete" +
      `?text=${encodeURIComponent(q)}` +
      "&type=city" +
      "&limit=6" +
      "&format=json" +
      `&apiKey=${key}`;

    const upstream = await fetch(url);
    if (!upstream.ok) {
      res.status(502).json({ error: `Places lookup failed: ${upstream.status}` });
      return;
    }

    const data = await upstream.json();

    // Normalise to just what the app needs. Geoapify returns a lot of fields;
    // sending all of it would bloat every keystroke's response.
    const results = (data.results || []).map((r) => ({
      id: r.place_id,
      name: r.city || r.name || r.address_line1,
      country: r.country,
      lat: r.lat,
      lon: r.lon,
      label: [r.city || r.name, r.state, r.country].filter(Boolean).join(", "),
    }));

    // Cache briefly — the same prefixes get typed constantly.
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json(results);
  } catch (err) {
    res.status(500).json({ error: `Places proxy error: ${err.message}` });
  }
}
