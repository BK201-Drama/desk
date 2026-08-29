/**
 * Bundled 插件自动发现（L1/L2）
 *
 * 约定：`src/plugins/<id>/manifest.json` + `panel.tsx`
 * - 新增插件：只加目录，不必改本文件
 * - `_` 开头目录（如 `_template`）跳过
 * - 旧面板可继续用 features/ 转发；新面板应自包含在本目录
 */
import type { BundledPlugin, PluginManifest, PluginModule } from "../host/types";

const manifestModules = import.meta.glob("./*/manifest.json", {
  eager: true,
  import: "default",
}) as Record<string, PluginManifest>;

const panelModules = import.meta.glob("./*/panel.tsx") as Record<
  string,
  () => Promise<{ default: PluginModule }>
>;

function pluginDir(globPath: string): string | null {
  const match = /^\.\/([^/]+)\//.exec(globPath);
  if (!match) return null;
  const dir = match[1];
  if (dir.startsWith("_")) return null;
  return dir;
}

function discoverBundledPlugins(): BundledPlugin[] {
  const out: BundledPlugin[] = [];

  for (const [manifestPath, manifest] of Object.entries(manifestModules)) {
    const dir = pluginDir(manifestPath);
    if (!dir) continue;

    const panelPath = `./${dir}/panel.tsx`;
    const loadPanel = panelModules[panelPath];
    if (!loadPanel) {
      console.error(`[plugins] ${dir}: missing panel.tsx (has manifest.json)`);
      continue;
    }

    if (!manifest?.id) {
      console.error(`[plugins] ${dir}: manifest.json missing id`);
      continue;
    }

    if (manifest.id !== dir) {
      console.warn(
        `[plugins] dir "${dir}" ≠ manifest.id "${manifest.id}"; discovery uses folder path, runtime id is manifest.id`
      );
    }

    out.push({
      manifest,
      load: async () => {
        const mod = await loadPanel();
        return mod.default;
      },
    });
  }

  return out.sort(
    (a, b) => (a.manifest.order ?? 100) - (b.manifest.order ?? 100) || a.manifest.id.localeCompare(b.manifest.id)
  );
}

export const bundledPlugins: BundledPlugin[] = discoverBundledPlugins();
