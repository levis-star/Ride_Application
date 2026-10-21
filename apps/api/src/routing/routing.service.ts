import { Injectable, Logger } from "@nestjs/common";
import { LatLng, roadDistanceFallbackM } from "@rukwaride/shared";
import { appConfig } from "../config/app-config";

export interface RouteEstimate {
  distanceM: number;
  durationS: number;
  source: "osrm" | "haversine";
  /** Road geometry as [lng, lat] pairs (OSRM); straight 2-point line on fallback. */
  geometry?: [number, number][];
}

/** Urban average speed used when OSRM is unavailable, m/s. */
const FALLBACK_SPEED_MPS = 7;

/**
 * Self-hosted OSRM with haversine ×1.4 fallback (spec §4). OSRM being down
 * must never block dispatch — every method degrades silently.
 */
@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  private fallbackRoute(from: LatLng, to: LatLng): RouteEstimate {
    const distanceM = Math.round(roadDistanceFallbackM(from, to));
    return {
      distanceM,
      durationS: Math.round(distanceM / FALLBACK_SPEED_MPS),
      source: "haversine",
      geometry: [
        [from.lng, from.lat],
        [to.lng, to.lat],
      ],
    };
  }

  async route(from: LatLng, to: LatLng): Promise<RouteEstimate> {
    if (!appConfig.osrmUrl) return this.fallbackRoute(from, to);
    try {
      // overview=full + geojson → road-following geometry for the map + sim.
      const url = `${appConfig.osrmUrl}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) throw new Error(`OSRM ${res.status}`);
      const json = (await res.json()) as {
        routes?: Array<{ distance: number; duration: number; geometry?: { coordinates: [number, number][] } }>;
      };
      const r = json.routes?.[0];
      if (!r) throw new Error("OSRM: no route");
      return {
        distanceM: Math.round(r.distance),
        durationS: Math.round(r.duration),
        source: "osrm",
        geometry: r.geometry?.coordinates,
      };
    } catch (err) {
      this.logger.warn(`OSRM route failed (${String(err)}), using haversine fallback`);
      return this.fallbackRoute(from, to);
    }
  }

  /** ETA of many drivers to one pickup — OSRM /table, else haversine/speed. */
  async etaToPickupS(drivers: Array<{ id: string; pos: LatLng }>, pickup: LatLng): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (drivers.length === 0) return result;
    if (appConfig.osrmUrl) {
      try {
        const coords = [...drivers.map((d) => `${d.pos.lng},${d.pos.lat}`), `${pickup.lng},${pickup.lat}`].join(";");
        const sources = drivers.map((_, i) => i).join(";");
        const url = `${appConfig.osrmUrl}/table/v1/driving/${coords}?sources=${sources}&destinations=${drivers.length}&annotations=duration`;
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) throw new Error(`OSRM ${res.status}`);
        const json = (await res.json()) as { durations?: number[][] };
        if (!json.durations) throw new Error("OSRM: no durations");
        drivers.forEach((d, i) => {
          const duration = json.durations![i]?.[0];
          result.set(d.id, duration == null ? Number.MAX_SAFE_INTEGER : Math.round(duration));
        });
        return result;
      } catch (err) {
        this.logger.warn(`OSRM table failed (${String(err)}), using haversine fallback`);
      }
    }
    for (const d of drivers) {
      result.set(d.id, Math.round(roadDistanceFallbackM(d.pos, pickup) / FALLBACK_SPEED_MPS));
    }
    return result;
  }
}
