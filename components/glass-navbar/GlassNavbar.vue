<template>
  <view class="glass-nav" :class="themeClass">
    <view class="glass-material" />
    <view class="glass-content">
      <view class="glass-copy">
        <text class="glass-title">{{ title }}</text>
        <text v-if="subtitle" class="glass-subtitle">{{ subtitle }}</text>
      </view>
      <view v-if="$slots.right" class="glass-right">
        <slot name="right" />
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
defineProps<{
  title: string;
  subtitle?: string;
  themeClass?: string;
}>();
</script>

<style>
.glass-nav {
  --glass-top: calc(var(--status-bar-height, 0px) + env(safe-area-inset-top, 0px));
  position: fixed;
  top: 0;
  right: 0;
  left: 0;
  z-index: 998;
  padding-top: var(--glass-top);
}

.glass-material {
  position: absolute;
  inset: var(--glass-top) 0 0;
  overflow: hidden;
  background:
    linear-gradient(118deg, rgba(255, 255, 255, 0.16) 0%, rgba(255, 255, 255, 0.03) 28%, transparent 48%),
    linear-gradient(180deg, rgba(18, 25, 44, 0.74), rgba(7, 10, 18, 0.64));
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.12),
    inset 0 -12px 24px rgba(255, 255, 255, 0.02),
    0 12px 28px rgba(3, 6, 14, 0.24);
  backdrop-filter: blur(26px) saturate(170%);
  -webkit-backdrop-filter: blur(26px) saturate(170%);
}

.glass-material::before {
  content: "";
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background:
    radial-gradient(120% 58% at 12% -18%, rgba(255, 255, 255, 0.14), transparent 58%),
    radial-gradient(96% 52% at 86% -24%, rgba(125, 211, 252, 0.08), transparent 56%);
  pointer-events: none;
}

.glass-material::after {
  content: "";
  position: absolute;
  top: -46px;
  left: 8%;
  width: 42%;
  height: 104px;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.08), rgba(232, 112, 58, 0.1), transparent);
  filter: blur(18px);
  transform: rotate(12deg);
  pointer-events: none;
}

.glass-content {
  position: relative;
  display: flex;
  width: 100%;
  height: 52px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 16px;
  box-sizing: border-box;
}

.glass-copy {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}

.glass-title {
  overflow: hidden;
  color: #f3f6fc;
  font-size: 17px;
  font-weight: 700;
  line-height: 22px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.glass-subtitle {
  overflow: hidden;
  margin-top: 1px;
  color: rgba(231, 236, 245, 0.62);
  font-size: 10px;
  line-height: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.glass-right {
  flex: none;
  max-width: 42vw;
}

.theme-light.glass-nav .glass-material {
  --light-glass-top: linear-gradient(118deg, rgba(255, 255, 255, 0.82) 0%, rgba(255, 255, 255, 0.2) 32%, transparent 52%);
  --light-glass-base: linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(244, 246, 249, 0.78));
  background:
    var(--light-glass-top),
    var(--light-glass-base);
  border-bottom-color: rgba(24, 39, 61, 0.1);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.88),
    0 10px 26px rgba(24, 39, 61, 0.08);
  backdrop-filter: blur(26px) saturate(150%);
  -webkit-backdrop-filter: blur(26px) saturate(150%);
}

.theme-light.glass-nav .glass-material::before {
  background:
    radial-gradient(120% 58% at 12% -18%, rgba(255, 255, 255, 0.64), transparent 58%),
    radial-gradient(96% 52% at 86% -24%, rgba(56, 189, 248, 0.08), transparent 56%);
}

.theme-light.glass-nav .glass-title {
  color: #202b3c;
}

.theme-light.glass-nav .glass-subtitle {
  color: #66748b;
}
</style>
