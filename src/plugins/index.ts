/**
 * Bundled 插件自动发现
 *
 * `src/plugins/<id>/manifest.json` + `panel.tsx`
 * - 新增：只加目录；`_` 前缀跳过
 * - 面板自包含；跨插件工具见 `src/lib/`
 */
import type { BundledPlugin, PluginManifest, PluginModule } from "../host/types";
import githubPanel from "./github/panel";
import stockPanel from "./stock/panel";
import tokenCapsulePanel from "./token-capsule/panel";

const manifestModules = import.meta.glob("./*/manifest.json", {
  eager: true,
  import: "default",
}) as Record<string, PluginManifest>;

const panelModules = import.meta.glob([
  "./*/panel.tsx",
  "!./github/panel.tsx",
  "!./stock/panel.tsx",
  "!./token-capsule/panel.tsx",
]) as Record<string, () => Promise<{ default: PluginModule }>>;

/** 首屏关键：打进主包，不走懒加载 chunk */
const EAGER_PANELS: Record<string, PluginModule> = {
  github: githubPanel,
  stock: stockPanel,
  "token-capsule": tokenCapsulePanel,
};

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
    const eager = EAGER_PANELS[manifest.id] ?? EAGER_PANELS[dir];
    const loadPanel = panelModules[panelPath];
    if (!eager && !loadPanel) {
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
      load: eager
        ? async () => eager
        : async () => {
            const mod = await loadPanel!();
            return mod.default;
          },
    });
  }

  return out.sort(
    (a, b) => (a.manifest.order ?? 100) - (b.manifest.order ?? 100) || a.manifest.id.localeCompare(b.manifest.id)
  );
}

export const bundledPlugins: BundledPlugin[] = discoverBundledPlugins();
