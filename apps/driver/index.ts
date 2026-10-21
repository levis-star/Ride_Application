import { registerRootComponent } from "expo";
import Constants from "expo-constants";
import * as Sentry from "@sentry/react-native";
// The background location task must be imported at module scope so Android
// can invoke it while the app is backgrounded (expo-task-manager contract).
import "./src/location-task";
import App from "./src/App";

// Crash reporting (spec §17): DSN is baked in via app.config.js `extra` at
// build time; an empty DSN leaves the SDK disabled (dev builds, demo).
const sentryDsn = (Constants.expoConfig?.extra as { sentryDsn?: string } | undefined)?.sentryDsn;
if (sentryDsn) {
  Sentry.init({ dsn: sentryDsn, tracesSampleRate: 0 });
}

registerRootComponent(sentryDsn ? Sentry.wrap(App) : App);
