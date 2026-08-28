import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>bandapp</Text>
      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#111214",
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    color: "#e8e8e8",
    fontSize: 24,
  },
});
