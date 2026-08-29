import { useEffect } from "react";
import type { PluginComponentProps } from "../../host/types";
import { useQqMusic } from "./useQqMusic";
import "./panel.css";

const ICON_PREV = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 6h2v12H6V6zm3.5 6 8.5 6V6l-8.5 6z" />
  </svg>
);
const ICON_NEXT = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M16 6h2v12h-2V6zM6 18l8.5-6L6 6v12z" />
  </svg>
);
const ICON_PLAY = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 5v14l11-7L8 5z" />
  </svg>
);
const ICON_PAUSE = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 5h4v14H6V5zm8 0h4v14h-4V5z" />
  </svg>
);

export function QqMusicPanel({ ctx }: PluginComponentProps) {
  const { title, artistLine, playing, cover, act, launchForeground, refresh } = useQqMusic(ctx);

  useEffect(() => {
    const unsubs = [
      ctx.registerCommand({
        id: "toggle",
        title: "播放/暂停",
        group: "媒体",
        run: () => void act("toggle"),
      }),
      ctx.registerCommand({
        id: "next",
        title: "下一首",
        group: "媒体",
        run: () => void act("next"),
      }),
      ctx.registerCommand({
        id: "launch",
        title: "QQ 音乐前台",
        group: "媒体",
        run: () => void launchForeground(),
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [ctx, act, launchForeground, refresh]);

  return (
    <div className={`qqm-card${playing ? " is-playing" : ""}`} data-testid="qq-music-panel">
      <button
        type="button"
        className="qqm-art"
        title="打开 QQ 音乐前台"
        style={cover ? { backgroundImage: `url('${cover.replace(/'/g, "%27")}')` } : undefined}
        onClick={() => void launchForeground()}
      >
        {!cover && <span className="qqm-art-fallback">♪</span>}
      </button>
      <div className="qqm-title" title={title}>
        {title}
      </div>
      <div className="qqm-artist" title={artistLine}>
        {artistLine}
      </div>
      <div className="qqm-transport" role="group" aria-label="播放控制">
        <button
          type="button"
          className="qqm-ctrl"
          title="上一首"
          aria-label="上一首"
          onClick={() => void act("prev")}
        >
          {ICON_PREV}
        </button>
        <button
          type="button"
          className="qqm-ctrl qqm-play"
          title="播放/暂停"
          aria-label="播放/暂停"
          onClick={() => void act("toggle")}
        >
          {playing ? ICON_PAUSE : ICON_PLAY}
        </button>
        <button
          type="button"
          className="qqm-ctrl"
          title="下一首"
          aria-label="下一首"
          onClick={() => void act("next")}
        >
          {ICON_NEXT}
        </button>
      </div>
    </div>
  );
}

export default QqMusicPanel;
