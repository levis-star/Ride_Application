import { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { Alert, KeyboardAvoidingView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { api, storeTokens } from "../api";
import type { RootStackParamList } from "../App";

type Props = NativeStackScreenProps<RootStackParamList, "Login">;

export default function LoginScreen({ navigation }: Props) {
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("+255");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function requestCode() {
    setBusy(true);
    try {
      await api("POST", "/auth/otp/request", { phone });
      setStep("code");
    } catch (e) {
      Alert.alert("Hitilafu", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    try {
      const res = await api<{ accessToken: string; refreshToken: string; role: string }>(
        "POST",
        "/auth/otp/verify",
        { phone, code },
      );
      if (res.role === "ADMIN" || res.role === "DISPATCHER") {
        Alert.alert("Samahani", "Akaunti ya ofisi — tumia dashibodi ya wavuti.");
        return;
      }
      await storeTokens(res.accessToken, res.refreshToken);
      // New/passenger numbers register as drivers first (spec §13 onboarding).
      navigation.replace(res.role === "DRIVER" ? "Home" : "Onboarding");
    } catch (e) {
      Alert.alert("Hitilafu", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior="padding">
      <Text style={styles.logo}>RukwaRide</Text>
      <Text style={styles.subtitle}>Dereva</Text>

      {step === "phone" ? (
        <View style={styles.form}>
          <Text style={styles.label}>Nambari ya simu</Text>
          <TextInput
            style={styles.input}
            keyboardType="phone-pad"
            value={phone}
            onChangeText={(v) => setPhone(v.replace(/[^+\d]/g, ""))}
            autoFocus
          />
          <TouchableOpacity style={styles.button} onPress={() => void requestCode()} disabled={busy}>
            <Text style={styles.buttonText}>Tuma nambari ya uthibitisho</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.form}>
          <Text style={styles.label}>Weka nambari ya uthibitisho (SMS)</Text>
          <TextInput
            style={[styles.input, styles.codeInput]}
            keyboardType="number-pad"
            maxLength={6}
            value={code}
            onChangeText={(v) => setCode(v.replace(/\D/g, ""))}
            autoFocus
          />
          <TouchableOpacity
            style={[styles.button, code.length !== 6 && styles.buttonDisabled]}
            onPress={() => void verify()}
            disabled={busy || code.length !== 6}
          >
            <Text style={styles.buttonText}>Thibitisha</Text>
          </TouchableOpacity>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#f9fafb" },
  logo: { fontSize: 36, fontWeight: "900", color: "#15803d", textAlign: "center" },
  subtitle: { fontSize: 16, color: "#6b7280", textAlign: "center", marginBottom: 32 },
  form: { gap: 12 },
  label: { fontSize: 16, fontWeight: "600", color: "#111827" },
  input: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 12,
    padding: 14,
    fontSize: 18,
  },
  codeInput: { textAlign: "center", letterSpacing: 12, fontSize: 24 },
  button: { backgroundColor: "#15803d", borderRadius: 12, padding: 16, alignItems: "center" },
  buttonDisabled: { backgroundColor: "#9ca3af" },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
