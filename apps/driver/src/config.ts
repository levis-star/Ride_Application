import Constants from "expo-constants";

/**
 * API endpoint. Default (extra.apiUrl in app.json) targets the Android
 * emulator's host loopback (10.0.2.2). Real devices on the same LAN:
 * set EXPO_PUBLIC_API_URL=http://<your-machine-ip>:3001 when starting expo.
 */
export const API_URL: string =
  process.env.EXPO_PUBLIC_API_URL ??
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ??
  "http://10.0.2.2:3001";

/** GPS ping cadence while online (spec §7: every 5 s). */
export const PING_INTERVAL_MS = 5000;
