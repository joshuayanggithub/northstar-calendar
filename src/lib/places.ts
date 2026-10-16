// Place autocomplete for the location field. Photon (OSM) is keyless and
// CORS-open, unlike Google Places which needs a billed Maps key; the saved
// value stays a plain string so Google Calendar round-trips it untouched.

export interface Place {
  label: string; // what we store: "Name, City" / full address line
  name: string;
  detail: string; // secondary line in the dropdown
  lat: number;
  lon: number;
}

interface PhotonFeature {
  properties: {
    name?: string;
    housenumber?: string;
    street?: string;
    district?: string;
    city?: string;
    state?: string;
    country?: string;
  };
  geometry: { coordinates: [number, number] };
}

function toPlace(f: PhotonFeature): Place | null {
  const p = f.properties;
  const name = p.name ?? [p.housenumber, p.street].filter(Boolean).join(" ");
  if (!name) return null;
  const detailParts = [
    p.street && p.name ? p.street : null,
    p.district,
    p.city,
    p.state,
    p.country,
  ].filter((x): x is string => !!x && x !== name);
  const detail = [...new Set(detailParts)].slice(0, 3).join(", ");
  const label = detail ? `${name}, ${detail.split(", ").slice(0, 2).join(", ")}` : name;
  return {
    label,
    name,
    detail,
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
  };
}

export async function searchPlaces(q: string, signal?: AbortSignal): Promise<Place[]> {
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`places: ${res.status}`);
  const json = (await res.json()) as { features: PhotonFeature[] };
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const f of json.features ?? []) {
    const place = toPlace(f);
    if (place && !seen.has(place.label)) {
      seen.add(place.label);
      out.push(place);
    }
  }
  return out;
}

/** One-shot geocode so a reopened event with a saved location gets a preview. */
export async function geocodeOne(q: string, signal?: AbortSignal): Promise<Place | null> {
  const list = await searchPlaces(q, signal);
  return list[0] ?? null;
}

export function gmapsUrl(location: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
}

/** Keyless OSM embed centered on the place, with a marker. */
export function osmEmbedUrl(lat: number, lon: number): string {
  const d = 0.006;
  const bbox = [lon - d * 1.8, lat - d, lon + d * 1.8, lat + d].map((n) => n.toFixed(5)).join("%2C");
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat.toFixed(5)}%2C${lon.toFixed(5)}`;
}
