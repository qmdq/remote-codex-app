const KEEP_SCREEN_ON_KEY = "remote-codex-keep-screen-on";

export const isKeepScreenOnEnabled = (): boolean => uni.getStorageSync(KEEP_SCREEN_ON_KEY) === true;

const applyNativeKeepScreenOn = (enabled: boolean): Promise<void> => new Promise((resolve, reject) => {
  // #ifdef APP-PLUS
  if (typeof uni.setKeepScreenOn !== "function") {
    reject(new Error("当前 App 运行环境不支持屏幕常亮"));
    return;
  }
  uni.setKeepScreenOn({
    keepScreenOn: enabled,
    success: () => resolve(),
    fail: (error) => reject(error),
  });
  // #endif

  // #ifndef APP-PLUS
  resolve();
  // #endif
});

export const applySavedKeepScreenOn = async (): Promise<boolean> => {
  try {
    await applyNativeKeepScreenOn(isKeepScreenOnEnabled());
    return true;
  } catch (error) {
    console.warn("应用屏幕常亮设置失败", error);
    return false;
  }
};

export const setKeepScreenOnPreference = async (enabled: boolean): Promise<boolean> => {
  const previous = isKeepScreenOnEnabled();
  uni.setStorageSync(KEEP_SCREEN_ON_KEY, enabled);

  try {
    await applyNativeKeepScreenOn(enabled);
    return true;
  } catch (error) {
    uni.setStorageSync(KEEP_SCREEN_ON_KEY, previous);
    try {
      await applyNativeKeepScreenOn(previous);
    } catch {
      // Keep the persisted preference consistent even when the native API is unavailable.
    }
    console.warn("设置屏幕常亮失败", error);
    return false;
  }
};
