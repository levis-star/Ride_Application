import { useEffect, useState } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { api } from "../api";

interface HistoryRow {
  id: string;
  status: string;
  createdAt: string;
  pickupLabel: string;
  dropLabel: string;
  finalFare: number | null;
  estimatedFare: number;
  fareBreakdown: { driverEarnings?: number } | null;
}

export default function HistoryScreen() {
  const [rows, setRows] = useState<HistoryRow[]>([]);

  useEffect(() => {
    void api<HistoryRow[]>("GET", "/trips").then(setRows).catch(() => {});
  }, []);

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={{ padding: 16, gap: 8 }}
      data={rows}
      keyExtractor={(r) => r.id}
      ListEmptyComponent={<Text style={styles.empty}>Hakuna safari bado.</Text>}
      renderItem={({ item }) => (
        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.date}>{new Date(item.createdAt).toLocaleString("sw-TZ")}</Text>
            <Text style={[styles.status, item.status === "COMPLETED" ? styles.ok : styles.other]}>
              {item.status}
            </Text>
          </View>
          <Text style={styles.route}>
            {item.pickupLabel} → {item.dropLabel}
          </Text>
          {item.status === "COMPLETED" && (
            <Text style={styles.fare}>
              Ulipata: TZS {(item.fareBreakdown?.driverEarnings ?? item.finalFare ?? 0).toLocaleString()}
            </Text>
          )}
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f9fafb" },
  card: { backgroundColor: "#fff", borderRadius: 12, padding: 14, gap: 4 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between" },
  date: { fontSize: 12, color: "#9ca3af" },
  status: { fontSize: 11, fontWeight: "700" },
  ok: { color: "#15803d" },
  other: { color: "#9ca3af" },
  route: { fontWeight: "600", color: "#111827" },
  fare: { color: "#15803d", fontWeight: "800" },
  empty: { textAlign: "center", color: "#9ca3af", marginTop: 40 },
});
