// Awin product feed proxy.
//
// Fetches the affiliate product feed server-side so the Awin API key never
// reaches the browser — same reasoning as the Geoapify key. The feed URL
// contains the key, so it lives in an env var, not in the frontend.
//
// Frontend calls:  /api/feed
// Returns:         [{ id, title, store, price, was, imageUrl, sourceUrl, category, color, description }]
//
// Requires env var AWIN_FEED_URL — the full Create-a-Feed download URL,
// including the apikey path segment. Use the CSV (not gzip) variant.

import { gunzipSync } from "zlib";

// Ecosusi's category fields come through empty, which is common for smaller
// advertisers. Deriving from the product name is the practical fallback.
// Order matters — first match wins, so specific terms precede generic ones.
const CATEGORY_RULES = [
  // Not products — filter out. Plural/variant forms matter: this feed has
  // "Exclusive Gift Cards", which a \bgift card\b pattern would miss.
  [/gift\s*cards?/i, null],
  [/\be-?gift\b/i, null],
  [/\b(backpack|rucksack)\b/i, "bags"],
  [/\b(briefcase|laptop bag|messenger)\b/i, "bags"],
  [/\b(crossbody|shoulder bag|sling|satchel|saddle)\b/i, "bags"],
  [/\b(tote|bucket bag|handbag|purse)\b/i, "bags"],
  [/\b(wallet|clutch|card holder|cardholder)\b/i, "bags"],
  [/\b(cosmetic|toiletry|makeup bag|pouch)\b/i, "bags"],
  [/\bbag\b/i, "bags"],
  [/\b(watch)\b/i, "accessory"],
  [/\b(hat|beret|cap|beanie)\b/i, "accessory"],
  [/\b(scarf|clip|keychain|jewel|earring|necklace)\b/i, "accessory"],
  [/\b(dress)\b/i, "dresses"],
  [/\b(sweater|knit|cardigan|jumper)\b/i, "knitwear"],
  [/\b(coat|jacket|blazer|parka)\b/i, "outerwear"],
  [/\b(boot|shoe|sneaker|loafer|sandal|heel)\b/i, "footwear"],
  [/\b(jean|denim)\b/i, "denim"],
  [/\b(trouser|pant|skirt|suit)\b/i, "tailoring"],
  [/\b(shirt|blouse|top|tee)\b/i, "shirt"],
  [/\b(swim|bikini)\b/i, "swimwear"],
];

function deriveCategory(name, merchantCategory, categoryName) {
  // Trust the feed's own category if the advertiser provided one.
  const given = (merchantCategory || categoryName || "").trim();
  if (given && given.toLowerCase() !== "nan") {
    const g = given.toLowerCase();
    for (const [re, cat] of CATEGORY_RULES) if (re.test(g)) return cat;
  }
  for (const [re, cat] of CATEGORY_RULES) if (re.test(name || "")) return cat;
  return "accessory"; // safe default rather than dropping the product
}

// Colour words that actually appear in fashion product names/descriptions.
const COLOUR_WORDS = [
  "black","white","cream","ivory","beige","tan","brown","camel","chocolate","coffee","cocoa",
  "grey","gray","silver","gold","navy","blue","denim","teal","green","olive","sage",
  "red","burgundy","wine","pink","rose","blush","purple","lavender","lilac",
  "yellow","mustard","orange","rust","terracotta","apricot","khaki","clear",
];

// Colour is often absent from this feed's name and description (descriptions
// tend to cover materials, not colours). But some merchants encode it in the
// image filename — e.g. "..._Classic_Tote-Black.jpg" — so that's checked too.
// Returns "" when genuinely unknown rather than guessing; the app falls back
// to a neutral swatch, which is honest.
function deriveColour(name, description, imageUrl) {
  const filename = (imageUrl || "").split("/").pop() || "";
  const hay = `${name || ""} ${filename.replace(/[_-]/g, " ")} ${description || ""}`.toLowerCase();
  for (const c of COLOUR_WORDS) {
    if (new RegExp(`\\b${c}\\b`).test(hay)) return c;
  }
  return "";
}

// Minimal CSV parser that handles quoted fields containing commas and escaped
// quotes. Feed descriptions are full of both, so naive split(',') corrupts rows.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (ch !== "\r") field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

export default async function handler(req, res) {
  const feedUrl = process.env.AWIN_FEED_URL;
  if (!feedUrl) {
    res.status(500).json({ error: "AWIN_FEED_URL is not configured on the server." });
    return;
  }

  try {
    const upstream = await fetch(feedUrl);
    if (!upstream.ok) {
      res.status(502).json({ error: `Feed fetch failed: ${upstream.status}` });
      return;
    }

    // The feed may be gzipped depending on the URL's compression segment.
    const buf = Buffer.from(await upstream.arrayBuffer());
    let text;
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      text = gunzipSync(buf).toString("utf8"); // gzip magic bytes
    } else {
      text = buf.toString("utf8");
    }

    const rows = parseCsv(text);
    if (rows.length < 2) {
      res.status(502).json({ error: "Feed appeared empty." });
      return;
    }

    const header = rows[0].map((h) => h.trim());
    const idx = (name) => header.indexOf(name);
    const iName = idx("product_name");
    const iPrice = idx("search_price");
    const iStore = idx("merchant_name");
    const iAwImg = idx("aw_image_url");
    const iMerchImg = idx("merchant_image_url");
    const iLink = idx("aw_deep_link");
    const iDesc = idx("description");
    const iMcat = idx("merchant_category");
    const iCat = idx("category_name");
    const iId = idx("aw_product_id");
    const iStorePrice = idx("store_price");

    if (iName < 0 || iLink < 0) {
      res.status(502).json({ error: "Feed is missing product_name or aw_deep_link." });
      return;
    }

    const products = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.length < header.length - 2) continue; // skip malformed

      const name = (row[iName] || "").trim();
      const link = (row[iLink] || "").trim();
      if (!name || !link) continue;

      const category = deriveCategory(name, row[iMcat], row[iCat]);
      if (category === null) continue; // gift cards etc.

      const price = parseFloat(row[iPrice]) || 0;
      if (!price) continue; // no price, not sellable

      const storePrice = parseFloat(row[iStorePrice]) || 0;

      products.push({
        id: `awin-${(row[iId] || `${r}`).trim()}`,
        title: name,
        store: (row[iStore] || "").replace(/\s*\(US\)\s*$/, "").trim(),
        price: Math.round(price),
        // store_price above search_price means search_price is a sale price.
        was: storePrice > price ? Math.round(storePrice) : undefined,
        // Prefer the merchant's own CDN — full resolution. Awin's resizer caps
        // at 200x200 and letterboxes onto white, which looks poor full-bleed.
        imageUrl: (row[iMerchImg] || row[iAwImg] || "").trim(),
        imageFallback: (row[iAwImg] || "").trim(),
        sourceUrl: link, // tracked affiliate link — must be used, or no commission
        category,
        colorName: deriveColour(name, row[iDesc], row[iMerchImg]),
        description: (row[iDesc] || "").trim().slice(0, 300),
      });
    }

    res.setHeader("Cache-Control", "public, max-age=21600"); // 6h — feeds update daily
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({ count: products.length, products });
  } catch (err) {
    res.status(500).json({ error: `Feed proxy error: ${err.message}` });
  }
}
