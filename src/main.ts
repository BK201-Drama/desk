import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

const PANEL_REFRESH_MS = 5 * 60 * 1000;
const RECENT_MAX = 4;
const RECENT_LS_KEY = "desk-recent-v1";

/** label (lowercase) → extra search tokens */
const SEARCH_ALIASES: Record<string, string[]> = {
  英雄联盟: ["lol", "yxlm", "联盟", "league"],
  "counter-strike 2": ["cs", "cs2", "反恐"],
  穿越火线: ["cf"],
  饥荒联机版: ["饥荒", "dst"],
  terraria: ["泰拉"],
  飞书: ["feishu", "lark"],
  文献批量阅读助手: ["文献", "paper"],
  此电脑: ["pc", "mycomputer", "计算机"],
  回收站: ["recycle", "trash", "垃圾箱"],
};

type ContribCellDto = { date: string; count: number; level: number };

type FenceItemDto = {
  id: string;
  label: string;
  path: string;
  icon: string | null;
};
type FenceDto = { name: string; items: FenceItemDto[] };

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
  contrib_layout?: number;
  pins: GithubPinDto[];
  langs: GithubLangDto[];
  cached: boolean;
  error: string | null;
};

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

type ReminderDto = {
  id: string;
  title: string;
  rule: string;
  rule_label: string;
  done: boolean;
  created_at: number;
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function tick() {
  const now = new Date();
  const t = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const timeEl = document.getElementById("time");
  const dateEl = document.getElementById("date");
  if (timeEl) timeEl.textContent = t;
  if (dateEl) {
    dateEl.textContent = `${DAYS[now.getDay()]} · ${MONTHS[now.getMonth()]} ${now.getDate()}`;
  }
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let githubProfileUrl = "";
let githubLogin = "";
let multicaAppUrl = "";

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
  if (!date || !githubLogin) return;
  const url = `https://github.com/${githubLogin}?from=${date}&to=${date}`;
  void openUrl(url).catch(() => window.open(url, "_blank"));
}

function multicaIssueUrl(id: string) {
  if (!multicaAppUrl || !id) return "";
  return `${multicaAppUrl.replace(/\/$/, "")}/issues/${id}`;
}

function formatSyncTime(at: number) {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function setSyncStatus(
  id: string,
  at: number,
  ok: boolean,
  cached: boolean,
  error?: string | null
) {
  const el = document.getElementById(id);
  if (!el) return;
  const t = formatSyncTime(at);
  if (!ok) {
    el.textContent = `失败 ${t}`;
    el.className = "sync-hint err";
    el.title = error ?? "";
    return;
  }
  el.textContent = cached ? `缓存 ${t}` : `同步 ${t}`;
  el.className = cached ? "sync-hint cached" : "sync-hint";
  el.title = cached && error ? error : "";
}

function openGithubProfile() {
  if (!githubProfileUrl) return;
  void openUrl(githubProfileUrl).catch(() => window.open(githubProfileUrl, "_blank"));
}

function renderGithub(snap: GithubSnapshotDto) {
  githubLogin = snap.login;
  githubProfileUrl = snap.login ? `https://github.com/${snap.login}` : "";
  const profile = document.getElementById("ghProfile");
  const wall = document.getElementById("ghWall");
  if (profile) {
    profile.classList.toggle("gh-link", Boolean(githubProfileUrl));
    profile.title = githubProfileUrl ? "打开 GitHub 主页" : "";
  }
  if (wall) {
    wall.classList.toggle("gh-link", Boolean(githubProfileUrl));
    wall.title = githubProfileUrl ? "打开 GitHub 主页" : "";
  }

  const nameEl = document.getElementById("ghName");
  const handleEl = document.getElementById("ghHandle");
  const bioEl = document.getElementById("ghBio");
  const streakEl = document.getElementById("ghStreak");
  const avatar = document.getElementById("ghAvatar");
  if (nameEl) nameEl.textContent = snap.name || snap.login;
  if (handleEl) handleEl.textContent = `@${snap.login}`;
  if (bioEl) {
    bioEl.textContent = snap.bio || "—";
    if (snap.cached && snap.error) {
      bioEl.title = `缓存数据：${snap.error}`;
    }
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

  const grid = document.getElementById("grid");
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
  const yc = document.getElementById("yearCount");
  if (yc) yc.textContent = String(snap.year_total);

  const pinsEl = document.getElementById("pins");
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

  const bar = document.getElementById("langBar");
  const legend = document.getElementById("langLegend");
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
  const at = Date.now();
  try {
    const snap = await invoke<GithubSnapshotDto>("github_snapshot");
    renderGithub(snap);
    setSyncStatus("ghSync", at, true, snap.cached, snap.error);
  } catch (e) {
    console.error("github_snapshot", e);
    setSyncStatus("ghSync", at, false, false, String(e));
    const bioEl = document.getElementById("ghBio");
    if (bioEl) bioEl.textContent = `GitHub 未接通：${String(e)}`;
  }
}

function renderMc(snap: MulticaSnapshotDto) {
  multicaAppUrl = snap.app_url || "";
  const set = (id: string, n: number) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(n);
  };
  set("mcInbox", snap.inbox);
  set("mcDoing", snap.doing);
  set("mcReview", snap.review);

  const list = document.getElementById("mcList");
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
          if (!url) return;
          void openUrl(url).catch(() => window.open(url, "_blank"));
        });
      });
    }
  }

  const live = document.getElementById("mcLive");
  if (live) {
    live.textContent = snap.runtime_online ? "runtime online" : "runtime offline";
    live.classList.toggle("off", !snap.runtime_online);
  }
  const hint = document.getElementById("mcFootHint");
  if (hint) {
    // sync time set in loadMultica
    if (snap.error) hint.title = snap.error;
  }
}

