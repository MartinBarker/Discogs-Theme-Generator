export interface ColorTokens { [key: string]: string; }

export interface GeneratedTheme {
  tokens: ColorTokens;
  swatches: string[];
  name: string;
  isDark: boolean;
}

// ─── Maths ────────────────────────────────────────────────────────────────────

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Return a foreground color whose contrast ratio against `bgHex` is at
 * least `minRatio`. The result has a subtle tint of `hue` so it integrates
 * visually with the palette rather than being pure white / pure black.
 *
 * - For main text:   minRatio = 7   (WCAG AAA)
 * - For normal text: minRatio = 4.5 (WCAG AA)
 * - For large/muted: minRatio = 3.0
 * - For hints/nums:  minRatio = 2.5
 */
function fg(bgHex: string, hue: number, minRatio: number = 4.5): string {
  const wc = contrastRatio('#ffffff', bgHex);
  const bc = contrastRatio('#000000', bgHex);
  const goLight = wc >= bc;

  // Choose a subtle saturation — keeps the "tinted neutral" look
  const sat = 12;

  if (goLight) {
    // Start at a lightness that feels "muted" for lower ratios
    const start = minRatio <= 2.5 ? 45 : minRatio <= 3.0 ? 58 : 88;
    for (let l = start; l <= 100; l++) {
      const c = hslToHex(hue, sat, l);
      if (contrastRatio(c, bgHex) >= minRatio) { return c; }
    }
    return '#ffffff';
  } else {
    const start = minRatio <= 2.5 ? 55 : minRatio <= 3.0 ? 42 : 12;
    for (let l = start; l >= 0; l--) {
      const c = hslToHex(hue, sat, l);
      if (contrastRatio(c, bgHex) >= minRatio) { return c; }
    }
    return '#000000';
  }
}

/** Foreground guaranteed ≥ 4.5 contrast (WCAG AA) */
const fgAA   = (bg: string, h: number) => fg(bg, h, 4.5);
/** Muted foreground — ≥ 3.0 contrast, visually de-emphasised */
const fgMute = (bg: string, h: number) => fg(bg, h, 3.0);
/** Subtle foreground — ≥ 2.5 contrast, used for line numbers / hints */
const fgHint = (bg: string, h: number) => fg(bg, h, 2.5);

