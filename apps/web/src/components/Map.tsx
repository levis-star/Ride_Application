"use client";

// maplibre-gl v6 is ESM-only with named exports (no default export).
import {
  AttributionControl,
  GeoJSONSource,
  Map as MlMap,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";

/**
 * Map style. Default: OpenFreeMap vector tiles (free, no key, clear road
 * structure for the Rukwa region). Override with:
 *  - NEXT_PUBLIC_MAP_STYLE = a full MapLibre style URL (vector), or
 *  - NEXT_PUBLIC_TILE_URL  = a raster {z}/{x}/{y} template (operator's provider).
 */
const MAP_STYLE = process.env.NEXT_PUBLIC_MAP_STYLE ?? "https://tiles.openfreemap.org/styles/liberty";
const RASTER_TILE_URL = process.env.NEXT_PUBLIC_TILE_URL;

/** Sumbawanga town centre — the launch city (spec §1). */
export const DEFAULT_CENTER = { lat: -7.9667, lng: 31.6167 };

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  color: string;
  /** Emoji shown instead of a pin (driver vehicle, pickup, drop). */
  icon?: string;
  label?: string;
}

interface Props {
  center?: { lat: number; lng: number };
  markers?: MapMarker[];
  /** Road route to draw, as [lng, lat] pairs (OSRM geometry). */
  route?: [number, number][];
  /** Fires with the map centre after the user stops panning (pin-drop mode). */
  onMoveEnd?: (center: { lat: number; lng: number }) => void;
  className?: string;
}

function styleSpec(): string | StyleSpecification {
  if (RASTER_TILE_URL) {
    return {
      version: 8,
      sources: {
        osm: { type: "raster", tiles: [RASTER_TILE_URL], tileSize: 256, attribution: "© OpenStreetMap" },
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }],
    };
  }
  return MAP_STYLE;
}

function markerElement(m: MapMarker): HTMLElement {
  const el = document.createElement("div");
  if (m.icon) {
    el.textContent = m.icon;
    el.style.fontSize = "26px";
    el.style.lineHeight = "1";
    el.style.filter = "drop-shadow(0 1px 2px rgba(0,0,0,0.4))";
    el.style.cursor = "default";
    el.style.transform = "translateY(2px)";
  } else {
    el.style.width = "16px";
    el.style.height = "16px";
    el.style.borderRadius = "50%";
    el.style.background = m.color;
    el.style.border = "2px solid white";
    el.style.boxShadow = "0 1px 4px rgba(0,0,0,0.4)";
  }
  if (m.label) el.title = m.label;
  return el;
}

export default function Map({ center = DEFAULT_CENTER, markers = [], route, onMoveEnd, className = "" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const markerRefs = useRef<globalThis.Map<string, { marker: Marker; icon?: string; color: string }>>(
    new globalThis.Map(),
  );
  const styleReadyRef = useRef(false);
  const onMoveEndRef = useRef(onMoveEnd);
  onMoveEndRef.current = onMoveEnd;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new MapLibreMap({
      container: containerRef.current,
      style: styleSpec(),
      center: [center.lng, center.lat],
      zoom: 14,
      attributionControl: false,
    });
    map.addControl(new AttributionControl({ compact: true }));
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.on("moveend", () => {
      const c = map.getCenter();
      onMoveEndRef.current?.({ lat: c.lat, lng: c.lng });
    });
    map.on("load", () => {
      styleReadyRef.current = true;
      // Route line source + layers (empty until a route is supplied).
      if (!map.getSource("route")) {
        map.addSource("route", {
          type: "geojson",
          data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } },
        });
        map.addLayer({
          id: "route-casing",
          type: "line",
          source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#0f5132", "line-width": 7, "line-opacity": 0.35 },
        });
        map.addLayer({
          id: "route-line",
          type: "line",
          source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#16a34a", "line-width": 4 },
        });
      }
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      styleReadyRef.current = false;
      markerRefs.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mapRef.current?.easeTo({ center: [center.lng, center.lat], duration: 400 });
  }, [center.lat, center.lng]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seen = new Set<string>();
    for (const m of markers) {
      seen.add(m.id);
      const existing = markerRefs.current.get(m.id);
      // Recreate if the icon/color changed (e.g. driver status), else just move.
      if (existing && existing.icon === m.icon && existing.color === m.color) {
        existing.marker.setLngLat([m.lng, m.lat]);
      } else {
        existing?.marker.remove();
        const marker = new Marker({ element: markerElement(m) })
          .setLngLat([m.lng, m.lat])
          .addTo(map);
        markerRefs.current.set(m.id, { marker, icon: m.icon, color: m.color });
      }
    }
    for (const [id, ref] of markerRefs.current) {
      if (!seen.has(id)) {
        ref.marker.remove();
        markerRefs.current.delete(id);
      }
    }
  }, [markers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("route") as GeoJSONSource | undefined;
      if (!src) return;
      src.setData({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: route ?? [] },
      });
    };
    if (styleReadyRef.current) apply();
    else map.once("load", apply);
  }, [route]);

  return <div ref={containerRef} className={`h-full w-full ${className}`} />;
}
