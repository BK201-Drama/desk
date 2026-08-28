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
        case "plugin_apply_scheme":
        case "plugin_create_scheme":
        case "plugin_update_scheme":
        case "plugin_delete_scheme":
        case "plugin_discard_custom_draft":
          return config;
        case "set_keyboard_input":
          return null;
        case "plugin:event|listen":
          return 1;
        case "plugin:event|unlisten":
          return null;
        default:
          return null;
      }
    },
  };

  window.isTauri = true;
})();
