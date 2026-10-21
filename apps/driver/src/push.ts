import * as Notifications from "expo-notifications";
import { api } from "./api";

/**
 * FCM registration (spec §7.3): offers must surface when the app is
 * backgrounded. The API sends via FCM HTTP v1 directly, so we register the
 * NATIVE device token (not the Expo push token) into User.fcmToken.
 *
 * Requires google-services.json in the dev build (operator TODO: Firebase
 * project). Without it registration throws — push simply stays off and the
 * socket + SMS chain still delivers.
 */

// Heads-up alerts while the app is foregrounded (offer sound comes from FCM).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function registerPushToken(): Promise<void> {
  try {
    const perms = await Notifications.requestPermissionsAsync();
    if (!perms.granted) return;
    const { data } = await Notifications.getDevicePushTokenAsync();
    await api("PATCH", "/users/me", { fcmToken: String(data) });
  } catch {
    // Expo Go / no google-services.json — run without push.
  }
}
