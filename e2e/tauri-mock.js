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

  let config = structuredClone(defaultConfig);
  let callbackId = 1;

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: function () {},
  };

  window.__TAURI_INTERNALS__ = {
    transformCallback: function (cb) {
      callbackId += 1;
      return callbackId;
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
        case "plugin:event|listen":
          return 1;
        case "plugin:event|unlisten":
          return null;
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
        case "fence_list":
        case "fence_takeover":
        case "fence_save_order":
          return [];
        case "fence_snapshot":
          return { fences: [], icons: [] };
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
