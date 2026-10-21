import { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { api, ApiError, storeTokens } from "../api";
import type { RootStackParamList } from "../App";

// The server accepts jpeg/png/webp/pdf and re-checks the bytes; the picker
// returns images, so map its mime type onto an accepted content type.
const MIME_TO_CONTENT: Record<string, "image/jpeg" | "image/png" | "image/webp"> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
};
// Base64 ceiling matching the server's 7 MB cap (~5 MB decoded); reject early
// with a friendly message rather than burning an upload that 400s.
const MAX_BASE64 = 6_800_000;

type Props = NativeStackScreenProps<RootStackParamList, "Onboarding">;

/** Tanzanian driving licence classes (A motorcycle, B/C light, D/E heavy). */
const LICENCE_CATEGORIES = ["A", "B", "C", "D", "E"];

const CLASSES = [
  { value: "BODABODA", icon: "🏍️", label: "Bodaboda" },
  { value: "BAJAJI", icon: "🛺", label: "Bajaji" },
  { value: "CAR", icon: "🚗", label: "Gari" },
] as const;

const DOC_LABELS: Record<string, string> = {
  NATIONAL_ID: "Kitambulisho cha Taifa",
  DRIVING_LICENSE: "Leseni ya udereva",
  VEHICLE_PHOTO: "Picha ya chombo",
  INSURANCE: "Bima",
  LATRA_VEHICLE_LICENSE: "Leseni ya LATRA",
  DRIVER_PHOTO: "Picha yako",
};

interface Onboarding {
  approvedAt: string | null;
  requiredDocuments: string[];
  documents: { type: string; status: string; rejectionReason: string | null }[];
  vehicle: { plateNumber: string; class: string } | null;
  canGoOnline: boolean;
}

/**
 * Registration + onboarding checklist (spec §13). Document photos are
 * uploaded via the web onboarding page (same phone login) — the checklist
 * here reflects review status live so the driver knows when they're cleared.
 */
