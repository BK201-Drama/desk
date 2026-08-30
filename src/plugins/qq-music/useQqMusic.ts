import { useCallback, useEffect, useRef, useState } from "react";
import type { HostContext } from "../../host/types";
import {
  displayArtist,
  displayTitle,
  emptyNowPlaying,
  normalizeNowPlaying,
  stabilizeStatus,
  trackKey,
  type NowPlaying,
} from "./model";

export function useQqMusic(ctx: HostContext) {
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [flash, setFlash] = useState("");
  const npRef = useRef<NowPlaying | null>(null);
  const lastStable = useRef("stopped");
  const artBust = useRef({ key: "", t: 0 });
  const refreshing = useRef(false);
  const flashTimer = useRef<number | null>(null);

  useEffect(() => {
    npRef.current = np;
  }, [np]);

  const flashMsg = useCallback((msg: string) => {
    setFlash(msg);
    if (flashTimer.current != null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => {
      setFlash("");
      flashTimer.current = null;
    }, 1800);
  }, []);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    const prev = npRef.current;
    try {
      const raw = await ctx.invoke("qqmusic_now_playing");
      const next = normalizeNowPlaying(raw);
      const stab = stabilizeStatus(next, prev, lastStable.current);
      lastStable.current = stab.lastStable;
      next.status = stab.status;
      setNp(next);
    } catch (e) {
      console.warn("qqmusic_now_playing", e);
      setNp(emptyNowPlaying(String(e)));
    } finally {
      refreshing.current = false;
    }
  }, [ctx]);

  const act = useCallback(
    async (kind: "toggle" | "next" | "prev") => {
      const cmd =
        kind === "toggle"
          ? "qqmusic_toggle"
          : kind === "next"
            ? "qqmusic_next"
            : "qqmusic_prev";
      const cur = npRef.current;
      const looksDown =
        !cur || (!cur.active && cur.status !== "playing" && cur.status !== "paused");
      if (looksDown) flashMsg("正在启动 QQ 音乐…");
      try {
        const r = await ctx.invoke<{ cold_started?: boolean }>(cmd);
        ctx.emit("qqmusic:control", { kind, cold_started: !!r?.cold_started });
        if (r?.cold_started) {
          flashMsg("已启动，正在播放…");
          window.setTimeout(() => void refresh(), 1500);
          window.setTimeout(() => void refresh(), 3500);
          return;
        }
        if (kind === "toggle" && npRef.current) {
          const status = npRef.current.status === "playing" ? "paused" : "playing";
          lastStable.current = status;
          setNp({ ...npRef.current, status });
        }
        window.setTimeout(() => void refresh(), kind === "toggle" ? 400 : 800);
      } catch (e) {
        console.warn(cmd, e);
        flashMsg(String(e));
      }
    },
    [ctx, flashMsg, refresh]
  );

  const launchForeground = useCallback(async () => {
    try {
      await ctx.invoke("qqmusic_launch");
    } catch {
      await ctx.openUrl("https://y.qq.com/");
    }
  }, [ctx]);

  const artUrl = useCallback(
    (path: string | null, track: string) => {
      if (!path) return "";
      if (track !== artBust.current.key) {
        artBust.current = { key: track, t: Date.now() };
      }
      try {
        return `${ctx.convertFileSrc(path)}?t=${artBust.current.t}`;
      } catch {
        return "";
      }
    },
    [ctx]
  );

  useEffect(() => {
    // 不在挂载时 ensure_running：冷启动会弹 QQ 主窗，开机也拖慢 desk。
    // 仅轮询 SMTC；用户点播控时再由 toggle/next 冷启动。
    const boot = window.setTimeout(() => void refresh(), 1200);
    const iv = window.setInterval(() => void refresh(), 2500);
    return () => {
      window.clearTimeout(boot);
      window.clearInterval(iv);
      if (flashTimer.current != null) window.clearTimeout(flashTimer.current);
    };
  }, [ctx, refresh]);

  const title = displayTitle(np);
  const artistLine = flash || displayArtist(np);
  const playing = np?.status === "playing";
  const cover = artUrl(np?.artwork_path ?? null, trackKey(np));

  return { title, artistLine, playing, cover, act, launchForeground, refresh };
}
