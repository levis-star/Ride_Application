import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { api } from "../api";

interface Earnings {
  day: { trips: number; gross: number; earnings: number };
  week: { trips: number; gross: number; earnings: number };
}

function Block({ title, data }: { title: string; data?: { trips: number; gross: number; earnings: number } }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.big}>TZS {data?.earnings.toLocaleString() ?? "…"}</Text>
      <View style={styles.row}>
        <Text style={styles.sub}>Safari: {data?.trips ?? "…"}</Text>
        <Text style={styles.sub}>Jumla (na kamisheni): TZS {data?.gross.toLocaleString() ?? "…"}</Text>
      </View>
    </View>
  );
}

export default function EarningsScreen() {
  const [earnings, setEarnings] = useState<Earnings | null>(null);

  useEffect(() => {
    void api<Earnings>("GET", "/drivers/me/earnings").then(setEarnings).catch(() => {});
  }, []);

  return (
    <View style={styles.container}>
      <Block title="Leo" data={earnings?.day} />
      <Block title="Wiki hii" data={earnings?.week} />
      <Text style={styles.note}>Mapato = nauli ukiondoa kamisheni na ada ya kuagiza.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f9fafb", padding: 16, gap: 12 },
  card: { backgroundColor: "#fff", borderRadius: 16, padding: 20, elevation: 2 },
  title: { color: "#6b7280", fontWeight: "600" },
  big: { fontSize: 30, fontWeight: "900", color: "#15803d", marginVertical: 4 },
  row: { flexDirection: "row", justifyContent: "space-between" },
  sub: { color: "#6b7280", fontSize: 13 },
  note: { color: "#9ca3af", fontSize: 12, textAlign: "center", marginTop: 8 },
});