async function loadMultica() {
  const at = Date.now();
  try {
    const snap = await invoke<MulticaSnapshotDto>("multica_snapshot");
    renderMc(snap);
    setSyncStatus("mcFootHint", at, true, snap.cached, snap.error);
  } catch (e) {
    console.error("multica_snapshot", e);
    setSyncStatus("mcFootHint", at, false, false, String(e));
    const list = document.getElementById("mcList");
    if (list) {
      list.innerHTML = `<div class="mc-row"><span class="title">Multica 未接通：${escapeHtml(String(e))}</span></div>`;
    }
  }
}

function renderReminders(items: ReminderDto[]) {
  const root = document.getElementById("remindItems");
  if (!root) return;
  if (!items.length) {
    root.innerHTML = `<div class="remind-row"><div class="body"><strong style="opacity:.5;font-weight:400">暂无待办</strong></div></div>`;
    return;
  }
  root.innerHTML = items
    .map(
      (r) => `
    <div class="remind-row${r.done ? " done" : ""}" data-id="${escapeHtml(r.id)}">
      <button type="button" class="dot${r.done ? " checked" : ""}" data-act="toggle" aria-label="勾选"></button>
      <div class="body">
        <strong>${escapeHtml(r.title)}</strong>
        <div class="sub">${escapeHtml(r.rule_label)}</div>
      </div>
      <button type="button" class="rm" data-act="remove" title="删除">×</button>
    </div>`
    )
    .join("");

  root.querySelectorAll<HTMLElement>(".remind-row").forEach((row) => {
    const id = row.dataset.id;
    if (!id) return;
    row.querySelector('[data-act="toggle"]')?.addEventListener("click", () => {
      if (!editing) return;
      void invoke<ReminderDto[]>("remind_toggle", { id })
        .then(renderReminders)
        .catch((e) => console.error(e));
    });
    row.querySelector('[data-act="remove"]')?.addEventListener("click", () => {
      if (!editing) return;
      void invoke<ReminderDto[]>("remind_remove", { id })
        .then(renderReminders)
        .catch((e) => console.error(e));
    });
  });
}

