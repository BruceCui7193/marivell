export type ThemePalette = 'natural' | 'forest' | 'ocean' | 'sepia' | 'graphite' | 'nord' | 'sakura' | 'lavender' | 'cyberpunk';
export type GlassEffect = 'frosted' | 'liquid' | 'off';

export interface ThemePaletteOption {
  id: ThemePalette;
  label: string;
  description: string;
  swatch: string;
}

export const THEME_PALETTE_OPTIONS: ThemePaletteOption[] = [
  {
    id: 'natural',
    label: '自然',
    description: '清爽通透的蓝灰',
    swatch: 'linear-gradient(135deg, #edf3f8 0%, #4d7592 100%)',
  },
  {
    id: 'forest',
    label: '森林',
    description: '郁郁葱葱的深翠绿调',
    swatch: 'linear-gradient(135deg, #e7efe8 0%, #3f6f5f 100%)',
  },
  {
    id: 'ocean',
    label: '海湾',
    description: '清爽温润的深海蓝灰',
    swatch: 'linear-gradient(135deg, #edf3f8 0%, #4d7592 100%)',
  },
  {
    id: 'sepia',
    label: '暖纸',
    description: '护眼复古的琥珀沙色',
    swatch: 'linear-gradient(135deg, #f6ead7 0%, #9a6e45 100%)',
  },
  {
    id: 'graphite',
    label: '石墨',
    description: '极简中性的冷静灰阶',
    swatch: 'linear-gradient(135deg, #eceef0 0%, #56606b 100%)',
  },
  {
    id: 'nord',
    label: '北极光',
    description: '极地之境的清冷霜蓝',
    swatch: 'linear-gradient(135deg, #e5e9f0 0%, #88c0d0 100%)',
  },
  {
    id: 'sakura',
    label: '春樱',
    description: '浪漫梦幻的樱粉暖沙',
    swatch: 'linear-gradient(135deg, #fff5f6 0%, #e87a90 100%)',
  },
  {
    id: 'lavender',
    label: '薰衣草',
    description: '静谧高贵的暮色丁香紫',
    swatch: 'linear-gradient(135deg, #f3f0fc 0%, #8b5cf6 100%)',
  },
  {
    id: 'cyberpunk',
    label: '赛博朋克',
    description: '未来科技感的暗夜霓虹',
    swatch: 'linear-gradient(135deg, #0f172a 0%, #ec4899 100%)',
  },
];

export function isThemePalette(value: string | null): value is ThemePalette {
  return THEME_PALETTE_OPTIONS.some((option) => option.id === value);
}

export interface GlassEffectOption {
  id: GlassEffect;
  label: string;
  description: string;
}

export const GLASS_EFFECT_OPTIONS: GlassEffectOption[] = [
  {
    id: 'frosted',
    label: '毛玻璃',
    description: '轻量模糊，功耗均衡',
  },
  {
    id: 'liquid',
    label: '液态玻璃',
    description: '折射高光，更通透',
  },
  {
    id: 'off',
    label: '关闭透明',
    description: '纯色界面，更省电',
  },
];

export function isGlassEffect(value: string | null): value is GlassEffect {
  return GLASS_EFFECT_OPTIONS.some((option) => option.id === value);
}
