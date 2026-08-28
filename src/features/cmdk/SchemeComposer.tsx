import {
  activeScheme,
  chipLabel,
  MAX_SCHEMES,
} from "../../domain/layout";
import { QUICK_PRESETS } from "../../domain/cmdk";
import {
  buildSchemeComposerView,
  isBuiltinActive,
  useSchemeActions,
} from "../../application/cmdk/useSchemeActions";
import { useLayoutConfig } from "../../application/layout/useLayoutConfig";
import { useEffect, useState } from "react";

function TrackChips({ ids, emptyText }: { ids: string[]; emptyText: string }) {
  if (!ids.length) {
    return <span className="cmdk-chip empty">{emptyText}</span>;
  }
  return (
    <>
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 && <span className="cmdk-chip-sep">›</span>}
          <span className="cmdk-chip">{chipLabel(id)}</span>
        </span>
      ))}
    </>
  );
}

type Props = {
  hidden: boolean;
};

export function SchemeComposer({ hidden }: Props) {
  const { config } = useLayoutConfig();
  const {
    applyPresetId,
    applySchemeTab,
    createNewScheme,
    saveActiveScheme,
    discardScheme,
    deleteActiveScheme,
  } = useSchemeActions();

  const view = buildSchemeComposerView(config);
  const [nameInput, setNameInput] = useState("");

  useEffect(() => {
    setNameInput(view?.schemeName ?? "");
  }, [view?.schemeName, view?.activeId]);

  if (hidden || !view) {
    return <div className="cmdk-composer hidden" data-testid="cmdk-composer" />;
  }

  const { schemes, count, activeId, draft, onScheme, currentBlocks, savedBlocks, activePreset, canCreate } =
    view;
  const current = config ? activeScheme(config) : null;

  const status = !onScheme ? (
    <span className="cmdk-scheme-status">改插件后新建/保存</span>
  ) : draft ? (
    <span className="cmdk-scheme-status is-draft">● 未保存</span>
  ) : (
    <span className="cmdk-scheme-status is-saved">✓ 已保存</span>
  );

  return (
    <div className="cmdk-composer" data-testid="cmdk-composer">
      <div className="cmdk-scheme-card">
        <div className="cmdk-scheme-head">
          <span className="cmdk-composer-label">
            方案 <span className="cmdk-scheme-count">{count}/{MAX_SCHEMES}</span>
          </span>
          <div className="cmdk-scheme-tabs">
            {schemes.length === 0 ? (
              <span className="cmdk-scheme-empty">暂无</span>
            ) : (
              schemes.map((s) => {
                const isActive = activeId === s.id && onScheme;
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={`cmdk-scheme-tab${isActive ? " is-active" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void applySchemeTab(s.id);
                    }}
                  >
                    {isActive && draft && <span className="cmdk-scheme-dot" />}
                    {s.name}
                  </button>
                );
              })
            )}
          </div>
          <button
            type="button"
            className={`cmdk-scheme-new${canCreate ? "" : " disabled"}`}
            disabled={!canCreate}
            onClick={(e) => {
              e.stopPropagation();
              void createNewScheme(nameInput.trim() || undefined);
            }}
          >
            + 新建
          </button>
        </div>

        <div className="cmdk-scheme-row">
          <input
            className="cmdk-scheme-name"
            type="text"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder="方案名称"
            maxLength={24}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                void saveActiveScheme(nameInput.trim() || undefined);
              }
            }}
          />
          <div className="cmdk-scheme-actions">
            <button
              type="button"
              className="cmdk-scheme-btn primary"
              disabled={!(onScheme || count < MAX_SCHEMES)}
              onClick={(e) => {
                e.stopPropagation();
                void saveActiveScheme(nameInput.trim() || undefined);
              }}
            >
              保存
            </button>
            <button
              type="button"
              className="cmdk-scheme-btn"
              disabled={!draft}
              onClick={(e) => {
                e.stopPropagation();
                void discardScheme();
              }}
            >
              放弃
            </button>
            <button
              type="button"
              className="cmdk-scheme-btn danger"
              disabled={!activeId}
              onClick={(e) => {
                e.stopPropagation();
                void deleteActiveScheme();
              }}
            >
              删除
            </button>
          </div>
        </div>

        <div className="cmdk-scheme-edit">
          <span className="cmdk-scheme-sublabel">面板</span>
          <div className="cmdk-composer-track">
            <TrackChips ids={currentBlocks} emptyText="下方打开插件" />
          </div>
          {current && draft ? (
            <div className="cmdk-composer-track is-dim" title="已保存版本">
              <TrackChips ids={savedBlocks} emptyText="空" />
            </div>
          ) : null}
          {status}
        </div>

        <div className="cmdk-builtin-row">
          <span className="cmdk-builtin-label">内置</span>
          <div className="cmdk-preset-pills">
            {QUICK_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`cmdk-preset-pill${isBuiltinActive(activePreset, p.id) ? " is-active" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void applyPresetId(p.id);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SchemeComposer;
