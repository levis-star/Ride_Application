// Dynamic Expo config (replaces app.json) so operator files activate by
// simply existing:
//   - google-services.json in this directory → FCM wiring in the Android
//     build (Firebase console → project settings → your Android app →
//     download). Pair with PUSH_PROVIDER=fcm on the API.
//   - SENTRY_DSN env at build time → crash reporting in the app.
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const googleServices = join(__dirname, "google-services.json");

module.exports = {
  expo: {
    name: "RukwaRide Dereva",
    slug: "rukwaride-driver",
    version: "0.1.0",
    orientation: "portrait",
    userInterfaceStyle: "light",
    platforms: ["android"],
    android: {
      package: "tz.co.rukwaride.driver",
      ...(existsSync(googleServices) ? { googleServicesFile: "./google-services.json" } : {}),
      permissions: [
        "ACCESS_COARSE_LOCATION",
        "ACCESS_FINE_LOCATION",
        "ACCESS_BACKGROUND_LOCATION",
        "FOREGROUND_SERVICE",
        "FOREGROUND_SERVICE_LOCATION",
        "POST_NOTIFICATIONS",
        "WAKE_LOCK",
        "CAMERA",
      ],
    },
    plugins: [
      [
        "expo-location",
        {
          isAndroidBackgroundLocationEnabled: true,
          isAndroidForegroundServiceEnabled: true,
          locationAlwaysAndWhenInUsePermission:
            "RukwaRide inahitaji mahali pako ukiwa mtandaoni ili kukuletea safari.",
        },
      ],
      "expo-secure-store",
      "expo-task-manager",
      "@maplibre/maplibre-react-native",
      [
        "expo-notifications",
        {
          defaultChannel: "offers",
        },
      ],
      [
        "expo-image-picker",
        {
          photosPermission: "RukwaRide inahitaji kufikia picha zako ili kupakia nyaraka za usajili.",
          cameraPermission: "RukwaRide inahitaji kamera ili kupiga picha za nyaraka za usajili.",
        },
      ],
      "@sentry/react-native/expo",
    ],
    extra: {
      apiUrl: "http://10.0.2.2:3001",
      // Baked into the build; empty string disables Sentry cleanly.
      sentryDsn: process.env.SENTRY_DSN ?? "",
    },
  },
};
