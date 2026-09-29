import { nextTick, onUnmounted, ref } from "vue";

export const useIosTabTransition = () => {
  const entering = ref(true);
  let active = true;
  let timers: ReturnType<typeof setTimeout>[] = [];

  const clearTimers = () => {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  };

  const replay = () => {
    clearTimers();
    if (!active) return;
    entering.value = false;
    nextTick(() => {
      if (!active) return;
      timers.push(setTimeout(() => {
        if (!active) return;
        entering.value = true;
        timers.push(setTimeout(() => {
          entering.value = false;
        }, 390));
      }, 16));
    });
  };

  onUnmounted(() => {
    active = false;
    clearTimers();
  });

  return { entering, replay };
};
