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
  // **改这里 = e2e/style-baseline.json 全体失效**：必须同时 `UPDATE_STYLE_BASELINE=1
  // npm run test:style` 并逐行 review diff。规则在 panel.css，照选择器去搜（**别写行号**）。
  // `collapsed` / `rows` **参与渲染**（`.is-collapsed` / `.fence-grid.rows-N`），默认值必须是
  // 「不收起 + 自动」才录得出纯新增的基线 —— 想录别的状态用 `__MOCK_UI_PRESET__` 现改
  // （用法见下面那个钩子的定义），**别改默认值**。
  const FENCE_FIXTURE = [
    {
      name: "游戏",
      collapsed: false,
      rows: 0,
      items: [
        { id: "d-lol-0", label: "英雄联盟", path: "C:\\Desktop\\英雄联盟.lnk", icon: null, is_dir: false },
        { id: "d-cs2-0", label: "counter-strike 2", path: "C:\\Desktop\\counter-strike 2.lnk", icon: null, is_dir: false },
        { id: "d-cf-0", label: "穿越火线", path: "C:\\Desktop\\穿越火线.lnk", icon: null, is_dir: false },
        { id: "d-dst-0", label: "饥荒联机版", path: "C:\\Desktop\\饥荒联机版.lnk", icon: null, is_dir: false },
        { id: "d-terraria-0", label: "Terraria", path: "C:\\Desktop\\Terraria.lnk", icon: null, is_dir: false },
      ],
    },
    {
      name: "工具",
      collapsed: false,
      rows: 0,
      items: [
        { id: "d-cursor-0", label: "Cursor", path: "C:\\Desktop\\Cursor.lnk", icon: null, is_dir: false },
        { id: "d-gitbash-0", label: "Git Bash", path: "C:\\Desktop\\Git Bash.lnk", icon: null, is_dir: false },
        { id: "d-pwsh-0", label: "PowerShell", path: "C:\\Desktop\\PowerShell.lnk", icon: null, is_dir: false },
        { id: "d-taskmgr-0", label: "任务管理器", path: "C:\\Desktop\\任务管理器.lnk", icon: null, is_dir: false },
      ],
    },
    {
      name: "工作",
      collapsed: false,
      rows: 0,
      items: [
        { id: "d-feishu-0", label: "飞书", path: "C:\\Desktop\\飞书.lnk", icon: null, is_dir: false },
        { id: "d-paper-0", label: "文献批量阅读助手", path: "C:\\Desktop\\文献批量阅读助手.lnk", icon: null, is_dir: false },
        { id: "d-yuque-0", label: "语雀", path: "C:\\Desktop\\语雀.lnk", icon: null, is_dir: false },
        { id: "d-obsidian-0", label: "Obsidian", path: "C:\\Desktop\\Obsidian.lnk", icon: null, is_dir: false },
      ],
    },
    {
      name: "文件夹",
      collapsed: false,
      rows: 0,
      items: [
        { id: "d-downloads-0", label: "下载", path: "C:\\Desktop\\下载", icon: null, is_dir: true },
        { id: "d-proj-0", label: "项目", path: "C:\\Desktop\\项目", icon: null, is_dir: true },
        { id: "d-shots-0", label: "截图", path: "C:\\Desktop\\截图", icon: null, is_dir: true },
      ],
    },
    {
      name: "系统",
      collapsed: false,
      rows: 0,
      items: [
        { id: "sys-recycle", label: "回收站", path: "shell:RecycleBinFolder", icon: null, is_dir: true },
        { id: "sys-pc", label: "此电脑", path: "shell:MyComputerFolder", icon: null, is_dir: true },
      ],
    },
  ];

  // 最近：不含 `sys-`（useRecents() 会过滤掉它们，过滤后不足 4 条 `#fenceRecent` 就**不渲染**）。
  // ⚠️ 这份数组**按页可变**：recent_push 会就地 unshift，所以断言过「最近」的用例
  // 必须自己保证顺序，不能假设开局那 4 条。
  const RECENT_FIXTURE = ["d-feishu-0", "d-cursor-0", "d-lol-0", "d-obsidian-0"];

  let config = structuredClone(defaultConfig);
  let callbackId = 1;

  // 给 fence-watch.spec.ts 用：**克隆**着改，改不到基线那份（暴露引用的话，一 push 就污染 style-audit 的输入）。
  window.__FENCE_FIXTURE__ = function () {
    return structuredClone(FENCE_FIXTURE);
  };

  // ── 后端状态 ────────────────────────────────────────────────────────────
  // `liveFixture` 是**可变**的那一份：`fence_create` / `fence_rename` / `fence_delete`
  // 的桩就地改它，改完由 `__MOCK_PUSH__()` 推一帧（真机是「ops 写桌面 → watcher 推 fence:changed」）。
  // 与 `FENCE_FIXTURE` 分开是**必须**的：后者是样式基线的输入，被改脏会让 style-audit 在不同状态之间随机飘。
  let liveFixture = structuredClone(FENCE_FIXTURE);
  // 显示偏好必须**在渲染前**摆好（先画默认态再改，样式审查会拍到中间那一帧）：
  //   page.addInitScript(() => { window.__MOCK_UI_PRESET__ = { 工作: { collapsed: true } } })
  // ⚠️ **不能在这里就地读 `__MOCK_UI_PRESET__`**：本文件是第一个 init script，开关脚本排在
  // 它后面，读**永远是 undefined** —— 且失败非常安静（基线照录，录的是默认态）。
  // 所以推迟到第一次 invoke（那时 init script 都跑完了，且仍早于第一帧）。
  let uiPresetApplied = false;
  function applyUiPreset() {
    if (uiPresetApplied) return;
    uiPresetApplied = true;
    const uiPreset = window.__MOCK_UI_PRESET__ || {};
    Object.keys(uiPreset).forEach(function (n) {
      const f = liveFixture.find(function (x) {
        return x.name === n;
      });
      if (!f) throw new Error("mock: __MOCK_UI_PRESET__ 里的围栏不存在 " + n);
      Object.assign(f, uiPreset[n]);
    });
  }
  let createdSeq = 0;

  /** 当前「后端认为的」看板。测试用它拼断言，不要用 __FENCE_FIXTURE__。 */
  window.__MOCK_BOARD__ = function () {
    return structuredClone(liveFixture);
  };

  /**
   * 每个 `invoke` 的记录，形如 `[{ cmd, args }]`。命令名写错由 `default:` 的 throw 兜住，
   * 但**参数名**写错仍看不出来 —— mock 只按命令名分发，不看 args。Tauri 2 的命令参数默认
   * 是 camelCase：写成 `new_name` 真机会 invalid args、mock 里一切正常，只有断言 args 拦得住。
   */
  const mockCalls = [];
  window.__MOCK_CALLS__ = mockCalls;

  // ── 事件送达 ────────────────────────────────────────────────────────────
  // 真机上「后端 emit → 前端 listen 回调」由 Rust 注入的脚本完成（mock 里没有），这几行是
  // 它的替代品 —— 缺了它 `fence:changed` 根本送不到前端。只加回调登记，不动 DOM 形状。
  const callbacks = new Map();
  const eventListeners = []; // { eventId, event, handlerId }
  let eventIdSeq = 0;

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: function () {},
  };

  /** 模拟一次后端 emit。返回**实际送达的回调数** —— 测试断言它 ≥ 1，「桥断了」才会当场红。 */
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

  /** 把「后端当前这一帧」推给前端 —— 真机上这是 watcher 干的活。返回送达的回调数。 */
  window.__MOCK_PUSH__ = function () {
    return window.__deskEmit("fence:changed", structuredClone(liveFixture));
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
      // 第一次被问就把显示偏好落到 liveFixture 上（见上方 applyUiPreset 的 ⚠️）。
      applyUiPreset();
      // 浅拷贝，不用 structuredClone：args 里可能有 Tauri 的回调句柄等不可克隆的东西，
      // 一次抛错会把整个 mock 打死（那是 e2e 全红）。记录先写、再抛，断言里仍能看到调用。
      mockCalls.push({ cmd: cmd, args: Object.assign({}, args) });
      // 让指定命令失败：弹窗那条路（`alert` 报错）真机上只有后端出错才走得到，没这开关就没护栏。
      if ((window.__MOCK_FAIL_CMDS__ || []).indexOf(cmd) !== -1) {
        throw new Error("mock: " + cmd + " 故意失败");
      }
      switch (cmd) {
        // ── 宿主基础命令 ───────────────────────────────────────────────────
        case "boot_mark":
          // Rust: `Result<(), String>` —— 成功就是 null。
          return null;
        case "autostart_get":
          // Rust: `app.autolaunch().is_enabled()` → bool。**真机就是 true**（`lib.rs` 启动 3 秒后
          // 无条件重新登记）；改成 false 会让 8 份基线全红，且 `.icon-btn.on` 从此没有覆盖。
          return true;
        case "autostart_set":
          // Rust: 改完回读 `is_enabled()`，返回**新状态**（不是入参）。
          return !!args.enabled;
        case "sys_res_snapshot":
          // Rust DTO **没有 serde rename**，字段就是 snake_case。给一张**有内容**的表：
          // 全 0 正是 `normalizeSnapshot(undefined)` 的输出，画出来和「没接通」一样。
          return {
            mem_used_bytes: 12884901888,
            mem_total_bytes: 34359738368,
            cpu_pct: 23.5,
            net_down_bps: 1250000,
            net_up_bps: 84000,
            apps: [
              { name: "chrome", mem_bytes: 3221225472, cpu_pct: 8.2, process_count: 14 },
              { name: "Code", mem_bytes: 2147483648, cpu_pct: 5.1, process_count: 9 },
              { name: "desk", mem_bytes: 268435456, cpu_pct: 1.4, process_count: 1 },
            ],
            fetched_at: 1759000000000,
          };
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
          // `__MOCK_KEYBOARD_DELAY_MS__` 拖慢「借键盘」这条 IPC，用来验「租约没到手就不渲染对话框」。
          if (window.__MOCK_KEYBOARD_DELAY_MS__) {
            await new Promise(function (r) {
              setTimeout(r, window.__MOCK_KEYBOARD_DELAY_MS__);
            });
          }
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
          // 两个命令返回同一份数据是刻意的：数据不一致的话样式审查会在两个状态之间随机飘。
          // 返回 `liveFixture`（不是 FENCE_FIXTURE）：ops 改完后端状态后，重读该看到新结果。
          return structuredClone(liveFixture);
        case "fence_save_order": {
          // **桩必须真的重排 `liveFixture`**：真机回吐的是**重排后**的看板，而前端
          // `persistOrder` 拿返回值直接 setFences —— 回吐没重排的会把乐观更新顶掉，
          // 症状是「拖完图标自己弹回去」（**只在 mock 里存在的假失败**）。
          // 语义对齐后端：只认 `layout` 里提到的 id 的**归属**，`sys-` 项不参与重排。
          const layout = Array.isArray(args.layout) ? args.layout : [];
          const byId = new Map();
          liveFixture.forEach(function (f) {
            f.items.forEach(function (it) {
              byId.set(it.id, it);
            });
          });
          const next = {};
          layout.forEach(function (block) {
            if (block.name === "系统") return;
            next[block.name] = (block.ids || [])
              .filter(function (id) {
                return !String(id).startsWith("sys-");
              })
              .map(function (id) {
                return byId.get(id);
              })
              .filter(Boolean);
          });
          // 没被 layout 认领的项（`sys-` 全在这一类里）留在原栏末尾。
          const claimed = new Set();
          Object.keys(next).forEach(function (n) {
            next[n].forEach(function (it) {
              claimed.add(it.id);
            });
          });
          liveFixture.forEach(function (f) {
            const list = next[f.name] || (next[f.name] = []);
            f.items.forEach(function (it) {
              if (!claimed.has(it.id)) list.push(it);
            });
          });
          liveFixture.forEach(function (f) {
            if (next[f.name]) f.items = next[f.name];
          });
          return structuredClone(liveFixture);
        }
        // 显示偏好（收起 / 高度）。与 `fence_save_order` 一样**返回一帧新看板**而不是 null ——
        // 真机这条链是「前端乐观改 → invoke → 用返回值对齐」，返回 null 的话
        // `normalizeFences(undefined)` 会把整个看板清空（mock 特有的假失败）。
        // ⚠️ **不推 `fence:changed`**：这条命令改的是 `fence.json` 不是桌面，真机 watcher
        // 也不会为它响 —— 前端只能靠返回值更新（`useMenuIo` 那个 `ui` 参数的由来）。
        case "fence_save_ui": {
          if (window.__MOCK_SAVE_UI_THROWS__) throw new Error("mock: 显示偏好写入失败");
          const name = String(args.name || "");
          const host = liveFixture.find(function (f) {
            return f.name === name;
          });
          // 真机给不存在的名字**不会**报错；mock 抛是为了让「名字传错了」立刻炸 ——
          // 静默成功的话用例会断言到一个**根本没生效**的状态上。
          if (!host) throw new Error("mock: 没有这个围栏 " + name);
          // `null` = 不改这一项；`rows: 0` = 回到自动。
          if (args.collapsed != null) host.collapsed = Boolean(args.collapsed);
          if (args.rows != null) host.rows = Math.max(0, Number(args.rows) || 0);
          return structuredClone(liveFixture);
        }
        // ── 文件操作命令 ───────────────────────────────────────────────────
        // 参数名按**真机**的 camelCase 写 —— 这几个桩是「前端发的参数名对不对」的落点。
        case "fence_launch":
        case "fence_open_with":
        case "fence_reveal":
        case "fence_clipboard":
        case "fence_paste":
        case "fence_send_to":
        case "fence_compress":
        case "fence_properties":
          // 只记录调用（已经记在 __MOCK_CALLS__ 里），不改后端状态。
          return null;
        case "fence_create": {
          // 真机由后端 classify 决定进哪个围栏；mock 固定塞进「工作」（用例不关心落哪一栏）。
          const name = String(args.name || "");
          const kind = String(args.kind || "");
          const ext = kind === "folder" ? "" : kind === "lnk" ? ".lnk" : ".txt";
          // 与后端同规则：自己带了扩展名就不叠第二层。
          const fileName =
            !ext || name.toLowerCase().endsWith(ext) ? name : name + ext;
          createdSeq += 1;
          const created = {
            // 真机的 id 是 `meta::key(origin, file_name)`；mock 用不会撞的序号就够。
            id: "d-new-" + createdSeq,
            // 看板上文件的 label **没有扩展名**（真机取的是 file_stem）。
            label: ext === ".txt" ? name.replace(/\.txt$/i, "") : name,
            path: "C:\\Desktop\\" + fileName,
            icon: null,
            is_dir: kind === "folder",
          };
          const host = liveFixture.find(function (f) {
            return f.name === "工作";
          });
          if (host) host.items.push(created);
          return null;
        }
        case "fence_rename": {
          const oldPath = String(args.path || "");
          const newName = String(args.newName || "");
          liveFixture.forEach(function (f) {
            f.items.forEach(function (it) {
              if (it.path !== oldPath) return;
              const cut = oldPath.lastIndexOf("\\");
              it.path = (cut < 0 ? "" : oldPath.slice(0, cut + 1)) + newName;
              // label 同样按 file_stem 规则（开头的点不是扩展名，同后端 split_name）。
              const dot = newName.lastIndexOf(".");
              it.label = dot > 0 ? newName.slice(0, dot) : newName;
            });
          });
          return null;
        }
        case "fence_delete": {
          const p = String(args.path || "");
          liveFixture.forEach(function (f) {
            f.items = f.items.filter(function (it) {
              return it.path !== p;
            });
          });
          return null;
        }
        // 桌面图标开关。`__MOCK_ICONS_VISIBLE_THROWS__` 让测试能主动制造「开关读写失败」
        // （`warn` 态基线靠它触发）；默认 falsy，默认态照旧「一切正常」。
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
        // `__MOCK_RECENT_EMPTY__` 模拟「首次运行」：空列表既不能报错，
        // 也不能让 `#fenceRecent` 留一个空壳。
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
          // ⚠️ **不许有兜底返回值 —— 未 mock 的命令必须炸出来。** 静默返回 `{}` 会让
          // 「没 mock」与「真返回空」在 e2e 里完全一样：面板拿着后端永远不产生的形状渲染，
          // 测试全绿而真机 `permission denied`。两条出路：前端真会调 → 补一个写出真实
          // 形状的 case；根本不该被调 → 那是前端 bug，让它炸。
          throw new Error(
            "mock 未覆盖命令: " +
              cmd +
              "\n它不在 e2e/tauri-mock.js 的任何 case 里。" +
              "若前端确实会调用它，请在此补一个 case 并写出真实返回值形状" +
              "（不要用 `return {}` 糊过去 —— 那正是这次要消掉的沉默）。" +
              "\n命令清单见 src/generated/commands.ts。"
          );
      }
    },
  };

  window.isTauri = true;
})();
