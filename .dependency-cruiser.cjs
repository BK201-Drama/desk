/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "plugin-must-not-import-other-plugin",
      severity: "error",
      comment: "A desk plugin may use host, app, and lib. It may not reach into another plugin.",
      from: { path: "^src/plugins/([^/]+)/" },
      to: { path: "^src/plugins/", pathNot: "^src/plugins/$1" },
    },
    {
      name: "lib-must-not-import-plugins-or-app",
      severity: "error",
      from: { path: "^src/lib/" },
      to: { path: "^src/(plugins|app)/" },
    },
    {
      name: "host-must-not-import-plugins-or-app",
      severity: "error",
      comment: "Runtime host code stays under plugins. Tests may import a plugin fixture.",
      from: { path: "^src/host/", pathNot: "\\.test\\.tsx?$" },
      to: { path: "^src/(plugins|app)/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
  },
};
