import type { HostContext, PluginModule } from "../../host/types";
import "./panel.css";

type NowPlaying = {
  active: boolean;
  app_id: string;
  title: string;
  artist: string;
  album: string;
  status: string;
  artwork_path: string | null;
  can_play_pause: boolean;
  can_next: boolean;
  can_prev: boolean;
  installed: boolean;
  install_path: string | null;
  hint: string;
};

let root: HTMLElement | null = null;
let ctxRef: HostContext | null = null;
let timer: number | null = null;
let np: NowPlaying | null = null;
let flash = "";
let lastRenderKey = "";
let artPathCached: string | null = null;
let artBust = 0;
let refreshing = false;

function artUrl(path: string | null): string {
  if (!path || !ctxRef) return "";
  if (path !== artPathCached) {
    artPathCached = path;
    artBust = Date.now();
  }
  try {
    return `${ctxRef.convertFileSrc(path)}?t=${artBust}`;
  } catch {
    return "";
  }
}

function renderKey(d: NowPlaying | null, flashMsg: string): string {
  if (!d) return `empty|${flashMsg}`;
  return [
    d.active ? 1 : 0,
    d.status,
    d.title,
    d.artist,
    d.album,
    d.artwork_path ?? "",
    d.hint,
    flashMsg,
  ].join("\u0001");
}

const ICON_PREV = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2v12H6V6zm3.5 6 8.5 6V6l-8.5 6z"/></svg>`;
const ICON_NEXT = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 6h2v12h-2V6zM6 18l8.5-6L6 6v12z"/></svg>`;
const ICON_PLAY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z"/></svg>`;

function bindControls() {
  if (!root) return;
  root.querySelector("#qqmToggle")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void act("toggle");
  });
  root.querySelector("#qqmNext")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void act("next");
  });
  root.querySelector("#qqmPrev")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void act("prev");
  });
  root.querySelector("#qqmLaunch")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void launchForeground();
  });
}

function render(force = false) {
  if (!root) return;
  const key = renderKey(np, flash);
  if (!force && key === lastRenderKey && root.querySelector(".qqm-card")) return;
  lastRenderKey = key;

  const d = np;
  const playing = d?.status === "playing";
  const art = artUrl(d?.artwork_path ?? null);
  const title = d?.active ? d.title || "未知曲目" : "未在播放";
  const artistLine = d?.active
    ? d.artist || d.album || "QQ 音乐"
    : d?.hint || "连接 QQ 音乐中…";
  const artistTip = d?.active
    ? [d.artist, d.album].filter(Boolean).join(" · ") || artistLine
    : artistLine;

  root.innerHTML = `
    <div class="qqm-card ${playing ? "is-playing" : ""}">
      <button type="button" class="qqm-art" id="qqmLaunch" title="打开 QQ 音乐前台"
        style="${art ? `background-image:url('${art}')` : ""}">
        ${art ? "" : `<span class="qqm-art-fallback">♪</span>`}
      </button>
      <div class="qqm-title" title="${escapeAttr(title)}">${escapeHtml(title)}</div>
      <div class="qqm-artist" title="${escapeAttr(flash || artistTip)}">${escapeHtml(flash || artistLine)}</div>
      <div class="qqm-transport" role="group" aria-label="播放控制">
        <button type="button" class="qqm-ctrl" id="qqmPrev" title="上一首" aria-label="上一首">${ICON_PREV}</button>
        <button type="button" class="qqm-ctrl qqm-play" id="qqmToggle" title="播放/暂停" aria-label="播放/暂停">
          ${playing ? ICON_PAUSE : ICON_PLAY}
        </button>
        <button type="button" class="qqm-ctrl" id="qqmNext" title="下一首" aria-label="下一首">${ICON_NEXT}</button>
      </div>
    </div>`;

  bindControls();
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function setFlash(msg: string) {
  flash = msg;
  render(true);
  window.setTimeout(() => {
    flash = "";
    render(true);
  }, 1800);
}

async function refresh() {
  if (!ctxRef || refreshing) return;
  refreshing = true;
  const prev = np;
  try {
    const next = await ctxRef.invoke<NowPlaying>("qqmusic_now_playing");
    // SMTC 过渡态别刷掉播放图标，否则会来回闪
    if (
      (next.status === "changing" || next.status === "opened" || next.status === "unknown") &&
      prev &&
      (prev.status === "playing" || prev.status === "paused") &&
      next.title === prev.title
    ) {
      next.status = prev.status;
    }
    np = next;
  } catch (e) {
    console.warn("qqmusic_now_playing", e);
    np = {
      active: false,
      app_id: "",
      title: "",
      artist: "",
      album: "",
      status: "stopped",
      artwork_path: null,
      can_play_pause: false,
      can_next: false,
      can_prev: false,
      installed: false,
      install_path: null,
      hint: String(e),
    };
  } finally {
    refreshing = false;
  }
  if (!flash) render();
}

async function act(kind: "toggle" | "next" | "prev") {
  if (!ctxRef) return;
  const cmd =
    kind === "toggle"
      ? "qqmusic_toggle"
      : kind === "next"
        ? "qqmusic_next"
        : "qqmusic_prev";
  const looksDown = !np || (!np.active && np.status !== "playing" && np.status !== "paused");
  if (looksDown) setFlash("正在启动 QQ 音乐…");
  try {
    const r = await ctxRef.invoke<{ cold_started?: boolean }>(cmd);
    ctxRef.emit("qqmusic:control", { kind, cold_started: !!r?.cold_started });
    if (r?.cold_started) {
      setFlash("已启动，正在播放…");
      window.setTimeout(() => void refresh(), 1500);
      window.setTimeout(() => void refresh(), 3500);
      return;
    }
    if (kind === "toggle" && np) {
      np = {
        ...np,
        status: np.status === "playing" ? "paused" : "playing",
      };
      render(true);
    }
    window.setTimeout(() => void refresh(), 500);
  } catch (e) {
    console.warn(cmd, e);
    setFlash(String(e));
  }
}

async function ensureRunning() {
  if (!ctxRef) return;
  try {
    await ctxRef.invoke("qqmusic_ensure_running");
  } catch (e) {
    console.warn("qqmusic_ensure_running", e);
  }
}

async function launchForeground() {
  if (!ctxRef) return;
  try {
    await ctxRef.invoke("qqmusic_launch");
  } catch {
    await ctxRef.openUrl("https://y.qq.com/");
  }
}

const panel: PluginModule = {
  async mount(el, ctx) {
    root = el;
    ctxRef = ctx;
    lastRenderKey = "";
    artPathCached = null;
    el.innerHTML = `<div class="qqm-card"><div class="qqm-artist" style="grid-column:1/-1">连接 QQ 音乐…</div></div>`;

    ctx.registerCommand({
      id: "toggle",
      title: "播放/暂停",
      group: "媒体",
      run: () => act("toggle"),
    });
    ctx.registerCommand({
      id: "next",
      title: "下一首",
      group: "媒体",
      run: () => act("next"),
    });
    ctx.registerCommand({
      id: "launch",
      title: "QQ 音乐前台",
      group: "媒体",
      run: () => launchForeground(),
    });

    void ensureRunning();
    await refresh();
    // 轮询只拉数据；内容没变不重绘，避免封面/按钮闪烁
    timer = window.setInterval(() => void refresh(), 3000);
    window.setTimeout(() => void refresh(), 2500);
  },
  unmount() {
    if (timer != null) window.clearInterval(timer);
    timer = null;
    root = null;
    ctxRef = null;
    np = null;
    lastRenderKey = "";
    artPathCached = null;
  },
};

export default panel;
