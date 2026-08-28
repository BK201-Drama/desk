import { useEffect, useRef, type ReactNode } from "react";
import type { PluginComponentProps } from "../../host/types";
import { formatContribTip, type GithubSnapshot } from "../../domain/github";
import { useGithubSnapshot, useLocalClock } from "../../application/github/useGithubSnapshot";
import { setSyncStatus } from "../../host/util";

function ContribGrid({
  snap,
  onDay,
}: {
  snap: GithubSnapshot;
  onDay: (date: string) => void;
}) {
  const cells = snap.contrib_cells;
  const nodes: ReactNode[] = [];
  let i = 0;
  for (const week of snap.weeks) {
    for (let d = 0; d < 7; d++) {
      const meta = cells[i];
      const lv = meta?.level ?? week[d] ?? 0;
      const date = meta?.date;
      nodes.push(
        <div
          key={i}
          className={`cell l${lv}${date ? " has-day" : ""}`}
          title={date ? formatContribTip(date, meta?.count ?? 0) : undefined}
          onClick={(e) => {
            if (!date) return;
            e.stopPropagation();
            onDay(date);
          }}
        />
      );
      i += 1;
    }
  }
  return <div className="grid">{nodes}</div>;
}

export function GithubPanel({ ctx }: PluginComponentProps) {
  const { snap, errorText, refresh } = useGithubSnapshot(ctx);
  const clock = useLocalClock();
  const syncRef = useRef<HTMLSpanElement>(null);

  const profileUrl = snap?.login ? `https://github.com/${snap.login}` : "";

  useEffect(() => {
    const unsubs = [
      ctx.registerCommand({
        id: "sync",
        title: "同步 GitHub",
        group: "GitHub",
        run: () => void refresh(),
      }),
      ctx.registerCommand({
        id: "open-profile",
        title: "打开 GitHub 主页",
        group: "GitHub",
        run: () => {
          if (profileUrl) void ctx.openUrl(profileUrl);
        },
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [ctx, refresh, profileUrl]);

  useEffect(() => {
    if (!syncRef.current || !snap) return;
    setSyncStatus(syncRef.current, Date.now(), !errorText, snap.cached, snap.error);
  }, [snap, errorText]);

  const openProfile = () => {
    if (profileUrl) void ctx.openUrl(profileUrl);
  };

  const name = snap?.name || snap?.login || "…";
  const handle = snap?.login ? `@${snap.login}` : "@…";
  const bio = errorText
    ? `GitHub 未接通：${errorText}`
    : snap?.bio || (snap ? "—" : "加载 GitHub…");
  const avatarLetter = (snap?.name || snap?.login || "?").slice(0, 1).toUpperCase();

  return (
    <div data-testid="github-panel">
      <div
        className={`profile${profileUrl ? " gh-link" : ""}`}
        title={profileUrl ? "打开 GitHub 主页" : ""}
        onClick={openProfile}
      >
        <div
          className={`avatar${snap?.avatar_url ? " has-img" : ""}`}
          style={
            snap?.avatar_url ? { backgroundImage: `url('${snap.avatar_url}')` } : undefined
          }
        >
          {snap?.avatar_url ? "" : avatarLetter}
        </div>
        <div className="profile-text">
          <div className="name">
            <span>{name}</span> <span className="handle">{handle}</span>
          </div>
          <div className="bio" title={snap?.cached && snap.error ? `缓存数据：${snap.error}` : undefined}>
            {bio}
          </div>
        </div>
        <div className="stats">
          <b>{snap ? snap.streak : "—"}</b>
          <span>day streak</span>
        </div>
      </div>
      <div className="row-clock-wall">
        <div className="clock">
          <div className="clock-time">{clock.time}</div>
          <div className="clock-date">{clock.date}</div>
          <div className="streak">
            今年 <strong>{snap ? snap.year_total : "—"}</strong>
          </div>
        </div>
        <div
          className={`wall${profileUrl ? " gh-link" : ""}`}
          title={profileUrl ? "打开 GitHub 主页" : ""}
          onClick={openProfile}
        >
          <div className="wall-meta">
            <span>Contributions</span>
            <span className="sync-hint" ref={syncRef}>
              GitHub …
            </span>
          </div>
          {snap ? (
            <ContribGrid
              snap={snap}
              onDay={(date) => {
                if (!snap.login) return;
                void ctx.openUrl(
                  `https://github.com/${snap.login}?from=${date}&to=${date}`
                );
              }}
            />
          ) : (
            <div className="grid" />
          )}
        </div>
      </div>
      <div className="section-label">Pinned</div>
      <div className="pins">
        {(snap?.pins ?? []).map((p) => (
          <div key={p.repo} className="pin">
            <div className="repo">{p.repo}</div>
            <div className="desc">{p.desc || "—"}</div>
            <div className="meta">
              <span>
                <i className="lang-dot" style={{ background: p.lang }} />
                {p.lang_name}
              </span>
              <span>★ {p.stars}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="section-label">Languages</div>
      <div className="langs">
        <div className="lang-bar">
          {(snap?.langs ?? []).map((l) => (
            <i key={l.name} style={{ width: `${l.pct}%`, background: l.color }} />
          ))}
        </div>
        <div className="lang-legend">
          {(snap?.langs ?? []).map((l) => (
            <span key={l.name} style={{ ["--c" as string]: l.color }}>
              {l.name} {l.pct}%
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export default GithubPanel;
