<script setup lang="ts">
import { computed, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import { agent } from "../../utils/agent";
import { parseMarkdown } from "../../utils/markdown";
import { setTheme, syncTheme, theme, themeClass } from "../../utils/theme";

interface FileEntry {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number;
}

interface LoadedFile {
  path: string;
  name: string;
  kind: "text" | "image" | "binary";
  mime: string;
  size: number;
  truncated: boolean;
  content: string;
  dataUrl: string;
}

const entries = ref<FileEntry[]>([]);
const currentPath = ref("");
const rootName = ref("项目");
const loading = ref(false);
const notice = ref("");
const file = ref<LoadedFile | null>(null);
const editing = ref(false);
const draftContent = ref("");
const saving = ref(false);
const dirty = computed(() => editing.value && draftContent.value !== (file.value?.content || ""));
const loadedProjectId = ref("");
const textLines = computed(() => file.value?.kind === "text" ? file.value.content.split(/\r?\n/) : []);
const markdownPreview = computed(() => Boolean(file.value && /\.(md|markdown)$/i.test(file.value.name)));
const htmlPreview = computed(() => Boolean(file.value && /\.(html?|xhtml)$/i.test(file.value.name)));
const previewBlocks = computed(() => markdownPreview.value ? parseMarkdown(file.value?.content || "") : []);
const uploading = ref(false);
const cancelUpload = ref(false);
const uploadProgress = ref({ name: "", received: 0, total: 0 });
let uploadTask: UniApp.UploadTask | null = null;
const uploadPercent = computed(() => uploadProgress.value.total
  ? Math.min(100, Math.round(uploadProgress.value.received / uploadProgress.value.total * 100))
  : 100);

const breadcrumb = computed(() => {
  const parts = currentPath.value ? currentPath.value.split("/").filter(Boolean) : [];
  return [{ name: rootName.value, path: "" }, ...parts.map((name, index) => ({
    name,
    path: parts.slice(0, index + 1).join("/"),
  }))];
});

const formatSize = (size: number) => {
  if (!size) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
};

const showError = (message: string, duration = 6000) => {
  notice.value = message;
  setTimeout(() => {
    notice.value = "";
  }, duration);
};

const loadDirectory = async (path = currentPath.value) => {
  if (!agent.selectedProject) {
    showError("请先选择项目");
    return;
  }
  loading.value = true;
  file.value = null;
  try {
    const result = await agent.listFiles(path);
    currentPath.value = result.path;
    entries.value = result.entries;
  } catch (error: any) {
    showError(error?.message || "目录加载失败");
  } finally {
    loading.value = false;
  }
};

const openPath = async (path: string) => {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
  if (!normalized || normalized.includes("..")) return;
  const parts = normalized.split("/").filter(Boolean);
  const name = parts.pop();
  if (!name) return;
  const parent = parts.join("/");
  await loadDirectory(parent);
  const entry = entries.value.find((item) => item.type === "file" && item.name === name);
  if (entry) await openEntry(entry);
  else showError("文件不在当前项目中");
};

const openEntry = async (entry: FileEntry) => {
  if (entry.type === "directory") {
    await loadDirectory(entry.path);
    return;
  }
  loading.value = true;
  try {
    const result = await agent.readFile(entry.path, 320 * 1024);
    file.value = result;
    editing.value = false;
    draftContent.value = result.kind === "text" ? result.content : "";
  } catch (error: any) {
    showError(error?.message || "文件读取失败");
  } finally {
    loading.value = false;
  }
};

const startEditing = () => {
  if (!file.value || file.value.kind !== "text") return;
  draftContent.value = file.value.content;
  editing.value = true;
};

const cancelEditing = () => {
  if (dirty.value) {
    uni.showModal({
      title: "放弃修改？",
      content: "未保存的内容会丢失。",
      confirmText: "放弃",
      success: (result) => {
        if (result.confirm) {
          draftContent.value = file.value?.content || "";
          editing.value = false;
        }
      },
    });
    return;
  }
  editing.value = false;
};

const saveEditing = async () => {
  if (!file.value || file.value.kind !== "text" || saving.value) return;
  saving.value = true;
  try {
    await agent.writeFile(file.value.path, draftContent.value);
    const refreshed = await agent.readFile(file.value.path, 320 * 1024);
    file.value = refreshed;
    draftContent.value = refreshed.content;
    editing.value = false;
    await loadDirectory(currentPath.value);
    showError("文件已保存");
  } catch (error: any) {
    showError(error?.message || "文件保存失败");
  } finally {
    saving.value = false;
  }
};

const goBreadcrumb = async (path: string) => {
  if (editing.value && dirty.value) {
    const result = await new Promise<boolean>((resolve) => {
      uni.showModal({
        title: "放弃修改？",
        content: "未保存的内容会丢失。",
        confirmText: "放弃",
        success: (modal) => resolve(modal.confirm),
        fail: () => resolve(false),
      });
    });
    if (!result) return;
  }
  editing.value = false;
  if (file.value || entries.value) {
    await loadDirectory(path);
  }
};

interface PickedUpload {
  path: string;
  name: string;
  size: number;
}

const getUploadEndpoint = () => {
  if (!agent.selectedProject) {
    throw new Error("请先选择项目");
  }
  if (!agent.previewInfo || !agent.settings.token) {
    throw new Error("当前服务未提供文件上传");
  }
  return {
    url: `http://${agent.previewInfo.host}:${agent.previewInfo.port}/upload`,
    token: agent.settings.token,
    projectId: agent.selectedProject.id,
  };
};

interface NativeChosenFile {
  name?: string;
  path?: string;
  pathHolp?: string;
  pathHelp?: string;
  size?: string | number;
  sizeHolp?: string | number;
  type?: string;
}

const normalizeAppFilePath = (value: unknown) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^file:\/\//i.test(raw)) return raw;
  return `file://${raw.startsWith("/") ? "" : "/"}${raw}`;
};