async function loadReminders() {
  try {
    const items = await invoke<ReminderDto[]>("remind_list");
    renderReminders(items);
  } catch (e) {
    console.error("remind_list", e);
  }
}

function iconUrl(icon: string | null, label: string): string {
  if (icon) {
    try {
      return `background-image:url('${convertFileSrc(icon)}')`;
    } catch {
      return `background-image:url('${icon}')`;
    }
  }
  if (label === "回收站") return "background:linear-gradient(145deg,#94a3b8,#475569)";
  if (label === "此电脑") return "background:linear-gradient(145deg,#93c5fd,#2563eb)";
  return "background:linear-gradient(145deg,#c4b5fd,#7c3aed)";
}

type FenceLayout = { name: string; ids: string[] };

const DRAG_THRESHOLD_PX = 6;

let fencePointer: {
  id: number;
  el: HTMLElement;
  startX: number;
  startY: number;
  active: boolean;
} | null = null;
let fenceSuppressClick = false;

let fenceFilter = "";
let allFences: FenceDto[] = [];
let searchSelectedIndex = -1;
let recentIds: string[] = [];

function findItemById(id: string): FenceItemDto | null {
  for (const f of allFences) {
    const item = f.items.find((i) => i.id === id);
    if (item) return item;
  }
  return null;
}

function loadRecentIds(): string[] {
  return recentIds.slice(0, RECENT_MAX);
}

