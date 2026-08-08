import type { CustomColorSettings, GradientSettings } from './settings';

export type ThemePalette = 'natural' | 'forest' | 'ocean' | 'sepia' | 'graphite' | 'nord' | 'sakura' | 'lavender' | 'cyberpunk';
export type GlassEffect = 'frosted' | 'liquid' | 'off';

export interface ThemePaletteOption {
  id: ThemePalette;
  label: string;
  labelEn: string;
  description: string;
  descriptionEn: string;
  swatch: string;
}


export function getThemePaletteColors(palette: ThemePalette): CustomColorSettings {
  switch (palette) {
    case 'forest':
      return { accent: '#3f6f5f', background: '#f5f7f2', editorBackground: '#fffef9', border: '#d8e0d3', text: '#1f2b25' };
    case 'ocean':
      return { accent: '#4d7592', background: '#f4f7fb', editorBackground: '#fdfefe', border: '#d7e1ea', text: '#1d2b38' };
    case 'sepia':
      return { accent: '#9a6e45', background: '#fbf3e8', editorBackground: '#fffdf8', border: '#e4d5c1', text: '#35291e' };
    case 'graphite':
      return { accent: '#56606b', background: '#f5f6f7', editorBackground: '#ffffff', border: '#dadde2', text: '#252c35' };
    case 'nord':
      return { accent: '#5e81ac', background: '#eceff4', editorBackground: '#f5f7fa', border: '#d8dee9', text: '#2e3440' };
    case 'sakura':
      return { accent: '#e87a90', background: '#fff5f6', editorBackground: '#fffbfa', border: '#f3d3d9', text: '#5a3e40' };
    case 'lavender':
      return { accent: '#7c3aed', background: '#f6f4fa', editorBackground: '#fcfbfe', border: '#e2dbe9', text: '#2c1e38' };
    case 'cyberpunk':
      return { accent: '#db2777', background: '#e2e8f0', editorBackground: '#f8fafc', border: '#cbd5e1', text: '#0f172a' };
    case 'natural':
    default:
      return { accent: '#4d7592', background: '#f4f7fb', editorBackground: '#fdfefe', border: '#d7e1ea', text: '#1d2b38' };
  }
}

export interface ThemeGradientStyles {
  surface: string;
  paper: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function buildThemeGradientStyles(
  settings: GradientSettings,
  themeMode: 'light' | 'dark',
  palette: ThemePalette,
): ThemeGradientStyles | null {
  if (!settings.enabled) {
    return null;
  }

  const isDark = themeMode === 'dark';
  const cyberpunk = palette === 'cyberpunk';
  const paletteBoost = cyberpunk ? 1.65 : 1;
  const darkScale = isDark ? (cyberpunk ? 0.72 : 0.42) : 1;
  const factor = clamp(settings.strength * paletteBoost * darkScale, 0, 1.5);
  const strength = Math.round(factor * 26);
  const secondary = cyberpunk ? 'var(--ui-text)' : 'var(--ui-accent)';

  return {
    surface: `linear-gradient(180deg, color-mix(in srgb, var(--ui-accent) ${strength}%, transparent), transparent 74%), linear-gradient(90deg, color-mix(in srgb, ${secondary} ${Math.round(strength * 0.7)}%, transparent), transparent 58%)`,
    paper: `linear-gradient(165deg, color-mix(in srgb, var(--ui-accent) ${Math.round(strength * 0.55)}%, transparent), transparent 44%), linear-gradient(15deg, color-mix(in srgb, ${secondary} ${Math.round(strength * 0.3)}%, transparent), transparent 62%)`,
  };
}

export const THEME_PALETTE_OPTIONS: ThemePaletteOption[] = [
  {
    id: 'natural',
    label: '自然',
    labelEn: 'Natural',
    description: '清爽通透的蓝灰',
    descriptionEn: 'Clear blue-gray tones',
    swatch: 'linear-gradient(135deg, #edf3f8 0%, #4d7592 100%)',
  },
  {
    id: 'forest',
    label: '森林',
    labelEn: 'Forest',
    description: '郁郁葱葱的深翠绿调',
    descriptionEn: 'Lush deep green tones',
    swatch: 'linear-gradient(135deg, #e7efe8 0%, #3f6f5f 100%)',
  },
  {
    id: 'ocean',
    label: '海湾',
    labelEn: 'Bay',
    description: '清爽温润的深海蓝灰',
    descriptionEn: 'Fresh deep sea blue-gray',
    swatch: 'linear-gradient(135deg, #edf3f8 0%, #4d7592 100%)',
  },
  {
    id: 'sepia',
    label: '暖纸',
    labelEn: 'Warm Paper',
    description: '护眼复古的琥珀沙色',
    descriptionEn: 'Eye-friendly amber sand',
    swatch: 'linear-gradient(135deg, #f6ead7 0%, #9a6e45 100%)',
  },
  {
    id: 'graphite',
    label: '石墨',
    labelEn: 'Graphite',
    description: '极简中性的冷静灰阶',
    descriptionEn: 'Minimal neutral gray',
    swatch: 'linear-gradient(135deg, #eceef0 0%, #56606b 100%)',
  },
  {
    id: 'nord',
    label: '北极光',
    labelEn: 'Aurora',
    description: '极地之境的清冷霜蓝',
    descriptionEn: 'Cool polar frost blue',
    swatch: 'linear-gradient(135deg, #e5e9f0 0%, #88c0d0 100%)',
  },
  {
    id: 'sakura',
    label: '春樱',
    labelEn: 'Sakura',
    description: '浪漫梦幻的樱粉暖沙',
    descriptionEn: 'Dreamy cherry blossom',
    swatch: 'linear-gradient(135deg, #fff5f6 0%, #e87a90 100%)',
  },
  {
    id: 'lavender',
    label: '薰衣草',
    labelEn: 'Lavender',
    description: '静谧高贵的暮色丁香紫',
    descriptionEn: 'Quiet dusk violet',
    swatch: 'linear-gradient(135deg, #f3f0fc 0%, #8b5cf6 100%)',
  },
  {
    id: 'cyberpunk',
    label: '赛博朋克',
    labelEn: 'Cyberpunk',
    description: '未来科技感的暗夜霓虹',
    descriptionEn: 'Futuristic neon night',
    swatch: 'linear-gradient(135deg, #0f172a 0%, #ec4899 100%)',
  },
];

export function isThemePalette(value: string | null): value is ThemePalette {
  return THEME_PALETTE_OPTIONS.some((option) => option.id === value);
}

export interface GlassEffectOption {
  id: GlassEffect;
  label: string;
  labelEn: string;
  description: string;
  descriptionEn: string;
}

export const GLASS_EFFECT_OPTIONS: GlassEffectOption[] = [
  {
    id: 'frosted',
    label: '毛玻璃',
    labelEn: 'Frosted',
    description: '轻量模糊，带弹性动画',
    descriptionEn: 'Lightweight blur with elastic animation',
  },
  {
    id: 'liquid',
    label: '液态玻璃',
    labelEn: 'Liquid',
    description: '物理折射，更强的模糊与厚度',
    descriptionEn: 'Physical refraction with stronger blur',
  },
  {
    id: 'off',
    label: '关闭透明',
    labelEn: 'Off',
    description: '纯色界面，更省电',
    descriptionEn: 'Solid interface for lower power use',
  },
];

export function isGlassEffect(value: string | null): value is GlassEffect {
  return GLASS_EFFECT_OPTIONS.some((option) => option.id === value);
}