const parseAppFileSize = (file: NativeChosenFile) => {
  const rawBytes = Number(file?.sizeHolp ?? file?.size);
  if (Number.isFinite(rawBytes) && rawBytes > 0) return Math.round(rawBytes);

  const sizeText = String(file?.size || "").trim().toUpperCase();
  const match = sizeText.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/);
  if (!match) return 0;

  const units = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 } as const;
  return Math.round(Number(match[1]) * units[match[2] as keyof typeof units]);
};

const chooseUploadFile = () => new Promise<PickedUpload>((resolve, reject) => {
  // #ifdef APP-PLUS
  const picker = (uni as any).requireNativePlugin?.("Aq-ChooseFile");
  if (!picker || typeof picker.openMode !== "function") {
    reject(new Error("文件选择插件未配置，请重新打包 App"));
    return;
  }

  picker.openMode({
    size: "1",
    types: [
      { name: "文档", value: ["doc", "wps", "docx", "xls", "xlsx", "pdf"] },
      { name: "视频", value: ["mp4"] },
      { name: "音乐", value: ["mp3", "flac"] },
      { name: "图片", value: ["jpg", "png"] },
    ],
  }, (result: any) => {
    const item = (Array.isArray(result?.res) ? result.res[0] : result?.res) as NativeChosenFile | undefined;
    if (!item) {
      reject(new Error(result?.code && result.code !== "success" ? "未选择文件" : "系统没有返回文件"));
      return;
    }

    const directPath = String(item.pathHolp || item.pathHelp || "").trim();
    const rawPath = directPath || String(item.path || "").trim();
    const path = directPath || normalizeAppFilePath(rawPath);
    const name = String(item.name || (path ? path.split(/[\\/]/).pop() : "") || "upload.bin")
      .replace(/[\\/]/g, "_")
      .trim();

    if (!rawPath) {
      reject(new Error("系统没有返回文件路径"));
      return;
    }

    resolve({ path, name, size: parseAppFileSize(item) });
  });
  return;
  // #endif

  // #ifndef APP-PLUS
  uni.chooseFile({
    count: 1,
    type: "all",
    success: (result: any) => {
      const paths = Array.isArray(result?.tempFilePaths) ? result.tempFilePaths : [];
      const files = Array.isArray(result?.tempFiles) ? result.tempFiles : [];
      const raw = files[0] || {};
      const path = String(raw.path || paths[0] || "").trim();
      const name = String(raw.name || (path ? path.split(/[\\/]/).pop() : "") || "upload.bin")
        .replace(/[\\/]/g, "_")
        .trim();
      const size = Number(raw.size || 0);
      if (!path) {
        reject(new Error("系统没有返回文件路径"));
        return;
      }
      resolve({ path, name, size });
    },
    fail: (error: any) => reject(new Error(error?.errMsg || error?.message || "文件选择失败")),
  });
  // #endif
});

