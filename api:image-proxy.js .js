// Image proxy for the shopping app — Vercel serverless function version.
// Fetches a product image server-side (bypassing browser hotlink/referer
// blocks that retailers like Aritzia use) and re-serves it from this
// function's own URL. The app calls:
//   https://YOUR-PROJECT.vercel.app/api/image-proxy?url=<encoded image url>
// instead of the retailer's image URL directly.

// Only fetch images from these hosts — an open proxy that fetches ANY url
// can be abused to hide someone else's traffic behind your proxy. Add a
// retailer's image host here before pinning items from a new store.
const ALLOWED_HOSTS = [
  "assets.aritzia.com",
  "images.asos-media.com",
  "n.nordstrommedia.com",
  "images.revolveassets.com",
  "images.urbndata.com", // Free People / Anthropologie / Urban Outfitters
  "images.madewell.com",
  "media.everlane.com",
];

export default async function handler(req, res) {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    res.status(400).send("Missing ?url= parameter");
    return;
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    res.status(400).send("Invalid url parameter");
    return;
  }

  if (!ALLOWED_HOSTS.includes(parsedTarget.hostname)) {
    res.status(403).send(
      `Host not allowed: ${parsedTarget.hostname}. Add it to ALLOWED_HOSTS in the proxy script.`
    );
    return;
  }

  try {
    const siteRoot = parsedTarget.hostname.replace(/^assets\./, "www.").replace(/^images\./, "www.");
    const upstreamResponse = await fetch(parsedTarget.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Referer": `https://${siteRoot}/`,
        "Origin": `https://${siteRoot}`,
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });

    if (!upstreamResponse.ok) {
      res.status(502).send(
        `Upstream fetch failed: ${upstreamResponse.status} ${upstreamResponse.statusText}. ` +
        `If this repeats across platforms, the retailer's CDN may be blocking based on ` +
        `something other than headers (e.g. broader bot/IP detection).`
      );
      return;
    }

    const contentType = upstreamResponse.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await upstreamResponse.arrayBuffer());

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).send(buffer);
  } catch (err) {
    res.status(500).send(`Proxy error: ${err.message}`);
  }
}
