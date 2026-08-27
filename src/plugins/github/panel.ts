import type { HostContext, PluginModule } from "../../host/types";
import { escapeHtml, pad, setSyncStatus } from "../../host/util";

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];
const PANEL_REFRESH_MS = 5 * 60 * 1000;

type ContribCellDto = { date: string; count: number; level: number };
type GithubPinDto = {
  repo: string;
  desc: string;
  lang: string;
  lang_name: string;
  stars: string;
};
type GithubLangDto = { name: string; pct: number; color: string };
type GithubSnapshotDto = {
  login: string;
  name: string;
  bio: string;
  avatar_url: string;
  streak: number;
  year_total: number;
  weeks: number[][];
  contrib_cells?: ContribCellDto[];
  pins: GithubPinDto[];
  langs: GithubLangDto[];
  cached: boolean;
  error: string | null;
};

let clockTimer: number | null = null;
let refreshTimer: number | null = null;
let githubProfileUrl = "";
let githubLogin = "";
let lastSnap: GithubSnapshotDto | null = null;
let lastSyncAt = 0;
let lastOk = false;
let rootEl: HTMLElement | null = null;
let ctxRef: HostContext | null = null;

function tick() {
  if (!rootEl) return;
  const now = new Date();
  const t = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const timeEl = rootEl.querySelector("#time");
  const dateEl = rootEl.querySelector("#date");
  if (timeEl) timeEl.textContent = t;
  if (dateEl) {
    dateEl.textContent = `${DAYS[now.getDay()]} · ${MONTHS[now.getMonth()]} ${now.getDate()}`;
  }
}

function formatContribTip(date: string, count: number) {
  if (!date) return "";
  const [y, m, d] = date.split("-").map(Number);
  const local = new Date(y, (m || 1) - 1, d || 1);
  const label = local.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  if (!count) return `${label}：无贡献`;
  return `${label}：${count} 次贡献`;
}

function openContribDay(date: string) {
  if (!date || !githubLogin || !ctxRef) return;
  const url = `https://github.com/${githubLogin}?from=${date}&to=${date}`;
  void ctxRef.openUrl(url);
}

function openGithubProfile() {
  if (!githubProfileUrl || !ctxRef) return;
  void ctxRef.openUrl(githubProfileUrl);
}

function renderGithub(snap: GithubSnapshotDto) {
  if (!rootEl) return;
  lastSnap = snap;
  githubLogin = snap.login;
  githubProfileUrl = snap.login ? `https://github.com/${snap.login}` : "";
  const profile = rootEl.querySelector("#ghProfile") as HTMLElement | null;
  const wall = rootEl.querySelector("#ghWall") as HTMLElement | null;
  if (profile) {
    profile.classList.toggle("gh-link", Boolean(githubProfileUrl));
    profile.title = githubProfileUrl ? "打开 GitHub 主页" : "";
  }
  if (wall) {
    wall.classList.toggle("gh-link", Boolean(githubProfileUrl));
    wall.title = githubProfileUrl ? "打开 GitHub 主页" : "";
  }

  const nameEl = rootEl.querySelector("#ghName");
  const handleEl = rootEl.querySelector("#ghHandle");
  const bioEl = rootEl.querySelector("#ghBio") as HTMLElement | null;
  const streakEl = rootEl.querySelector("#ghStreak");
  const avatar = rootEl.querySelector("#ghAvatar") as HTMLElement | null;
  if (nameEl) nameEl.textContent = snap.name || snap.login;
  if (handleEl) handleEl.textContent = `@${snap.login}`;
  if (bioEl) {
    bioEl.textContent = snap.bio || "—";
    if (snap.cached && snap.error) bioEl.title = `缓存数据：${snap.error}`;
  }
  if (streakEl) streakEl.textContent = String(snap.streak);
  if (avatar) {
    if (snap.avatar_url) {
      avatar.textContent = "";
      avatar.style.backgroundImage = `url('${snap.avatar_url}')`;
      avatar.classList.add("has-img");
    } else {
      avatar.textContent = (snap.name || snap.login || "?").slice(0, 1).toUpperCase();
      avatar.style.backgroundImage = "";
      avatar.classList.remove("has-img");
    }
  }

  const grid = rootEl.querySelector("#grid");
  if (grid) {
    grid.innerHTML = "";
    const cells = snap.contrib_cells ?? [];
    let i = 0;
    for (const week of snap.weeks) {
      for (let d = 0; d < 7; d++) {
        const meta = cells[i];
        const lv = meta?.level ?? week[d] ?? 0;
        const cell = document.createElement("div");
        cell.className = `cell l${lv}${meta?.date ? " has-day" : ""}`;
        if (meta?.date) {
          cell.title = formatContribTip(meta.date, meta.count);
          cell.addEventListener("click", (e) => {
            e.stopPropagation();
            openContribDay(meta.date);
          });
        }
        grid.appendChild(cell);
        i += 1;
      }
    }
  }
  const yc = rootEl.querySelector("#yearCount");
  if (yc) yc.textContent = String(snap.year_total);

  const pinsEl = rootEl.querySelector("#pins");
  if (pinsEl) {
    pinsEl.innerHTML = snap.pins
      .map(
        (p) => `
    <div class="pin">
      <div class="repo">${escapeHtml(p.repo)}</div>
      <div class="desc">${escapeHtml(p.desc || "—")}</div>
      <div class="meta">
        <span><i class="lang-dot" style="background:${escapeHtml(p.lang)}"></i>${escapeHtml(p.lang_name)}</span>
        <span>★ ${escapeHtml(p.stars)}</span>
      </div>
    </div>`
      )
      .join("");
  }

  const bar = rootEl.querySelector("#langBar");
  const legend = rootEl.querySelector("#langLegend");
  if (bar && legend) {
    bar.innerHTML = snap.langs
      .map((l) => `<i style="width:${l.pct}%;background:${escapeHtml(l.color)}"></i>`)
      .join("");
    legend.innerHTML = snap.langs
      .map(
        (l) =>
          `<span style="--c:${escapeHtml(l.color)}">${escapeHtml(l.name)} ${l.pct}%</span>`
      )
      .join("");
  }
}

