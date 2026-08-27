import type { HostContext, PluginModule } from "../../host/types";
import { escapeHtml, setSyncStatus } from "../../host/util";

const PANEL_REFRESH_MS = 5 * 60 * 1000;

type MulticaIssueDto = { st: string; title: string; who: string; id: string };
type MulticaSnapshotDto = {
  app_url: string;
  inbox: number;
  doing: number;
  review: number;
  issues: MulticaIssueDto[];
  runtime_online: boolean;
  cached: boolean;
  error: string | null;
};

let refreshTimer: number | null = null;
let multicaAppUrl = "";
let lastSnap: MulticaSnapshotDto | null = null;
let lastSyncAt = 0;
let lastOk = false;
let rootEl: HTMLElement | null = null;
let ctxRef: HostContext | null = null;

function multicaIssueUrl(id: string) {
  if (!multicaAppUrl || !id) return "";
  return `${multicaAppUrl.replace(/\/$/, "")}/issues/${id}`;
}

function renderMc(snap: MulticaSnapshotDto) {
  if (!rootEl) return;
  lastSnap = snap;
  multicaAppUrl = snap.app_url || "";
  const set = (id: string, n: number) => {
    const el = rootEl!.querySelector(`#${id}`);
    if (el) el.textContent = String(n);
  };
  set("mcInbox", snap.inbox);
  set("mcDoing", snap.doing);
  set("mcReview", snap.review);

  const list = rootEl.querySelector("#mcList");
  if (list) {
    if (!snap.issues.length) {
      list.innerHTML = `<div class="mc-row"><span class="title" style="opacity:.55">暂无进行中的 issue</span></div>`;
    } else {
      list.innerHTML = snap.issues
        .map((i) => {
          const url = multicaIssueUrl(i.id);
          const urlAttr = url ? ` data-url="${url.replace(/"/g, "&quot;")}"` : "";
          return `
    <div class="mc-row mc-link"${urlAttr} title="${url ? "打开 issue" : ""}">
      <span class="st ${escapeHtml(i.st)}">${escapeHtml(i.st)}</span>
      <span class="title">${escapeHtml(i.title)}</span>
      <span class="who">${escapeHtml(i.who)}</span>
    </div>`;
        })
        .join("");
      list.querySelectorAll<HTMLElement>(".mc-row.mc-link[data-url]").forEach((row) => {
        row.addEventListener("click", () => {
          const url = row.dataset.url;
          if (!url || !ctxRef) return;
          void ctxRef.openUrl(url);
        });
      });
    }
  }

  const live = rootEl.querySelector("#mcLive");
  if (live) {
    live.textContent = snap.runtime_online ? "runtime online" : "runtime offline";
    live.classList.toggle("off", !snap.runtime_online);
  }
  const hint = rootEl.querySelector("#mcFootHint") as HTMLElement | null;
  if (hint && snap.error) hint.title = snap.error;
}

async function loadMultica() {
  if (!ctxRef || !rootEl) return;
  const at = Date.now();
  const hint = rootEl.querySelector("#mcFootHint") as HTMLElement | null;
  try {
    const snap = await ctxRef.invoke<MulticaSnapshotDto>("multica_snapshot");
    renderMc(snap);
    lastSyncAt = at;
    lastOk = true;
    setSyncStatus(hint, at, true, snap.cached, snap.error);
    ctxRef.emit("multica:sync", {
      ok: true,
      cached: snap.cached,
      online: snap.runtime_online,
      ms: Date.now() - at,
    });
  } catch (e) {
    console.error("multica_snapshot", e);
    lastSyncAt = at;
    lastOk = false;
    setSyncStatus(hint, at, false, false, String(e));
    const list = rootEl.querySelector("#mcList");
    if (list) {
      list.innerHTML = `<div class="mc-row"><span class="title">Multica 未接通：${escapeHtml(String(e))}</span></div>`;
    }
    ctxRef.emit("multica:sync", { ok: false, error: String(e) });
  }
}

async function openBoard() {
  if (!ctxRef) return;
  try {
    const url = await ctxRef.invoke<string>("multica_app_url");
    await ctxRef.openUrl(url);
  } catch (e) {
    console.warn("multica_app_url failed, fallback localhost", e);
    await ctxRef.openUrl("http://localhost:18473");
  }
}

const panel: PluginModule = {
  async mount(el, ctx) {
    rootEl = el;
    ctxRef = ctx;
    el.innerHTML = `
      <div class="mc">
        <div class="mc-head">
          <span class="brand">Multica</span>
          <button type="button" class="mc-open" id="mcOpen">打开看板 →</button>
        </div>
        <div class="mc-stats">
          <span class="mc-pill warn"><strong id="mcInbox">—</strong> inbox</span>
          <span class="mc-pill go"><strong id="mcDoing">—</strong> doing</span>
          <span class="mc-pill"><strong id="mcReview">—</strong> review</span>
        </div>
        <div class="mc-list" id="mcList"></div>
        <div class="mc-foot">
          <span class="live" id="mcLive">runtime …</span>
          <span id="mcFootHint">本地实例</span>
        </div>
      </div>`;

    el.querySelector("#mcOpen")?.addEventListener("click", () => void openBoard());

    ctx.registerCommand({
      id: "sync",
      title: "同步 Multica",
      group: "Multica",
      run: () => loadMultica(),
    });
    ctx.registerCommand({
      id: "open",
      title: "打开 Multica 看板",
      group: "Multica",
      run: () => openBoard(),
    });

    window.setTimeout(() => {
      void loadMultica();
      refreshTimer = window.setInterval(() => void loadMultica(), PANEL_REFRESH_MS);
    }, 800);
  },
  unmount() {
    if (refreshTimer != null) window.clearInterval(refreshTimer);
    refreshTimer = null;
    rootEl = null;
    ctxRef = null;
  },
};

export function getMulticaHud() {
  return {
    lastSyncAt,
    lastOk,
    cached: lastSnap?.cached ?? false,
    online: lastSnap?.runtime_online ?? false,
  };
}

export default panel;
