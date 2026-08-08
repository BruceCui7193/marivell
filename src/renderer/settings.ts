export interface CustomColorSettings {
  accent: string;
  background: string;
  editorBackground: string;
  border: string;
  text: string;
}

export interface FrostedGlassSettings {
  blur: number;
  saturation: number;
  brightness: number;
  fillOpacity: number;
}

export interface LiquidGlassSettings {
  blurAmount: number;
  glassThickness: number;
  refractiveIndex: number;
  specularOpacity: number;
}

export interface GlassCustomizationSettings {
  frostedEnabled: boolean;
  liquidEnabled: boolean;
}

export interface GradientSettings {
  enabled: boolean;
  strength: number;
}

export const DEFAULT_CUSTOM_COLORS: CustomColorSettings = {
  accent: '#4d7592',
  background: '#f4f7fb',
  editorBackground: '#fdfefe',
  border: '#d7e1ea',
  text: '#1d2b38',
};

export const DEFAULT_FROSTED_GLASS: FrostedGlassSettings = {
  blur: 9,
  saturation: 145,
  brightness: 104,
  fillOpacity: 0.26,
};

export const DEFAULT_LIQUID_GLASS: LiquidGlassSettings = {
  blurAmount: 7,
  glassThickness: 180,
  refractiveIndex: 3,
  specularOpacity: 0.9,
};

export const DEFAULT_GLASS_CUSTOMIZATION: GlassCustomizationSettings = {
  frostedEnabled: false,
  liquidEnabled: false,
};

export const DEFAULT_GRADIENT: GradientSettings = {
  enabled: true,
  strength: 0.55,
};

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  try {
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return fallback;
  }
}

export function loadCustomColors(): CustomColorSettings {
  return parseJson(
    localStorage.getItem('markdown-editor-custom-colors'),
    DEFAULT_CUSTOM_COLORS,
  );
}

export function saveCustomColors(colors: CustomColorSettings): void {
  localStorage.setItem('markdown-editor-custom-colors', JSON.stringify(colors));
}

export function loadFrostedGlass(): FrostedGlassSettings {
  return parseJson(
    localStorage.getItem('markdown-editor-frosted-glass'),
    DEFAULT_FROSTED_GLASS,
  );
}

export function saveFrostedGlass(settings: FrostedGlassSettings): void {
  localStorage.setItem('markdown-editor-frosted-glass', JSON.stringify(settings));
}

export function loadLiquidGlass(): LiquidGlassSettings {
  return parseJson(
    localStorage.getItem('markdown-editor-liquid-glass'),
    DEFAULT_LIQUID_GLASS,
  );
}

export function saveLiquidGlass(settings: LiquidGlassSettings): void {
  localStorage.setItem('markdown-editor-liquid-glass', JSON.stringify(settings));
}

export function loadGradient(): GradientSettings {
  return parseJson(
    localStorage.getItem('markdown-editor-gradient'),
    DEFAULT_GRADIENT,
  );
}

export function saveGradient(settings: GradientSettings): void {
  localStorage.setItem('markdown-editor-gradient', JSON.stringify(settings));
}

export function loadGlassCustomization(): GlassCustomizationSettings {
  return parseJson(
    localStorage.getItem('markdown-editor-glass-customization'),
    DEFAULT_GLASS_CUSTOMIZATION,
  );
}

export function saveGlassCustomization(settings: GlassCustomizationSettings): void {
  localStorage.setItem('markdown-editor-glass-customization', JSON.stringify(settings));
}

export function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

export function hexToRgb(value: string): { r: number; g: number; b: number } | null {
  if (!isHexColor(value)) {
    return null;
  }
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  const toHex = (value: number) => clamp(value).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function loadCustomColorsEnabled(): boolean {
  return (
    localStorage.getItem('markdown-editor-custom-colors-enabled') === '1' ||
    localStorage.getItem('markdown-editor-custom-colors') !== null
  );
}

export function saveCustomColorsEnabled(enabled: boolean): void {
  localStorage.setItem('markdown-editor-custom-colors-enabled', enabled ? '1' : '0');
}
