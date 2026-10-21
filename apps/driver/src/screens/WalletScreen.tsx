import { useCallback, useEffect, useState } from "react";
import { Alert, FlatList, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { api } from "../api";
import type { DriverProfileMe } from "../types";

interface LedgerRow {
  id: string;
  at: string;
  amount: number;
  memo: string | null;
}

export default function WalletScreen() {
  const [profile, setProfile] = useState<DriverProfileMe | null>(null);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [topupOpen, setTopupOpen] = useState(false);
  const [amount, setAmount] = useState("5000");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void api<DriverProfileMe>("GET", "/drivers/me").then(setProfile).catch(() => {});
    void api<LedgerRow[]>("GET", "/drivers/me/ledger").then(setRows).catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);

  async function submitTopup() {
    const value = Number.parseInt(amount, 10);
    if (!Number.isInteger(value) || value < 1000) {
      Alert.alert("Kiasi kidogo", "Weka angalau TZS 1,000.");
      return;
    }
    setBusy(true);
    try {
      // Collection push lands on the driver's phone (USSD/STK prompt); the
      // wallet credits when the aggregator webhook confirms.
      await api("POST", "/payments/topup", { amount: value });
      setTopupOpen(false);
      Alert.alert("Ombi limetumwa", "Kamilisha malipo kwenye simu yako. Salio litaongezeka likithibitishwa.");
      setTimeout(refresh, 4000);
    } catch (e) {
      Alert.alert("Imeshindikana", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>Salio la pochi</Text>
        <Text style={styles.balance}>TZS {profile?.walletBalance.toLocaleString() ?? "…"}</Text>
        <Text style={styles.limit}>
          Kikomo: TZS {profile?.negativeBalanceLimit.toLocaleString() ?? "…"}
        </Text>
        {!topupOpen ? (
          <TouchableOpacity style={styles.topupButton} onPress={() => setTopupOpen(true)}>
            <Text style={styles.topupText}>➕ Weka salio</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.topupForm}>
            <TextInput
              style={styles.topupInput}
              keyboardType="number-pad"
              value={amount}
              onChangeText={(v) => setAmount(v.replace(/\D/g, ""))}
              placeholder="TZS"
            />
            <TouchableOpacity style={styles.topupButton} onPress={() => void submitTopup()} disabled={busy}>
              <Text style={styles.topupText}>{busy ? "…" : "Tuma"}</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ padding: 16, gap: 8 }}
        ListEmptyComponent={<Text style={styles.empty}>Hakuna miamala bado.</Text>}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.memo}>{item.memo ?? "Muamala"}</Text>
              <Text style={styles.date}>{new Date(item.at).toLocaleString("sw-TZ")}</Text>
            </View>
            <Text style={[styles.amount, item.amount < 0 ? styles.debit : styles.credit]}>
              {item.amount > 0 ? "+" : ""}
              {item.amount.toLocaleString()}
            </Text>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f9fafb" },
  balanceCard: { backgroundColor: "#15803d", padding: 24, alignItems: "center", gap: 4 },
  balanceLabel: { color: "#bbf7d0" },
  balance: { color: "#fff", fontSize: 32, fontWeight: "900" },
  limit: { color: "#bbf7d0", fontSize: 12 },
  topupButton: { marginTop: 12, backgroundColor: "#fff", borderRadius: 12, paddingVertical: 10, paddingHorizontal: 24 },
  topupText: { color: "#15803d", fontWeight: "800", fontSize: 16 },
  topupForm: { flexDirection: "row", gap: 8, marginTop: 12, alignItems: "center" },
  topupInput: {
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 18,
    minWidth: 120,
    textAlign: "center",
  },
  row: { flexDirection: "row", backgroundColor: "#fff", borderRadius: 12, padding: 14, alignItems: "center" },
  memo: { fontWeight: "600", color: "#111827" },
  date: { fontSize: 12, color: "#9ca3af", marginTop: 2 },
  amount: { fontWeight: "800", fontSize: 16 },
  debit: { color: "#b91c1c" },
  credit: { color: "#15803d" },
  empty: { textAlign: "center", color: "#9ca3af", marginTop: 40 },
});
