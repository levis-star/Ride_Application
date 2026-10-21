/**
 * Background GPS pipeline (spec §13: foreground service while online).
 *
 * expo-location's Android foreground service invokes this task every ~5 s.
 * Delivery order: socket if connected → offline queue → HTTP batch flush on
 * reconnect (spec §7 flaky-3G contract, same as the passenger-side design and
 * the simulator's behavior).
 */
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { api } from "./api";
import { PING_INTERVAL_MS } from "./config";
import { driverSocket } from "./socket";

export const LOCATION_TASK = "rukwaride-driver-location";

interface QueuedPing {
  lat: number;
  lng: number;
  heading?: number;
  recordedAt: number;
}

const queue: QueuedPing[] = [];
let flushing = false;

async function flushQueue(): Promise<void> {
  if (flushing || queue.length === 0) return;
  flushing = true;
  try {
    const batch = queue.splice(0, Math.min(queue.length, 500));
    await api("POST", "/drivers/me/locations", { points: batch });
  } catch {
    // API unreachable — keep queueing; next ping retries.
  } finally {
    flushing = false;
  }
}

export function handlePing(ping: QueuedPing): void {
  const socket = driverSocket();
  if (socket.connected) {
    socket.emit("driver:location", ping);
    if (queue.length > 0) void flushQueue();
  } else {
    queue.push(ping);
    if (queue.length > 2000) queue.splice(0, queue.length - 2000); // bound memory
    if (queue.length % 12 === 0) void flushQueue();
  }
}

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const { locations } = data as { locations: Location.LocationObject[] };
  for (const loc of locations) {
    handlePing({
      lat: loc.coords.latitude,
      lng: loc.coords.longitude,
      heading: loc.coords.heading != null && loc.coords.heading >= 0 ? loc.coords.heading : undefined,
      recordedAt: loc.timestamp,
    });
  }
});

export async function startBackgroundLocation(): Promise<void> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== "granted") throw new Error("Location permission denied");
  // ACCESS_BACKGROUND_LOCATION: Android shows a second "Allow all the time"
  // prompt. Required for offers while the phone is pocketed.
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== "granted") throw new Error("Background location permission denied");

  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: PING_INTERVAL_MS,
    distanceInterval: 5,
    // Persistent notification = Android foreground service (spec §13).
    foregroundService: {
      notificationTitle: "RukwaRide — uko mtandaoni",
      notificationBody: "Unapokea safari. Gusa kufungua.",
      killServiceOnDestroy: false,
    },
    pausesUpdatesAutomatically: false,
  });
}

export async function stopBackgroundLocation(): Promise<void> {
  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
  if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
}