export default function OnboardingScreen({ navigation }: Props) {
  const [phase, setPhase] = useState<"loading" | "register" | "checklist">("loading");
  const [ob, setOb] = useState<Onboarding | null>(null);
  const [name, setName] = useState("");
  const [vehicleClass, setVehicleClass] = useState<string>("BODABODA");
  const [plate, setPlate] = useState("");
  const [license, setLicense] = useState("");
  const [licenceCategory, setLicenceCategory] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const canRegister =
    !busy &&
    name.trim().length >= 2 &&
    plate.trim().length >= 4 &&
    license.replace(/\D/g, "").length === 10 &&
    licenceCategory.length > 0 &&
    email.includes("@");

  const refresh = useCallback(async () => {
    try {
      const data = await api<Onboarding>("GET", "/drivers/me/onboarding");
      setOb(data);
      setPhase("checklist");
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) setPhase("register");
      else Alert.alert("Hitilafu", e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (phase !== "checklist" || ob?.canGoOnline) return;
    const t = setInterval(() => void refresh(), 8000);
    return () => clearInterval(t);
  }, [phase, ob?.canGoOnline, refresh]);

  async function register() {
    setBusy(true);
    try {
      const res = await api<{ accessToken: string; refreshToken: string }>("POST", "/drivers/register", {
        name,
        vehicleClass,
        plateNumber: plate,
        licenseNumber: license.trim(),
        licenceCategory,
        email: email.trim(),
      });
      await storeTokens(res.accessToken, res.refreshToken); // fresh DRIVER-role tokens
      await refresh();
    } catch (e) {
      Alert.alert("Hitilafu", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Ask camera-or-gallery, then capture + upload a document photo in-app. */
  function pickDocument(type: string) {
    Alert.alert(DOC_LABELS[type] ?? type, "Chagua chanzo cha picha", [
      { text: "Piga picha", onPress: () => void capture(type, "camera") },
      { text: "Chagua kwenye simu", onPress: () => void capture(type, "library") },
      { text: "Ghairi", style: "cancel" },
    ]);
  }

  async function capture(type: string, source: "camera" | "library") {
    try {
      const perm =
        source === "camera"
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Ruhusa inahitajika", "Tafadhali ruhusu ufikiaji wa kamera/picha ili kupakia nyaraka.");
        return;
      }
      const opts: ImagePicker.ImagePickerOptions = {
        mediaTypes: ["images"],
        base64: true,
        quality: 0.6,
      };
      const result =
        source === "camera"
          ? await ImagePicker.launchCameraAsync(opts)
          : await ImagePicker.launchImageLibraryAsync(opts);
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset?.base64) {
        Alert.alert("Hitilafu", "Imeshindwa kusoma picha. Jaribu tena.");
        return;
      }
      if (asset.base64.length > MAX_BASE64) {
        Alert.alert("Picha kubwa mno", "Tafadhali chukua picha kwa ubora wa chini kisha jaribu tena.");
        return;
      }
      const contentType = MIME_TO_CONTENT[asset.mimeType ?? "image/jpeg"] ?? "image/jpeg";
      setUploading(type);
      await api("POST", "/drivers/me/documents", { type, contentType, data: asset.base64 });
      await refresh();
    } catch (e) {
      Alert.alert("Hitilafu", e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(null);
    }
  }

  if (phase === "loading") {
    return (
      <View style={[styles.container, { justifyContent: "center" }]}>
        <ActivityIndicator size="large" color="#15803d" />
      </View>
    );
  }

  if (phase === "register") {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.title}>Usajili wa dereva</Text>
        <Text style={styles.hint}>Jisajili, pakia nyaraka, kisha subiri idhini ya ofisi.</Text>

        <Text style={styles.label}>Jina lako</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} />

        <Text style={styles.label}>Aina ya chombo</Text>
        <View style={styles.classRow}>
          {CLASSES.map((c) => (
            <TouchableOpacity
              key={c.value}
              style={[styles.classCard, vehicleClass === c.value && styles.classCardActive]}
              onPress={() => setVehicleClass(c.value)}
            >
              <Text style={styles.classIcon}>{c.icon}</Text>
              <Text style={styles.classLabel}>{c.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.label}>Namba ya usajili (mf. MC 123 ABC)</Text>
        <TextInput style={styles.input} autoCapitalize="characters" value={plate} onChangeText={(v) => setPlate(v.toUpperCase())} />

        {/* Licence number, class and email are Required by LATRA's e-ticketing
            system — without them the driver cannot be registered with LATRA
            and none of their trips could ever be reported. */}
        <Text style={styles.label}>Namba ya leseni ya udereva (tarakimu 10)</Text>
        <TextInput
          style={styles.input}
          keyboardType="number-pad"
          value={license}
          onChangeText={setLicense}
        />

        <Text style={styles.label}>Daraja la leseni</Text>
        <View style={styles.classRow}>
          {LICENCE_CATEGORIES.map((c) => (
            <TouchableOpacity
              key={c}
              style={[styles.classCard, licenceCategory === c && styles.classCardActive]}
              onPress={() => setLicenceCategory(c)}
            >
              <Text style={styles.classLabel}>{c}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.label}>Barua pepe</Text>
        <TextInput
          style={styles.input}
          keyboardType="email-address"
          autoCapitalize="none"
          value={email}
          onChangeText={setEmail}
        />

        <TouchableOpacity
          style={[styles.button, !canRegister && styles.buttonDisabled]}
          disabled={!canRegister}
          onPress={() => void register()}
        >
          <Text style={styles.buttonText}>Jisajili sasa</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Hatua za usajili</Text>

      <View style={styles.stepCard}>
        <Text style={styles.stepIcon}>✅</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.stepTitle}>Umejisajili</Text>
          {ob?.vehicle && (
            <Text style={styles.stepSub}>
              {CLASSES.find((c) => c.value === ob.vehicle!.class)?.icon} {ob.vehicle.plateNumber}
            </Text>
          )}
        </View>
      </View>

      <View style={styles.stepCard}>
        <Text style={styles.stepIcon}>📄</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.stepTitle}>Nyaraka</Text>
          {(ob?.requiredDocuments ?? []).map((type) => {
            const doc = ob?.documents.find((d) => d.type === type);
            const approved = doc?.status === "APPROVED";
            const status = !doc
              ? "— haijapakiwa"
              : approved
                ? "✓ imeidhinishwa"
                : doc.status === "REJECTED"
                  ? `✗ imekataliwa${doc.rejectionReason ? ` (${doc.rejectionReason})` : ""}`
                  : "… inasubiri ukaguzi";
            return (
              <View key={type} style={styles.docRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.docLabel}>{DOC_LABELS[type] ?? type}</Text>
                  <Text style={styles.stepSub}>{status}</Text>
                </View>
                {!approved && (
                  <TouchableOpacity
                    style={[styles.uploadBtn, uploading !== null && styles.buttonDisabled]}
                    disabled={uploading !== null}
                    onPress={() => pickDocument(type)}
                  >
                    {uploading === type ? (
                      <ActivityIndicator color="#15803d" size="small" />
                    ) : (
                      <Text style={styles.uploadBtnText}>{doc ? "Pakia upya" : "Pakia"}</Text>
                    )}
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </View>
      </View>

      <View style={styles.stepCard}>
        <Text style={styles.stepIcon}>{ob?.approvedAt ? "✅" : "⏳"}</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.stepTitle}>Idhini ya ofisi</Text>
          <Text style={styles.stepSub}>
            {ob?.approvedAt ? "Umeidhinishwa!" : "Subiri idhini — ukurasa huu utajisasisha wenyewe."}
          </Text>
        </View>
      </View>

      {ob?.canGoOnline && (
        <TouchableOpacity style={styles.button} onPress={() => navigation.replace("Home")}>
          <Text style={styles.buttonText}>Anza kufanya kazi →</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f9fafb" },
  content: { padding: 20, paddingBottom: 40 },
  title: { fontSize: 22, fontWeight: "800", color: "#15803d", marginBottom: 6 },
  hint: { color: "#6b7280", marginBottom: 16 },
  label: { fontWeight: "600", marginTop: 14, marginBottom: 6 },
  input: {
    backgroundColor: "white",
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 10,
    padding: 12,
    fontSize: 16,
  },
  classRow: { flexDirection: "row", gap: 8 },
  classCard: {
    flex: 1,
    alignItems: "center",
    padding: 12,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "#e5e7eb",
    backgroundColor: "white",
  },
  classCardActive: { borderColor: "#15803d", backgroundColor: "#f0fdf4" },
  classIcon: { fontSize: 26 },
  classLabel: { fontSize: 12, fontWeight: "600", marginTop: 4 },
  button: {
    backgroundColor: "#15803d",
    borderRadius: 12,
    padding: 15,
    alignItems: "center",
    marginTop: 22,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: "white", fontWeight: "700", fontSize: 16 },
  stepCard: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: "white",
    borderRadius: 12,
    padding: 14,
    marginTop: 10,
    elevation: 1,
  },
  stepIcon: { fontSize: 20 },
  stepTitle: { fontWeight: "700", fontSize: 15 },
  stepSub: { color: "#4b5563", marginTop: 2, fontSize: 13 },
  docRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: "#f3f4f6",
  },
  docLabel: { fontWeight: "600", fontSize: 14, color: "#111827" },
  uploadBtn: {
    borderWidth: 1.5,
    borderColor: "#15803d",
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 14,
    minWidth: 84,
    alignItems: "center",
  },
  uploadBtnText: { color: "#15803d", fontWeight: "700", fontSize: 13 },
});