const performUpload = (picked: PickedUpload, overwrite: boolean) => new Promise<void>((resolve, reject) => {
  const name = picked.name;
  if (!name || name === "." || name === "..") {
    reject(new Error("文件名无效"));
    return;
  }
  let endpoint: { url: string; token: string; projectId: string };
  try {
    endpoint = getUploadEndpoint();
  } catch (error: any) {
    reject(error);
    return;
  }

  const targetPath = currentPath.value ? `${currentPath.value}/${name}` : name;
  cancelUpload.value = false;
  uploadProgress.value = { name, received: 0, total: picked.size };

  const options: any = {
    url: endpoint.url,
    filePath: picked.path,
    name: "file",
    header: { "X-Device-Token": endpoint.token },
    formData: {
      project_id: endpoint.projectId,
      path: targetPath,
      overwrite: overwrite ? "true" : "false",
    },
    success: (response: any) => {
      let data: any = null;
      try {
        data = JSON.parse(response.data);
      } catch {
        data = null;
      }
      if (response.statusCode >= 200 && response.statusCode < 300) {
        resolve();
        return;
      }
      const error: any = new Error(data?.message || `上传失败 (${response.statusCode})`);
      if (data?.code) error.code = data.code;
      reject(error);
    },
    fail: (error: any) => {
      const message = String(error?.errMsg || error?.message || "");
      reject(new Error(/abort|cancel/i.test(message) ? "已取消上传" : (message || "文件上传失败")));
    },
  };
  const task = uni.uploadFile(options);

  uploadTask = task || null;
  if (task && typeof task.onProgressUpdate === "function") {
    task.onProgressUpdate((progress: any) => {
      uploadProgress.value = {
        ...uploadProgress.value,
        received: Number(progress?.totalBytesSent || 0),
        total: Number(progress?.totalBytesExpectedToSend || picked.size),
      };
    });
  }
});

const upload = async (picked: PickedUpload, overwrite = false) => {
  uploading.value = true;
  try {
    await performUpload(picked, overwrite);
    file.value = null;
    editing.value = false;
    draftContent.value = "";
    await loadDirectory(currentPath.value);
    showError("文件上传完成");
  } catch (error: any) {
    if (error?.code === "file.exists" && !overwrite) {
      uploading.value = false;
      const confirmation = await new Promise<boolean>((resolve) => {
        uni.showModal({
          title: "文件已存在",
          content: `是否覆盖 ${picked.name}？`,
          confirmText: "覆盖",
          success: (result) => resolve(result.confirm),
          fail: () => resolve(false),
        });
      });
      if (confirmation) {
        await upload(picked, true);
      }
      return;
    }
    if (!cancelUpload.value) showError(error?.message || "文件上传失败");
  } finally {
    uploading.value = false;
    uploadTask = null;
  }
};

const chooseAndUpload = async () => {
  if (uploading.value) return;
  try {
    const picked = await chooseUploadFile();
    if (!picked.name || picked.name === "." || picked.name === "..") {
      showError("文件名无效");
      return;
    }
    await upload(picked);
  } catch (error: any) {
    const message = String(error?.message || "");
    if (!/cancel|取消/i.test(message)) showError(message || "文件选择失败", 10000);
  }
};

const stopUpload = () => {
  cancelUpload.value = true;
  if (uploadTask && typeof uploadTask.abort === "function") {
    uploadTask.abort();
    uploadTask = null;
  }
};

const openWebPreview = () => {
  if (!file.value) return;
  try {
    const url = agent.getPreviewUrl(file.value.path);
    uni.navigateTo({
      url: `/pages/webview/webview?url=${encodeURIComponent(url)}&title=${encodeURIComponent(file.value.name)}`,
    });
  } catch (error: any) {
    showError(error?.message || "网页预览不可用");
  }
};

const toggleTheme = () => {
  setTheme(theme.value === "dark" ? "light" : "dark");
};

onShow(() => {
  syncTheme();
  rootName.value = agent.selectedProject?.name || "项目";
  if (agent.selectedProject?.id !== loadedProjectId.value) {
    loadedProjectId.value = agent.selectedProject?.id || "";
    currentPath.value = "";
    entries.value = [];
    file.value = null;
  }
  if (agent.state === "online" && agent.selectedProject) {
    const pending = uni.getStorageSync("remote-codex-pending-file") as string;
    if (pending) {
      uni.removeStorageSync("remote-codex-pending-file");
      openPath(pending);
    } else {
      loadDirectory(currentPath.value);
    }
  } else {
    showError("请先连接并选择项目");
  }
});
</script>