/** Append 2-digit alpha to a 6-digit hex: alpha('#fff', 0.5) → '#ffffff80' */
function alpha(hex: string, opacity: number): string {
  return hex.slice(0, 7) + Math.round(opacity * 255).toString(16).padStart(2, '0');
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ─── Theme generation ─────────────────────────────────────────────────────────

export interface ThemeParams {
  hue?:             number;
  isDark?:          boolean;
  sat?:             number;
  accentHue?:       number;
  accentSat?:       number;
  /** Anchor the bg surface scale to this lightness value (from image). */
  baseLightness?:   number;
  /** Anchor the accent colour to this lightness value (from image). */
  accentLightness?: number;
}

/** Convert a hex colour to its HSL components (h 0-360, s 0-100, l 0-100). */
function hexToHslObj(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2 * 100;
  if (max === min) { return { h: 0, s: 0, l }; }
  const d = max - min;
  const s = (l > 50 ? d / (2 - max - min) : d / (max + min)) * 100;
  let h = 0;
  if (max === r)      { h = ((g - b) / d + (g < b ? 6 : 0)) * 60; }
  else if (max === g) { h = ((b - r) / d + 2) * 60; }
  else                { h = ((r - g) / d + 4) * 60; }
  return { h, s, l };
}

/**
 * Build a GeneratedTheme seeded by an array of colours extracted from an image.
 * Falls back to a fully-random theme if the array is empty or too small.
 */
export function buildThemeFromColors(extractedColors: string[]): GeneratedTheme {
  const valid = extractedColors.filter(c => /^#[0-9a-f]{6}$/i.test(c));
  if (valid.length < 3) { return generateColorTheme(); }

  const hslColors = valid.map(hexToHslObj);

  // Determine dark / light by median lightness
  const sortedByL = [...hslColors].sort((a, b) => a.l - b.l);
  const medianL   = sortedByL[Math.floor(sortedByL.length / 2)].l;
  const isDark    = medianL < 48;

  // Background hue: from the darkest (dark theme) or lightest (light theme) colour
  const bgCandidates = hslColors
    .filter(c => isDark ? c.l < 35 : c.l > 65)
    .sort((a, b) => isDark ? a.l - b.l : b.l - a.l);
  const bgColor = bgCandidates[0] ?? (isDark ? { h: 220, s: 25, l: 12 } : { h: 220, s: 15, l: 95 });

  // Accent: most saturated colour
  const accentCandidate = [...hslColors].sort((a, b) => b.s - a.s)[0]
    ?? { h: (bgColor.h + 180) % 360, s: 70, l: 55 };

  return generateColorTheme({
    hue:       bgColor.h,
    isDark,
    sat:       clamp(bgColor.s, 12, 48),
    accentHue: accentCandidate.h,
    accentSat: clamp(accentCandidate.s, 55, 95),
  });
}

// ─── Vibrant palette → theme ──────────────────────────────────────────────────

export interface VibrantPaletteColors {
  vibrant:      string | null;
  darkVibrant:  string | null;
  lightVibrant: string | null;
  muted:        string | null;
  darkMuted:    string | null;
  lightMuted:   string | null;
}

/**
 * Build a GeneratedTheme from a node-vibrant Palette.
 * ALL colour decisions derive exclusively from the six Vibrant swatches.
 * The swatches shown in the UI are the actual palette colours from the image.
 */
export function buildThemeFromVibrantPalette(palette: VibrantPaletteColors): GeneratedTheme {
  const all = [
    palette.vibrant, palette.darkVibrant, palette.lightVibrant,
    palette.muted, palette.darkMuted, palette.lightMuted,
  ].filter((c): c is string => c !== null);

  if (all.length < 2) { return generateColorTheme(); }

  // dark/light: average relative luminance of the full palette
  const avgLum = all.map(relativeLuminance).reduce((a, b) => a + b, 0) / all.length;
  const isDark = avgLum < 0.30;

  // Background seed: darkest colour for dark themes, lightest for light themes
  const sortedByL = [...all].sort((a, b) => hexToHslObj(a).l - hexToHslObj(b).l);
  const bgHex  = isDark ? sortedByL[0] : sortedByL[sortedByL.length - 1];
  const bgHsl  = hexToHslObj(bgHex);

  // Accent seed: Vibrant first, then DarkVibrant, then most-saturated swatch
  const accentHex =
    palette.vibrant ??
    palette.darkVibrant ??
    [...all].sort((a, b) => hexToHslObj(b).s - hexToHslObj(a).s)[0];
  const accentHsl = hexToHslObj(accentHex);

  const theme = generateColorTheme({
    hue:             bgHsl.h,
    isDark,
    sat:             clamp(bgHsl.s, 10, 55),
    accentHue:       accentHsl.h,
    accentSat:       clamp(accentHsl.s, 45, 95),
    // Anchor backgrounds and accent to the actual image swatch lightness values
    baseLightness:   bgHsl.l,
    accentLightness: accentHsl.l,
  });

  // Replace default swatches with the real palette colours for display
  if (all.length >= 3) {
    theme.swatches = all.slice(0, 6);
  }

  return theme;
}

export function generateColorTheme(params?: ThemeParams): GeneratedTheme {
  const hue    = params?.hue    ?? Math.floor(Math.random() * 360);
  const isDark = params?.isDark ?? Math.random() > 0.35;  // 65 % dark, 35 % light
  const sat    = params?.sat    ?? (20 + Math.random() * 30);

  const accentHue = params?.accentHue ?? (hue + 150 + Math.random() * 60) % 360;
  const accentSat = params?.accentSat ?? (65 + Math.random() * 25);

  // ── Background scale ────────────────────────────────────────────────────────
  // Five surfaces, ordered darkest→lightest for dark themes:
  //   bg0 = activity bar (deepest chrome)
  //   bg1 = sidebar
  //   bg2 = editor canvas
  //   bg3 = tab bar / header backgrounds
  //   bg4 = active tab / hover highlights
  //   bg5 = lighter hover / focus ring fill

  let bg0: string, bg1: string, bg2: string, bg3: string, bg4: string, bg5: string;

  if (isDark) {
    // Use baseLightness from image swatch if provided (anchors bg scale to real image colours)
    const base = params?.baseLightness !== undefined
      ? clamp(params.baseLightness, 4, 22)
      : clamp(8 + Math.random() * 8, 7, 16);
    bg0 = hslToHex(hue, sat,        clamp(base - 4, 3,    base));
    bg1 = hslToHex(hue, sat,        clamp(base - 2, 4,    base));
    bg2 = hslToHex(hue, sat,        base);
    bg3 = hslToHex(hue, sat,        clamp(base + 2, base, 24));
    bg4 = hslToHex(hue, sat,        clamp(base + 5, base, 28));
    bg5 = hslToHex(hue, sat,        clamp(base + 9, base, 34));
  } else {
    const base = params?.baseLightness !== undefined
      ? clamp(params.baseLightness, 80, 98)
      : clamp(93 + Math.random() * 5, 91, 98);
    bg0 = hslToHex(hue, sat * 0.55, clamp(base - 13, 68, base));
    bg1 = hslToHex(hue, sat * 0.42, clamp(base - 8,  72, base));
    bg2 = hslToHex(hue, sat * 0.18, base);
    bg3 = hslToHex(hue, sat * 0.32, clamp(base - 4,  80, base));
    bg4 = hslToHex(hue, sat * 0.16, clamp(base - 1,  88, base));
    bg5 = hslToHex(hue, sat * 0.40, clamp(base - 10, 74, base));
  }

  // ── Accent ──────────────────────────────────────────────────────────────────
  // Clamp image accent lightness into a readable range so buttons are never too dark/light
  const accentL = params?.accentLightness !== undefined
    ? clamp(params.accentLightness, isDark ? 42 : 32, isDark ? 74 : 66)
    : (isDark ? 54 + Math.random() * 10 : 42 + Math.random() * 10);
  const accent     = hslToHex(accentHue, accentSat, accentL);
  const accentFg   = fgAA(accent, accentHue);   // text ON accent buttons/badges
  const accentDark = hslToHex(accentHue, accentSat, clamp(accentL - 14, 18, accentL));
  const accentSoft = isDark
    ? hslToHex(accentHue, accentSat * 0.65, clamp(accentL - 22, 18, 48))
    : hslToHex(accentHue, accentSat * 0.45, clamp(accentL + 28, 62, 92));

  // ── Per-surface foregrounds (all contrast-checked) ──────────────────────────
  const f0     = fgAA(bg0, hue);   const f0m = fgMute(bg0, hue);  const f0h = fgHint(bg0, hue);
  const f1     = fgAA(bg1, hue);   const f1m = fgMute(bg1, hue);
  const f2     = fgAA(bg2, hue);   const f2m = fgMute(bg2, hue);  const f2h = fgHint(bg2, hue);
  const f3     = fgAA(bg3, hue);   const f3m = fgMute(bg3, hue);

  // ── Widget / overlay backgrounds (menus, dropdowns, suggestions, etc.) ──────
  const widgetBg = isDark
    ? hslToHex(hue, sat, clamp(relativeLuminance(bg2) < 0.05 ? 20 : 16, 12, 28))
    : hslToHex(hue, sat * 0.22, clamp(97, 90, 100));
  const widgetFg = fgAA(widgetBg, hue);
  const widgetFgM = fgMute(widgetBg, hue);

  // ── Input backgrounds ────────────────────────────────────────────────────────
  const inputBg = isDark
    ? hslToHex(hue, sat * 0.6, clamp(relativeLuminance(bg2) < 0.05 ? 6 : 8, 4, 14))
    : hslToHex(hue, sat * 0.08, 99);
  const inputFg = fgAA(inputBg, hue);

  // ── Semantic colors ──────────────────────────────────────────────────────────
  // Fixed-hue semantic colors; lightness tuned per dark/light to stay ≥ 3:1 on bg2
  const semantic = (h: number) => hslToHex(h, 70, isDark ? 65 : 40);
  const errColor  = semantic(355);
  const warnColor = semantic(38);
  const infoColor = semantic(210);
  const okColor   = semantic(140);

  // ── Borders ──────────────────────────────────────────────────────────────────
  const border      = alpha(isDark ? '#ffffff' : '#000000', isDark ? 0.1  : 0.12);
  const borderFocus = accent;

  // ── Selection / find ─────────────────────────────────────────────────────────
  const selBg  = alpha(accent, isDark ? 0.35 : 0.25);
  const findBg = alpha(hslToHex(accentHue, accentSat, isDark ? 40 : 72), isDark ? 0.55 : 0.40);

  // ── List active-selection (must be high contrast) ────────────────────────────
  const listSelBg  = accentSoft;
  const listSelFg  = fgAA(listSelBg, accentHue);

  const swatches = [bg0, bg1, bg2, bg4, f2, accent];

  // ── Token map ────────────────────────────────────────────────────────────────
  const t: ColorTokens = {

    // ── Base / global ──────────────────────────────────────────────────────────
    'foreground':                                      f2,
    'disabledForeground':                              f2h,
    'descriptionForeground':                           f2m,
    'errorForeground':                                 errColor,
    'focusBorder':                                     borderFocus,
    'selection.background':                            selBg,
    'widget.border':                                   border,
    'widget.shadow':                                   alpha('#000000', 0.3),
    'textLink.foreground':                             accent,
    'textLink.activeForeground':                       hslToHex(accentHue, accentSat, clamp(accentL + 10, accentL, 80)),
    'textBlockQuote.background':                       bg1,
    'textBlockQuote.border':                           accent,
    'textCodeBlock.background':                        bg3,
    'textPreformat.foreground':                        f2,
    'textSeparator.foreground':                        f2h,
    'icon.foreground':                                 f2m,
    'sash.hoverBorder':                                accent,

    // ── Editor ────────────────────────────────────────────────────────────────
    'editor.background':                               bg2,
    'editor.foreground':                               f2,
    'editorLineNumber.foreground':                     f2h,
    'editorLineNumber.activeForeground':               f2m,
    'editorLineNumber.dimmedForeground':               f2h,
    'editorCursor.background':                         bg2,
    'editorCursor.foreground':                         accent,
    'editor.selectionBackground':                      selBg,
    'editor.selectionForeground':                      fgAA(selBg.slice(0, 7), hue),
    'editor.inactiveSelectionBackground':              alpha(accent, isDark ? 0.18 : 0.13),
    'editor.selectionHighlightBackground':             alpha(accent, isDark ? 0.22 : 0.16),
    'editor.wordHighlightBackground':                  alpha(accent, isDark ? 0.22 : 0.16),
    'editor.wordHighlightStrongBackground':            alpha(accent, isDark ? 0.34 : 0.24),
    'editor.findMatchBackground':                      findBg,
    'editor.findMatchBorder':                          accent,
    'editor.findMatchHighlightBackground':             alpha(hslToHex(accentHue, accentSat, isDark ? 35 : 75), 0.40),
    'editor.findRangeHighlightBackground':             alpha(bg5, 0.55),
    'editor.rangeHighlightBackground':                 alpha(accent, isDark ? 0.12 : 0.08),
    'editor.lineHighlightBackground':                  alpha(bg5, isDark ? 0.45 : 0.55),
    'editor.lineHighlightBorder':                      alpha(bg5, 0),
    'editor.foldBackground':                           alpha(accentSoft, 0.15),
    'editorWhitespace.foreground':                     alpha(f2h, 0.45),
    'editorIndentGuide.background1':                   alpha(f2h, 0.22),
    'editorIndentGuide.activeBackground1':             alpha(f2m, 0.50),
    'editorRuler.foreground':                          alpha(f2h, 0.28),
    'editorCodeLens.foreground':                       f2h,
    'editorBracketMatch.background':                   alpha(accent, 0.2),
    'editorBracketMatch.border':                       accent,
    'editorBracketHighlight.foreground1':              accent,
    'editorBracketHighlight.foreground2':              hslToHex((accentHue + 60) % 360, accentSat, accentL),
    'editorBracketHighlight.foreground3':              hslToHex((accentHue + 120) % 360, accentSat, accentL),
    'editorOverviewRuler.border':                      border,
    'editorOverviewRuler.findMatchForeground':         accent,
    'editorOverviewRuler.selectionHighlightForeground': accentSoft,
    'editorOverviewRuler.errorForeground':             errColor,
    'editorOverviewRuler.warningForeground':           warnColor,
    'editorOverviewRuler.infoForeground':              infoColor,
    'editorOverviewRuler.addedForeground':             okColor,
    'editorOverviewRuler.modifiedForeground':          infoColor,
    'editorOverviewRuler.deletedForeground':           errColor,
    'editorError.foreground':                          errColor,
    'editorError.border':                              alpha(errColor, 0.4),
    'editorWarning.foreground':                        warnColor,
    'editorWarning.border':                            alpha(warnColor, 0.4),
    'editorInfo.foreground':                           infoColor,
    'editorInfo.border':                               alpha(infoColor, 0.4),
    'editorHint.foreground':                           alpha(infoColor, 0.8),
    'editorUnnecessaryCode.opacity':                   '#000000aa',
    'editorGutter.background':                         bg2,
    'editorGutter.modifiedBackground':                 infoColor,
    'editorGutter.addedBackground':                    okColor,
    'editorGutter.deletedBackground':                  errColor,

    // ── Editor widgets (suggest, hover, parameter hints) ──────────────────────
    'editorWidget.background':                         widgetBg,
    'editorWidget.foreground':                         widgetFg,
    'editorWidget.border':                             border,
    'editorWidget.resizeBorder':                       accent,
    'editorSuggestWidget.background':                  widgetBg,
    'editorSuggestWidget.border':                      border,
    'editorSuggestWidget.foreground':                  widgetFg,
    'editorSuggestWidget.selectedBackground':          listSelBg,
    'editorSuggestWidget.selectedForeground':          listSelFg,
    'editorSuggestWidget.selectedIconForeground':      listSelFg,
    'editorSuggestWidget.highlightForeground':         accent,
    'editorSuggestWidget.focusHighlightForeground':    accent,
    'editorSuggestWidgetStatus.foreground':            widgetFgM,
    'editorHoverWidget.background':                    widgetBg,
    'editorHoverWidget.border':                        border,
    'editorHoverWidget.foreground':                    widgetFg,
    'editorHoverWidget.statusBarBackground':           isDark ? bg3 : bg1,
    'editorGhostText.foreground':                      f2h,
    'editorGhostText.background':                      alpha(bg2, 0),

    // ── Activity bar ──────────────────────────────────────────────────────────
    'activityBar.background':                          bg0,
    'activityBar.foreground':                          f0,
    'activityBar.inactiveForeground':                  f0m,
    'activityBar.border':                              border,
    'activityBar.activeBorder':                        accent,
    'activityBar.activeBackground':                    alpha(accent, 0.15),
    'activityBar.activeFocusBorder':                   accent,
    'activityBar.dropBorder':                          accent,
    'activityBarBadge.background':                     accent,
    'activityBarBadge.foreground':                     accentFg,

    // ── Side bar ──────────────────────────────────────────────────────────────
    'sideBar.background':                              bg1,
    'sideBar.foreground':                              f1,
    'sideBar.border':                                  border,
    'sideBar.dropBackground':                          alpha(accent, 0.2),
    'sideBarTitle.foreground':                         f1,
    'sideBarSectionHeader.background':                 bg0,
    'sideBarSectionHeader.foreground':                 f0,
    'sideBarSectionHeader.border':                     border,
    'sideBarActivityBarTop.border':                    border,
    'sideBarStickyScroll.background':                  bg1,
    'sideBarStickyScroll.border':                      border,
    'sideBarStickyScroll.shadow':                      alpha('#000000', 0.2),

    // ── Status bar ────────────────────────────────────────────────────────────
    'statusBar.background':                            accentDark,
    'statusBar.foreground':                            fgAA(accentDark, accentHue),
    'statusBar.border':                                border,
    'statusBar.focusBorder':                           accent,
    'statusBar.debuggingBackground':                   hslToHex((accentHue + 30) % 360, accentSat, accentL),
    'statusBar.debuggingForeground':                   fgAA(hslToHex((accentHue + 30) % 360, accentSat, accentL), accentHue),
    'statusBar.debuggingBorder':                       border,
    'statusBar.noFolderBackground':                    bg0,
    'statusBar.noFolderForeground':                    f0,
    'statusBar.noFolderBorder':                        border,
    'statusBarItem.hoverBackground':                   alpha(isDark ? '#ffffff' : '#000000', 0.12),
    'statusBarItem.activeBackground':                  alpha(isDark ? '#ffffff' : '#000000', 0.18),
    'statusBarItem.focusBorder':                       accent,
    'statusBarItem.remoteBackground':                  accent,
    'statusBarItem.remoteForeground':                  accentFg,
    'statusBarItem.remoteHoverBackground':             hslToHex(accentHue, accentSat, clamp(accentL + (isDark ? 8 : -8), 20, 85)),
    'statusBarItem.errorBackground':                   hslToHex(355, 70, isDark ? 40 : 35),
    'statusBarItem.errorForeground':                   '#ffffff',
    'statusBarItem.warningBackground':                 hslToHex(38, 80, isDark ? 38 : 35),
    'statusBarItem.warningForeground':                 '#ffffff',

    // ── Title bar ─────────────────────────────────────────────────────────────
    'titleBar.activeBackground':                       bg0,
    'titleBar.activeForeground':                       f0,
    'titleBar.inactiveBackground':                     bg0,
    'titleBar.inactiveForeground':                     f0h,
    'titleBar.border':                                 border,

    // ── Tab bar ───────────────────────────────────────────────────────────────
    'editorGroupHeader.tabsBackground':                bg3,
    'editorGroupHeader.tabsBorder':                    border,
    'editorGroupHeader.noTabsBackground':              bg3,
    'editorGroupHeader.border':                        border,
    'tab.activeBackground':                            bg2,
    'tab.activeForeground':                            f2,
    'tab.border':                                      border,
    'tab.activeBorder':                                bg2,
    'tab.activeBorderTop':                             accent,
    'tab.activeModifiedBorder':                        hslToHex(accentHue, accentSat, accentL),
    'tab.inactiveBackground':                          bg3,
    'tab.inactiveForeground':                          f3m,
    'tab.inactiveModifiedBorder':                      alpha(accent, 0.5),
    'tab.hoverBackground':                             bg4,
    'tab.hoverForeground':                             f3,
    'tab.hoverBorder':                                 accent,
    'tab.unfocusedActiveBackground':                   bg3,
    'tab.unfocusedActiveForeground':                   f3m,
    'tab.unfocusedActiveBorder':                       bg3,
    'tab.unfocusedActiveBorderTop':                    alpha(accent, 0.5),
    'tab.unfocusedInactiveBackground':                 bg3,
    'tab.unfocusedInactiveForeground':                 f3m,
    'tab.unfocusedHoverBackground':                    bg4,
    'tab.unfocusedHoverForeground':                    f3m,
    'tab.lastPinnedBorder':                            border,

    // ── Editor groups / splits ────────────────────────────────────────────────
    'editorGroup.border':                              border,
    'editorGroup.dropBackground':                      alpha(accent, 0.2),
    'editorGroup.dropIntoPromptForeground':            f2,
    'editorGroup.dropIntoPromptBackground':            widgetBg,
    'editorGroup.emptyBackground':                     bg2,
    'editorGroup.focusedEmptyBorder':                  accent,

    // ── Panels (terminal, output, etc.) ───────────────────────────────────────
    'panel.background':                                bg1,
    'panel.border':                                    border,
    'panel.dropBorder':                                accent,
    'panelTitle.activeForeground':                     f1,
    'panelTitle.inactiveForeground':                   f1m,
    'panelTitle.activeBorder':                         accent,
    'panelInput.border':                               border,
    'panelSection.border':                             border,
    'panelSection.dropBackground':                     alpha(accent, 0.2),
    'panelSectionHeader.background':                   bg0,
    'panelSectionHeader.foreground':                   f0,
    'panelSectionHeader.border':                       border,
    'panelStickyScroll.background':                    bg1,
    'panelStickyScroll.border':                        border,
    'panelStickyScroll.shadow':                        alpha('#000000', 0.2),

    // ── Terminal ──────────────────────────────────────────────────────────────
    'terminal.background':                             bg2,
    'terminal.foreground':                             f2,
    'terminal.border':                                 border,
    'terminal.selectionBackground':                    selBg,
    'terminal.selectionForeground':                    fgAA(selBg.slice(0, 7), hue),
    'terminal.inactiveSelectionBackground':            alpha(accent, isDark ? 0.18 : 0.13),
    'terminalCursor.background':                       bg2,
    'terminalCursor.foreground':                       accent,
    'terminal.dropBackground':                         alpha(accent, 0.2),
    'terminal.tab.activeBorder':                       accent,
    // ANSI colors — fixed palette tuned per dark/light for readability
    'terminal.ansiBlack':                              bg0,
    'terminal.ansiRed':                                hslToHex(355, 70, isDark ? 65 : 40),
    'terminal.ansiGreen':                              hslToHex(140, 60, isDark ? 62 : 38),
    'terminal.ansiYellow':                             hslToHex(43,  80, isDark ? 65 : 40),
    'terminal.ansiBlue':                               hslToHex(220, 70, isDark ? 68 : 45),
    'terminal.ansiMagenta':                            hslToHex(300, 60, isDark ? 68 : 45),
    'terminal.ansiCyan':                               hslToHex(185, 65, isDark ? 65 : 40),
    'terminal.ansiWhite':                              hslToHex(hue, 10, isDark ? 85 : 45),
    'terminal.ansiBrightBlack':                        hslToHex(hue, sat, isDark ? 42 : 52),
    'terminal.ansiBrightRed':                          hslToHex(355, 70, isDark ? 72 : 48),
    'terminal.ansiBrightGreen':                        hslToHex(140, 60, isDark ? 68 : 43),
    'terminal.ansiBrightYellow':                       hslToHex(43,  80, isDark ? 72 : 48),
    'terminal.ansiBrightBlue':                         hslToHex(220, 70, isDark ? 75 : 52),
    'terminal.ansiBrightMagenta':                      hslToHex(300, 60, isDark ? 75 : 52),
    'terminal.ansiBrightCyan':                         hslToHex(185, 65, isDark ? 72 : 48),
    'terminal.ansiBrightWhite':                        hslToHex(hue, 5,  isDark ? 95 : 18),

    // ── Buttons ───────────────────────────────────────────────────────────────
    'button.background':                               accent,
    'button.foreground':                               accentFg,
    'button.border':                                   alpha(accentFg, 0.08),
    'button.hoverBackground':                          hslToHex(accentHue, accentSat, clamp(accentL + (isDark ? 8 : -8), 20, 85)),
    'button.secondaryBackground':                      bg4,
    'button.secondaryForeground':                      fgAA(bg4, hue),
    'button.secondaryHoverBackground':                 bg5,
    'button.separator':                                alpha(accentFg, 0.3),

    // ── Inputs ────────────────────────────────────────────────────────────────
    'input.background':                                inputBg,
    'input.foreground':                                inputFg,
    'input.border':                                    border,
    'input.placeholderForeground':                     fgHint(inputBg, hue),
    'inputOption.activeBackground':                    accentSoft,
    'inputOption.activeForeground':                    fgAA(accentSoft, accentHue),
    'inputOption.activeBorder':                        accent,
    'inputOption.hoverBackground':                     alpha(accent, 0.1),
    'inputValidation.errorBackground':                 isDark ? hslToHex(355, 35, 18) : hslToHex(355, 75, 94),
    'inputValidation.errorForeground':                 isDark ? hslToHex(355, 70, 72) : hslToHex(355, 70, 28),
    'inputValidation.errorBorder':                     hslToHex(355, 70, isDark ? 55 : 45),
    'inputValidation.warningBackground':               isDark ? hslToHex(38, 35, 16) : hslToHex(38, 75, 94),
    'inputValidation.warningForeground':               isDark ? hslToHex(38, 80, 68) : hslToHex(38, 70, 25),
    'inputValidation.warningBorder':                   hslToHex(38, 80, isDark ? 55 : 45),
    'inputValidation.infoBackground':                  isDark ? hslToHex(210, 35, 18) : hslToHex(210, 65, 94),
    'inputValidation.infoForeground':                  isDark ? hslToHex(210, 70, 72) : hslToHex(210, 70, 25),
    'inputValidation.infoBorder':                      hslToHex(210, 70, isDark ? 55 : 45),

    // ── Dropdowns ─────────────────────────────────────────────────────────────
    'dropdown.background':                             widgetBg,
    'dropdown.foreground':                             widgetFg,
    'dropdown.border':                                 border,
    'dropdown.listBackground':                         widgetBg,

    // ── Lists / trees ─────────────────────────────────────────────────────────
    'list.activeSelectionBackground':                  listSelBg,
    'list.activeSelectionForeground':                  listSelFg,
    'list.activeSelectionIconForeground':              listSelFg,
    'list.inactiveSelectionBackground':                alpha(listSelBg, 0.6),
    'list.inactiveSelectionForeground':                listSelFg,
    'list.inactiveSelectionIconForeground':            listSelFg,
    'list.hoverBackground':                            bg4,
    'list.hoverForeground':                            f2,
    'list.focusBackground':                            listSelBg,
    'list.focusForeground':                            listSelFg,
    'list.focusOutline':                               accent,
    'list.focusHighlightForeground':                   accent,
    'list.inactiveFocusBackground':                    alpha(listSelBg, 0.5),
    'list.inactiveFocusOutline':                       alpha(accent, 0.5),
    'list.dropBackground':                             alpha(accent, 0.25),
    'list.highlightForeground':                        accent,
    'list.filterMatchBackground':                      findBg,
    'list.filterMatchBorder':                          accent,
    'list.deemphasizedForeground':                     f2m,
    'list.errorForeground':                            errColor,
    'list.warningForeground':                          warnColor,
    'listFilterWidget.background':                     widgetBg,
    'listFilterWidget.outline':                        accent,
    'listFilterWidget.noMatchesOutline':               errColor,
    'listFilterWidget.shadow':                         alpha('#000000', 0.25),
    'tree.indentGuidesStroke':                         alpha(f2h, 0.45),
    'tree.inactiveIndentGuidesStroke':                 alpha(f2h, 0.22),
    'tree.tableColumnsBorder':                         border,
    'tree.tableOddRowsBackground':                     alpha(bg3, isDark ? 0.4 : 0.5),

    // ── Badges ────────────────────────────────────────────────────────────────
    'badge.background':                                accent,
    'badge.foreground':                                accentFg,

    // ── Quick picker (Ctrl+P, Command Palette) ────────────────────────────────
    'quickInput.background':                           widgetBg,
    'quickInput.foreground':                           widgetFg,
    'quickInputTitle.background':                      alpha(accent, 0.15),
    'quickInputList.focusBackground':                  listSelBg,
    'quickInputList.focusForeground':                  listSelFg,
    'quickInputList.focusIconForeground':              listSelFg,
    'pickerGroup.border':                              border,
    'pickerGroup.foreground':                          accent,

    // ── Command center ────────────────────────────────────────────────────────
    'commandCenter.foreground':                        f0m,
    'commandCenter.activeForeground':                  f0,
    'commandCenter.background':                        bg0,
    'commandCenter.activeBackground':                  bg4,
    'commandCenter.border':                            border,
    'commandCenter.inactiveForeground':                f0h,
    'commandCenter.inactiveBorder':                    border,
    'commandCenter.activeBorder':                      accent,
    'commandCenter.debuggingBackground':               alpha(hslToHex((accentHue + 30) % 360, accentSat, accentL), 0.9),

    // ── Notifications ─────────────────────────────────────────────────────────
    'notifications.background':                        widgetBg,
    'notifications.foreground':                        widgetFg,
    'notifications.border':                            border,
    'notificationToast.border':                        border,
    'notificationCenter.border':                       border,
    'notificationCenterHeader.background':             bg0,
    'notificationCenterHeader.foreground':             f0,
    'notificationsErrorIcon.foreground':               errColor,
    'notificationsWarningIcon.foreground':             warnColor,
    'notificationsInfoIcon.foreground':                infoColor,
    'notificationLink.foreground':                     accent,

    // ── Breadcrumbs ───────────────────────────────────────────────────────────
    'breadcrumb.foreground':                           f2m,
    'breadcrumb.background':                           bg2,
    'breadcrumb.focusForeground':                      f2,
    'breadcrumb.activeSelectionForeground':            f2,
    'breadcrumbPicker.background':                     widgetBg,

    // ── Menus (context menus, menu bar) ───────────────────────────────────────
    'menu.background':                                 widgetBg,
    'menu.foreground':                                 widgetFg,
    'menu.selectionBackground':                        listSelBg,
    'menu.selectionForeground':                        listSelFg,
    'menu.selectionBorder':                            border,
    'menu.separatorBackground':                        border,
    'menu.border':                                     border,
    'menubar.selectionBackground':                     alpha(accent, 0.15),
    'menubar.selectionForeground':                     f0,
    'menubar.selectionBorder':                         border,

    // ── Scrollbars ────────────────────────────────────────────────────────────
    'scrollbarSlider.background':                      alpha(isDark ? '#ffffff' : '#000000', 0.15),
    'scrollbarSlider.hoverBackground':                 alpha(isDark ? '#ffffff' : '#000000', 0.26),
    'scrollbarSlider.activeBackground':                alpha(isDark ? '#ffffff' : '#000000', 0.38),
    'scrollbar.shadow':                                alpha('#000000', 0.28),

    // ── Minimap ───────────────────────────────────────────────────────────────
    'minimap.findMatchHighlight':                      alpha(accent, 0.7),
    'minimap.selectionHighlight':                      alpha(accentSoft, 0.65),
    'minimap.selectionOccurrenceHighlight':            alpha(accentSoft, 0.45),
    'minimap.errorHighlight':                          alpha(errColor, 0.7),
    'minimap.warningHighlight':                        alpha(warnColor, 0.7),
    'minimap.background':                              alpha(bg2, 0.9),
    'minimapSlider.background':                        alpha(isDark ? '#ffffff' : '#000000', 0.10),
    'minimapSlider.hoverBackground':                   alpha(isDark ? '#ffffff' : '#000000', 0.18),
    'minimapSlider.activeBackground':                  alpha(isDark ? '#ffffff' : '#000000', 0.28),
    'minimapGutter.addedBackground':                   alpha(okColor, 0.7),
    'minimapGutter.modifiedBackground':                alpha(infoColor, 0.7),
    'minimapGutter.deletedBackground':                 alpha(errColor, 0.7),

    // ── Peek view ─────────────────────────────────────────────────────────────
    'peekView.border':                                 accent,
    'peekViewEditor.background':                       isDark ? hslToHex(hue, sat, clamp(parseInt(bg2.slice(1, 3), 16) < 30 ? 10 : 14, 8, 20)) : hslToHex(hue, sat * 0.18, 97),
    'peekViewEditorGutter.background':                 isDark ? hslToHex(hue, sat, clamp(parseInt(bg2.slice(1, 3), 16) < 30 ? 8 : 12, 6, 18)) : hslToHex(hue, sat * 0.18, 93),
    'peekViewEditor.matchHighlightBackground':         findBg,
    'peekViewEditor.matchHighlightBorder':             accent,
    'peekViewResult.background':                       bg1,
    'peekViewResult.fileForeground':                   f1,
    'peekViewResult.lineForeground':                   f1m,
    'peekViewResult.matchHighlightBackground':         findBg,
    'peekViewResult.selectionBackground':              listSelBg,
    'peekViewResult.selectionForeground':              listSelFg,
    'peekViewTitle.background':                        bg0,
    'peekViewTitleDescription.foreground':             f0m,
    'peekViewTitleLabel.foreground':                   f0,

    // ── Git decorations ───────────────────────────────────────────────────────
    'gitDecoration.addedResourceForeground':           hslToHex(140, 55, isDark ? 62 : 36),
    'gitDecoration.modifiedResourceForeground':        hslToHex(220, 65, isDark ? 68 : 42),
    'gitDecoration.deletedResourceForeground':         hslToHex(355, 65, isDark ? 68 : 42),
    'gitDecoration.renamedResourceForeground':         hslToHex(185, 60, isDark ? 65 : 40),
    'gitDecoration.untrackedResourceForeground':       hslToHex(140, 55, isDark ? 62 : 36),
    'gitDecoration.ignoredResourceForeground':         f2h,
    'gitDecoration.conflictingResourceForeground':     hslToHex(38, 75, isDark ? 65 : 40),
    'gitDecoration.submoduleResourceForeground':       hslToHex(185, 60, isDark ? 65 : 40),
    'gitDecoration.stageModifiedResourceForeground':   hslToHex(220, 65, isDark ? 68 : 42),
    'gitDecoration.stageDeletedResourceForeground':    hslToHex(355, 65, isDark ? 68 : 42),

    // ── Keybinding labels ─────────────────────────────────────────────────────
    'keybindingLabel.background':                      alpha(bg5, 0.8),
    'keybindingLabel.foreground':                      f2,
    'keybindingLabel.border':                          border,
    'keybindingLabel.bottomBorder':                    border,

    // ── Checkboxes & radio ────────────────────────────────────────────────────
    'checkbox.background':                             inputBg,
    'checkbox.foreground':                             inputFg,
    'checkbox.border':                                 border,
    'checkbox.selectBackground':                       accentSoft,
    'checkbox.selectBorder':                           accent,

    // ── Buttons — extension / marketplace ────────────────────────────────────
    'extensionButton.prominentBackground':             accent,
    'extensionButton.prominentForeground':             accentFg,
    'extensionButton.prominentHoverBackground':        hslToHex(accentHue, accentSat, clamp(accentL + (isDark ? 8 : -8), 20, 85)),
    'extensionButton.background':                      accent,
    'extensionButton.foreground':                      accentFg,
    'extensionButton.hoverBackground':                 hslToHex(accentHue, accentSat, clamp(accentL + (isDark ? 8 : -8), 20, 85)),
    'extensionButton.separator':                       alpha(accentFg, 0.3),
    'extensionBadge.remoteBackground':                 accentDark,
    'extensionBadge.remoteForeground':                 fgAA(accentDark, accentHue),
    'extensionIcon.starForeground':                    hslToHex(43, 80, isDark ? 65 : 42),
    'extensionIcon.verifiedForeground':                okColor,
    'extensionIcon.preReleaseForeground':              warnColor,
    'extensionIcon.sponsorForeground':                 hslToHex(355, 65, isDark ? 68 : 42),

    // ── Settings editor ───────────────────────────────────────────────────────
    'settings.headerForeground':                       f2,
    'settings.headerBorder':                           border,
    'settings.modifiedItemIndicator':                  accent,
    'settings.dropdownBackground':                     widgetBg,
    'settings.dropdownForeground':                     widgetFg,
    'settings.dropdownBorder':                         border,
    'settings.dropdownListBorder':                     border,
    'settings.checkboxBackground':                     inputBg,
    'settings.checkboxForeground':                     inputFg,
    'settings.checkboxBorder':                         border,
    'settings.textInputBackground':                    inputBg,
    'settings.textInputForeground':                    inputFg,
    'settings.textInputBorder':                        border,
    'settings.numberInputBackground':                  inputBg,
    'settings.numberInputForeground':                  inputFg,
    'settings.numberInputBorder':                      border,
    'settings.focusedRowBackground':                   alpha(accent, 0.06),
    'settings.rowHoverBackground':                     bg4,
    'settings.sashBorder':                             border,
    'settings.settingsHeaderHoverForeground':          accent,

    // ── Debug ─────────────────────────────────────────────────────────────────
    'debugToolBar.background':                         widgetBg,
    'debugToolBar.border':                             border,
    'debugExceptionWidget.background':                 isDark ? hslToHex(355, 30, 15) : hslToHex(355, 60, 95),
    'debugExceptionWidget.border':                     hslToHex(355, 60, isDark ? 50 : 45),
    'debugTokenExpression.name':                       hslToHex(accentHue, accentSat, isDark ? 68 : 42),
    'debugTokenExpression.value':                      okColor,
    'debugTokenExpression.string':                     hslToHex(43, 70, isDark ? 65 : 40),
    'debugTokenExpression.boolean':                    infoColor,
    'debugTokenExpression.number':                     hslToHex(300, 55, isDark ? 70 : 45),
    'debugTokenExpression.error':                      errColor,
    'debugConsole.infoForeground':                     infoColor,
    'debugConsole.warningForeground':                  warnColor,
    'debugConsole.errorForeground':                    errColor,
    'debugConsole.sourceForeground':                   f2m,
    'debugConsoleInputIcon.foreground':                accent,
    'debugIcon.breakpointForeground':                  errColor,
    'debugIcon.breakpointDisabledForeground':          f2m,
    'debugIcon.breakpointUnverifiedForeground':        f2m,
    'debugIcon.startForeground':                       okColor,
    'debugIcon.pauseForeground':                       warnColor,
    'debugIcon.stopForeground':                        errColor,
    'debugIcon.disconnectForeground':                  errColor,
    'debugIcon.restartForeground':                     okColor,
    'debugIcon.stepOverForeground':                    accent,
    'debugIcon.stepIntoForeground':                    accent,
    'debugIcon.stepOutForeground':                     accent,
    'debugIcon.continueForeground':                    accent,
    'debugIcon.stepBackForeground':                    accent,

    // ── Progress bar ──────────────────────────────────────────────────────────
    'progressBar.background':                          accent,

    // ── Welcome page ──────────────────────────────────────────────────────────
    'welcomePage.background':                          bg2,
    'welcomePage.tileBackground':                      bg3,
    'welcomePage.tileHoverBackground':                 bg4,
    'welcomePage.tileBorder':                          border,
    'welcomePage.buttonBackground':                    alpha(bg4, 0.8),
    'welcomePage.buttonHoverBackground':               bg4,
    'walkThrough.embeddedEditorBackground':            bg3,
    'walkthrough.stepTitle.foreground':                f2,

    // ── Source control ────────────────────────────────────────────────────────
    'scm.providerBorder':                              border,

    // ── Charts ────────────────────────────────────────────────────────────────
    'charts.foreground':                               f2,
    'charts.lines':                                    f2m,
    'charts.red':                                      hslToHex(355, 70, isDark ? 65 : 42),
    'charts.blue':                                     hslToHex(220, 70, isDark ? 68 : 45),
    'charts.yellow':                                   hslToHex(43,  80, isDark ? 65 : 42),
    'charts.orange':                                   hslToHex(25,  75, isDark ? 65 : 42),
    'charts.green':                                    okColor,
    'charts.purple':                                   hslToHex(280, 65, isDark ? 68 : 45),

    // ── Symbol icons ──────────────────────────────────────────────────────────
    'symbolIcon.arrayForeground':                      f2,
    'symbolIcon.booleanForeground':                    infoColor,
    'symbolIcon.classForeground':                      hslToHex(43, 80, isDark ? 65 : 42),
    'symbolIcon.colorForeground':                      hslToHex(300, 60, isDark ? 68 : 45),
    'symbolIcon.constantForeground':                   hslToHex(accentHue, accentSat, isDark ? 68 : 42),
    'symbolIcon.enumeratorForeground':                 hslToHex(43, 70, isDark ? 65 : 40),
    'symbolIcon.enumeratorMemberForeground':           hslToHex(43, 70, isDark ? 65 : 40),
    'symbolIcon.eventForeground':                      errColor,
    'symbolIcon.fieldForeground':                      hslToHex(accentHue, 55, isDark ? 65 : 42),
    'symbolIcon.fileForeground':                       f2,
    'symbolIcon.folderForeground':                     hslToHex(accentHue, accentSat, isDark ? 65 : 42),
    'symbolIcon.functionForeground':                   hslToHex(220, 70, isDark ? 68 : 45),
    'symbolIcon.interfaceForeground':                  okColor,
    'symbolIcon.keyForeground':                        hslToHex(accentHue, accentSat, isDark ? 68 : 42),
    'symbolIcon.keywordForeground':                    hslToHex(300, 60, isDark ? 68 : 45),
    'symbolIcon.methodForeground':                     hslToHex(220, 70, isDark ? 68 : 45),
    'symbolIcon.moduleForeground':                     f2,
    'symbolIcon.namespaceForeground':                  f2,
    'symbolIcon.nullForeground':                       f2m,
    'symbolIcon.numberForeground':                     hslToHex(43, 80, isDark ? 68 : 42),
    'symbolIcon.objectForeground':                     hslToHex(43, 70, isDark ? 65 : 40),
    'symbolIcon.operatorForeground':                   f2,
    'symbolIcon.packageForeground':                    hslToHex(accentHue, accentSat, isDark ? 65 : 42),
    'symbolIcon.propertyForeground':                   hslToHex(accentHue, 55, isDark ? 65 : 42),
    'symbolIcon.referenceForeground':                  f2,
    'symbolIcon.snippetForeground':                    f2,
    'symbolIcon.stringForeground':                     okColor,
    'symbolIcon.structForeground':                     hslToHex(43, 70, isDark ? 65 : 40),
    'symbolIcon.textForeground':                       f2,
    'symbolIcon.typeParameterForeground':              okColor,
    'symbolIcon.unitForeground':                       f2,
    'symbolIcon.variableForeground':                   hslToHex(accentHue, 55, isDark ? 65 : 42),
  };

  return { tokens: t, swatches, name: getThemeName(hue, isDark), isDark };
}

function getThemeName(hue: number, isDark: boolean): string {
  const hueNames: Array<[number, string]> = [
    [15, 'Red'], [45, 'Orange'], [65, 'Yellow'],
    [150, 'Green'], [195, 'Cyan'], [255, 'Blue'],
    [285, 'Violet'], [345, 'Magenta'], [360, 'Red'],
  ];
  let hueName = 'Red';
  for (const [max, name] of hueNames) {
    if (hue <= max) { hueName = name; break; }
  }
  const darkMoods  = ['Midnight', 'Dark', 'Deep', 'Shadow', 'Night', 'Obsidian', 'Noir'];
  const lightMoods = ['Light', 'Dawn', 'Soft', 'Airy', 'Pale', 'Mist', 'Pearl'];
  const moods = isDark ? darkMoods : lightMoods;
  return `${moods[Math.floor(Math.random() * moods.length)]} ${hueName}`;
}
