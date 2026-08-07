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
import { setAppLanguage, translate, useAppLanguage, type AppLanguage } from '../i18n';

type SettingsTab = 'general' | 'appearance' | 'files' | 'about';

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
  const appLanguage = useAppLanguage();
  const [tab, setTab] = useState<SettingsTab>('general');
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
        setAssociationMessage(
          next ? translate('associationSuccess') : translate('associationRemoved'),
        );
      } else {
        setAssociationMessage(result.error ?? translate('associationFailed'));
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
      <section aria-label={translate('settings')} aria-modal="true" className="settings-dialog" role="dialog">
        <header className="settings-dialog__header">
          <h2 className="settings-dialog__title">{translate('settings')}</h2>
          <button aria-label={translate('closeSettings')} className="settings-dialog__close" onClick={onClose} type="button">
            ×
          </button>
        </header>

        <div className="settings-dialog__body">
          <nav className="settings-dialog__tabs">
            <button
              className={clsx('settings-dialog__tab', tab === 'general' && 'is-active')}
              onClick={() => setTab('general')}
              type="button"
            >
              {translate('general')}
            </button>
            <button
              className={clsx('settings-dialog__tab', tab === 'appearance' && 'is-active')}
              onClick={() => setTab('appearance')}
              type="button"
            >
              {translate('appearance')}
            </button>
            <button
              className={clsx('settings-dialog__tab', tab === 'files' && 'is-active')}
              onClick={() => setTab('files')}
              type="button"
            >
              {translate('fileAssociation')}
            </button>
            <button
              className={clsx('settings-dialog__tab', tab === 'about' && 'is-active')}
              onClick={() => setTab('about')}
              type="button"
            >
              {translate('about')}
            </button>
          </nav>

          <div className="settings-dialog__content">
            {tab === 'general' ? (
              <section className="settings-section">
                <h3 className="settings-section__title">{translate('language')}</h3>
                <select
                  className="settings-select"
                  onChange={(event) => setAppLanguage(event.target.value as AppLanguage)}
                  value={appLanguage}
                >
                  <option value="zh-CN">简体中文</option>
                  <option value="en">English</option>
                </select>
              </section>
            ) : null}

            {tab === 'appearance' ? (
              <>
                <section className="settings-section">
                  <h3 className="settings-section__title">{translate('themePalette')}</h3>
                  <div className="settings-row">
                    {(['system', 'light', 'dark'] as ThemeMode[]).map((mode) => (
                      <button
                        className={clsx('settings-option', theme === mode && 'is-active')}
                        key={mode}
                        onClick={() => onSetTheme(mode)}
                        type="button"
                      >
                        {mode === 'system'
                          ? translate('auto')
                          : mode === 'light'
                            ? translate('light')
                            : translate('dark')}
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
                        {appLanguage === 'en' ? option.labelEn : option.label}
                      </option>
                    ))}
                  </select>
                  <div className="settings-row">
                    {GLASS_EFFECT_OPTIONS.map((option) => (
                      <button
                        className={clsx('settings-option', glassEffect === option.id && 'is-active')}
                        key={option.id}
                        onClick={() => onSetGlassEffect(option.id)}
                        title={
                          appLanguage === 'en' ? option.descriptionEn : option.description
                        }
                        type="button"
                      >
                        {appLanguage === 'en' ? option.labelEn : option.label}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="settings-section">
                  <h3 className="settings-section__title">{translate('customColors')}</h3>
                  <div className="settings-colors">
                    <ColorField
                      label={translate('accent')}
                      onChange={(accent) => onSetCustomColors({ ...customColors, accent })}
                      value={customColors.accent}
                    />
                    <ColorField
                      label={translate('background')}
                      onChange={(background) => onSetCustomColors({ ...customColors, background })}
                      value={customColors.background}
                    />
                    <ColorField
                      label={translate('editorBackground')}
                      onChange={(editorBackground) =>
                        onSetCustomColors({ ...customColors, editorBackground })
                      }
                      value={customColors.editorBackground}
                    />
                    <ColorField
                      label={translate('border')}
                      onChange={(border) => onSetCustomColors({ ...customColors, border })}
                      value={customColors.border}
                    />
                    <ColorField
                      label={translate('text')}
                      onChange={(text) => onSetCustomColors({ ...customColors, text })}
                      value={customColors.text}
                    />
                  </div>
                </section>

                <section className="settings-section">
                  <h3 className="settings-section__title">{translate('glassParams')}</h3>
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
                    <span>{translate('customizeFrosted')}</span>
                  </label>
                  {glassCustomization.frostedEnabled ? (
                    <div className="settings-sliders">
                      <NumberSlider
                        label={translate('blur')}
                        max={24}
                        min={2}
                        onChange={(blur) => onSetFrostedGlass({ ...frostedGlass, blur })}
                        suffix="px"
                        value={frostedGlass.blur}
                      />
                      <NumberSlider
                        label={translate('saturation')}
                        max={200}
                        min={100}
                        onChange={(saturation) => onSetFrostedGlass({ ...frostedGlass, saturation })}
                        suffix="%"
                        value={frostedGlass.saturation}
                      />
                      <NumberSlider
                        label={translate('brightness')}
                        max={120}
                        min={90}
                        onChange={(brightness) => onSetFrostedGlass({ ...frostedGlass, brightness })}
                        suffix="%"
                        value={frostedGlass.brightness}
                      />
                      <NumberSlider
                        label={translate('fillOpacity')}
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
                    <span>{translate('customizeLiquid')}</span>
                  </label>
                  {glassCustomization.liquidEnabled ? (
                    <div className="settings-sliders">
                      <NumberSlider
                        label={translate('blur')}
                        max={20}
                        min={0}
                        onChange={(blurAmount) => onSetLiquidGlass({ ...liquidGlass, blurAmount })}
                        suffix="px"
                        value={liquidGlass.blurAmount}
                      />
                      <NumberSlider
                        label={translate('thickness')}
                        max={320}
                        min={40}
                        onChange={(glassThickness) =>
                          onSetLiquidGlass({ ...liquidGlass, glassThickness })
                        }
                        suffix="px"
                        value={liquidGlass.glassThickness}
                      />
                      <NumberSlider
                        label={translate('refraction')}
                        max={5}
                        min={1}
                        step={0.1}
                        onChange={(refractiveIndex) =>
                          onSetLiquidGlass({ ...liquidGlass, refractiveIndex })
                        }
                        value={liquidGlass.refractiveIndex}
                      />
                      <NumberSlider
                        label={translate('specular')}
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
                    {translate('resetDefaults')}
                  </button>
                </section>
              </>
            ) : null}

            {tab === 'files' ? (
              <section className="settings-section">
                <h3 className="settings-section__title">{translate('markdownFileAssociation')}</h3>
                <p className="settings-description">{translate('fileAssociationDescription')}</p>
                {association ? (
                  <div className="settings-status">
                    {association.supported
                      ? association.associated
                        ? translate('currentlyAssociated')
                        : translate('currentlyNotAssociated')
                      : translate('unsupportedPlatform', { platform: association.platform })}
                  </div>
                ) : (
                  <div className="settings-status">{translate('readingStatus')}</div>
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
                      ? translate('processing')
                      : association.associated
                        ? translate('unassociate')
                        : translate('associate')}
                  </button>
                ) : null}
              </section>
            ) : null}

            {tab === 'about' ? (
              <section className="settings-section">
                <h3 className="settings-section__title">{translate('about')}</h3>
                <div className="settings-about">
                  <div>
                    <strong>{appInfo?.name ?? 'Markdown Editor Pro'}</strong>
                  </div>
                  <div>{translate('version')} {appInfo?.version ?? '…'}</div>
                  <div>{translate('platform')} {appInfo?.platform ?? '…'}</div>
                </div>

                <label className="settings-checkbox">
                  <input
                    checked={includePrerelease}
                    onChange={(event) => setIncludePrerelease(event.target.checked)}
                    type="checkbox"
                  />
                  <span>{translate('checkPrerelease')}</span>
                </label>
                <button
                  className="settings-button is-primary"
                  disabled={checkingUpdates}
                  onClick={() => void checkUpdates()}
                  type="button"
                >
                  {checkingUpdates ? translate('checking') : translate('checkUpdates')}
                </button>

                {updateResult ? (
                  <div className="settings-update">
                    {updateResult.error ? (
                      <div className="settings-message">
                        {translate('updateFailed', { error: updateResult.error ?? '' })}
                      </div>
                    ) : updateResult.hasUpdate ? (
                      <>
                        <div className="settings-status">
                          {translate('updateFound', {
                            latest: updateResult.latestVersion,
                            current: updateResult.currentVersion,
                          })}
                        </div>
                        {updateResult.releaseUrl ? (
                          <button
                            className="settings-button"
                            onClick={() => void window.markdownEditor.openExternal(updateResult.releaseUrl!)}
                            type="button"
                          >
                            {translate('openReleasePage')}
                          </button>
                        ) : null}
                      </>
                    ) : (
                      <div className="settings-status">{translate('upToDate')}</div>
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