async function loadGithub() {
  if (!ctxRef || !rootEl) return;
  const at = Date.now();
  const syncEl = rootEl.querySelector("#ghSync") as HTMLElement | null;
  try {
    const snap = await ctxRef.invoke<GithubSnapshotDto>("github_snapshot");
    renderGithub(snap);
    lastSyncAt = at;
    lastOk = true;
    setSyncStatus(syncEl, at, true, snap.cached, snap.error);
    ctxRef.emit("github:sync", {
      ok: true,
      cached: snap.cached,
      hasToken: Boolean(snap.login),
      ms: Date.now() - at,
    });
  } catch (e) {
    console.error("github_snapshot", e);
    lastSyncAt = at;
    lastOk = false;
    setSyncStatus(syncEl, at, false, false, String(e));
    const bioEl = rootEl.querySelector("#ghBio");
    if (bioEl) bioEl.textContent = `GitHub 未接通：${String(e)}`;
    ctxRef.emit("github:sync", { ok: false, error: String(e) });
  }
}

const panel: PluginModule = {
  async mount(el, ctx) {
    rootEl = el;
    ctxRef = ctx;
    el.innerHTML = `
      <div class="profile gh-link" id="ghProfile" title="打开 GitHub 主页">
        <div class="avatar" id="ghAvatar">K</div>
        <div class="profile-text">
          <div class="name">
            <span id="ghName">…</span> <span class="handle" id="ghHandle">@…</span>
          </div>
          <div class="bio" id="ghBio">加载 GitHub…</div>
        </div>
        <div class="stats">
          <b id="ghStreak">—</b>
          <span>day streak</span>
        </div>
      </div>
      <div class="row-clock-wall">
        <div class="clock">
          <div class="clock-time" id="time">--:--</div>
          <div class="clock-date" id="date">---</div>
          <div class="streak">今年 <strong id="yearCount">—</strong></div>
        </div>
        <div class="wall gh-link" id="ghWall" title="打开 GitHub 主页">
          <div class="wall-meta"><span>Contributions</span><span class="sync-hint" id="ghSync">GitHub …</span></div>
          <div class="grid" id="grid"></div>
        </div>
      </div>
      <div class="section-label">Pinned</div>
      <div class="pins" id="pins"></div>
      <div class="section-label">Languages</div>
      <div class="langs">
        <div class="lang-bar" id="langBar"></div>
        <div class="lang-legend" id="langLegend"></div>
      </div>`;

    el.querySelector("#ghProfile")?.addEventListener("click", () => openGithubProfile());
    el.querySelector("#ghWall")?.addEventListener("click", () => openGithubProfile());

    tick();
    clockTimer = window.setInterval(tick, 1000);

    ctx.registerCommand({
      id: "sync",
      title: "同步 GitHub",
      group: "GitHub",
      run: () => loadGithub(),
    });
    ctx.registerCommand({
      id: "open-profile",
      title: "打开 GitHub 主页",
      group: "GitHub",
      run: () => openGithubProfile(),
    });

    window.setTimeout(() => {
      void loadGithub();
      refreshTimer = window.setInterval(() => void loadGithub(), PANEL_REFRESH_MS);
    }, 800);
  },
  unmount() {
    if (clockTimer != null) window.clearInterval(clockTimer);
    if (refreshTimer != null) window.clearInterval(refreshTimer);
    clockTimer = null;
    refreshTimer = null;
    rootEl = null;
    ctxRef = null;
    lastSnap = null;
  },
};

export function getGithubHud() {
  return {
    lastSyncAt,
    lastOk,
    cached: lastSnap?.cached ?? false,
    hasLogin: Boolean(githubLogin),
    error: lastSnap?.error ?? null,
  };
}

export default panel;
