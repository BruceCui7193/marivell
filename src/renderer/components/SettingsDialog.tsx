import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import type { AppInfo, FileAssociationStatus, ThemeMode, UpdateCheckResult } from '@shared/contracts';
import { GLASS_EFFECT_OPTIONS, THEME_PALETTE_OPTIONS, type GlassEffect, type ThemePalette } from '../theme';
import {
  DEFAULT_CUSTOM_COLORS,
  DEFAULT_FROSTED_GLASS,
  DEFAULT_GLASS_CUSTOMIZATION,
  DEFAULT_LIQUID_GLASS,
  hexToRgb,
  isHexColor,
  rgbToHex,
  type CustomColorSettings,
  type FrostedGlassSettings,
  type GlassCustomizationSettings,
  type LiquidGlassSettings,
} from '../settings';

type SettingsTab = 'appearance' | 'files' | 'about';

interface SettingsDialogProps {
  onClose: () => void;
  theme: ThemeMode;
  themePalette: ThemePalette;
  glassEffect: GlassEffect;
  customColors: CustomColorSettings;
  frostedGlass: FrostedGlassSettings;
  liquidGlass: LiquidGlassSettings;
  glassCustomization: GlassCustomizationSettings;
  onSetTheme: (theme: ThemeMode) => void;
  onSetThemePalette: (palette: ThemePalette) => void;
  onSetGlassEffect: (effect: GlassEffect) => void;
  onSetCustomColors: (colors: CustomColorSettings) => void;
  onSetFrostedGlass: (settings: FrostedGlassSettings) => void;
  onSetLiquidGlass: (settings: LiquidGlassSettings) => void;
  onSetGlassCustomization: (settings: GlassCustomizationSettings) => void;
}

interface ColorFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

function ColorField({ label, value, onChange }: ColorFieldProps) {
  const parsed = useMemo(() => hexToRgb(value), [value]);
  const [rgb, setRgb] = useState(parsed ?? { r: 0, g: 0, b: 0 });

  useEffect(() => {
    if (parsed) {
      setRgb(parsed);
    }
  }, [parsed]);

  const updateRgb = (channel: 'r' | 'g' | 'b', next: number) => {
    const updated = { ...rgb, [channel]: next };
    setRgb(updated);
    onChange(rgbToHex(updated.r, updated.g, updated.b));
  };

  return (
    <label className="settings-color-field">
      <span className="settings-color-field__label">{label}</span>
      <input
        className="settings-color-field__picker"
        onChange={(event) => onChange(event.target.value)}
        type="color"
        value={isHexColor(value) ? value : '#000000'}
      />
      <input
        className="settings-color-field__hex"
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        type="text"
        value={value}
      />
      <input
        aria-label={`${label} R`}
        className="settings-color-field__rgb"
        max={255}
        min={0}
        onChange={(event) => updateRgb('r', Number(event.target.value))}
        type="number"
        value={rgb.r}
      />
      <input
        aria-label={`${label} G`}
        className="settings-color-field__rgb"
        max={255}
        min={0}
        onChange={(event) => updateRgb('g', Number(event.target.value))}
        type="number"
        value={rgb.g}
      />
      <input
        aria-label={`${label} B`}
        className="settings-color-field__rgb"
        max={255}
        min={0}
        onChange={(event) => updateRgb('b', Number(event.target.value))}
        type="number"
        value={rgb.b}
      />
    </label>
  );
}

function NumberSlider({
  label,
  min,
  max,
  step = 1,
  value,
  suffix = '',
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="settings-slider">
      <span className="settings-slider__label">{label}</span>
      <input
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="range"
        value={value}
      />
      <span className="settings-slider__value">{value}{suffix}</span>
    </label>
  );
}