async function migrateRecentFromLocalStorage() {
  try {
    if (recentIds.length) return;
    const raw = localStorage.getItem(RECENT_LS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;
    const legacy = parsed
      .filter((x): x is string => typeof x === "string" && !x.startsWith("sys-"))
      .slice(0, RECENT_MAX);
    localStorage.removeItem(RECENT_LS_KEY);
    if (!legacy.length) return;
    for (const id of [...legacy].reverse()) {
      recentIds = await invoke<string[]>("recent_push", { id });
    }
  } catch {
    /* ignore */
  }
}

async function loadRecentFromDisk() {
  try {
    recentIds = await invoke<string[]>("recent_list");
    recentIds = recentIds.slice(0, RECENT_MAX);
    await migrateRecentFromLocalStorage();
  } catch (e) {
    console.warn("recent_list", e);
    recentIds = [];
  }
}

function recordRecentLaunch(item: FenceItemDto) {
  if (item.id.startsWith("sys-")) return;
  void invoke<string[]>("recent_push", { id: item.id })
    .then((ids) => {
      recentIds = ids.slice(0, RECENT_MAX);
      renderRecentBar();
    })
    .catch((e) => console.warn("recent_push", e));
}

function matchesFenceSearch(item: FenceItemDto, q: string): boolean {
  const label = item.label.toLowerCase();
  if (label.includes(q)) return true;
  const base = item.path.split(/[/\\]/).pop()?.toLowerCase() ?? "";
  if (base.includes(q)) return true;
  const aliases = SEARCH_ALIASES[item.label] ?? SEARCH_ALIASES[label] ?? [];
  if (aliases.some((a) => a.includes(q) || q.includes(a))) return true;
  for (const tokens of Object.values(SEARCH_ALIASES)) {
    if (tokens.includes(q) && tokens.some((t) => label.includes(t))) return true;
  }
  return false;
}

function focusFenceSearch() {
  const el = document.getElementById("fenceSearch") as HTMLInputElement | null;
  if (!el) return;
  void setTextInputActive(true);
  el.focus();
  el.select();
}

function clearFenceSearch() {
  fenceFilter = "";
  searchSelectedIndex = -1;
  const el = document.getElementById("fenceSearch") as HTMLInputElement | null;
  if (el) el.value = "";
  applyFenceFilter();
}

function updateSearchSelection(rows: HTMLElement[]) {
  rows.forEach((row, idx) => {
    row.classList.toggle("is-selected", idx === searchSelectedIndex);
  });
  const active = rows[searchSelectedIndex];
  active?.scrollIntoView({ block: "nearest" });
}

function getQuickBarItems(): FenceItemDto[] {
  return loadRecentIds()
    .map((id) => findItemById(id))
    .filter((item): item is FenceItemDto => item !== null && !item.id.startsWith("sys-"));
}

function hideRecentBar() {
  const root = document.getElementById("fenceRecent");
  if (!root) return;
  root.hidden = true;
  root.className = "";
  root.innerHTML = "";
}

function renderRecentBar() {
  const root = document.getElementById("fenceRecent");
  if (!root) return;
  if (fenceFilter.trim()) {
    hideRecentBar();
    return;
  }
  const items = getQuickBarItems();
  if (!items.length) {
    hideRecentBar();
    return;
  }
  root.hidden = false;
  root.className = "fence";
  root.innerHTML = `
    <div class="fence-title">最近 <em>${items.length}</em></div>
    <div class="fence-grid">${items.map((item) => fenceAppButton(item, escapeHtml(item.label))).join("")}</div>`;
  wireFenceLaunch(root);
}

function launchFenceItem(path: string, id?: string) {
  if (editing) return;
  if (id) {
    const item = findItemById(id);
    if (item) recordRecentLaunch(item);
  }
  void invoke("fence_launch", { path }).catch((err) => console.error(err));
}

function launchSelectedSearchRow() {
  const rows = getSearchRows();
  if (searchSelectedIndex < 0 || searchSelectedIndex >= rows.length) return;
  const row = rows[searchSelectedIndex];
  const path = row.dataset.path;
  if (!path) return;
  launchFenceItem(path, row.dataset.id);
}

function getSearchRows(): HTMLElement[] {
  const list = document.querySelector("#fenceSearchResults .fence-search-list");
  if (!list) return [];
  return [...list.querySelectorAll<HTMLElement>(".fence-search-row")];
}

function wireGlobalKeys() {
  document.addEventListener("keydown", (e) => {
    const active = document.activeElement;
    const inField = isTextField(active);
    const inSearch = active?.id === "fenceSearch";
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      focusFenceSearch();
      return;
    }

    if (e.key === "/" && !inField) {
      e.preventDefault();
      focusFenceSearch();
      return;
    }

    if (e.key === "Escape") {
      if (fenceFilter.trim() || inSearch) {
        e.preventDefault();
        clearFenceSearch();
        if (inSearch) (active as HTMLInputElement).blur();
      }
      return;
    }

    if (!fenceFilter.trim()) return;

    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const rows = getSearchRows();
      if (!rows.length) return;
      e.preventDefault();
      if (e.key === "ArrowDown") {
        searchSelectedIndex =
          searchSelectedIndex < 0 ? 0 : Math.min(searchSelectedIndex + 1, rows.length - 1);
      } else {
        searchSelectedIndex =
          searchSelectedIndex < 0 ? rows.length - 1 : Math.max(searchSelectedIndex - 1, 0);
      }
      updateSearchSelection(rows);
      return;
    }

    if (e.key === "Enter" && searchSelectedIndex >= 0 && (inSearch || !inField)) {
      const rows = getSearchRows();
      if (!rows.length) return;
      e.preventDefault();
      launchSelectedSearchRow();
    }
  });
}

function highlightLabel(label: string, q: string) {
  if (!q) return escapeHtml(label);
  const lower = label.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return escapeHtml(label);
  const before = escapeHtml(label.slice(0, idx));
  const mid = escapeHtml(label.slice(idx, idx + q.length));
  const after = escapeHtml(label.slice(idx + q.length));
  return `${before}<mark>${mid}</mark>${after}`;
}

