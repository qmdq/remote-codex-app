import type { UploadFileSource } from "./agent";

const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp)$/i;

const readBlobChunk = (file: any, start: number, end: number) => new Promise<string>((resolve, reject) => {
  const reader = new (globalThis as any).FileReader();
  reader.onload = () => {
    const value = String(reader.result || "");
    const comma = value.indexOf(",");
    if (comma < 0) {
      reject(new Error("无法读取图片内容"));
      return;
    }
    resolve(value.slice(comma + 1));
  };
  reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
  reader.readAsDataURL(file.slice(start, end));
});

const fromBlob = (file: any, fallbackName: string): UploadFileSource => ({
  name: String(file.name || fallbackName || "image.jpg"),
  size: Number(file.size || 0),
  readChunkBase64: (start, end) => readBlobChunk(file, start, end),
});

const fromAppPath = (path: string, name: string) => new Promise<UploadFileSource>((resolve, reject) => {
  const runtime = (globalThis as any).plus;
  if (!runtime?.io?.resolveLocalFileSystemURL) {
    reject(new Error("当前 App 环境不支持读取本地图片"));
    return;
  }
  runtime.io.resolveLocalFileSystemURL(path, (entry: any) => {
    entry.file((file: any) => resolve(fromBlob(file, name)), reject);
  }, reject);
});

const fromPlusFile = (file: any, name: string): UploadFileSource => {
  let fullBase64: Promise<string> | null = null;
  const readFullBase64 = () => fullBase64 ||= new Promise<string>((resolve, reject) => {
    const runtime = (globalThis as any).plus;
    if (typeof runtime?.io?.FileReader !== "function") {
      reject(new Error("当前 App 环境不支持读取图片"));
      return;
    }
    const reader = new runtime.io.FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      const comma = value.indexOf(",");
      if (comma < 0) {
        reject(new Error("无法读取图片内容"));
        return;
      }
      resolve(value.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
  return {
    name,
    size: Number(file.size || 0),
    readChunkBase64: async (start, end) => {
      const encoded = await readFullBase64();
      const binary = atob(encoded);
      return btoa(binary.slice(start, end));
    },
  };
};

const extensionOf = (path: string) => path.split("?")[0].split("#")[0].split("/").pop() || "";

export interface SelectedImage extends UploadFileSource {
  localUrl: string;
}

export const chooseImageSource = () => new Promise<SelectedImage>((resolve, reject) => {
  uni.chooseImage({
    count: 1,
    sizeType: ["compressed", "original"],
    sourceType: ["album", "camera"],
    success: (result) => {
      const file = result.tempFiles?.[0] as any;
      const path = String(file?.path || result.tempFilePaths?.[0] || "");
      if (!path) {
        reject(new Error("没有选择图片"));
        return;
      }
      const extension = extensionOf(path) || "jpg";
      const name = `image-${Date.now()}.${extension}`;
      if (!IMAGE_EXTENSIONS.test(name)) {
        reject(new Error("仅支持 JPG、PNG、GIF、WebP、BMP 图片"));
        return;
      }
      if (typeof file?.size === "number" && (file.size < 0 || file.size > 20 * 1024 * 1024)) {
        reject(new Error("图片不能超过 20 MB"));
        return;
      }
      if (typeof file?.slice === "function") {
        resolve({ ...fromBlob(file, name), localUrl: path });
        return;
      }
      if (file && typeof file.size === "number") {
        resolve({ ...fromPlusFile(file, name), localUrl: path });
        return;
      }
      fromAppPath(path, name)
        .then((source) => resolve({ ...source, localUrl: path }))
        .catch(reject);
    },
    fail: (error: any) => reject(new Error(error?.errMsg || "图片选择失败")),
  });
});
