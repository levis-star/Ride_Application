import { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Linking,
  Modal,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import * as Location from "expo-location";
import { api, ApiError, clearTokens } from "../api";
import type { RootStackParamList } from "../App";
import DriverMap from "../components/DriverMap";
import { startBackgroundLocation, stopBackgroundLocation } from "../location-task";
import { registerPushToken } from "../push";
import { closeDriverSocket, driverSocket } from "../socket";
import type { DriverProfileMe, LatLng, OfferAcceptResult, OfferNew, TripBoardItem, TripSnapshot } from "../types";

type Props = NativeStackScreenProps<RootStackParamList, "Home">;

// Swahili labels for messages received from the passenger.
const PAX_MSG_SW: Record<string, string> = {
  ARRIVED_OUTSIDE: "Abiria: Nipo nje",
  ON_MY_WAY: "Abiria: Naja sasa hivi",
  WAIT_5_MIN: "Abiria: Subiri dakika 5",
  CANT_FIND_YOU: "Abiria: Sikuoni",
  CALL_ME: "Abiria: Nipigie simu",
  OK_THANKS: "Abiria: Sawa, asante",
};
// Quick messages the driver can send to the passenger.
const DRIVER_QUICK: { key: string; label: string }[] = [
  { key: "ON_MY_WAY", label: "Naja" },
  { key: "ARRIVED_OUTSIDE", label: "Nimefika" },
  { key: "WAIT_5_MIN", label: "Subiri 5 dk" },
  { key: "CANT_FIND_YOU", label: "Sikuoni" },
];

export default function HomeScreen({ navigation }: Props) {
  const [profile, setProfile] = useState<DriverProfileMe | null>(null);
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [offer, setOffer] = useState<OfferNew | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [trip, setTrip] = useState<TripSnapshot | null>(null);
  const [board, setBoard] = useState<TripBoardItem[]>([]);
  const [route, setRoute] = useState<[number, number][] | undefined>(undefined);
  const [paxMsg, setPaxMsg] = useState<string | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval>>(undefined);
  // Suppresses the transient offer:new the server emits for our own claim.
  const claimingRef = useRef<string | null>(null);

  const refreshProfile = useCallback(async () => {
    const me = await api<DriverProfileMe>("GET", "/drivers/me");
    // Registered but not yet cleared → back to the onboarding checklist.
    if (!me.approvedAt) {
      navigation.replace("Onboarding");
      return;
    }
    setProfile(me);
    setOnline(me.status !== "OFFLINE");
  }, [navigation]);

  useEffect(() => {
    void refreshProfile().catch((e) =>
      navigation.replace(e instanceof ApiError && (e.status === 403 || e.status === 404) ? "Onboarding" : "Login"),
    );
    void registerPushToken(); // offers reach a backgrounded app via FCM
  }, [refreshProfile, navigation]);

  // Trip board: passengers still searching nearby, claimable while idle.
  const refreshBoard = useCallback(async () => {
    try {
      setBoard(await api<TripBoardItem[]>("GET", "/drivers/me/trip-board"));
    } catch {
      /* board is best-effort */
    }
  }, []);

  useEffect(() => {
    if (!online || trip || offer) {
      setBoard([]);
      return;
    }
    void refreshBoard();
    const timer = setInterval(() => void refreshBoard(), 10_000);
    return () => clearInterval(timer);
  }, [online, trip, offer, refreshBoard]);

  async function claimBoardTrip(item: TripBoardItem) {
    setBusy(true);
    claimingRef.current = item.tripId;
    try {
      const res = await api<OfferAcceptResult>("POST", `/drivers/me/trip-board/${item.tripId}/claim`, {});
      if (res.ok && res.trip) {
        setTrip(res.trip);
        setBoard([]);
      }
    } catch (e) {
      Alert.alert("Samahani", e instanceof ApiError && e.status === 409 ? "Safari imeshachukuliwa." : String(e));
      void refreshBoard();
    } finally {
      claimingRef.current = null;
      setBusy(false);
    }
  }

  // Green route line for the current leg (offer → pickup; trip → pickup/drop).
  useEffect(() => {
    const leg = offer
      ? { from: offer.pickup, to: offer.drop }
      : trip && (trip.status === "ACCEPTED" || trip.status === "ARRIVED")
        ? { fromDriver: true, to: trip.pickup }
        : trip && trip.status === "IN_PROGRESS"
          ? { fromDriver: true, to: trip.drop }
          : null;
    if (!leg) {
      setRoute(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        let from: LatLng | undefined = "from" in leg ? leg.from : undefined;
        if (!from) {
          const pos = await Location.getLastKnownPositionAsync();
          if (!pos) return;
          from = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        }
        const r = await api<{ geometry: [number, number][] | null }>("POST", "/routing/directions", {
          from,
          to: leg.to,
        });
        if (!cancelled && r.geometry) setRoute(r.geometry);
      } catch {
        /* map still shows markers without the line */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [offer, trip, trip?.status]);

  // Socket wiring: offers arrive here; the server owns every timeout.
  useEffect(() => {
    const socket = driverSocket();
    const onOffer = (o: OfferNew) => {
      if (claimingRef.current === o.tripId) return; // our own claim's offer
      setOffer(o);
      clearInterval(countdownTimer.current);
      countdownTimer.current = setInterval(() => {
        const left = Math.max(0, Math.round((new Date(o.expiresAt).getTime() - Date.now()) / 1000));
        setCountdown(left);
        if (left === 0) clearInterval(countdownTimer.current);
      }, 250);
    };
    const onWithdrawn = (w: { tripId: string }) => {
      setOffer((current) => (current?.tripId === w.tripId ? null : current));
    };
    const onTripUpdate = (u: Partial<TripSnapshot> & { tripId: string; status?: string }) => {
      setTrip((current) => {
        if (!current || current.tripId !== u.tripId) return current;
        if (u.status && ["CANCELLED_BY_PASSENGER", "COMPLETED", "FAILED"].includes(u.status)) {
          if (u.status === "CANCELLED_BY_PASSENGER") Alert.alert("Safari imefutwa na abiria");
          void refreshProfile();
          return null;
        }
        return { ...current, ...u } as TripSnapshot;
      });
    };
    const onForcedStatus = (s: { status: string; reason?: string }) => {
      if (s.status === "OFFLINE") {
        setOnline(false);
        Alert.alert("Umewekwa nje ya mtandao", s.reason === "STALE_LOCATION" ? "GPS haikusikika kwa muda." : "");
      }
    };
    const onBoardItem = (item: TripBoardItem) => {
      setBoard((current) =>
        current.some((i) => i.tripId === item.tripId) ? current : [...current, item],
      );
    };
    const onMessage = (m: { tripId: string; message: string }) => {
      setPaxMsg(PAX_MSG_SW[m.message] ?? m.message);
      setTimeout(() => setPaxMsg(null), 5000);
    };
    socket.on("offer:new", onOffer);
    socket.on("offer:withdrawn", onWithdrawn);
    socket.on("trip:update", onTripUpdate);
    socket.on("driver:status", onForcedStatus);
    socket.on("tripboard:new", onBoardItem);
    socket.on("trip:message", onMessage);
    return () => {
      socket.off("offer:new", onOffer);
      socket.off("offer:withdrawn", onWithdrawn);
      socket.off("trip:update", onTripUpdate);
      socket.off("driver:status", onForcedStatus);
      socket.off("tripboard:new", onBoardItem);
      socket.off("trip:message", onMessage);
    };
  }, [refreshProfile]);

  async function toggleOnline(next: boolean) {
    if (!profile) return;
    setBusy(true);
    try {
      if (next) {
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        await api("POST", "/drivers/me/status", {
          status: "AVAILABLE",
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        });
        await startBackgroundLocation();
        driverSocket(); // ensure connected
        setOnline(true);
      } else {
        await api("POST", "/drivers/me/status", { status: "OFFLINE" });
        await stopBackgroundLocation();
        setOnline(false);
      }
      await refreshProfile();
    } catch (e) {
      Alert.alert("Imeshindikana", e instanceof Error ? e.message : String(e));
      setOnline(!next ? true : false);
    } finally {
      setBusy(false);
    }
  }

  function respondToOffer(accept: boolean) {
    if (!offer) return;
    const socket = driverSocket();
    if (accept) {
      socket.emit("offer:accept", { tripId: offer.tripId, offerSeq: offer.offerSeq }, (res: OfferAcceptResult) => {
        setOffer(null);
        if (res.ok && res.trip) setTrip(res.trip);
        else Alert.alert("Samahani", res.reason === "ALREADY_TAKEN" ? "Safari imechukuliwa." : "Ofa imeisha.");
      });
    } else {
      socket.emit("offer:decline", { tripId: offer.tripId, offerSeq: offer.offerSeq }, () => setOffer(null));
    }
  }

  async function tripAction(action: "ARRIVED" | "START" | "COMPLETE") {
    if (!trip) return;
    setBusy(true);
    try {
      const pos = await Location.getLastKnownPositionAsync();
      const result = await api<{ status: string; finalFare?: number }>("POST", `/trips/${trip.tripId}/action`, {
        action,
        lat: pos?.coords.latitude,
        lng: pos?.coords.longitude,
      });
      if (action === "COMPLETE") {
        Alert.alert("Safari imekamilika", `Pokea TZS ${result.finalFare?.toLocaleString() ?? "?"} taslimu.`);
        setTrip(null);
        await refreshProfile();
      } else {
        setTrip({ ...trip, status: result.status });
      }
    } catch (e) {
      Alert.alert("Imeshindikana", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function navigateTo(target: { lat: number; lng: number }, label: string) {
    // Deep link to any installed maps app (spec §13 — no in-app voice/nav).
    void Linking.openURL(`geo:${target.lat},${target.lng}?q=${target.lat},${target.lng}(${encodeURIComponent(label)})`);
  }

  async function sendQuickMessage(message: string) {
    if (!trip) return;
    await api("POST", `/trips/${trip.tripId}/message`, { message }).catch(() => undefined);
  }

  function raiseSos() {
    if (!trip) return;
    Alert.alert("Dharura", "Piga kengele ya dharura? Ofisi itaarifiwa.", [
      { text: "Ghairi", style: "cancel" },
      {
        text: "Piga kengele",
        style: "destructive",
        onPress: () => {
          void (async () => {
            const pos = await Location.getLastKnownPositionAsync().catch(() => null);
            await api("POST", `/trips/${trip.tripId}/sos`, {
              lat: pos?.coords.latitude,
              lng: pos?.coords.longitude,
            }).catch(() => undefined);
            Alert.alert("Kengele imepigwa", "Ofisi inakuja kukusaidia.");
          })();
        },
      },
    ]);
  }

  const belowLimit = profile !== null && profile.walletBalance < profile.negativeBalanceLimit;

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, gap: 12 }}>
      {/* Wallet banner — top-up CTA is prominent by spec §9 */}
      <TouchableOpacity style={[styles.wallet, belowLimit && styles.walletDanger]} onPress={() => navigation.navigate("Wallet")}>
        <Text style={styles.walletLabel}>Pochi</Text>
        <Text style={[styles.walletAmount, belowLimit && { color: "#b91c1c" }]}>
          TZS {profile?.walletBalance.toLocaleString() ?? "…"}
        </Text>
        {belowLimit && <Text style={styles.walletWarn}>Weka salio ili uweze kuwa mtandaoni</Text>}
      </TouchableOpacity>

      {/* Online toggle */}
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <View>
            <Text style={styles.cardTitle}>{online ? "Uko MTANDAONI" : "Uko nje ya mtandao"}</Text>
            <Text style={styles.cardSub}>
              {profile?.vehicle ? `${profile.vehicle.class} • ${profile.vehicle.plateNumber}` : "Hakuna chombo"}
            </Text>
          </View>
          <Switch
            value={online}
            disabled={busy || trip !== null}
            onValueChange={(v) => void toggleOnline(v)}
            trackColor={{ true: "#86efac" }}
            thumbColor={online ? "#15803d" : "#9ca3af"}
          />
        </View>
      </View>

      {/* Nearby searching passengers (trip board) */}
      {online && !trip && board.length > 0 && (
        <View style={[styles.card, styles.boardCard]}>
          <Text style={styles.cardTitle}>🔔 Abiria wanasubiri karibu nawe</Text>
          {board.slice(0, 3).map((item) => (
            <View key={item.tripId} style={styles.boardRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.boardFare}>TZS {item.driverEarningsEstimate.toLocaleString()}</Text>
                <Text style={styles.cardSub}>
                  {(item.distanceToPickupM / 1000).toFixed(1)} km kutoka kwako •{" "}
                  {Math.round(item.searchingForS)}s akisubiri
                </Text>
              </View>
              <TouchableOpacity
                style={styles.claimButton}
                disabled={busy}
                onPress={() => void claimBoardTrip(item)}
              >
                <Text style={styles.buttonText}>Chukua</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {/* Active trip */}
      {trip && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            {trip.kind === "PARCEL" ? "📦 Kifurushi" : "Safari"} — {trip.status}
          </Text>
          <Text style={styles.cardSub}>
            {trip.paymentMethod === "CASH" ? `Pokea TZS ${trip.estimatedFare.toLocaleString()} (kadirio) taslimu` : "Malipo ya simu"}
          </Text>
          {trip.kind === "PARCEL" && trip.recipient && (
            <Text style={styles.parcelInfo}>
              Mpokeaji: {trip.recipient.name} · {trip.recipient.phone}
              {trip.packageNote ? `\n${trip.packageNote}` : ""}
            </Text>
          )}
          {paxMsg && <Text style={styles.paxMsg}>💬 {paxMsg}</Text>}
          <DriverMap
            pickup={trip.pickup}
            drop={trip.status === "IN_PROGRESS" ? trip.drop : undefined}
            route={route}
          />

          {/* Quick messages to the passenger */}
          <View style={styles.quickRow}>
            {DRIVER_QUICK.map((m) => (
              <TouchableOpacity key={m.key} style={styles.quickChip} onPress={() => void sendQuickMessage(m.key)}>
                <Text style={styles.quickChipText}>{m.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {trip.status === "ACCEPTED" && (
            <>
              <TouchableOpacity style={styles.buttonOutline} onPress={() => navigateTo(trip.pickup, "Abiria")}>
                <Text style={styles.buttonOutlineText}>🧭 Elekea kwa abiria</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.button} onPress={() => void tripAction("ARRIVED")} disabled={busy}>
                <Text style={styles.buttonText}>Nimefika</Text>
              </TouchableOpacity>
            </>
          )}
          {trip.status === "ARRIVED" && (
            <TouchableOpacity style={styles.button} onPress={() => void tripAction("START")} disabled={busy}>
              <Text style={styles.buttonText}>Anza safari</Text>
            </TouchableOpacity>
          )}
          {trip.status === "IN_PROGRESS" && (
            <>
              <TouchableOpacity style={styles.buttonOutline} onPress={() => navigateTo(trip.drop, "Mwisho")}>
                <Text style={styles.buttonOutlineText}>🧭 Elekea mwisho wa safari</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.button} onPress={() => void tripAction("COMPLETE")} disabled={busy}>
                <Text style={styles.buttonText}>Maliza safari</Text>
              </TouchableOpacity>
            </>
          )}
          <TouchableOpacity style={styles.sosButton} onPress={raiseSos}>
            <Text style={styles.sosButtonText}>🆘 Dharura</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Nav */}
      <View style={styles.row}>
        <TouchableOpacity style={styles.navCard} onPress={() => navigation.navigate("Earnings")}>
          <Text style={styles.navIcon}>📈</Text>
          <Text style={styles.navLabel}>Mapato</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.navCard} onPress={() => navigation.navigate("History")}>
          <Text style={styles.navIcon}>🕓</Text>
          <Text style={styles.navLabel}>Safari</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.navCard}
          onPress={() => {
            void (async () => {
              await stopBackgroundLocation().catch(() => undefined);
              closeDriverSocket();
              await clearTokens();
              navigation.replace("Login");
            })();
          }}
        >
          <Text style={styles.navIcon}>🚪</Text>
          <Text style={styles.navLabel}>Toka</Text>
        </TouchableOpacity>
      </View>

      {/* Full-screen incoming offer (spec §13) */}
      <Modal visible={offer !== null} animationType="slide" onRequestClose={() => respondToOffer(false)}>
        {offer && (
          <View style={styles.offerScreen}>
            <Text style={styles.offerCountdown}>{countdown}s</Text>
            <Text style={styles.offerTitle}>Safari mpya!</Text>
            <DriverMap pickup={offer.pickup} drop={offer.drop} route={route} height={260} />
            <View style={styles.offerStats}>
              <Text style={styles.offerStat}>
                📍 Umbali kwenda kwa abiria: {(offer.distanceToPickupM / 1000).toFixed(1)} km (~
                {Math.ceil(offer.etaToPickupS / 60)} dak)
              </Text>
              <Text style={styles.offerStat}>
                💰 Utapata (kadirio): TZS {offer.driverEarningsEstimate.toLocaleString()}
              </Text>
              <Text style={styles.offerStat}>
                {offer.paymentMethod === "CASH" ? "💵 Malipo: taslimu" : "📱 Malipo: simu"}
              </Text>
              {offer.pickupNote && <Text style={styles.offerStat}>📝 {offer.pickupNote}</Text>}
            </View>
            <TouchableOpacity style={[styles.button, styles.acceptButton]} onPress={() => respondToOffer(true)}>
              <Text style={styles.buttonText}>KUBALI</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.declineButton} onPress={() => respondToOffer(false)}>
              <Text style={styles.declineText}>Kataa</Text>
            </TouchableOpacity>
          </View>
        )}
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f9fafb" },
  card: { backgroundColor: "#fff", borderRadius: 16, padding: 16, gap: 10, elevation: 2 },
  cardTitle: { fontSize: 18, fontWeight: "800", color: "#111827" },
  cardSub: { fontSize: 14, color: "#6b7280" },
  wallet: { backgroundColor: "#fff", borderRadius: 16, padding: 16, elevation: 2 },
  walletDanger: { borderWidth: 2, borderColor: "#dc2626" },
  walletLabel: { fontSize: 13, color: "#6b7280" },
  walletAmount: { fontSize: 26, fontWeight: "900", color: "#15803d" },
  walletWarn: { color: "#b91c1c", marginTop: 4, fontWeight: "600" },
  row: { flexDirection: "row", gap: 12 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  boardCard: { borderWidth: 2, borderColor: "#86efac" },
  boardRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  boardFare: { fontSize: 16, fontWeight: "800", color: "#15803d" },
  claimButton: { backgroundColor: "#15803d", borderRadius: 10, paddingVertical: 10, paddingHorizontal: 18 },
  parcelInfo: { backgroundColor: "#fef3c7", borderRadius: 8, padding: 8, fontSize: 13, color: "#92400e" },
  paxMsg: { backgroundColor: "#dcfce7", borderRadius: 8, padding: 8, fontSize: 14, fontWeight: "600", color: "#15803d" },
  quickRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  quickChip: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 16, paddingVertical: 6, paddingHorizontal: 12 },
  quickChipText: { fontSize: 13, color: "#374151" },
  sosButton: { borderWidth: 2, borderColor: "#dc2626", borderRadius: 12, padding: 12, alignItems: "center" },
  sosButtonText: { color: "#dc2626", fontWeight: "800", fontSize: 15 },
  navCard: { flex: 1, backgroundColor: "#fff", borderRadius: 16, padding: 16, alignItems: "center", elevation: 2 },
  navIcon: { fontSize: 24 },
  navLabel: { marginTop: 4, fontWeight: "600", color: "#374151" },
  button: { backgroundColor: "#15803d", borderRadius: 12, padding: 16, alignItems: "center" },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "800" },
  buttonOutline: { borderWidth: 1, borderColor: "#d1d5db", borderRadius: 12, padding: 14, alignItems: "center" },
  buttonOutlineText: { color: "#111827", fontSize: 15, fontWeight: "600" },
  offerScreen: { flex: 1, backgroundColor: "#052e16", justifyContent: "center", padding: 24, gap: 16 },
  offerCountdown: { fontSize: 64, fontWeight: "900", color: "#4ade80", textAlign: "center" },
  offerTitle: { fontSize: 28, fontWeight: "900", color: "#fff", textAlign: "center" },
  offerStats: { backgroundColor: "#14532d", borderRadius: 16, padding: 16, gap: 8 },
  offerStat: { color: "#dcfce7", fontSize: 16 },
  acceptButton: { padding: 20, backgroundColor: "#16a34a" },
  declineButton: { alignItems: "center", padding: 12 },
  declineText: { color: "#86efac", fontSize: 16 },
});
