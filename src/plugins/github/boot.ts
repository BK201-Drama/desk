import { invoke } from "@tauri-apps/api/core";
import { normalizeGithubSnapshot, type GithubSnapshot } from "./model";

/** 启动时预读，供面板首帧同步使用（避免 mount 后先 null 再闪一下） */
let bootSnap: GithubSnapshot | null = null;

export function peekGithubBoot(): GithubSnapshot | null {
  return bootSnap;
}

export async function preloadGithubBoot(): Promise<void> {
  try {
    const raw = await invoke("github_cached");
    if (raw == null) {
      bootSnap = null;
      return;
    }
    bootSnap = normalizeGithubSnapshot(raw);
    bootSnap.cached = true;
    // 预热头像，减少面板出现后头像区再闪一下
    if (bootSnap.avatar_url) {
      const img = new Image();
      img.decoding = "async";
      img.src = bootSnap.avatar_url;
    }
  } catch (e) {
    console.warn("preloadGithubBoot", e);
    bootSnap = null;
  }
}
