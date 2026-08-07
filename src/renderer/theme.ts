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
