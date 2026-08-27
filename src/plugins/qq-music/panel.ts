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

function artUrl(path: string | null): string {
  if (!path || !ctxRef) return "";
  try {
    // bust cache so art updates between tracks
    return `${ctxRef.convertFileSrc(path)}?t=${Date.now()}`;
  } catch {
    return "";
  }
}

function render() {
  if (!root) return;
  const d = np;
  const playing = d?.status === "playing";
  const art = artUrl(d?.artwork_path ?? null);
  const title = d?.active ? d.title || "未知曲目" : "未在播放";
  const artist = d?.active
    ? [d.artist, d.album].filter(Boolean).join(" · ") || "QQ 音乐"
    : d?.hint || "连接 QQ 音乐中…";

  root.innerHTML = `
    <div class="qqm-card ${playing ? "is-playing" : ""}">
      <div class="qqm-art" style="${art ? `background-image:url('${art}')` : ""}">
        ${art ? "" : `<span class="qqm-art-fallback">♪</span>`}
      </div>
      <div class="qqm-meta">
        <div class="qqm-title" title="${escapeAttr(title)}">${escapeHtml(title)}</div>
        <div class="qqm-artist" title="${escapeAttr(flash || artist)}">${escapeHtml(flash || artist)}</div>
        <div class="qqm-controls">
          <button type="button" class="qqm-ctrl" id="qqmPrev" title="上一首">‹</button>
          <button type="button" class="qqm-ctrl qqm-play" id="qqmToggle" title="播放/暂停">
            ${playing ? "❚❚" : "▶"}
          </button>
          <button type="button" class="qqm-ctrl" id="qqmNext" title="下一首">›</button>
          <button type="button" class="qqm-open" id="qqmLaunch" title="把 QQ 音乐拉到前台">前台</button>
        </div>
      </div>
    </div>`;

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
  render();
  window.setTimeout(() => {
    flash = "";
    render();
  }, 1800);
}

async function refresh() {
  if (!ctxRef) return;
  try {
    np = await ctxRef.invoke<NowPlaying>("qqmusic_now_playing");
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
      render();
    }
    window.setTimeout(() => void refresh(), 400);
  } catch (e) {
    console.warn(cmd, e);
    setFlash(String(e));
  }
}

/** 面板存在 = 保证 QQ 在后台；已在跑则 noop。 */
async function ensureRunning() {
  if (!ctxRef) return;
  try {
    await ctxRef.invoke("qqmusic_ensure_running");
  } catch (e) {
    console.warn("qqmusic_ensure_running", e);
  }
}

/** 显式拉前台（不是「启动」）。 */
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
    el.innerHTML = `<div class="qqm-card"><div class="qqm-meta"><div class="qqm-artist">连接 QQ 音乐…</div></div></div>`;

    ctx.registerCommand({
      id: "toggle",
      title: "QQ 音乐 · 播放/暂停",
      group: "媒体",
      run: () => act("toggle"),
    });
    ctx.registerCommand({
      id: "next",
      title: "QQ 音乐 · 下一首",
      group: "媒体",
      run: () => act("next"),
    });
    ctx.registerCommand({
      id: "launch",
      title: "QQ 音乐 · 拉到前台",
      group: "媒体",
      run: () => launchForeground(),
    });

    // 有面板就后台自启，不必再点「打开」
    void ensureRunning();
    await refresh();
    timer = window.setInterval(() => void refresh(), 2000);
    // 刚拉起时 SMTC 可能还没就绪，稍后补一次
    window.setTimeout(() => void refresh(), 2500);
  },
  unmount() {
    if (timer != null) window.clearInterval(timer);
    timer = null;
    root = null;
    ctxRef = null;
    np = null;
  },
};

export default panel;