<template>
  <view class="screen" :class="themeClass">
    <view class="browser-head">
      <view class="browser-title-wrap">
        <text class="browser-title">文件</text>
        <text class="browser-subtitle">直接预览</text>
      </view>
      <view class="breadcrumb">
        <text
          v-for="item in breadcrumb"
          :key="item.path || '__root__'"
          class="crumb"
          :class="{ active: item.path === currentPath }"
          @click="goBreadcrumb(item.path)"
        >{{ item.name }}</text>
      </view>
      <view class="browser-actions">
        <button class="action upload-action" :disabled="uploading" @click="chooseAndUpload">上传</button>
        <button class="action" @click="loadDirectory">刷新</button>
        <button class="theme-toggle" @click="toggleTheme">{{ theme === "dark" ? "浅色" : "深色" }}</button>
      </view>
    </view>

    <view v-if="uploading" class="upload-progress">
      <view class="upload-progress-head">
        <text class="upload-name">正在上传 {{ uploadProgress.name }}</text>
        <button class="cancel-upload" @click="stopUpload">取消</button>
      </view>
      <view class="progress-track"><view class="progress-value" :style="{ width: `${uploadPercent}%` }" /></view>
      <text class="progress-label mono">{{ formatSize(uploadProgress.received) }} / {{ formatSize(uploadProgress.total) }} · {{ uploadPercent }}%</text>
    </view>

    <view v-if="loading" class="state loading-veil">
      <view class="loading-orbit pulse" />
      <text class="loading-text">正在读取</text>
    </view>

    <view v-if="file" class="preview">
      <view class="preview-head">
        <view class="preview-title-wrap">
          <text class="preview-name">{{ file.name }}</text>
          <text class="preview-kind">直接预览 · {{ file.kind === "text" ? "文本" : file.kind === "image" ? "图片" : "文件" }}</text>
        </view>
        <view class="preview-actions">
          <button v-if="file.kind === 'text' && htmlPreview" class="action web-action" @click="openWebPreview">网页</button>
          <button v-if="file.kind === 'text' && !editing" class="action edit-action" @click="startEditing">编辑</button>
          <button v-if="editing" class="action" :disabled="saving" @click="cancelEditing">取消</button>
          <button v-if="editing" class="action save-action" :disabled="saving || !dirty" @click="saveEditing">{{ saving ? "保存中" : "保存" }}</button>
          <button class="action" @click="goBreadcrumb(currentPath)">关闭</button>
        </view>
      </view>
      <text v-if="file.truncated" class="preview-note">内容较大，已截断显示。</text>

      <image
        v-if="file.kind === 'image' && file.dataUrl"
        class="image-preview"
        :src="file.dataUrl"
        mode="widthFix"
      />
      <view v-else-if="file.kind === 'text' && markdownPreview && !editing" class="markdown-preview">
        <block v-for="(block, index) in previewBlocks" :key="index">
          <rich-text v-if="block.type === 'paragraph'" class="preview-paragraph" :nodes="block.html" />
          <rich-text v-else-if="block.type === 'heading'" class="preview-heading" :class="`heading-${block.level}`" :nodes="block.html" />
          <view v-else-if="block.type === 'list'" class="preview-list">
            <view v-for="(item, itemIndex) in block.items" :key="itemIndex" class="preview-list-item">
              <text class="list-marker">{{ block.ordered ? `${itemIndex + 1}.` : "•" }}</text>
              <rich-text :nodes="item" />
            </view>
          </view>
          <rich-text v-else-if="block.type === 'quote'" class="preview-quote" :nodes="block.html" />
          <scroll-view v-else class="preview-code-scroll" scroll-x>
            <view class="preview-code">
              <text v-if="block.language" class="preview-language mono">{{ block.language }}</text>
              <text class="preview-code-text mono">{{ block.text }}</text>
            </view>
          </scroll-view>
        </block>
      </view>
      <textarea
        v-if="file.kind === 'text' && editing"
        v-model="draftContent"
        class="editor mono"
        :maxlength="-1"
        auto-height
        placeholder="开始编辑文件…"
      />
      <view v-else-if="file.kind === 'text'" class="code">
        <view v-for="(line, index) in textLines" :key="index" class="code-line">
          <text class="line-no mono">{{ index + 1 }}</text>
          <text class="line-text mono">{{ line || " " }}</text>
        </view>
      </view>
      <view v-else class="binary-preview">
        <text class="binary-title">该文件类型暂不支持直接预览</text>
        <text class="binary-meta mono">{{ file.mime }} · {{ formatSize(file.size) }}</text>
      </view>
    </view>

    <view v-else class="entries">
      <view
        v-for="entry in entries"
        :key="entry.path"
        class="entry"
        @click="openEntry(entry)"
      >
        <view class="entry-icon" :class="entry.type">{{ entry.type === "directory" ? "D" : "F" }}</view>
        <view class="entry-main">
          <text class="entry-name">{{ entry.name }}</text>
          <text class="entry-meta mono">{{ entry.type === "directory" ? "目录" : formatSize(entry.size) }}</text>
        </view>
        <text class="entry-arrow">›</text>
      </view>
      <view v-if="!entries.length && !loading" class="state">目录为空。</view>
    </view>

    <text v-if="notice" class="notice">{{ notice }}</text>
  </view>
