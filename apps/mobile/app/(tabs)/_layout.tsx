import { Tabs, usePathname, useRouter } from "expo-router";
import { useState } from "react";
import { NewSessionSheet } from "@/features/sessions/NewSessionSheet";
import { color } from "@/theme";
import { TabBar } from "@/ui";

export default function TabsLayout() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  return (
    <>
      <Tabs
        screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: color.bg } }}
        tabBar={() => (
          <TabBar
            active={pathname.startsWith("/band") ? "band" : "sessions"}
            onPressSessions={() => router.navigate("/")}
            onPressBand={() => router.navigate("/band")}
            onPressFab={() => setSheetOpen(true)}
          />
        )}
      >
        <Tabs.Screen name="index" />
        <Tabs.Screen name="band" />
      </Tabs>
      <NewSessionSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} />
    </>
  );
}
