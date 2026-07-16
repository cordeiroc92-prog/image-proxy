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
  // 'country' or 'city' — searching for a country with type=city returns
  // cities that merely contain the word (e.g. "portugal" -> Portugalete, Spain)
  // and omits the actual country, which is worse than useless.
  const type = req.query.type === "country" ? "country" : "city";

  // Comma-separated ISO country codes of the countries already on the trip.
  // Their cities are ranked first — someone planning Portugal who types "porto"
  // means Porto, not Porto Alegre. Others still appear below, so searching a
  // city in a new country still works and adds that country.
  const bias = (req.query.bias || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z]{2}$/.test(s));

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

  const buildUrl = (countryFilter) =>
    "https://api.geoapify.com/v1/geocode/autocomplete" +
    `?text=${encodeURIComponent(q)}` +
    `&type=${type}` +
    "&limit=6" +
    "&format=json" +
    (countryFilter ? `&filter=countrycode:${countryFilter}` : "") +
    `&apiKey=${key}`;

  const normalise = (r) =>
    type === "country"
      ? { id: r.place_id, name: r.country, country: r.country, countryCode: r.country_code, lat: r.lat, lon: r.lon, label: r.country }
      : {
          id: r.place_id,
          name: r.city || r.name || r.address_line1,
          country: r.country,
          countryCode: r.country_code,
          lat: r.lat,
          lon: r.lon,
          label: [r.city || r.name, r.state, r.country].filter(Boolean).join(", "),
        };

  try {
    // When biasing, run two searches: one restricted to the trip's countries,
    // one unrestricted. Merge with the biased ones first, deduped.
    const requests = [fetch(buildUrl(null))];
    if (type === "city" && bias.length > 0) {
      requests.unshift(fetch(buildUrl(bias.join(","))));
    }

    const responses = await Promise.all(requests);
    for (const r of responses) {
      if (!r.ok) {
        res.status(502).json({ error: `Places lookup failed: ${r.status}` });
        return;
      }
    }
    const payloads = await Promise.all(responses.map((r) => r.json()));

    const seen = new Set();
    const results = [];
    for (const p of payloads) {
      for (const r of p.results || []) {
        const item = normalise(r);
        if (!item.name || seen.has(item.id)) continue;
        seen.add(item.id);
        results.push(item);
        if (results.length >= 8) break;
      }
      if (results.length >= 8) break;
    }

    // Cache briefly — the same prefixes get typed constantly.
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json(results);
  } catch (err) {
    res.status(500).json({ error: `Places proxy error: ${err.message}` });
  }
}
