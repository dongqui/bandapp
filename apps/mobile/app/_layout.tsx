import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
  JetBrainsMono_600SemiBold,
  useFonts,
} from "@expo-google-fonts/jetbrains-mono";
import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect, type ReactNode } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ApiProvider } from "@/api";
import { AuthProvider, useAuth } from "@/features/auth/AuthProvider";
import { gate } from "@/features/auth/authGate";
import { ThemeProvider, color } from "@/theme";
import { ToastProvider } from "@/ui";

function AuthGate({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    const decision = gate(state.status, segments[0]);
    if (decision) router.replace(decision.redirect);
  }, [state.status, segments, router]);

  if (state.status === "restoring") return null; // 폰트 로딩과 동일한 스플래시 처리
  return <>{children}</>;
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
    JetBrainsMono_600SemiBold,
  });
  if (!fontsLoaded) return null;
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ApiProvider>
          <AuthProvider>
            <AuthGate>
              <ToastProvider>
                <StatusBar style="light" />
                <Stack
                  screenOptions={{
                    headerShown: false,
                    contentStyle: { backgroundColor: color.bg },
                  }}
                />
              </ToastProvider>
            </AuthGate>
          </AuthProvider>
        </ApiProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
