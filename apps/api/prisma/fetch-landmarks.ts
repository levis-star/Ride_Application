/**
 * Fetch real Sumbawanga landmarks from OpenStreetMap (Overpass) and write
 * prisma/landmarks-sumbawanga.json. Run occasionally to refresh; the seed
 * loads the JSON so search + routing hit actual places (spec §11).
 *
 *   pnpm --filter @rukwaride/api exec tsx prisma/fetch-landmarks.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CENTER = { lat: -7.9667, lng: 31.6167 };
const RADIUS_M = 10_000; // Sumbawanga town + immediate surroundings
/** Same name within this distance = the same place mapped twice, not two places. */
const SAME_PLACE_M = 120;
const OVERPASS = process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";

type SpecCategory = "market" | "hospital" | "school" | "stand" | "office" | "other";

interface OverpassEl {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface LandmarkOut {
  name: string;
  aliasNames: string[];
  lat: number;
  lng: number;
  category: SpecCategory;
}

/** Map OSM tags to our seed categories (spec §5 Landmark.category). */
function categorize(tags: Record<string, string>): SpecCategory | null {
  const a = tags.amenity;
  const shop = tags.shop;
  const office = tags.office;
  const tourism = tags.tourism;
  const place = tags.place;
  const highway = tags.highway;
  const aeroway = tags.aeroway;

  if (a === "atm") return "other"; // a cash machine, never an "office"/bank
  if (a === "marketplace" || shop === "supermarket" || shop === "marketplace") return "market";
  if (["hospital", "clinic", "doctors", "pharmacy", "dentist"].includes(a ?? "")) return "hospital";
  if (["school", "college", "university", "kindergarten"].includes(a ?? "")) return "school";
  if (a === "bus_station" || highway === "bus_stop" || aeroway === "aerodrome") return "stand";
  if (
    ["bank", "bureau_de_change", "police", "post_office", "townhall", "courthouse"].includes(a ?? "") ||
    office
  )
    return "office";
  if (
    ["fuel", "place_of_worship", "restaurant", "cafe", "fast_food", "hospital", "fuel", "pharmacy"].includes(
      a ?? "",
    ) ||
    tourism === "hotel" ||
    tourism === "guest_house" ||
    tourism === "attraction" ||
    shop ||
    place === "neighbourhood" ||
    place === "suburb" ||
    place === "village"
  )
    return "other";
  return null;
}

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

async function main() {
  const query = `[out:json][timeout:90];
(
  node["name"]["amenity"](around:${RADIUS_M},${CENTER.lat},${CENTER.lng});
  way["name"]["amenity"](around:${RADIUS_M},${CENTER.lat},${CENTER.lng});
  // ATMs are frequently unnamed, and banks are sometimes mapped with only an
  // operator — both are dropped by the ["name"] filters above.
  node["amenity"="atm"](around:${RADIUS_M},${CENTER.lat},${CENTER.lng});
  node["amenity"="bank"]["operator"](around:${RADIUS_M},${CENTER.lat},${CENTER.lng});
  way["amenity"="bank"]["operator"](around:${RADIUS_M},${CENTER.lat},${CENTER.lng});
  node["name"]["shop"](around:${RADIUS_M},${CENTER.lat},${CENTER.lng});
  node["name"]["office"](around:${RADIUS_M},${CENTER.lat},${CENTER.lng});
  node["name"]["tourism"](around:${RADIUS_M},${CENTER.lat},${CENTER.lng});
  node["name"]["aeroway"="aerodrome"](around:${RADIUS_M},${CENTER.lat},${CENTER.lng});
  node["place"~"neighbourhood|suburb|village"](around:${RADIUS_M},${CENTER.lat},${CENTER.lng});
);
out center 800;`;

  // Node's fetch can hang on IPv6 to Overpass here; prefer a pre-fetched file
  // (OVERPASS_JSON=<path>, produced via `curl -4`), else fetch directly.
  let json: { elements: OverpassEl[] };
  const cacheFile = process.env.OVERPASS_JSON;
  if (cacheFile) {
    console.log(`Reading Overpass elements from ${cacheFile}…`);
    json = JSON.parse(readFileSync(cacheFile, "utf8")) as { elements: OverpassEl[] };
  } else {
    console.log(`Querying Overpass for POIs within ${RADIUS_M / 1000} km of Sumbawanga…`);
    const res = await fetch(OVERPASS, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        // Overpass sits behind Apache/mod_security, which answers 406 Not
        // Acceptable to requests without a real User-Agent.
        "user-agent": "RukwaRide/1.0 (landmark import; +https://rukwaride.co.tz)",
      },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`Overpass ${res.status}: ${(await res.text()).slice(0, 300)}`);
    json = (await res.json()) as { elements: OverpassEl[] };
  }

