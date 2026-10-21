import { Camera, LineLayer, MapView, PointAnnotation, ShapeSource } from "@maplibre/maplibre-react-native";
import { StyleSheet, Text, View } from "react-native";
import type { LatLng } from "../types";

/**
 * Embedded course map (Bolt-style): pickup/drop/driver markers + the green
 * OSRM route for the current leg. Same OpenFreeMap style as the passenger
 * web app; needs internet for tiles (the trip flow already does).
 */
const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

interface Props {
  pickup?: LatLng;
  drop?: LatLng;
  driver?: LatLng;
  /** [lng, lat] pairs from POST /routing/directions */
  route?: [number, number][];
  height?: number;
}

export default function DriverMap({ pickup, drop, driver, route, height = 220 }: Props) {
  const points = [pickup, drop, driver].filter((p): p is LatLng => !!p);
  if (points.length === 0) return null;
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const pad = 0.004; // ~400 m breathing room around the leg
  const bounds = {
    ne: [Math.max(...lngs) + pad, Math.max(...lats) + pad] as [number, number],
    sw: [Math.min(...lngs) - pad, Math.min(...lats) - pad] as [number, number],
  };

  return (
    <View style={[styles.wrap, { height }]}>
      <MapView style={styles.map} mapStyle={MAP_STYLE} logoEnabled={false} attributionEnabled={false}>
        <Camera bounds={bounds} animationDuration={400} />
        {route && route.length > 1 && (
          <ShapeSource
            id="route"
            shape={{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: route } }}
          >
            <LineLayer
              id="route-line"
              style={{ lineColor: "#16a34a", lineWidth: 4, lineCap: "round", lineJoin: "round" }}
            />
          </ShapeSource>
        )}
        {pickup && (
          <PointAnnotation id="pickup" coordinate={[pickup.lng, pickup.lat]}>
            <Text style={styles.marker}>🟢</Text>
          </PointAnnotation>
        )}
        {drop && (
          <PointAnnotation id="drop" coordinate={[drop.lng, drop.lat]}>
            <Text style={styles.marker}>📍</Text>
          </PointAnnotation>
        )}
        {driver && (
          <PointAnnotation id="driver" coordinate={[driver.lng, driver.lat]}>
            <Text style={styles.marker}>🏍️</Text>
          </PointAnnotation>
        )}
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: 12, overflow: "hidden", marginTop: 10 },
  map: { flex: 1 },
  marker: { fontSize: 24 },
});
