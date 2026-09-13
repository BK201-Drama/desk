/** Browser init script — Playwright addInitScript({ path }) */
(function () {
  const defaultConfig = {
    active_preset: "coder",
    disabled: ["hello", "ops-hud", "event-tape"],
    order: ["github", "multica", "remind", "fence", "qq-music", "clock", "cmdk"],
    schemes: [],
    active_scheme_id: null,
  };

  const presets = [
    { id: "coder", name: "程序员", description: "默认开发布局" },
    { id: "minimal", name: "极简", description: "最少面板" },
    { id: "fence", name: "围栏", description: "仅围栏" },
  ];

  // ── 样式审查 fixture（e2e/style-audit.spec.ts 的输入）────────────────────
  // 这份数据决定看板围栏区的 DOM 形状，而 e2e/style-baseline.json 是从这个 DOM 录的。
  // **改这里 = 基线全体失效**：必须同时 `UPDATE_STYLE_BASELINE=1 npm run test:style`
  // 并逐行 review diff。
  //
  // 覆盖 styles.css 里所有有分支的形状：
  //   游戏 / 工具  → --fence-rows: 3   (styles.css:1084-1086)
  //   工作 / 系统  → --fence-rows: 1   (styles.css:1088-1090)
  //   最近         → #fenceRecent:not([hidden])，4 列 1 行 (styles.css:1236-1244)
  const FENCE_FIXTURE = [
    {
      name: "游戏",
      items: [
        { id: "d-lol-0", label: "英雄联盟", path: "C:\\Desktop\\英雄联盟.lnk", icon: null },
        { id: "d-cs2-0", label: "counter-strike 2", path: "C:\\Desktop\\counter-strike 2.lnk", icon: null },
        { id: "d-cf-0", label: "穿越火线", path: "C:\\Desktop\\穿越火线.lnk", icon: null },
        { id: "d-dst-0", label: "饥荒联机版", path: "C:\\Desktop\\饥荒联机版.lnk", icon: null },
        { id: "d-terraria-0", label: "Terraria", path: "C:\\Desktop\\Terraria.lnk", icon: null },
      ],
    },
    {
      name: "工具",
      items: [
        { id: "d-cursor-0", label: "Cursor", path: "C:\\Desktop\\Cursor.lnk", icon: null },
        { id: "d-gitbash-0", label: "Git Bash", path: "C:\\Desktop\\Git Bash.lnk", icon: null },
        { id: "d-pwsh-0", label: "PowerShell", path: "C:\\Desktop\\PowerShell.lnk", icon: null },
        { id: "d-taskmgr-0", label: "任务管理器", path: "C:\\Desktop\\任务管理器.lnk", icon: null },
      ],
    },
    {
      name: "工作",
      items: [
        { id: "d-feishu-0", label: "飞书", path: "C:\\Desktop\\飞书.lnk", icon: null },
        { id: "d-paper-0", label: "文献批量阅读助手", path: "C:\\Desktop\\文献批量阅读助手.lnk", icon: null },
        { id: "d-yuque-0", label: "语雀", path: "C:\\Desktop\\语雀.lnk", icon: null },
        { id: "d-obsidian-0", label: "Obsidian", path: "C:\\Desktop\\Obsidian.lnk", icon: null },
      ],
    },
    {
      name: "文件夹",
      items: [
        { id: "d-downloads-0", label: "下载", path: "C:\\Desktop\\下载", icon: null },
        { id: "d-proj-0", label: "项目", path: "C:\\Desktop\\项目", icon: null },
        { id: "d-shots-0", label: "截图", path: "C:\\Desktop\\截图", icon: null },
      ],
    },
    {
      name: "系统",
      items: [
        { id: "sys-recycle", label: "回收站", path: "shell:RecycleBinFolder", icon: null },
        { id: "sys-pc", label: "此电脑", path: "shell:MyComputerFolder", icon: null },
      ],
    },
  ];

  // 最近：4 条，跨 工作 / 工具 / 游戏 三个围栏。不含 sys- —— useRecents() 会过滤掉
  // （src/plugins/fence/recent/index.ts），过滤后不足 4 条 #fenceRecent 就不显示。
  //
  // ⚠️ 这份数组**按页可变**：recent_push 会就地 unshift，后续 recent_list 就返回新内容。
  // 所以同一个测试文件里，断言过「最近」的用例必须自己保证顺序，不能假设开局那 4 条。
  const RECENT_FIXTURE = ["d-feishu-0", "d-cursor-0", "d-lol-0", "d-obsidian-0"];

  let config = structuredClone(defaultConfig);
  let callbackId = 1;

  // 给 fence-watch.spec.ts 用：拿一份**克隆**去改，改不到基线那份。
  // 直接暴露数组引用的话，测试里一 push 就同时污染了 style-audit 的输入。
  window.__FENCE_FIXTURE__ = function () {
    return structuredClone(FENCE_FIXTURE);
  };

  // ── 事件送达 ────────────────────────────────────────────────────────────
  // 真机上「后端 emit → 前端 listen 回调」是 Rust 注入的脚本干的
  // （`window.__TAURI_INTERNALS__.runCallback(handlerId, eventData)`，
  //  tauri-2.11.5/src/event/mod.rs 的 event_initialization_script）。mock 里
  // 没有那个脚本，所以这几行是它的替代品 —— Task 13 起 `fence:changed` 要走
  // 这条路进前端，之前 `plugin:event|listen` 直接 `return 1` 吞掉回调，
  // 事件根本送不到。
  //
  // 改这里**不会**影响样式基线：只加回调登记，DOM 形状一个字节没动。
  const callbacks = new Map();
  const eventListeners = []; // { eventId, event, handlerId }
  let eventIdSeq = 0;

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: function () {},
  };

  /**
   * 模拟一次后端 emit。返回**实际送达的回调数** —— 测试断言它 ≥ 1，
   * 这样「桥断了」会当场红，而不是安静地什么都没发生。
   */
  window.__deskEmit = function (event, payload) {
    let n = 0;
    for (const l of eventListeners.slice()) {
      if (l.event !== event) continue;
      const cb = callbacks.get(l.handlerId);
      if (!cb) continue;
      cb({ event: event, id: l.eventId, payload: payload });
      n += 1;
    }
    return n;
  };

  window.__TAURI_INTERNALS__ = {
    transformCallback: function (cb) {
      callbackId += 1;
      if (typeof cb === "function") callbacks.set(callbackId, cb);
      return callbackId;
    },
    runCallback: function (id, payload) {
      const cb = callbacks.get(id);
      if (cb) cb(payload);
    },
    convertFileSrc: function (path) {
      return path;
    },
    invoke: async function (cmd, args) {
      args = args || {};
      switch (cmd) {
        case "plugin_get_config":
          return config;
        case "plugin_list_user":
          return [];
        case "plugin_list_presets":
          return presets;
        case "plugin_set_disabled": {
          const id = args.id;
          const disabled = args.disabled;
          const dis = new Set(config.disabled || []);
          if (disabled) dis.add(id);
          else dis.delete(id);
          config = Object.assign({}, config, { disabled: Array.from(dis) });
          return config;
        }
        case "plugin_set_order":
          config = Object.assign({}, config, {
            order: args.order,
            active_preset: "scheme",
          });
          return config;
        case "plugin_apply_preset":
          config = Object.assign({}, config, {
            active_preset: args.id,
            active_scheme_id: null,
          });
          return config;
        case "plugin_apply_scheme": {
          const scheme = (config.schemes || []).find(function (s) {
            return s.id === args.id;
          });
          if (scheme) {
            config = Object.assign({}, config, {
              active_preset: "scheme",
              active_scheme_id: scheme.id,
              disabled: scheme.disabled.slice(),
              order: scheme.order.slice(),
            });
          }
          return config;
        }
        case "plugin_create_scheme": {
          const schemes = (config.schemes || []).slice();
          if (schemes.length >= 3) return config;
          const id = "scheme-" + Date.now();
          const name = (args.name && String(args.name).trim()) || "方案 " + (schemes.length + 1);
          schemes.push({
            id: id,
            name: name,
            disabled: (config.disabled || []).slice(),
            order: (config.order || []).slice(),
          });
          config = Object.assign({}, config, {
            schemes: schemes,
            active_preset: "scheme",
            active_scheme_id: id,
          });
          return config;
        }
        case "plugin_update_scheme": {
          const schemes = (config.schemes || []).map(function (s) {
            if (s.id !== args.id) return s;
            return Object.assign({}, s, {
              name: (args.name && String(args.name).trim()) || s.name,
              disabled: (config.disabled || []).slice(),
              order: (config.order || []).slice(),
            });
          });
          config = Object.assign({}, config, {
            schemes: schemes,
            active_preset: "scheme",
            active_scheme_id: args.id,
          });
          return config;
        }
        case "plugin_delete_scheme": {
          const schemes = (config.schemes || []).filter(function (s) {
            return s.id !== args.id;
          });
          config = Object.assign({}, config, {
            schemes: schemes,
            active_preset: "coder",
            active_scheme_id: null,
          });
          return config;
        }
        case "plugin_discard_custom_draft":
          config = Object.assign({}, config, {
            active_preset: "coder",
            active_scheme_id: null,
          });
          return config;
        case "set_keyboard_input":
          return null;
        case "plugin:event|listen": {
          eventIdSeq += 1;
          eventListeners.push({
            eventId: eventIdSeq,
            event: args.event,
            handlerId: args.handler,
          });
          return eventIdSeq;
        }
        case "plugin:event|unlisten": {
          const i = eventListeners.findIndex(function (l) {
            return l.eventId === args.eventId;
          });
          if (i >= 0) eventListeners.splice(i, 1);
          return null;
        }
        case "remind_list":
          return [];
        case "github_snapshot":
          return {
            login: "mock",
            name: "Mock",
            bio: "",
            avatar_url: "",
            streak: 0,
            year_total: 0,
            weeks: [],
            contrib_cells: [],
            pins: [],
            langs: [],
            cached: true,
            error: null,
          };
        case "github_cached":
          return {
            login: "mock",
            name: "Mock",
            bio: "",
            avatar_url: "",
            streak: 0,
            year_total: 0,
            weeks: [],
            contrib_cells: [],
            pins: [],
            langs: [],
            cached: true,
            error: null,
          };
        case "multica_snapshot":
          return {
            app_url: "http://localhost:18473",
            inbox: 0,
            doing: 0,
            review: 0,
            issues: [],
            runtime_online: false,
            cached: true,
            error: null,
          };
        case "stock_quotes":
        case "stock_cached":
          return [];
        case "cursor_usage":
        case "cursor_cached":
          return {
            ok: false,
            remaining_pct: 0,
            used_pct: 0,
            auto_pct_used: 0,
            api_pct_used: 0,
            included_limit_usd: 0,
            included_used_usd: 0,
            included_remaining_usd: 0,
            total_spend_usd: 0,
            message: "",
            auto_message: "",
            api_message: "",
            billing_cycle_end_ms: null,
            hit_limit: false,
            hint: "mock",
          };
        case "fence_list":
        case "fence_rescan":
        case "fence_save_order":
          // 三个命令返回同一份数据是刻意的：它们读的都是「同一批围栏」，
          // 数据不一致的话样式审查会在两个状态之间随机飘。
          // （旧版的 `fence_takeover` 随 Task 10 删掉了 —— 现在读源是真桌面，
          //  `fence_rescan` 只是「重扫一遍」，结论仍是这份数据。）
          return structuredClone(FENCE_FIXTURE);
        case "fence_snapshot":
          return { fences: structuredClone(FENCE_FIXTURE), icons: [] };
        // 桌面图标开关。`__MOCK_ICONS_VISIBLE_THROWS__` 让测试能主动制造
        // 「开关读写失败」—— `warn` 态基线就是靠它触发的。默认 falsy，
        // 所以默认态 / 搜索态仍然是「一切正常」。
        case "fence_icons_visible":
          if (window.__MOCK_ICONS_VISIBLE_THROWS__) {
            throw new Error("mock: 读写桌面图标开关失败");
          }
          return true;
        case "fence_set_icons_visible":
          if (window.__MOCK_ICONS_VISIBLE_THROWS__) {
            throw new Error("mock: 读写桌面图标开关失败");
          }
          return !!args.visible;
        // `__MOCK_RECENT_EMPTY__` 模拟「首次运行 / 删掉 recent-launches.json」：
        // 空列表既不能报错，也不能让 #fenceRecent 留一个空壳（旧代码用
        // `recents.length > 0 ? … : null` 挡住的那个洞）。
        case "recent_list":
          return window.__MOCK_RECENT_EMPTY__ ? [] : RECENT_FIXTURE.slice();
        case "recent_push": {
          if (window.__MOCK_RECENT_EMPTY__) return [];
          const rid = args.id;
          if (typeof rid === "string" && rid && !RECENT_FIXTURE.includes(rid)) {
            RECENT_FIXTURE.unshift(rid);
          }
          return RECENT_FIXTURE.slice(0, 4);
        }
        case "qqmusic_now_playing":
        case "qqmusic_status":
        case "qqmusic_snapshot":
          return {
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
            installed: true,
            install_path: null,
            hint: "mock",
          };
        default:
          // Prefer empty collections over null so vanilla plugins don't NPE in E2E
          if (/_list$/.test(cmd)) return [];
          if (/_snapshot$/.test(cmd)) return {};
          return {};
      }
    },
  };

  window.isTauri = true;
})();