  const byKey = new Map<string, LandmarkOut>();
  for (const el of json.elements) {
    const tags = el.tags ?? {};
    const name = tags.name?.trim();
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) continue;
    const category = categorize(tags);
    if (!category) continue;

    // A cash machine is not a branch. OSM around Sumbawanga has ATMs tagged
    // amenity=bank AND named "NMB Bank", which sent passengers to a machine
    // when they asked for the bank. Anything we can positively identify as an
    // ATM is labelled as one; the rest is corrected by staff in the admin
    // landmark editor (OSM tagging alone cannot tell us the difference).
    const isAtm = tags.amenity === "atm";
    let displayName = name ?? tags.operator?.trim() ?? tags.brand?.trim();
    if (isAtm) {
      const brand = name ?? tags.operator?.trim() ?? tags.brand?.trim();
      displayName = brand ? `ATM ${brand.replace(/\s*bank\s*/i, "").trim()}` : "ATM";
    }
    // Keep a real POI whose only identifier is the operator (e.g. an NBC
    // branch mapped without a name) rather than dropping it entirely.
    if (!displayName || displayName.length < 2) continue;

    const aliases = [tags["name:en"], tags["name:sw"], tags.alt_name, tags.short_name].filter(
      (x): x is string => Boolean(x) && x !== displayName,
    );

    /*
     * Dedupe by name AND proximity. Merging on name alone collapsed six
     * distinct "NMB Bank" points into one, so a passenger searching "NMB" was
     * offered a single location that might be the wrong one. Two points with
     * the same name are the same place only if they are close together
     * (a building way + its node); otherwise they are genuinely different
     * places and both are kept.
     */
    const nameKey = displayName.toLowerCase();
    let mergedInto: string | undefined;
    for (const [k, v] of byKey) {
      if (v.name.toLowerCase() !== nameKey) continue;
      if (haversineM(v.lat, v.lng, lat, lng) <= SAME_PLACE_M) {
        mergedInto = k;
        break;
      }
    }
    if (mergedInto) {
      // Same place mapped twice — prefer the node with richer tagging.
      const existing = byKey.get(mergedInto)!;
      existing.aliasNames = [...new Set([...existing.aliasNames, ...aliases])];
      continue;
    }
    byKey.set(`${nameKey}@${el.type}/${el.id}`, {
      name: displayName,
      aliasNames: aliases,
      lat,
      lng,
      category: isAtm ? "other" : category,
    });
  }

  const landmarks = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  const out = resolve(__dirname, "landmarks-sumbawanga.json");
  writeFileSync(out, JSON.stringify(landmarks, null, 2));
  const byCat = landmarks.reduce<Record<string, number>>((m, l) => ((m[l.category] = (m[l.category] ?? 0) + 1), m), {});
  console.log(`Wrote ${landmarks.length} landmarks → ${out}`);
  console.log("By category:", byCat);
  console.log("Samples:", landmarks.slice(0, 8).map((l) => `${l.name} (${l.category})`).join(", "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
