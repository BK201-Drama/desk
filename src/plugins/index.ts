import type { BundledPlugin, PluginManifest } from "../host/types";
import clockManifest from "./clock/manifest.json";
import githubManifest from "./github/manifest.json";
import multicaManifest from "./multica/manifest.json";
import remindManifest from "./remind/manifest.json";
import fenceManifest from "./fence/manifest.json";
import helloManifest from "./hello/manifest.json";
import opsHudManifest from "./ops-hud/manifest.json";
import cmdkManifest from "./cmdk/manifest.json";
import eventTapeManifest from "./event-tape/manifest.json";
import qqMusicManifest from "./qq-music/manifest.json";
import stockManifest from "./stock/manifest.json";
import tokenCapsuleManifest from "./token-capsule/manifest.json";

function m(raw: unknown): PluginManifest {
  return raw as PluginManifest;
}

export const bundledPlugins: BundledPlugin[] = [
  {
    manifest: m(clockManifest),
    load: async () => (await import("./clock/panel")).default,
  },
  {
    manifest: m(githubManifest),
    load: async () => (await import("./github/panel")).default,
  },
  {
    manifest: m(tokenCapsuleManifest),
    load: async () => (await import("./token-capsule/panel")).default,
  },
  {
    manifest: m(multicaManifest),
    load: async () => (await import("./multica/panel")).default,
  },
  {
    manifest: m(remindManifest),
    load: async () => (await import("./remind/panel")).default,
  },
  {
    manifest: m(stockManifest),
    load: async () => (await import("./stock/panel")).default,
  },
  {
    manifest: m(qqMusicManifest),
    load: async () => (await import("./qq-music/panel")).default,
  },
  {
    manifest: m(fenceManifest),
    load: async () => (await import("./fence/panel")).default,
  },
  {
    manifest: m(helloManifest),
    load: async () => (await import("./hello/panel")).default,
  },
  {
    manifest: m(opsHudManifest),
    load: async () => (await import("./ops-hud/panel")).default,
  },
  {
    manifest: m(cmdkManifest),
    load: async () => (await import("./cmdk/panel")).default,
  },
  {
    manifest: m(eventTapeManifest),
    load: async () => (await import("./event-tape/panel")).default,
  },
];
