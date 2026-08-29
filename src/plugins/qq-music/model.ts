import { asObject, asString } from "../../lib/safe";

export type NowPlaying = {
  active: boolean;
  app_id: string;
  title: string;
  artist: string;
  album: string;
  status: string;
  artwork_path: string | null;
  can_play_pause: boolean;
  can_next: boolean;
  can_prev: boolean;
  installed: boolean;
  install_path: string | null;
  hint: string;
};

export function emptyNowPlaying(hint = ""): NowPlaying {
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
    installed: false,
    install_path: null,
    hint,
  };
}

export function normalizeNowPlaying(raw: unknown): NowPlaying {
  const o = asObject<Record<string, unknown>>(raw);
  if (!o) return emptyNowPlaying();
  return {
    active: Boolean(o.active),
    app_id: asString(o.app_id),
    title: asString(o.title),
    artist: asString(o.artist),
    album: asString(o.album),
    status: asString(o.status, "stopped"),
    artwork_path: o.artwork_path == null ? null : asString(o.artwork_path),
    can_play_pause: Boolean(o.can_play_pause),
    can_next: Boolean(o.can_next),
    can_prev: Boolean(o.can_prev),
    installed: Boolean(o.installed),
    install_path: o.install_path == null ? null : asString(o.install_path),
    hint: asString(o.hint),
  };
}

export function trackKey(d: NowPlaying | null): string {
  if (!d) return "";
  return [d.title, d.artist, d.album, d.artwork_path ?? ""].join("\u0001");
}

export function stabilizeStatus(
  next: NowPlaying,
  prev: NowPlaying | null,
  lastStable: string
): { status: string; lastStable: string } {
  const s = next.status;
  if (s === "playing" || s === "paused" || s === "stopped") {
    return { status: s, lastStable: s };
  }
  if (
    prev &&
    trackKey(prev) === trackKey(next) &&
    (prev.status === "playing" || prev.status === "paused")
  ) {
    return { status: prev.status, lastStable };
  }
  return { status: lastStable, lastStable };
}

export function displayTitle(d: NowPlaying | null): string {
  if (!d) return "连接 QQ 音乐…";
  return d.active ? d.title || "未知曲目" : "未在播放";
}

export function displayArtist(d: NowPlaying | null): string {
  if (!d) return "连接 QQ 音乐中…";
  return d.active ? d.artist || d.album || "QQ 音乐" : d.hint || "连接 QQ 音乐中…";
}
