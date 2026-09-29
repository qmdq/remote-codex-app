<script setup lang="ts">
import { ref } from "vue";
import { onLoad } from "@dcloudio/uni-app";

const url = ref("");
const title = ref("网页预览");

onLoad((query) => {
  url.value = decodeURIComponent(String(query?.url || ""));
  title.value = decodeURIComponent(String(query?.title || "网页预览"));
  uni.setNavigationBarTitle({ title: title.value });
});

const reload = () => {
  const next = url.value;
  url.value = "";
  setTimeout(() => {
    url.value = next;
  }, 60);
};

const close = () => {
  uni.navigateBack();
};
</script>

<template>
  <view class="web-page">
    <view v-if="url" class="web-toolbar">
      <button class="web-action" @click="reload">刷新</button>
      <button class="web-action close" @click="close">关闭</button>
    </view>
    <view v-else class="web-empty">
      <text>预览地址无效</text>
    </view>
    <web-view v-if="url" class="web-view" :src="url" />
  </view>
</template>

<style>
.web-page {
  height: 100vh;
  background: #05070d;
}
.web-toolbar {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 7px 10px;
  background: #0a0e18;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.web-action {
  height: 28px;
  margin: 0;
  padding: 0 11px;
  border: 1px solid #253353;
  border-radius: 99px;
  background: #101728;
  color: #a9b7d3;
  font-size: 11px;
  line-height: 26px;
}
.web-action.close {
  border-color: rgba(248, 113, 113, 0.42);
  color: #f87171;
}
.web-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  color: #8b93a7;
  font-size: 13px;
}
.web-view {
  width: 100%;
  height: calc(100vh - 43px);
}
</style>
