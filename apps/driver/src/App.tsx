import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { loadTokens } from "./api";
import LoginScreen from "./screens/LoginScreen";
import OnboardingScreen from "./screens/OnboardingScreen";
import HomeScreen from "./screens/HomeScreen";
import WalletScreen from "./screens/WalletScreen";
import EarningsScreen from "./screens/EarningsScreen";
import HistoryScreen from "./screens/HistoryScreen";

export type RootStackParamList = {
  Login: undefined;
  Onboarding: undefined;
  Home: undefined;
  Wallet: undefined;
  Earnings: undefined;
  History: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    void loadTokens().then((ok) => {
      setAuthed(ok);
      setReady(true);
    });
  }, []);

  if (!ready) {
    return (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <ActivityIndicator size="large" color="#15803d" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      <StatusBar style="dark" />
      <Stack.Navigator
        initialRouteName={authed ? "Home" : "Login"}
        screenOptions={{ headerTintColor: "#15803d", headerTitleStyle: { fontWeight: "700" } }}
      >
        <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
        <Stack.Screen
          name="Onboarding"
          component={OnboardingScreen}
          options={{ title: "Usajili", headerBackVisible: false }}
        />
        <Stack.Screen name="Home" component={HomeScreen} options={{ title: "RukwaRide Dereva", headerBackVisible: false }} />
        <Stack.Screen name="Wallet" component={WalletScreen} options={{ title: "Pochi" }} />
        <Stack.Screen name="Earnings" component={EarningsScreen} options={{ title: "Mapato" }} />
        <Stack.Screen name="History" component={HistoryScreen} options={{ title: "Safari zangu" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
