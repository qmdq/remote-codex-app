import { reactive } from "vue";

type TabKey = "projects" | "chat" | "events" | "monitor" | "settings";

const tabNavigation = reactive({
  target: null as TabKey | null,
  loading: false,
  leaving: false,
  startedAt: 0,
});

let navigationToken = 0;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

const finishTabNavigation = (token: number) => {
  if (token !== navigationToken || tabNavigation.leaving) return;
  tabNavigation.leaving = true;
  hideTimer = setTimeout(() => {
    if (token !== navigationToken) return;
    tabNavigation.loading = false;
    tabNavigation.leaving = false;
    tabNavigation.target = null;
  }, 180);
};

const clearTimers = () => {
  if (hideTimer != null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (fallbackTimer != null) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
};

export const beginTabNavigation = (key: TabKey) => {
  navigationToken += 1;
  const token = navigationToken;
  clearTimers();
  tabNavigation.target = key;
  tabNavigation.loading = true;
  tabNavigation.leaving = false;
  tabNavigation.startedAt = Date.now();

  fallbackTimer = setTimeout(() => {
    finishTabNavigation(token);
  }, 1800);
};

export const markTabPageMounted = (key: TabKey) => {
  const token = navigationToken;
  if (tabNavigation.target !== key || !tabNavigation.loading) return;
  if (hideTimer != null) clearTimeout(hideTimer);
  const remaining = Math.max(0, 500 - (Date.now() - tabNavigation.startedAt));
  hideTimer = setTimeout(() => finishTabNavigation(token), remaining);
};

export const cancelTabNavigation = () => {
  navigationToken += 1;
  clearTimers();
  tabNavigation.loading = false;
  tabNavigation.leaving = false;
  tabNavigation.target = null;
};

export const tabNavigationState = tabNavigation;
