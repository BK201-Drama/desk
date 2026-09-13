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
  //
  // `is_dir` 是 Task 15 加的：右键菜单靠它决定「打开方式」出不出现。
  // 它**不参与渲染**（没有任何 class / data 属性读它），所以补这个字段
  // 不会动样式基线 —— 加完请跑一次 `npm run test:style` 复核三个基线零 diff。
  // 真机线上一定有这个字段（serde 无条件序列化 bool），所以每个条目都写全。
  //
  // `collapsed` / `rows` 是 2026-09-13（围栏交互）加的：`FenceDto` 上的两个显示偏好，
  // 与 `is_dir` 不同，它们**参与渲染**（`.is-collapsed` / `.fence-grid.rows-N` 两个类）。
  // 于是这份 fixture 的默认值必须是「不收起（false）+ 自动（0）」——
  // 那正是 `gridClass(0)` 返回裸 `"fence-grid"` 的那一支，既有 6 份基线才能重录成**纯新增**。
  // 想录「收起」/「自定义高度」两个新状态，请用 `__MOCK_SAVE_UI__` 现改（见下面
  // `fence_save_ui` 的桩），**不要**把默认值改掉。
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

  // ── 后端状态（Task 15 加的）─────────────────────────────────────────────
  // `liveFixture` 是**可变**的那一份：`fence_create` / `fence_rename` / `fence_delete`
  // 的桩会就地改它，改完由 `__MOCK_PUSH__()` 推一帧给前端 —— 真机上这条链是
  // 「ops 写桌面 → watcher 推 fence:changed」，mock 里就是这两步，别省。
  //
  // 与 `FENCE_FIXTURE` 分开是**必须**的：后者是样式基线的输入，
  // 一旦被某个用例改脏，style-audit 会在不同状态之间随机飘。
  let liveFixture = structuredClone(FENCE_FIXTURE);
  // 首帧之前就把显示偏好摆好。**必须在渲染前**：先画成默认态再改，
  // 样式审查会拍到中间那一帧（收缩态 / 自定义高度态两个基线就靠这个开关）。
  //   page.addInitScript(() => { window.__MOCK_UI_PRESET__ = { 工作: { collapsed: true } } })
  //
  // ⚠️ **不能在这里就地读 `__MOCK_UI_PRESET__`**。本文件是 `addInitScript` 注册的
  // 第一个脚本，测试体里再挂一个 `addInitScript` 去设这个开关时，执行顺序是
  // 「mock 先、开关后」—— 在这里读**永远是 undefined**，而失败方式非常安静：
  // 基线照样录，只是录到的是默认态。（`__MOCK_ICONS_VISIBLE_THROWS__` 没这个毛病，
  // 它是 invoke **运行时**才读的。）所以推迟到第一次 invoke：那时所有 init script
  // 都跑完了，而 `fence_list` 还没被问过，仍早于第一帧。
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
   * 每个 `invoke` 的记录，形如 `[{ cmd, args }]`。
   *
   * 为什么 e2e 需要它：`default:` 分支返回 `{}`，**命令名写错也会「成功」**，
   * 光看界面根本分不出来。而「Tauri 2 的参数是 camelCase」这条约束更是
   * 只有断言 args 才拦得住（写成 `new_name` 在真机上会 invalid args，
   * 在 mock 里却一切正常）。
   */
  const mockCalls = [];
  window.__MOCK_CALLS__ = mockCalls;

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

  /**
   * 把「后端当前这一帧」推给前端 —— 真机上这是 watcher 干的活
   * （`watch.rs:29` 是全仓**唯一**发出 `fence:changed` 的地方）。
   * 返回送达的回调数，测试断言它 ≥ 1，免得「桥断了」被当成「界面没更新」。
   */
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
      // 浅拷贝，不用 structuredClone：args 里可能有 Tauri 的回调句柄等
      // 不可克隆的东西，一次抛错就会把整个 mock 打死（那是 e2e 全红，不是一条失败）。
      mockCalls.push({ cmd: cmd, args: Object.assign({}, args) });
      // 让指定命令失败。弹窗那条路（`alert` 报错）在真机上只有后端出错才走得到，
      // 没有这个开关就等于没有护栏。与 `__MOCK_ICONS_VISIBLE_THROWS__` 同一套路：
      // 记录先写、再抛，所以断言里仍能看到「这个命令被调过」。
      if ((window.__MOCK_FAIL_CMDS__ || []).indexOf(cmd) !== -1) {
        throw new Error("mock: " + cmd + " 故意失败");
      }
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
          // `__MOCK_KEYBOARD_DELAY_MS__` 把「借键盘」这条 IPC 拖慢 —— 用来验
          // 「租约没到手就不渲染对话框」。真机上这个往返是真有耗时的，只是快；
          // 不拖慢的话「先渲染后借」和「先借后渲染」在 e2e 里看不出区别。
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
          // 两个命令返回同一份数据是刻意的：它们读的都是「同一批围栏」，
          // 数据不一致的话样式审查会在两个状态之间随机飘。
          // （旧版的 `fence_takeover` 随 Task 10 删掉了 —— 现在读源是真桌面，
          //  `fence_rescan` 只是「重扫一遍」，结论仍是这份数据。）
          //
          // 返回 `liveFixture`（不是 FENCE_FIXTURE）：ops 改完后端状态之后，
          // 任何一次重读都该看到新结果（Task 15）。开局两者内容相同。
          return structuredClone(liveFixture);
        case "fence_save_order": {
          // 拖拽重排（2026-09-13 起常态可用）。**桩必须真的重排 `liveFixture`**：
          // 真机上这条命令写 `fence.json` 的归属与 order，再 `collect_fences()`
          // 回吐**重排后**的看板，而前端 `persistOrder` 是拿这个返回值直接
          // setFences 的 —— 桩回吐一份没重排的，会把前端刚做的乐观更新顶掉，
          // 症状是「拖完图标自己弹回去」。那是个**只在 mock 里存在**的假失败，
          // 正是文件头警告的那类坑。
          //
          // 语义对齐 `fence_save_order`（src/fence/mod.rs:623）：只认 `layout` 里
          // 提到的那些 id 的**归属**，`sys-` 项不参与重排（后端 `continue` 掉它们）。
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
          // 没被 layout 认领的项（`sys-` 全在这一类里）留在原栏末尾 ——
          // 一次拖拽把别的图标弄丢的话，断言会变成很难读的「图标不见了」。
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
        case "fence_snapshot":
          return { fences: structuredClone(liveFixture), icons: [] };
        // 显示偏好（收起 / 高度，2026-09-13）。与 `fence_save_order` 一样，
        // **返回一帧新看板**而不是 null —— 真机上这条链是
        // 「前端乐观改 → invoke → 用返回值对齐」，返回 null 的话
        // `normalizeFences(undefined)` 会把整个看板清空（那是 mock 特有的假失败）。
        //
        // ⚠️ **不推 `fence:changed`**：这条命令改的是 `fence.json`（看板自己的偏好），
        // 不是桌面，真机上的 watcher 也不会为它响。所以前端只能靠返回值更新 ——
        // 这正是 `useMenuIo` 那个 `ui` 参数存在的原因，别在这里"顺手"补一次推送。
        case "fence_save_ui": {
          if (window.__MOCK_SAVE_UI_THROWS__) throw new Error("mock: 显示偏好写入失败");
          const name = String(args.name || "");
          const host = liveFixture.find(function (f) {
            return f.name === name;
          });
          // 真机上是 `meta::load()` 后按键查表，给一个不存在的名字**不会**报错
          // （entries 里加一条就是了）。mock 这里抛是为了让"名字传错了"立刻炸 ——
          // 静默成功的话，用例会断言到一个**根本没生效**的状态上。
          if (!host) throw new Error("mock: 没有这个围栏 " + name);
          // `null` = 不改这一项（后端那两个参数是 `Option<T>`）；`rows: 0` = 回到自动。
          if (args.collapsed != null) host.collapsed = Boolean(args.collapsed);
          if (args.rows != null) host.rows = Math.max(0, Number(args.rows) || 0);
          return structuredClone(liveFixture);
        }
        // ── Task 14/15 的十个文件操作命令 ────────────────────────────────
        // 参数名按**真机**的 camelCase 写（Tauri 2 默认 camelCase）。桩本身很简单，
        // 但它是「前端发的参数名对不对」这条断言的落点 —— 见 e2e/fence-menu.spec.ts。
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
          // 真机上落到桌面、由 `index.rs` 的 classify 决定进哪个围栏；mock 不模拟
          // 分类，固定塞进「工作」—— 用例只断言「新项出现在看板上」，不关心落哪一栏。
          const name = String(args.name || "");
          const kind = String(args.kind || "");
          const ext = kind === "folder" ? "" : kind === "lnk" ? ".lnk" : ".txt";
          // 与 `ops::with_ext`（ops.rs:223）同规则：自己带了扩展名就不叠第二层。
          const fileName =
            !ext || name.toLowerCase().endsWith(ext) ? name : name + ext;
          createdSeq += 1;
          const created = {
            // 真机的 id 是 `meta::key(origin, file_name)`；mock 用一个不会撞的序号。
            id: "d-new-" + createdSeq,
            // 看板上文件的 label **没有扩展名**（index.rs:74 取的是 file_stem）。
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
              // label 同样按 file_stem 规则（开头的点不是扩展名，同 ops::split_name）。
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
