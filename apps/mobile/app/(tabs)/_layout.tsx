import { Tabs, usePathname, useRouter } from "expo-router";
import { useState } from "react";
import { useAuth } from "@/features/auth/AuthProvider";
import { NotificationSheet } from "@/features/notifications/NotificationSheet";
import { useNotifications } from "@/features/notifications/NotificationsProvider";
import { NewSessionSheet } from "@/features/sessions/NewSessionSheet";
import { color } from "@/theme";
import { initialOf, TabBar, type TabKey } from "@/ui";

export default function TabsLayout() {
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const { state } = useAuth();
  const { unreadCount, sheetOpen, setSheetOpen } = useNotifications();
  const user = state.status === "authenticated" ? state.user : null;
  const active: TabKey = sheetOpen ? "alerts" : pathname.startsWith("/band") ? "band" : pathname.startsWith("/me") ? "me" : "sessions";
  const go = (tab: TabKey) => {
    if (tab === "alerts") {
      setSheetOpen(!sheetOpen);
      return;
    }
    setSheetOpen(false);
    router.navigate(tab === "sessions" ? "/" : `/${tab}`);
  };
  return (
    <>
      <Tabs
        screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: color.bg } }}
        tabBar={() => (
          <TabBar
            active={active}
            alerts={{ unread: unreadCount }}
            me={{ initial: initialOf(user?.displayName), photoUri: user?.profileImageUrl ?? null }}
            onPressTab={go}
            onPressRecord={() => {
              setSheetOpen(false);
              setNewSessionOpen(true);
            }}
          />
        )}
      >
        <Tabs.Screen name="index" />
        <Tabs.Screen name="band" />
        <Tabs.Screen name="me" />
      </Tabs>
      <NewSessionSheet visible={newSessionOpen} onClose={() => setNewSessionOpen(false)} />
      <NotificationSheet
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onOpenSettings={() => {
          setSheetOpen(false);
          router.push("/notifications?from=sheet");
        }}
      />
    </>
  );
}
