import { Tabs, usePathname, useRouter } from "expo-router";
import { useState } from "react";
import { useAuth } from "@/features/auth/AuthProvider";
import { NewSessionSheet } from "@/features/sessions/NewSessionSheet";
import { color } from "@/theme";
import { initialOf, TabBar, type TabKey } from "@/ui";

export default function TabsLayout() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const { state } = useAuth();
  const user = state.status === "authenticated" ? state.user : null;
  const active: TabKey = pathname.startsWith("/band") ? "band" : pathname.startsWith("/me") ? "me" : "sessions";
  const go = (tab: TabKey) => router.navigate(tab === "sessions" ? "/" : `/${tab}`);
  return (
    <>
      <Tabs
        screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: color.bg } }}
        tabBar={() => (
          <TabBar
            active={active}
            me={{ initial: initialOf(user?.displayName), photoUri: user?.profileImageUrl ?? null }}
            onPressTab={go}
            onPressRecord={() => setSheetOpen(true)}
          />
        )}
      >
        <Tabs.Screen name="index" />
        <Tabs.Screen name="band" />
        <Tabs.Screen name="me" />
      </Tabs>
      <NewSessionSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} />
    </>
  );
}
