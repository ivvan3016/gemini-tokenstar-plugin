import { useEffect } from 'react';
import type { UpdateApplyResult, UpdateCheckResult } from '../types/sky';

export interface UpdateModalProps {
  isOpen: boolean;
  isChecking: boolean;
  isApplying: boolean;
  checkResult: UpdateCheckResult | null;
  applyResult: UpdateApplyResult | null;
  error: string | null;
  onClose: () => void;
  onRecheck: () => void;
  onApplyUpdate: (tag?: string) => void;
  onOpenExternalUrl: (url: string) => void;
}

function formatPublishedDate(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/** Dark-glass modal for on-demand GitHub Release version check and in-plugin self-update. */
export function UpdateModal({
  isOpen,
  isChecking,
  isApplying,
  checkResult,
  applyResult,
  error,
  onClose,
  onRecheck,
  onApplyUpdate,
  onOpenExternalUrl,
}: UpdateModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isApplying) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, isApplying, onClose]);

  if (!isOpen) return null;

  const publishedDate = formatPublishedDate(checkResult?.published_at ?? null);
  const effectiveError =
    error || (checkResult?.status === 'error' ? checkResult.error : null);
  const currentVersionLabel = applyResult
    ? applyResult.updated_version
    : checkResult?.current_version;

  return (
    <div
      className="ts-update-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !isApplying) {
          onClose();
        }
      }}
    >
      <div
        className="ts-panel ts-update-modal"
        role="dialog"
        aria-modal="true"
        aria-label="插件版本与更新"
      >
        <div className="ts-update-header">
          <div className="ts-update-title-group">
            <span className="ts-update-emblem" aria-hidden="true">✦</span>
            <h2 className="ts-update-title">版本与更新</h2>
          </div>
          <button
            type="button"
            className="ts-icon-close"
            aria-label="关闭更新弹窗"
            disabled={isApplying}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="ts-update-body">
          <div className="ts-update-versions">
            <span className="ts-version-pill">
              当前版本{' '}
              <strong className="ts-tabular">
                {currentVersionLabel ? `v${currentVersionLabel}` : '读取中…'}
              </strong>
            </span>
            {checkResult?.latest_version && (
              <span
                className={`ts-version-pill${checkResult.has_update && !applyResult ? ' is-highlight' : ''}`}
              >
                最新版本{' '}
                <strong className="ts-tabular">v{checkResult.latest_version}</strong>
              </span>
            )}
          </div>

          {isChecking && (
            <div className="ts-update-banner is-info">
              <span className="ts-spin" aria-hidden="true">↻</span>
              <span>正在检查 GitHub 最新版本…</span>
            </div>
          )}

          {!isChecking && applyResult && (
            <div
              className={`ts-update-banner ${applyResult.restart_required ? 'is-restart' : 'is-ready'}`}
              role="status"
            >
              <strong>{applyResult.message}</strong>
              {applyResult.restart_required && (
                <p className="ts-update-subhint">
                  更新文件已写入插件目录。{applyResult.sync_deferred ? '检测到后端进程正在运行，' : ''}
                  关闭并重新打开 Antigravity 时将自动加载最新版本并同步后端依赖。
                </p>
              )}
            </div>
          )}

          {!isChecking && !applyResult && effectiveError && (
            <div className="ts-update-banner is-error" role="alert">
              <span>{effectiveError}</span>
            </div>
          )}

          {!isChecking && !applyResult && checkResult?.status === 'ok' && !checkResult.has_update && (
            <div className="ts-update-banner is-ready">
              <strong>已是最新版本</strong>
              {publishedDate && (
                <span className="ts-update-meta">当前发行版发布日期：{publishedDate}</span>
              )}
            </div>
          )}

          {!isChecking && !applyResult && checkResult?.status === 'ok' && checkResult.has_update && (
            <div className="ts-update-available">
              <div className="ts-update-banner is-available">
                <strong>发现新版本 v{checkResult.latest_version}</strong>
                {publishedDate && (
                  <span className="ts-update-meta">发布于 {publishedDate}</span>
                )}
              </div>

              {checkResult.release_notes && (
                <div className="ts-update-notes-wrap">
                  <div className="ts-update-notes-label">更新说明</div>
                  <pre className="ts-update-notes">{checkResult.release_notes}</pre>
                </div>
              )}

              {!checkResult.can_self_update && (
                <div className="ts-update-banner is-info">
                  <span>
                    {checkResult.has_bundle_asset
                      ? '当前处于开发仓库或独立网页模式，请前往 GitHub Release 下载更新，或在仓库目录执行 '
                      : '该 GitHub Release 未附带离线安装压缩包（tokenstar-plugin.zip），请前往 GitHub Release 手动更新或执行 '}
                    <code className="ts-diag-code">git pull</code>
                    {checkResult.has_bundle_asset ? ' 更新。' : '。'}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="ts-update-actions">
          {!applyResult && (
            <button
              type="button"
              className="ts-ghost-btn"
              disabled={isChecking || isApplying}
              onClick={onRecheck}
            >
              重新检查
            </button>
          )}

          {checkResult?.release_url && (
            <button
              type="button"
              className="ts-ghost-btn"
              disabled={isApplying}
              onClick={() => onOpenExternalUrl(checkResult.release_url)}
            >
              查看 GitHub Release
            </button>
          )}

          {!applyResult && checkResult?.has_update && checkResult.can_self_update && (
            <button
              type="button"
              className="ts-accent-btn"
              disabled={isChecking || isApplying}
              onClick={() => onApplyUpdate(checkResult.tag_name ?? undefined)}
            >
              {isApplying ? '正在下载并安装更新…' : '立即更新'}
            </button>
          )}

          {applyResult && (
            <button
              type="button"
              className="ts-accent-btn"
              onClick={onClose}
            >
              完成
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
