import { Stack } from "expo-router";
import { color } from "@/theme";

export default function BillingLayout() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg } }} />;
}