</template>

<style>
.screen {
  min-height: calc(100vh - var(--window-top, 0px) - var(--window-bottom, 0px));
  padding: 10px 10px 24px;
  box-sizing: border-box;
}
.browser-head {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 9px;
  padding: 10px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 10px;
  background: #101728;
}
.browser-title-wrap {
  flex: none;
  min-width: 55px;
}
.browser-title,
.browser-subtitle {
  display: block;
}
.browser-title {
  color: #e7ecf5;
  font-size: 14px;
  font-weight: 700;
}
.browser-subtitle {
  margin-top: 1px;
  color: #67738f;
  font-size: 9px;
}
.breadcrumb {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  align-items: center;
  overflow-x: auto;
  white-space: nowrap;
}
.crumb {
  flex: none;
  max-width: 150px;
  overflow: hidden;
  color: #8b93a7;
  font-size: 12px;
  text-overflow: ellipsis;
}
.crumb.active {
  color: #f0a06a;
}
.browser-actions,
.preview-head {
  display: flex;
  align-items: center;
  gap: 9px;
}
.upload-action {
  border-color: rgba(232, 112, 58, 0.35);
  color: #f0a06a;
}
.web-action {
  border-color: rgba(129, 140, 248, 0.35);
  color: #a5b4fc;
}
.upload-progress {
  margin-top: 9px;
  padding: 10px 12px;
  border: 1px solid rgba(232, 112, 58, 0.22);
  border-radius: 8px;
  background: rgba(232, 112, 58, 0.06);
}
.upload-progress-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.upload-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: #e7ecf5;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cancel-upload {
  flex: none;
  color: #f87171;
  font-size: 11px;
}
.progress-track {
  height: 4px;
  margin-top: 9px;
  overflow: hidden;
  border-radius: 2px;
  background: rgba(120, 132, 155, 0.2);
}
.progress-value {
  height: 100%;
  border-radius: 2px;
  background: #e8703a;
  transition: width 0.18s ease;
}
.progress-label {
  display: block;
  margin-top: 6px;
  color: #8b93a7;
  font-size: 10px;
}
.browser-actions {
  flex: none;
}
.action {
  height: 27px;
  padding: 0 10px;
  border: 1px solid #253353;
  border-radius: 99px;
  background: #101728;
  color: #a9b7d3;
  font-size: 11px;
  line-height: 25px;
}
.theme-toggle {
  height: 27px;
  padding: 0 9px;
  border: 1px solid rgba(232, 112, 58, 0.3);
  border-radius: 99px;
  background: rgba(232, 112, 58, 0.08);
  color: #f0a06a;
  font-size: 11px;
  line-height: 25px;
}
.state {
  padding: 34px 16px;
  color: #7d8db0;
  font-size: 13px;
  text-align: center;
}
.entries {
  margin-top: 10px;
}
.entry {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  padding: 10px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  background: #101728;
}
.entry-icon {
  width: 28px;
  height: 28px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 700;
}
.entry-icon.directory {
  background: rgba(56, 189, 248, 0.12);
  color: #7dd3fc;
}
.entry-icon.file {
  background: rgba(240, 160, 106, 0.12);
  color: #f0a06a;
}
.entry-main {
  flex: 1 1 0;
  min-width: 0;
}
.entry-name,
.entry-meta {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entry-name {
  color: #e7ecf5;
  font-size: 13px;
}
.entry-meta {
  margin-top: 3px;
  color: #67738f;
  font-size: 10px;
}
.entry-arrow {
  flex: none;
  color: #4f5c76;
}
.preview {
  margin-top: 10px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 10px;
  background: #0e1526;
  overflow: hidden;
}
.preview-head {
  padding: 9px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.preview-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.edit-action {
  border-color: rgba(56, 189, 248, 0.34);
  color: #7dd3fc;
}
.save-action {
  border-color: rgba(140, 230, 176, 0.38);
  background: rgba(140, 230, 176, 0.08);
  color: #8ce6b0;
}
.preview-title-wrap {
  flex: 1 1 0;
  min-width: 0;
}
.preview-name {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  color: #e7ecf5;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview-kind {
  display: block;
  margin-top: 2px;
  color: #67738f;
  font-size: 9px;
}
.preview-note {
  display: block;
  padding: 8px 10px 0;
  color: #fbbf24;
  font-size: 11px;
}
.image-preview {
  width: 100%;
}
.code {
  padding: 8px 0;
}
.editor {
  display: block;
  width: 100%;
  min-height: 420px;
  padding: 13px;
  box-sizing: border-box;
  border: 0;
  outline: none;
  background: #0b1020;
  color: #d8e0ef;
  font-size: 11px;
  line-height: 1.65;
  white-space: pre;
}
.markdown-preview {
  padding: 12px;
  color: #d8e0ef;
  font-size: 13px;
  line-height: 1.7;
}
.preview-paragraph {
  display: block;
  margin: 0 0 9px;
}
.preview-heading {
  display: block;
  margin: 12px 0 7px;
  color: #f3f6fb;
  font-weight: 700;
}
.heading-1 { font-size: 20px; }
.heading-2 { font-size: 17px; }
.heading-3 { font-size: 15px; }
.heading-4,
.heading-5,
.heading-6 { font-size: 13px; }
.preview-list {
  margin: 6px 0 10px;
}
.preview-list-item {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin: 4px 0;
}
.list-marker {
  flex: none;
  color: #e8703a;
}
.preview-quote {
  display: block;
  margin: 8px 0;
  padding-left: 10px;
  border-left: 2px solid #e8703a;
  color: #8b93a7;
}
.preview-code-scroll {
  margin: 8px 0;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: #0b1020;
}
.preview-code {
  min-width: 100%;
  padding: 10px;
  box-sizing: border-box;
}
.preview-language {
  display: block;
  margin-bottom: 5px;
  color: #e0a77b;
  font-size: 10px;
}
.preview-code-text {
  display: block;
  color: #d8e0ef;
  font-size: 11px;
  line-height: 1.65;
  white-space: pre;
}
.code-line {
  display: flex;
  width: 100%;
  gap: 9px;
  padding: 1px 9px;
}
.line-no {
  width: 30px;
  flex: none;
  text-align: right;
  color: #4f5c76;
  font-size: 10px;
  line-height: 18px;
}
.line-text {
  flex: 1 1 0;
  min-width: 0;
  overflow-x: auto;
  color: #d8e0ef;
  font-size: 10px;
  line-height: 18px;
  white-space: pre;
}
.notice {
  display: block;
  margin-top: 10px;
  padding: 8px 12px;
  border: 1px solid #33436e;
  border-radius: 99px;
  background: #1b2540;
  color: #dbe4f5;
  font-size: 11px;
  text-align: center;
}
.binary-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 42px 18px;
  text-align: center;
}
.binary-title {
  color: #e7ecf5;
  font-size: 13px;
}
.binary-meta {
  color: #8b93a7;
  font-size: 10px;
}
.theme-light .upload-name,
.theme-light .preview-heading,
.theme-light .browser-title,
.theme-light .preview-kind {
  color: var(--text-primary);
}
.theme-light .browser-subtitle,
.theme-light .preview-kind {
  color: var(--text-secondary);
}
.theme-light .theme-toggle {
  border-color: rgba(232, 112, 58, 0.3);
  background: rgba(232, 112, 58, 0.08);
  color: #c95f2a;
}
.theme-light .upload-progress {
  border-color: rgba(232, 112, 58, 0.24);
  background: rgba(232, 112, 58, 0.05);
}
.theme-light .markdown-preview,
.theme-light .preview-code-text,
.theme-light .line-text {
  color: #354155;
}
.theme-light .preview-code-scroll,
.theme-light .code {
  background: var(--code-bg);
}
.theme-light .binary-title {
  color: var(--text-primary);
}
.theme-light .binary-meta {
  color: var(--text-secondary);
}
</style>
