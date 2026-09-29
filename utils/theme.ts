import { computed, ref } from "vue";

export type ThemeMode = "dark" | "light";
export type ThemePreference = ThemeMode | "auto";

const THEME_KEY = "remote-codex-theme";
const THEME_MODE_KEY = "remote-codex-theme-mode";

export const theme = ref<ThemeMode>("dark");
export const themeMode = ref<ThemePreference>("dark");
export const themeClass = computed(() => `theme-${theme.value}`);

const systemTheme = (): ThemeMode => {
  const query = (globalThis as any).matchMedia?.("(prefers-color-scheme: light)");
  return query?.matches ? "light" : "dark";
};

export const syncTheme = () => {
  const storedMode = uni.getStorageSync(THEME_MODE_KEY) as ThemePreference;
  themeMode.value = storedMode === "auto" || storedMode === "light" || storedMode === "dark"
    ? storedMode
    : "dark";
  const stored = uni.getStorageSync(THEME_KEY);
  theme.value = themeMode.value === "auto"
    ? systemTheme()
    : stored === "light" ? "light" : "dark";
  syncNativeTheme();
};

export const setTheme = (next: ThemeMode) => {
  theme.value = next;
  themeMode.value = next;
  uni.setStorageSync(THEME_KEY, next);
  uni.setStorageSync(THEME_MODE_KEY, next);
  syncNativeTheme();
};

export const setThemeMode = (next: ThemePreference) => {
  themeMode.value = next;
  uni.setStorageSync(THEME_MODE_KEY, next);
  if (next !== "auto") {
    theme.value = next;
    uni.setStorageSync(THEME_KEY, next);
  } else {
    theme.value = systemTheme();
    uni.setStorageSync(THEME_KEY, theme.value);
  }
  syncNativeTheme();
};

export const startSystemThemeWatcher = () => {
  syncTheme();
  const query = (globalThis as any).matchMedia?.("(prefers-color-scheme: light)");
  const listener = () => {
    if (themeMode.value === "auto") syncTheme();
  };
  if (typeof query?.addEventListener === "function") {
    query.addEventListener("change", listener);
  } else if (typeof query?.addListener === "function") {
    query.addListener(listener);
  }

  // Native App builds do not always expose CSS matchMedia, so listen to UniApp's system theme event too.
  try {
    uni.onThemeChange?.((result: { theme: "dark" | "light" }) => {
      if (themeMode.value !== "auto") return;
      theme.value = result.theme === "light" ? "light" : "dark";
      uni.setStorageSync(THEME_KEY, theme.value);
      syncNativeTheme();
    });
  } catch {
    // Web and older runtimes use the matchMedia listener above.
  }
};

export const syncNativeTheme = () => {
  const light = theme.value === "light";
  const backgroundColor = light ? "#f4f6f9" : "#070a12";
  const foregroundColor = light ? "#000000" : "#ffffff";
  const document = (globalThis as any).document;
  document?.documentElement?.classList.toggle("theme-light", light);
  document?.documentElement?.classList.toggle("theme-dark", !light);
  document?.body?.classList.toggle("theme-light", light);
  document?.body?.classList.toggle("theme-dark", !light);

  try {
    uni.hideTabBar({ animation: false });
  } catch {
    // The liquid tab bar replaces the native bar where supported.
  }
  try {
    uni.setTabBarStyle({
      backgroundColor: light ? "#ffffff" : "#0a0e1a",
      color: light ? "#687386" : "#7e879c",
      selectedColor: "#e8703a",
      borderStyle: light ? "white" : "black",
    });
  } catch {
    // Non-tab pages and some uni-app targets do not expose a tab bar.
  }
  try {
    uni.setNavigationBarColor({
      backgroundColor,
      frontColor: foregroundColor,
    });
  } catch {
    // Web builds manage the navigation bar through CSS.
  }
};