function fenceAppButton(
  item: FenceItemDto,
  labelHtml: string,
  extra = ""
) {
  const bg = iconUrl(item.icon, item.label);
  const pathAttr = item.path.replace(/"/g, "&quot;");
  const idAttr = item.id.replace(/"/g, "&quot;");
  return `<button type="button" class="fence-app${extra}" data-id="${idAttr}" data-path="${pathAttr}" title="${escapeHtml(item.label)}">
    <div class="face" style="${bg}"></div>
    <span class="label">${labelHtml}</span>
  </button>`;
}

function wireFenceLaunch(root: HTMLElement) {
  root.querySelectorAll<HTMLButtonElement>(".fence-app, .fence-search-row").forEach((btn) => {
    btn.onclick = (e) => {
      if (fenceSuppressClick) {
        fenceSuppressClick = false;
        e.preventDefault();
        return;
      }
      const path = btn.dataset.path;
      if (!path) return;
      launchFenceItem(path, btn.dataset.id);
    };
  });
}

function applyFenceFilter() {
  const root = document.getElementById("fences");
  const hitsEl = document.getElementById("fenceSearchResults");
  const pane = document.querySelector(".pane-fences");
  if (!root || !hitsEl) return;

  const q = fenceFilter.trim().toLowerCase();
  pane?.classList.toggle("is-searching", Boolean(q));

  if (!q) {
    hitsEl.hidden = true;
    hitsEl.innerHTML = "";
    root.hidden = false;
    root.querySelectorAll<HTMLElement>(".fence").forEach((fence) => {
      fence.hidden = false;
      fence.querySelectorAll<HTMLElement>(".fence-app").forEach((app) => {
        app.hidden = false;
      });
      const n = fence.querySelectorAll(".fence-app").length;
      const em = fence.querySelector(".fence-title em");
      if (em) em.textContent = String(n);
    });
    const total = allFences.reduce((n, f) => n + f.items.length, 0);
    const countEl = document.getElementById("fenceCount");
    if (countEl) countEl.textContent = `· ${total}`;
    renderRecentBar();
    return;
  }

  type Hit = { item: FenceItemDto; fence: string };
  const hits: Hit[] = [];
  for (const f of allFences) {
    for (const item of f.items) {
      if (matchesFenceSearch(item, q)) {
        hits.push({ item, fence: f.name });
      }
    }
  }

  const recentRoot = document.getElementById("fenceRecent");
  if (recentRoot) {
    recentRoot.hidden = true;
  }

  root.hidden = true;
  hitsEl.hidden = false;

  const countEl = document.getElementById("fenceCount");
  if (countEl) countEl.textContent = `· ${hits.length} 匹配`;

  if (!hits.length) {
    const query = escapeHtml(fenceFilter.trim());
    hitsEl.innerHTML = `
      <div class="fence-search-panel">
        <div class="fence-search-empty-wrap">
          <p class="fence-search-empty">无「${query}」</p>
          <p class="fence-search-hint">试试英文名、拼音缩写或路径片段</p>
          <button type="button" class="fence-search-clear" id="fenceSearchClear">清除搜索</button>
        </div>
      </div>`;
    document.getElementById("fenceSearchClear")?.addEventListener("click", () => {
      clearFenceSearch();
      focusFenceSearch();
    });
    searchSelectedIndex = -1;
    return;
  }

  searchSelectedIndex = 0;
  const query = escapeHtml(fenceFilter.trim());
  hitsEl.innerHTML = `
    <div class="fence-search-panel">
      <div class="fence-search-meta"><span>${hits.length} 个结果</span><span class="fence-search-query">${query}</span></div>
      <div class="fence-search-list">
        ${hits
          .map((h, idx) => {
            const bg = iconUrl(h.item.icon, h.item.label);
            const pathAttr = h.item.path.replace(/"/g, "&quot;");
            const idAttr = h.item.id.replace(/"/g, "&quot;");
            const sel = idx === 0 ? " is-selected" : "";
            return `<button type="button" class="fence-search-row${sel}" data-id="${idAttr}" data-path="${pathAttr}" title="${escapeHtml(h.item.label)}">
              <div class="face" style="${bg}"></div>
              <div class="fence-search-row-text">
                <span class="label">${highlightLabel(h.item.label, q)}</span>
                <span class="cat">${escapeHtml(h.fence)}</span>
              </div>
            </button>`;
          })
          .join("")}
      </div>
    </div>`;
  wireFenceLaunch(hitsEl);
}

function collectFenceLayout(): FenceLayout[] {
  const root = document.getElementById("fences");
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>(".fence")]
    .map((fence) => {
      const name = fence.dataset.name ?? "";
      const ids = [...fence.querySelectorAll<HTMLElement>(".fence-app")]
        .map((el) => el.dataset.id ?? "")
        .filter((id) => id && !id.startsWith("sys-"));
      return { name, ids };
    })
    .filter((f) => f.name && f.name !== "系统");
}

function persistFenceOrder() {
  const layout = collectFenceLayout();
  void invoke<FenceDto[]>("fence_save_order", { layout })
    .then((fences) => renderFences(fences))
    .catch((e) => console.error("fence_save_order", e));
}

function refreshFenceCounts() {
  applyFenceFilter();
}

/** Nearest icon to insert before, or null to append. */
function dragInsertTarget(
  grid: HTMLElement,
  x: number,
  y: number,
  dragging: HTMLElement
): HTMLElement | null {
  const apps = [...grid.querySelectorAll<HTMLElement>(".fence-app")].filter(
    (el) => el !== dragging
  );
  for (const app of apps) {
    const r = app.getBoundingClientRect();
    const before =
      y < r.top + r.height / 2 || (y <= r.bottom && x < r.left + r.width / 2);
    if (before) return app;
  }
  return null;
}

function placeDraggingAtPoint(dragging: HTMLElement, x: number, y: number) {
  dragging.style.pointerEvents = "none";
  const under = document.elementFromPoint(x, y);
  dragging.style.pointerEvents = "";
  const grid = under?.closest<HTMLElement>(".fence-grid");
  if (!grid) return;
  const fence = grid.closest<HTMLElement>(".fence");
  if (!fence || fence.dataset.name === "系统") return;

  document
    .querySelectorAll(".fence-grid.drag-over")
    .forEach((el) => el.classList.remove("drag-over"));
  grid.classList.add("drag-over");

  const after = dragInsertTarget(grid, x, y, dragging);
  if (after == null) {
    if (dragging.parentElement !== grid || grid.lastElementChild !== dragging) {
      grid.appendChild(dragging);
    }
  } else if (after !== dragging.nextElementSibling) {
    grid.insertBefore(dragging, after);
  }
}

function endFencePointer(persist: boolean) {
  if (!fencePointer) return;
  const { el, active, id } = fencePointer;
  el.classList.remove("dragging");
  try {
    el.releasePointerCapture(id);
  } catch {
    /* ignore */
  }
  window.removeEventListener("pointermove", onFenceWindowMove);
  window.removeEventListener("pointerup", onFenceWindowUp);
  window.removeEventListener("pointercancel", onFenceWindowCancel);
  document
    .querySelectorAll(".fence-grid.drag-over")
    .forEach((node) => node.classList.remove("drag-over"));
  fencePointer = null;
  if (active) {
    fenceSuppressClick = true;
    refreshFenceCounts();
    if (persist) persistFenceOrder();
  }
}

function onFenceWindowMove(e: PointerEvent) {
  if (!fencePointer || e.pointerId !== fencePointer.id) return;
  const dx = e.clientX - fencePointer.startX;
  const dy = e.clientY - fencePointer.startY;
  if (!fencePointer.active) {
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    fencePointer.active = true;
    fencePointer.el.classList.add("dragging");
  }
  e.preventDefault();
  placeDraggingAtPoint(fencePointer.el, e.clientX, e.clientY);
}

function onFenceWindowUp(e: PointerEvent) {
  if (!fencePointer || e.pointerId !== fencePointer.id) return;
  endFencePointer(true);
}

function onFenceWindowCancel(e: PointerEvent) {
  if (!fencePointer || e.pointerId !== fencePointer.id) return;
  endFencePointer(false);
}

function wireFenceDnD(root: HTMLElement) {
  root.onpointerdown = (e) => {
    if (!editing || e.button !== 0) return;
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>(".fence-app");
    if (!btn || !root.contains(btn)) return;
    if ((btn.dataset.id ?? "").startsWith("sys-")) return;
    if (btn.closest<HTMLElement>(".fence")?.dataset.name === "系统") return;

    fencePointer = {
      id: e.pointerId,
      el: btn,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
    };
    window.addEventListener("pointermove", onFenceWindowMove);
    window.addEventListener("pointerup", onFenceWindowUp);
    window.addEventListener("pointercancel", onFenceWindowCancel);
    try {
      btn.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  root.onpointermove = (e) => {
    const over = (e.target as HTMLElement | null)?.closest<HTMLElement>(".fence-app");
    const next = over
      ? editing
        ? fencePointer?.active
          ? "grabbing"
          : "grab"
        : "pointer"
      : "default";
    void invoke("set_cursor", { icon: next }).catch(() => {});
  };
  root.onpointerleave = () => {
    void invoke("set_cursor", { icon: "default" }).catch(() => {});
  };

  wireFenceLaunch(root);
}

function renderFences(fences: FenceDto[]) {
  allFences = fences;
  const root = document.getElementById("fences");
  if (!root) return;
  let total = 0;
  root.innerHTML = fences
    .map((f) => {
      total += f.items.length;
      const apps = f.items
        .map((item) => fenceAppButton(item, escapeHtml(item.label)))
        .join("");
      return `<div class="fence" data-name="${f.name}">
      <div class="fence-title">${f.name} <em>${f.items.length}</em></div>
      <div class="fence-grid">${apps}</div>
    </div>`;
    })
    .join("");

  const countEl = document.getElementById("fenceCount");
  if (countEl) countEl.textContent = `· ${total}`;

  wireFenceDnD(root);
  applyFenceFilter();
}

async function loadFences() {
  await loadRecentFromDisk();
  try {
    const fences = await invoke<FenceDto[]>("fence_takeover");
    renderFences(fences);
  } catch (e) {
    console.warn("fence_takeover failed, try list", e);
    try {
      const fences = await invoke<FenceDto[]>("fence_list");
      renderFences(fences);
    } catch (e2) {
      console.error(e2);
      const root = document.getElementById("fences");
      if (root) {
        root.innerHTML = `<div class="fence"><div class="fence-title">围栏</div><p style="font-size:11px;color:#6b7a8c;padding:4px">无法接管桌面：${String(e)}</p></div>`;
      }
    }
  }
}

let editing = false;

async function setEditing(on: boolean) {
  editing = on;
  const board = document.getElementById("board");
  const btn = document.getElementById("editToggle");
  board?.classList.toggle("editing", on);
  const hint = on ? "完成 (Win+Shift+D)" : "编辑 (Win+Shift+D)";
  if (btn) btn.title = hint;
  if (btn) btn.setAttribute("aria-label", hint);
  if (on && fenceFilter) {
    fenceFilter = "";
    searchSelectedIndex = -1;
    const search = document.getElementById("fenceSearch") as HTMLInputElement | null;
    if (search) search.value = "";
    applyFenceFilter();
  }
}

async function setTextInputActive(active: boolean) {
  try {
    await invoke("set_keyboard_input", { active });
    if (active) {
      await getCurrentWindow().setFocus();
    }
  } catch (e) {
    console.warn("set_keyboard_input", e);
  }
}

function isTextField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  );
}

function wireTextInputFocus() {
  const onFocus = () => void setTextInputActive(true);
  const onBlur = () => {
    window.setTimeout(() => {
      if (!isTextField(document.activeElement)) {
        void setTextInputActive(false);
      }
    }, 0);
  };
  for (const id of ["fenceSearch", "todoTitle", "todoRule"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("focus", onFocus);
    el.addEventListener("blur", onBlur);
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
  }
}

function wireUi() {
  document.getElementById("editToggle")?.addEventListener("click", () => {
    void setEditing(!editing);
  });

  const autoBtn = document.getElementById("autostartToggle");
  const syncAutostartBtn = async () => {
    if (!autoBtn) return;
    try {
      const on = await invoke<boolean>("autostart_get");
      autoBtn.title = on ? "开机自启：开（点击关闭）" : "开机自启：关（点击开启）";
      autoBtn.setAttribute("aria-label", autoBtn.title);
      autoBtn.classList.toggle("on", on);
    } catch (e) {
      autoBtn.title = String(e);
      autoBtn.classList.remove("on");
    }
  };
  void syncAutostartBtn();
  autoBtn?.addEventListener("click", () => {
    void (async () => {
      try {
        const cur = await invoke<boolean>("autostart_get");
        await invoke<boolean>("autostart_set", { enabled: !cur });
        await syncAutostartBtn();
      } catch (e) {
        alert(String(e));
      }
    })();
  });

  document.getElementById("fenceRestore")?.addEventListener("click", () => {
    if (!confirm("把图标还原回系统桌面？")) return;
    void invoke("fence_restore")
      .then(() => loadFences())
      .catch((e) => alert(String(e)));
  });

  document.getElementById("fenceSearch")?.addEventListener("input", (e) => {
    fenceFilter = (e.target as HTMLInputElement).value;
    searchSelectedIndex = -1;
    applyFenceFilter();
  });
  const fenceSearch = document.getElementById("fenceSearch") as HTMLInputElement | null;
  const syncFenceFilter = () => {
    if (fenceSearch) fenceFilter = fenceSearch.value;
    applyFenceFilter();
  };
  fenceSearch?.addEventListener("compositionend", syncFenceFilter);
  fenceSearch?.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    void setTextInputActive(true);
  });

  const pop = document.getElementById("todoPop");
  document.getElementById("addTodo")?.addEventListener("click", () => {
    pop?.classList.add("show");
    document.getElementById("todoTitle")?.focus();
  });
  document.getElementById("todoCancel")?.addEventListener("click", () => {
    pop?.classList.remove("show");
  });
  document.getElementById("todoSave")?.addEventListener("click", () => {
    const input = document.getElementById("todoTitle") as HTMLInputElement | null;
    const rule = document.getElementById("todoRule") as HTMLSelectElement | null;
    const t = input?.value.trim() || "新待办";
    const r = rule?.value || "once";
    void invoke<ReminderDto[]>("remind_add", { title: t, rule: r })
      .then((items) => {
        renderReminders(items);
        pop?.classList.remove("show");
        if (input) input.value = "";
      })
      .catch((e) => alert(String(e)));
  });

  document.getElementById("ghProfile")?.addEventListener("click", () => {
    openGithubProfile();
  });
  document.getElementById("ghWall")?.addEventListener("click", () => {
    openGithubProfile();
  });

  document.getElementById("mcOpen")?.addEventListener("click", () => {
    void (async () => {
      try {
        const url = await invoke<string>("multica_app_url");
        await openUrl(url);
      } catch (e) {
        console.warn("multica_app_url failed, fallback localhost", e);
        const fallback = "http://localhost:18473";
        try {
          await openUrl(fallback);
        } catch {
          window.open(fallback, "_blank");
        }
      }
    })();
  });
}

window.addEventListener("DOMContentLoaded", () => {
  hideRecentBar();
  tick();
  setInterval(tick, 1000);
  wireUi();
  wireTextInputFocus();
  wireGlobalKeys();
  void listen("desk:toggle-edit", () => {
    void setEditing(!editing);
  });
  // Critical path first; network panels deferred to cut peak startup memory.
  void loadReminders();
  void loadFences();
  void setEditing(false);
  window.setTimeout(() => {
    void loadGithub();
    void loadMultica();
    setInterval(() => {
      void loadGithub();
      void loadMultica();
    }, PANEL_REFRESH_MS);
  }, 800);
});
