import type { UploadFileSource } from "./agent";

const readBlobChunk = (file: any, start: number, end: number) => new Promise<string>((resolve, reject) => {
  const reader = new (globalThis as any).FileReader();
  reader.onload = () => {
    const value = String(reader.result || "");
    const comma = value.indexOf(",");
    if (comma < 0) {
      reject(new Error("无法读取文件内容"));
      return;
    }
    resolve(value.slice(comma + 1));
  };
  reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
  reader.readAsDataURL(file.slice(start, end));
});

const fromBlob = (file: any): UploadFileSource => ({
  name: file.name,
  size: file.size,
  readChunkBase64: (start, end) => readBlobChunk(file, start, end),
});

const fromPlusFile = (file: any, name: string): UploadFileSource => {
  let fullBase64: Promise<string> | null = null;
  const readFullBase64 = () => fullBase64 ||= new Promise<string>((resolve, reject) => {
    const runtime = (globalThis as any).plus;
    if (typeof runtime?.io?.FileReader !== "function") {
      reject(new Error("当前 App 环境不支持读取本地文件"));
      return;
    }
    const reader = new runtime.io.FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      const comma = value.indexOf(",");
      if (comma < 0) {
        reject(new Error("无法读取文件内容"));
        return;
      }
      resolve(value.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });

  return {
    name: String(file.name || name || "upload.bin"),
    size: Number(file.size || 0),
    readChunkBase64: async (start, end) => {
      const encoded = await readFullBase64();
      const binary = atob(encoded);
      return btoa(binary.slice(start, end));
    },
  };
};

const fromAppPath = (path: string, name: string) => new Promise<UploadFileSource>((resolve, reject) => {
  const runtime = (globalThis as any).plus;
  if (!runtime?.io?.resolveLocalFileSystemURL) {
    reject(new Error("当前 App 环境不支持读取本地文件"));
    return;
  }
  runtime.io.resolveLocalFileSystemURL(path, (entry: any) => {
    entry.file((file: any) => resolve(fromPlusFile(file, file.name || name)), reject);
  }, reject);
});

const chooseAppFile = () => new Promise<UploadFileSource>((resolve, reject) => {
  const api = uni as any;
  if (typeof api.chooseFile !== "function") {
    reject(new Error("当前 App 版本不支持文件选择"));
    return;
  }
  api.chooseFile({
    count: 1,
    type: "all",
    success: (result: any) => {
      const selected = Array.isArray(result?.tempFiles) ? result.tempFiles[0] : result?.tempFiles;
      const rawPaths = result?.tempFilePaths;
      const fallbackPath = Array.isArray(rawPaths) ? rawPaths[0] : rawPaths;
      const path = String(selected?.path || fallbackPath || "").trim();
      const name = String(
        selected?.name || (path ? path.split(/[\\/]/).pop() : "") || "upload.bin",
      );
      if (!path) {
        reject(new Error("系统没有返回文件路径"));
        return;
      }
      fromAppPath(path, name)
        .then((source) => resolve({
          ...source,
          size: Number(selected?.size || source.size || 0),
        }))
        .catch((error) => reject(error instanceof Error ? error : new Error("无法读取所选文件")));
    },
    fail: (error: any) => reject(new Error(error?.errMsg || error?.message || "文件选择失败")),
  });
});

export const chooseUploadSource = () => new Promise<UploadFileSource>((resolve, reject) => {
  // #ifdef MP-WEIXIN
  const wxApi = (globalThis as any).wx;
  wxApi.chooseMessageFile({
    count: 1,
    type: "all",
    success: (result: any) => {
      const file = result.tempFiles?.[0];
      if (!file) {
        reject(new Error("没有选择文件"));
        return;
      }
      const manager = wxApi.getFileSystemManager();
      resolve({
        name: file.name,
        size: file.size,
        readChunkBase64: (start, end) => new Promise<string>((chunkResolve, chunkReject) => {
          manager.readFile({
            filePath: file.path,
            position: start,
            length: end - start,
            encoding: "base64",
            success: (data: any) => chunkResolve(data.data),
            fail: chunkReject,
          });
        }),
      });
    },
    fail: reject,
  });
  // #endif

  // #ifdef H5
  const api = uni as any;
  if (typeof api.chooseFile === "function") {
    api.chooseFile({
      count: 1,
      success: (result: any) => {
        const file = result.tempFiles?.[0]?.file || result.tempFiles?.[0];
        if (!file?.slice || typeof file.size !== "number") {
          reject(new Error("浏览器没有返回可读取的文件"));
          return;
        }
        resolve(fromBlob(file));
      },
      fail: reject,
    });
  } else {
    const document = (globalThis as any).document;
    if (!document?.createElement) {
      reject(new Error("当前 H5 运行环境不支持文件选择"));
    } else {
      const input = document.createElement("input");
      input.type = "file";
      input.style.display = "none";
      input.onchange = () => {
        const file = input.files?.[0];
        input.remove();
        if (!file) {
          reject(new Error("取消选择文件"));
          return;
        }
        resolve(fromBlob(file));
      };
      document.body?.appendChild(input);
      input.click();
    }
  }
  // #endif

  // #ifdef APP-PLUS
  chooseAppFile().then(resolve, reject);
  // #endif
});
