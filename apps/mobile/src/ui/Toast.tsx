import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { radius, useTheme } from "@/theme";
import { AppText } from "./AppText";

const ToastContext = createContext<{ show: (message: string) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { colors } = useTheme();
  const show = useCallback((msg: string) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(msg);
    timer.current = setTimeout(() => setMessage(""), 1800);
  }, []);
  const value = useMemo(() => ({ show }), [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {message ? (
        <View
          pointerEvents="none"
          style={{ position: "absolute", left: 0, right: 0, bottom: 112, alignItems: "center", zIndex: 40 }}
        >
          <View
            style={{
              backgroundColor: colors.toastBg,
              borderRadius: radius.input,
              paddingVertical: 10,
              paddingHorizontal: 16,
            }}
          >
            <AppText variant="caption" color={colors.toastText}>
              {message}
            </AppText>
          </View>
        </View>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const t = useContext(ToastContext);
  if (!t) throw new Error("useToast must be used within ToastProvider");
  return t;
}