export default function SettingsDialog({
  onClose,
  theme,
  themePalette,
  glassEffect,
  customColors,
  frostedGlass,
  liquidGlass,
  glassCustomization,
  onSetTheme,
  onSetThemePalette,
  onSetGlassEffect,
  onSetCustomColors,
  onSetFrostedGlass,
  onSetLiquidGlass,
  onSetGlassCustomization,
}: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>('appearance');
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [includePrerelease, setIncludePrerelease] = useState(
    () => localStorage.getItem('markdown-editor-check-prerelease') === '1',
  );
  const [association, setAssociation] = useState<FileAssociationStatus | null>(null);
  const [associationBusy, setAssociationBusy] = useState(false);
  const [associationMessage, setAssociationMessage] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  useEffect(() => {
    void window.markdownEditor.getAppInfo().then(setAppInfo).catch(() => {});
    void window.markdownEditor
      .getFileAssociationStatus()
      .then(setAssociation)
      .catch(() => {});
  }, []);

  const checkUpdates = async () => {
    localStorage.setItem('markdown-editor-check-prerelease', includePrerelease ? '1' : '0');
    setCheckingUpdates(true);
    try {
      setUpdateResult(await window.markdownEditor.checkForUpdates(includePrerelease));
    } catch (error) {
      setUpdateResult({
        currentVersion: appInfo?.version ?? '',
        latestVersion: appInfo?.version ?? '',
        releaseUrl: null,
        hasUpdate: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCheckingUpdates(false);
    }
  };

  const toggleAssociation = async () => {
    if (!association?.supported || associationBusy) {
      return;
    }
    setAssociationBusy(true);
    setAssociationMessage('');
    const next = !association.associated;
    try {
      const result = await window.markdownEditor.setFileAssociation(next);
      if (result.ok) {
        setAssociation({ ...association, associated: next });
        setAssociationMessage(next ? '已关联 Markdown 文件' : '已取消 Markdown 文件关联');
      } else {
        setAssociationMessage(result.error ?? '操作失败，可能需要更高权限');
      }
    } catch (error) {
      setAssociationMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setAssociationBusy(false);
    }
  };

  const resetAppearance = () => {
    onSetCustomColors(DEFAULT_CUSTOM_COLORS);
    onSetFrostedGlass(DEFAULT_FROSTED_GLASS);
    onSetLiquidGlass(DEFAULT_LIQUID_GLASS);
    onSetGlassCustomization(DEFAULT_GLASS_CUSTOMIZATION);
  };

  return createPortal(
    <div
      className="settings-dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section aria-label="设置" aria-modal="true" className="settings-dialog" role="dialog">
        <header className="settings-dialog__header">
          <h2 className="settings-dialog__title">设置</h2>
          <button aria-label="关闭设置" className="settings-dialog__close" onClick={onClose} type="button">
            ×
          </button>
        </header>

        <div className="settings-dialog__body">
          <nav className="settings-dialog__tabs">
            <button
              className={clsx('settings-dialog__tab', tab === 'appearance' && 'is-active')}
              onClick={() => setTab('appearance')}
              type="button"
            >
              外观
            </button>
            <button
              className={clsx('settings-dialog__tab', tab === 'files' && 'is-active')}
              onClick={() => setTab('files')}
              type="button"
            >
              文件关联
            </button>
            <button
              className={clsx('settings-dialog__tab', tab === 'about' && 'is-active')}
              onClick={() => setTab('about')}
              type="button"
            >
              关于
            </button>
          </nav>

          <div className="settings-dialog__content">
            {tab === 'appearance' ? (
              <>
                <section className="settings-section">
                  <h3 className="settings-section__title">主题与配色</h3>
                  <div className="settings-row">
                    {(['system', 'light', 'dark'] as ThemeMode[]).map((mode) => (
                      <button
                        className={clsx('settings-option', theme === mode && 'is-active')}
                        key={mode}
                        onClick={() => onSetTheme(mode)}
                        type="button"
                      >
                        {mode === 'system' ? '自动' : mode === 'light' ? '浅色' : '深色'}
                      </button>
                    ))}
                  </div>
                  <select
                    className="settings-select"
                    onChange={(event) => onSetThemePalette(event.target.value as ThemePalette)}
                    value={themePalette}
                  >
                    {THEME_PALETTE_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <div className="settings-row">
                    {GLASS_EFFECT_OPTIONS.map((option) => (
                      <button
                        className={clsx('settings-option', glassEffect === option.id && 'is-active')}
                        key={option.id}
                        onClick={() => onSetGlassEffect(option.id)}
                        title={option.description}
                        type="button"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="settings-section">
                  <h3 className="settings-section__title">自定义颜色</h3>
                  <div className="settings-colors">
                    <ColorField
                      label="强调色"
                      onChange={(accent) => onSetCustomColors({ ...customColors, accent })}
                      value={customColors.accent}
                    />
                    <ColorField
                      label="背景"
                      onChange={(background) => onSetCustomColors({ ...customColors, background })}
                      value={customColors.background}
                    />
                    <ColorField
                      label="编辑器背景"
                      onChange={(editorBackground) =>
                        onSetCustomColors({ ...customColors, editorBackground })
                      }
                      value={customColors.editorBackground}
                    />
                    <ColorField
                      label="边框"
                      onChange={(border) => onSetCustomColors({ ...customColors, border })}
                      value={customColors.border}
                    />
                    <ColorField
                      label="文字"
                      onChange={(text) => onSetCustomColors({ ...customColors, text })}
                      value={customColors.text}
                    />
                  </div>
                </section>

                <section className="settings-section">
                  <h3 className="settings-section__title">玻璃参数</h3>
                  <label className="settings-checkbox">
                    <input
                      checked={glassCustomization.frostedEnabled}
                      onChange={(event) =>
                        onSetGlassCustomization({
                          ...glassCustomization,
                          frostedEnabled: event.target.checked,
                        })
                      }
                      type="checkbox"
                    />
                    <span>自定义毛玻璃</span>
                  </label>
                  {glassCustomization.frostedEnabled ? (
                    <div className="settings-sliders">
                      <NumberSlider
                        label="模糊"
                        max={24}
                        min={2}
                        onChange={(blur) => onSetFrostedGlass({ ...frostedGlass, blur })}
                        suffix="px"
                        value={frostedGlass.blur}
                      />
                      <NumberSlider
                        label="饱和度"
                        max={200}
                        min={100}
                        onChange={(saturation) => onSetFrostedGlass({ ...frostedGlass, saturation })}
                        suffix="%"
                        value={frostedGlass.saturation}
                      />
                      <NumberSlider
                        label="亮度"
                        max={120}
                        min={90}
                        onChange={(brightness) => onSetFrostedGlass({ ...frostedGlass, brightness })}
                        suffix="%"
                        value={frostedGlass.brightness}
                      />
                      <NumberSlider
                        label="填充透明度"
                        max={50}
                        min={5}
                        onChange={(fillOpacity) =>
                          onSetFrostedGlass({ ...frostedGlass, fillOpacity: fillOpacity / 100 })
                        }
                        suffix="%"
                        value={Math.round(frostedGlass.fillOpacity * 100)}
                      />
                    </div>
                  ) : null}

                  <label className="settings-checkbox">
                    <input
                      checked={glassCustomization.liquidEnabled}
                      onChange={(event) =>
                        onSetGlassCustomization({
                          ...glassCustomization,
                          liquidEnabled: event.target.checked,
                        })
                      }
                      type="checkbox"
                    />
                    <span>自定义液态玻璃</span>
                  </label>
                  {glassCustomization.liquidEnabled ? (
                    <div className="settings-sliders">
                      <NumberSlider
                        label="模糊"
                        max={20}
                        min={0}
                        onChange={(blurAmount) => onSetLiquidGlass({ ...liquidGlass, blurAmount })}
                        suffix="px"
                        value={liquidGlass.blurAmount}
                      />
                      <NumberSlider
                        label="厚度"
                        max={320}
                        min={40}
                        onChange={(glassThickness) =>
                          onSetLiquidGlass({ ...liquidGlass, glassThickness })
                        }
                        suffix="px"
                        value={liquidGlass.glassThickness}
                      />
                      <NumberSlider
                        label="折射率"
                        max={5}
                        min={1}
                        step={0.1}
                        onChange={(refractiveIndex) =>
                          onSetLiquidGlass({ ...liquidGlass, refractiveIndex })
                        }
                        value={liquidGlass.refractiveIndex}
                      />
                      <NumberSlider
                        label="高光"
                        max={1}
                        min={0}
                        step={0.05}
                        onChange={(specularOpacity) =>
                          onSetLiquidGlass({ ...liquidGlass, specularOpacity })
                        }
                        value={liquidGlass.specularOpacity}
                      />
                    </div>
                  ) : null}

                  <button className="settings-button" onClick={resetAppearance} type="button">
                    恢复默认
                  </button>
                </section>
              </>
            ) : null}

            {tab === 'files' ? (
              <section className="settings-section">
                <h3 className="settings-section__title">Markdown 文件关联</h3>
                <p className="settings-description">
                  将 .md / .markdown 文件关联到本软件。Linux 使用用户级 MIME 配置，Windows 使用当前用户注册表，通常不需要管理员权限。
                </p>
                {association ? (
                  <div className="settings-status">
                    {association.supported
                      ? association.associated
                        ? '当前已关联'
                        : '当前未关联'
                      : `当前系统暂不支持运行时关联（${association.platform}）`}
                  </div>
                ) : (
                  <div className="settings-status">正在读取状态…</div>
                )}
                {associationMessage ? (
                  <div className="settings-message">{associationMessage}</div>
                ) : null}
                {association?.supported ? (
                  <button
                    className="settings-button is-primary"
                    disabled={associationBusy}
                    onClick={() => void toggleAssociation()}
                    type="button"
                  >
                    {associationBusy
                      ? '处理中…'
                      : association.associated
                        ? '取消关联'
                        : '关联 .md / .markdown'}
                  </button>
                ) : null}
              </section>
            ) : null}

            {tab === 'about' ? (
              <section className="settings-section">
                <h3 className="settings-section__title">关于</h3>
                <div className="settings-about">
                  <div>
                    <strong>{appInfo?.name ?? 'Markdown Editor Pro'}</strong>
                  </div>
                  <div>版本 {appInfo?.version ?? '…'}</div>
                  <div>平台 {appInfo?.platform ?? '…'}</div>
                </div>

                <label className="settings-checkbox">
                  <input
                    checked={includePrerelease}
                    onChange={(event) => setIncludePrerelease(event.target.checked)}
                    type="checkbox"
                  />
                  <span>检查预览版</span>
                </label>
                <button
                  className="settings-button is-primary"
                  disabled={checkingUpdates}
                  onClick={() => void checkUpdates()}
                  type="button"
                >
                  {checkingUpdates ? '检查中…' : '检查更新'}
                </button>

                {updateResult ? (
                  <div className="settings-update">
                    {updateResult.error ? (
                      <div className="settings-message">检查失败：{updateResult.error}</div>
                    ) : updateResult.hasUpdate ? (
                      <>
                        <div className="settings-status">
                          发现新版本 {updateResult.latestVersion}（当前 {updateResult.currentVersion}）
                        </div>
                        {updateResult.releaseUrl ? (
                          <button
                            className="settings-button"
                            onClick={() => void window.markdownEditor.openExternal(updateResult.releaseUrl!)}
                            type="button"
                          >
                            打开发布页
                          </button>
                        ) : null}
                      </>
                    ) : (
                      <div className="settings-status">当前已是最新版本</div>
                    )}
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
