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
let flashTimer: number | null = null;
let refreshing = false;
let bound = false;
let artTrackKey = "";
let artBust = 0;
let lastStableStatus = "stopped";
let paintedTrackKey = "";
let paintedStatus = "";
let paintedFlash = "";

const ICON_PREV = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2v12H6V6zm3.5 6 8.5 6V6l-8.5 6z"/></svg>`;
const ICON_NEXT = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 6h2v12h-2V6zM6 18l8.5-6L6 6v12z"/></svg>`;
const ICON_PLAY = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z"/></svg>`;

function trackKey(d: NowPlaying | null): string {
  if (!d) return "";
  // 封面文件路径固定，必须用曲目身份驱动刷新
  return [d.title, d.artist, d.album, d.artwork_path ?? ""].join("\u0001");
}

function artUrl(path: string | null, track: string): string {
  if (!path || !ctxRef) return "";
  if (track !== artTrackKey) {
    artTrackKey = track;
    artBust = Date.now();
  }
  try {
    return `${ctxRef.convertFileSrc(path)}?t=${artBust}`;
  } catch {
    return "";
  }
}

function stabilizeStatus(next: NowPlaying, prev: NowPlaying | null): string {
  const s = next.status;
  if (s === "playing" || s === "paused" || s === "stopped") {
    lastStableStatus = s;
    return s;
  }
  // changing / opened / unknown：同曲目时保持上一稳定态，避免播控图标闪
  if (prev && trackKey(prev) === trackKey(next) && (prev.status === "playing" || prev.status === "paused")) {
    return prev.status;
  }
  return lastStableStatus;
}

function ensureShell() {
  if (!root) return;
  if (root.querySelector(".qqm-card")) return;
  root.innerHTML = `
    <div class="qqm-card">
      <button type="button" class="qqm-art" id="qqmLaunch" title="打开 QQ 音乐前台">
        <span class="qqm-art-fallback">♪</span>
      </button>
      <div class="qqm-title">连接 QQ 音乐…</div>
      <div class="qqm-artist"></div>
      <div class="qqm-transport" role="group" aria-label="播放控制">
        <button type="button" class="qqm-ctrl" id="qqmPrev" title="上一首" aria-label="上一首">${ICON_PREV}</button>
        <button type="button" class="qqm-ctrl qqm-play" id="qqmToggle" title="播放/暂停" aria-label="播放/暂停">${ICON_PLAY}</button>
        <button type="button" class="qqm-ctrl" id="qqmNext" title="下一首" aria-label="下一首">${ICON_NEXT}</button>
      </div>
    </div>`;
  if (!bound) {
    bound = true;
    root.addEventListener("click", onRootClick);
  }
}

function onRootClick(e: Event) {
  const t = (e.target as HTMLElement | null)?.closest("button");
  if (!t || !root?.contains(t)) return;
  e.preventDefault();
  e.stopPropagation();
  const id = t.id;
  if (id === "qqmToggle") void act("toggle");
  else if (id === "qqmNext") void act("next");
  else if (id === "qqmPrev") void act("prev");
  else if (id === "qqmLaunch") void launchForeground();
}

function paint() {
  if (!root) return;
  ensureShell();
  const d = np;
  const tk = trackKey(d);
  const status = d?.status ?? "stopped";
  const playing = status === "playing";
  const title = d?.active ? d.title || "未知曲目" : "未在播放";
  const artistLine = d?.active
    ? d.artist || d.album || "QQ 音乐"
    : d?.hint || "连接 QQ 音乐中…";
  const artistTip = d?.active
    ? [d.artist, d.album].filter(Boolean).join(" · ") || artistLine
    : artistLine;

  const card = root.querySelector(".qqm-card") as HTMLElement;
  const artBtn = root.querySelector("#qqmLaunch") as HTMLElement;
  const titleEl = root.querySelector(".qqm-title") as HTMLElement;
  const artistEl = root.querySelector(".qqm-artist") as HTMLElement;
  const playBtn = root.querySelector("#qqmToggle") as HTMLElement;
  if (!card || !artBtn || !titleEl || !artistEl || !playBtn) return;

  card.classList.toggle("is-playing", playing);

  // 文案：有变化才写，避免无意义回流
  if (titleEl.textContent !== title) {
    titleEl.textContent = title;
    titleEl.title = title;
  }
  const artistShow = flash || artistLine;
  const artistTitle = flash || artistTip;
  if (artistEl.textContent !== artistShow || paintedFlash !== flash) {
    artistEl.textContent = artistShow;
    artistEl.title = artistTitle;
    paintedFlash = flash;
  }

  // 封面：仅换歌时换 URL（路径固定，靠 trackKey bust）
  if (tk !== paintedTrackKey) {
    paintedTrackKey = tk;
    const url = artUrl(d?.artwork_path ?? null, tk);
    if (url) {
      artBtn.style.backgroundImage = `url('${url.replace(/'/g, "%27")}')`;
      artBtn.innerHTML = "";
    } else {
      artBtn.style.backgroundImage = "";
      if (!artBtn.querySelector(".qqm-art-fallback")) {
        artBtn.innerHTML = `<span class="qqm-art-fallback">♪</span>`;
      }
    }
  }

  if (status !== paintedStatus) {
    paintedStatus = status;
    playBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  }
}

function setFlash(msg: string) {
  flash = msg;
  if (flashTimer != null) window.clearTimeout(flashTimer);
  paint();
  flashTimer = window.setTimeout(() => {
    flash = "";
    flashTimer = null;
    paint();
  }, 1800);
}

async function refresh() {
  if (!ctxRef || refreshing) return;
  refreshing = true;
  const prev = np;
  try {
    const next = await ctxRef.invoke<NowPlaying>("qqmusic_now_playing");
    next.status = stabilizeStatus(next, prev);
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
  paint();
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
      lastStableStatus = np.status;
      paint();
    }
    // 切歌后稍等 SMTC / 封面落盘再刷
    window.setTimeout(() => void refresh(), kind === "toggle" ? 400 : 800);
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
    bound = false;
    artTrackKey = "";
    paintedTrackKey = "";
    paintedStatus = "";
    paintedFlash = "";
    lastStableStatus = "stopped";
    ensureShell();

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
    timer = window.setInterval(() => void refresh(), 2500);
  },
  unmount() {
    if (timer != null) window.clearInterval(timer);
    timer = null;
    if (flashTimer != null) window.clearTimeout(flashTimer);
    flashTimer = null;
    if (root && bound) root.removeEventListener("click", onRootClick);
    bound = false;
    root = null;
    ctxRef = null;
    np = null;
  },
};

export default panel;
