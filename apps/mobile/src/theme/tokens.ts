import type { TextStyle } from "react-native";

export const color = {
  bg: "#0B0C0E",
  bgDeep: "#08090A",
  surface: "#15171B",
  surfaceSunken: "#0F1114",
  surfaceRaised: "#1A1C20",
  toastBg: "#22252B",
  toastText: "#E8EAEE",
  border: "#1D2025",
  borderStrong: "#23262B",
  borderStronger: "#2A2D33",
  borderHover: "#3A3E45",
  text: "#F2F3F5",
  textSecondary: "#C6CAD1",
  textMuted: "#8A8F98",
  textFaint: "#5A5F68",
  recording: "#FF4545",
  danger: "#E0736B",
  tabBarBg: "rgba(11,12,14,0.92)",
} as const;

export const accentOptions = ["#5B9DFF", "#4ADE80", "#FFB454", "#FF5C5C"] as const;

export const font = {
  mono: "JetBrainsMono_400Regular",
  monoMedium: "JetBrainsMono_500Medium",
  monoSemiBold: "JetBrainsMono_600SemiBold",
} as const;

export const space = { screenX: 24, sheetX: 16, sheetTop: 14, sheetBottom: 44 } as const;

export const radius = { chipSm: 9, input: 10, row: 12, chipLg: 16, sheet: 20 } as const;

export type TypeVariant =
  | "titleXL" | "title" | "heading" | "itemTitle" | "sheetTitle" | "rowTitle"
  | "body" | "caption" | "small"
  | "monoLabel" | "monoMeta" | "monoTimer" | "monoAvatar";

export const type: Record<TypeVariant, TextStyle> = {
  titleXL: { fontSize: 32, fontWeight: "700", letterSpacing: -0.3, color: color.text },
  title: { fontSize: 26, fontWeight: "700", letterSpacing: -0.3, color: color.text },
  heading: { fontSize: 22, fontWeight: "700", color: color.text },
  itemTitle: { fontSize: 20, fontWeight: "600", letterSpacing: -0.2, color: color.text },
  sheetTitle: { fontSize: 17, fontWeight: "600", color: color.text },
  rowTitle: { fontSize: 15, fontWeight: "600", color: color.text },
  body: { fontSize: 14, color: color.textSecondary },
  caption: { fontSize: 13, color: color.textMuted },
  small: { fontSize: 12, color: color.textFaint },
  monoLabel: { fontFamily: font.mono, fontSize: 11, letterSpacing: 1.5, color: color.textFaint },
  monoMeta: { fontFamily: font.mono, fontSize: 12, color: color.textMuted },
  monoTimer: { fontFamily: font.monoMedium, fontSize: 52, letterSpacing: 1.5, color: color.text },
  monoAvatar: { fontFamily: font.mono, fontSize: 14, color: color.textSecondary },
};
