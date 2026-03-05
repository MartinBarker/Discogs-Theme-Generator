import * as vscode from 'vscode';
import { generateColorTheme, buildThemeFromVibrantPalette, ColorTokens, GeneratedTheme, VibrantPaletteColors } from './colorTheme';
import { fetchRandomRelease, fetchReleaseById, searchAndFetchRelease, fetchImageBuffer, fetchImageDataUri, extractVibrantPalette, DiscogsRelease } from './discogsApi';
import {
  getHistory, pushHistory, deleteEntry, clearHistory,
  toSummary, discogsFromRelease, HistoryEntry,
} from './history';

const PREV_KEY  = 'discogsThemeGenerator.prev';   // { scope, tokens }
const SCOPE_KEY = 'discogsThemeGenerator.workspaceScope'; // true = workspace
const AR_KEY    = 'discogsThemeGenerator.autoRefresh';    // AutoRefreshConfig

interface AutoRefreshConfig {
  mode: 'off' | 'onOpen' | 'interval';
  intervalHours: number;
  intervalMinutes?: number;
}

export class DiscogsThemeGeneratorPanel {
  private panel: vscode.WebviewPanel | undefined;
  private readonly ctx: vscode.ExtensionContext;
  private autoRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPalette:   VibrantPaletteColors | undefined;
  private lastIsDark:    boolean = false;
  private lastRollIndex: number  = 0;
  private lastRelease:   (DiscogsRelease & { thumbDataUri?: string }) | undefined;

  constructor(ctx: vscode.ExtensionContext) {
    this.ctx = ctx;
    ctx.subscriptions.push({ dispose: () => this.clearTimer() });
  }

  openOrReveal() {
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.One); return; }
    this.panel = vscode.window.createWebviewPanel(
      'discogsThemeGenerator', 'Discogs Theme Generator', vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'images', 'icon.png');
    this.panel.webview.html = this.buildHtml();
    this.panel.webview.onDidReceiveMessage((m) => this.handleMessage(m));
    this.panel.onDidDispose(() => { this.panel = undefined; });
    setTimeout(() => {
      this.sendHistory();
      this.post({ command: 'stateSync', scope: this.getScopeLabel(), autoRefresh: this.getAutoRefreshConfig() });
      if (getHistory(this.ctx).length === 0) {
        setTimeout(() => this.startDiscogsFlow(), 400);
      }
    }, 300);
  }

  // ─── Called by extension.ts on activate ──────────────────────────────────────

  public startAutoRefresh() {
    const cfg = this.getAutoRefreshConfig();
    if (cfg.mode === 'onOpen') {
      this.applyDiscogsThemeSilently();
    } else if (cfg.mode === 'interval') {
      this.startAutoRefreshTimer();
    }
  }

  // ─── Message router ──────────────────────────────────────────────────────────

  private async handleMessage(msg: any) {
    switch (msg.command) {
      case 'generate':         await this.applyRandom(); break;
      case 'fromDiscogs':      await this.startDiscogsFlow(); break;
      case 'fromDiscogsSearch': await this.startDiscogsSearchFlow(msg.query); break;
      case 'loadEntry':      await this.loadHistoryEntry(msg.id); break;
      case 'deleteEntry':    await this.deleteHistoryEntry(msg.id); break;
      case 'copyJson':       await this.copyJson(msg.id ?? null, msg.tokens ?? null, msg.name ?? ''); break;
      case 'clearHistory':   await this.doClearHistory(); break;
      case 'reset':          await this.resetTheme(); break;
      case 'openUrl':        vscode.env.openExternal(vscode.Uri.parse(msg.url)); break;
      case 'setScope':       this.setScope(msg.useWorkspace); break;
      case 'setAutoRefresh':   this.setAutoRefresh(msg.config); break;
      case 'toggleDarkLight':  await this.toggleDarkLight(); break;
      case 'rerollColors':     await this.rerollColors(); break;
    }
  }

  // ─── Scope helpers ───────────────────────────────────────────────────────────

  private useWorkspaceScope(): boolean {
    return this.ctx.globalState.get<boolean>(SCOPE_KEY, true);
  }

  private getScopeLabel(): 'workspace' | 'global' {
    return this.useWorkspaceScope() ? 'workspace' : 'global';
  }

  private getConfigTarget(): vscode.ConfigurationTarget {
    if (this.useWorkspaceScope() && vscode.workspace.workspaceFolders?.length) {
      return vscode.ConfigurationTarget.Workspace;
    }
    return vscode.ConfigurationTarget.Global;
  }

  private setScope(useWorkspace: boolean) {
    this.ctx.globalState.update(SCOPE_KEY, useWorkspace);
  }

  // ─── Auto-refresh helpers ─────────────────────────────────────────────────────

  private getAutoRefreshConfig(): AutoRefreshConfig {
    return this.ctx.globalState.get<AutoRefreshConfig>(AR_KEY, { mode: 'off', intervalHours: 2, intervalMinutes: 0 });
  }

  private setAutoRefresh(config: AutoRefreshConfig) {
    this.ctx.globalState.update(AR_KEY, config);
    this.clearTimer();
    if (config.mode === 'interval') { this.startAutoRefreshTimer(); }
  }

  private startAutoRefreshTimer() {
    this.clearTimer();
    const cfg = this.getAutoRefreshConfig();
    if (cfg.mode !== 'interval') { return; }
    const totalMins = Math.max(5, (cfg.intervalHours ?? 2) * 60 + (cfg.intervalMinutes ?? 0));
    const ms = totalMins * 60 * 1000;
    const tick = async () => {
      await this.applyDiscogsThemeSilently();
      this.autoRefreshTimer = setTimeout(tick, ms);
    };
    this.autoRefreshTimer = setTimeout(tick, ms);
  }

  private clearTimer() {
    if (this.autoRefreshTimer) { clearTimeout(this.autoRefreshTimer); this.autoRefreshTimer = undefined; }
  }

  // ─── Toggle dark/light & re-roll ─────────────────────────────────────────────

  private async toggleDarkLight() {
    if (!this.lastPalette) { return; }
    this.lastIsDark    = !this.lastIsDark;
    this.lastRollIndex = 0;
    const theme = buildThemeFromVibrantPalette(this.lastPalette, { isDark: this.lastIsDark, rollIndex: 0 });
    await this.applyTheme(theme, 'discogs', this.lastRelease);
  }

  private async rerollColors() {
    if (!this.lastPalette) { return; }
    this.lastRollIndex++;
    const theme = buildThemeFromVibrantPalette(this.lastPalette, { isDark: this.lastIsDark, rollIndex: this.lastRollIndex });
    await this.applyTheme(theme, 'discogs', this.lastRelease);
  }

  // ─── Random theme ─────────────────────────────────────────────────────────────

  private async applyRandom() {
    const theme = generateColorTheme();
    await this.applyTheme(theme, 'random');
  }

  // ─── Discogs flow ─────────────────────────────────────────────────────────────

  private async startDiscogsFlow() {
    this.post({ command: 'statusUpdate', message: 'Finding a release on Discogs…' });
    try {
      const release = await fetchRandomRelease();

      this.post({ command: 'statusUpdate', message: 'Fetching album art…' });
      const { buffer, contentType } = await fetchImageBuffer(release.imageUrl);
      const imageDataUri = `data:${contentType};base64,${buffer.toString('base64')}`;

      let thumbDataUri = imageDataUri;
      if (release.thumb && release.thumb !== release.imageUrl) {
        try { thumbDataUri = await fetchImageDataUri(release.thumb); }
        catch { /* fall back to full image data URI */ }
      }

      // Show album art card immediately
      this.post({ command: 'discogsImageReady', release, imageDataUri, thumbDataUri });

      this.post({ command: 'statusUpdate', message: 'Extracting colours with Vibrant…' });
      const palette = await extractVibrantPalette(buffer);

      // Send debug info: exact URL passed to Vibrant + all extracted swatch hex values
      this.post({ command: 'vibrantDebug', imageUrl: release.imageUrl, palette });

      this.post({ command: 'statusUpdate', message: 'Applying palette…' });
      this.lastPalette   = palette;
      this.lastIsDark    = false;
      this.lastRollIndex = 0;
      this.lastRelease   = { ...release, thumbDataUri };
      const theme = buildThemeFromVibrantPalette(palette, { isDark: false, rollIndex: 0 });
      await this.applyTheme(theme, 'discogs', this.lastRelease);
    } catch (e: any) {
      this.post({ command: 'discogsError', message: e.message });
      vscode.window.showErrorMessage(`Discogs fetch failed: ${e.message}`);
    }
  }

  private async startDiscogsSearchFlow(query: string) {
    const trimmed = query.trim();
    if (!trimmed) { return; }
    this.post({ command: 'statusUpdate', message: /^\d+$/.test(trimmed) ? `Fetching release #${trimmed}…` : `Searching Discogs for "${trimmed}"…` });
    try {
      const release = /^\d+$/.test(trimmed)
        ? await fetchReleaseById(parseInt(trimmed, 10))
        : await searchAndFetchRelease(trimmed);

      this.post({ command: 'statusUpdate', message: 'Fetching album art…' });
      const { buffer, contentType } = await fetchImageBuffer(release.imageUrl);
      const imageDataUri = `data:${contentType};base64,${buffer.toString('base64')}`;

      let thumbDataUri = imageDataUri;
      if (release.thumb && release.thumb !== release.imageUrl) {
        try { thumbDataUri = await fetchImageDataUri(release.thumb); } catch { /* fall back */ }
      }

      this.post({ command: 'discogsImageReady', release, imageDataUri, thumbDataUri });

      this.post({ command: 'statusUpdate', message: 'Extracting colours with Vibrant…' });
      const palette = await extractVibrantPalette(buffer);
      this.post({ command: 'vibrantDebug', imageUrl: release.imageUrl, palette });

      this.post({ command: 'statusUpdate', message: 'Applying palette…' });
      this.lastPalette   = palette;
      this.lastIsDark    = false;
      this.lastRollIndex = 0;
      this.lastRelease   = { ...release, thumbDataUri };
      const theme = buildThemeFromVibrantPalette(palette, { isDark: false, rollIndex: 0 });
      await this.applyTheme(theme, 'discogs', this.lastRelease);
    } catch (e: any) {
      this.post({ command: 'discogsError', message: e.message });
      vscode.window.showErrorMessage(`Discogs search failed: ${e.message}`);
    }
  }

  /** Silent Discogs refresh — used by auto-refresh (no panel required). */
  private async applyDiscogsThemeSilently() {
    try {
      const release = await fetchRandomRelease();
      const { buffer, contentType } = await fetchImageBuffer(release.imageUrl);
      const imageDataUri = `data:${contentType};base64,${buffer.toString('base64')}`;

      let thumbDataUri = imageDataUri;
      if (release.thumb && release.thumb !== release.imageUrl) {
        try { thumbDataUri = await fetchImageDataUri(release.thumb); }
        catch { /* fall back */ }
      }

      const palette = await extractVibrantPalette(buffer);
      this.lastPalette   = palette;
      this.lastIsDark    = false;
      this.lastRollIndex = 0;
      this.lastRelease   = { ...release, thumbDataUri };
      const theme = buildThemeFromVibrantPalette(palette, { isDark: false, rollIndex: 0 });
      await this.applyTheme(theme, 'discogs', this.lastRelease);

      // Update the open panel's card if visible
      if (this.panel) {
        this.post({ command: 'discogsImageReady', release, imageDataUri, thumbDataUri });
        this.post({ command: 'vibrantDebug', imageUrl: release.imageUrl, palette });
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`Auto-refresh (Discogs) failed: ${e.message}`);
    }
  }

  // ─── Apply / reset ────────────────────────────────────────────────────────────

  private async applyTheme(
    theme: GeneratedTheme,
    source: 'random' | 'discogs',
    release?: DiscogsRelease & { thumbDataUri?: string },
  ) {
    const target = this.getConfigTarget();
    const scopeLabel = this.getScopeLabel();
    const config = vscode.workspace.getConfiguration('workbench');

    if (!this.ctx.globalState.get(PREV_KEY)) {
      const prevTokens = config.get<ColorTokens>('colorCustomizations') ?? {};
      await this.ctx.globalState.update(PREV_KEY, { scope: scopeLabel, tokens: prevTokens });
    }

    await config.update('colorCustomizations', theme.tokens, target);

    const entry: HistoryEntry = {
      id:        `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name:      theme.name,
      isDark:    theme.isDark,
      swatches:  theme.swatches,
      tokens:    theme.tokens,
      timestamp: Date.now(),
      source,
      discogs:   release ? discogsFromRelease(release) : undefined,
    };
    await pushHistory(this.ctx, entry);

    this.post({
      command: 'themeApplied',
      entry: { ...toSummary(entry), tokens: theme.tokens },
    });
    this.sendHistory();
  }

  private async loadHistoryEntry(id: string) {
    const entry = getHistory(this.ctx).find((e) => e.id === id);
    if (!entry) { return; }
    const target = this.getConfigTarget();
    const config = vscode.workspace.getConfiguration('workbench');
    if (!this.ctx.globalState.get(PREV_KEY)) {
      const prevTokens = config.get<ColorTokens>('colorCustomizations') ?? {};
      await this.ctx.globalState.update(PREV_KEY, { scope: this.getScopeLabel(), tokens: prevTokens });
    }
    await config.update('colorCustomizations', entry.tokens, target);
    this.post({
      command: 'themeApplied',
      entry: { ...toSummary(entry), tokens: entry.tokens },
    });
  }

  private async resetTheme() {
    const saved = this.ctx.globalState.get<{ scope?: string; tokens: ColorTokens } | ColorTokens>(PREV_KEY);
    if (saved === undefined) {
      vscode.window.showInformationMessage('No theme to reset — generate one first.');
      return;
    }
    // Handle both new format { scope, tokens } and legacy format (just tokens)
    let scope: string;
    let tokens: ColorTokens;
    if ('scope' in (saved as object) && 'tokens' in (saved as object)) {
      const s = saved as { scope: string; tokens: ColorTokens };
      scope = s.scope; tokens = s.tokens;
    } else {
      scope = 'global'; tokens = saved as ColorTokens;
    }
    const target = scope === 'workspace' && vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    const config = vscode.workspace.getConfiguration('workbench');
    await config.update(
      'colorCustomizations',
      Object.keys(tokens).length > 0 ? tokens : undefined,
      target,
    );
    await this.ctx.globalState.update(PREV_KEY, undefined);
    this.post({ command: 'themeReset' });
  }

  // ─── History ops ─────────────────────────────────────────────────────────────

  private async deleteHistoryEntry(id: string) {
    await deleteEntry(this.ctx, id);
    this.sendHistory();
  }

  private async doClearHistory() {
    await clearHistory(this.ctx);
    this.sendHistory();
  }

  private sendHistory() {
    this.post({ command: 'historyUpdated', history: getHistory(this.ctx).map(toSummary) });
  }

  // ─── JSON ─────────────────────────────────────────────────────────────────────

  private async copyJson(historyId: string | null, inlineTokens: ColorTokens | null, name: string) {
    let tokens = inlineTokens ?? undefined;
    let themeName = name;
    if (historyId) {
      const e = getHistory(this.ctx).find((x) => x.id === historyId);
      if (e) { tokens = e.tokens; themeName = e.name; }
    }
    if (!tokens) { return; }
    const json = JSON.stringify({
      name: themeName,
      generator: 'Discogs Theme Generator',
      'workbench.colorCustomizations': tokens,
    }, null, 2);
    await vscode.env.clipboard.writeText(json);
    this.post({ command: 'copySuccess', id: historyId });
    vscode.window.showInformationMessage(`"${themeName}" copied to clipboard.`);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private post(msg: object) { this.panel?.webview.postMessage(msg); }

  // ─── HTML ─────────────────────────────────────────────────────────────────────

  private buildHtml(): string {
    const nonce = Array.from({ length: 32 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]
    ).join('');
    const iconUri = this.panel!.webview.asWebviewUri(
      vscode.Uri.joinPath(this.ctx.extensionUri, 'images', 'icon.png')
    );
    const cspSource = this.panel!.webview.cspSource;
    const version: string = this.ctx.extension.packageJSON.version ?? '';

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; img-src data: blob: ${cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<title>Discogs Theme Generator</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  padding: 20px 18px 56px;
  min-height: 100vh;
}
/* ── header ── */
.hdr { display:flex; align-items:center; gap:10px; margin-bottom:4px; }
.hdr-icon { width:32px; height:32px; flex-shrink:0; }
.hdr-text { display:flex; flex-direction:column; }
h1 { font-size:1.35em; font-weight:700; line-height:1.2; }
.version { font-size:.68em; color:var(--vscode-descriptionForeground); }
.credits-link { color:var(--vscode-descriptionForeground); text-decoration:none; }
.credits-link:hover { text-decoration:underline; color:var(--vscode-foreground); }
.sub { font-size:.78em; color:var(--vscode-descriptionForeground); margin-bottom:16px; padding-left:42px; }
/* ── primary action ── */
.primary-action { margin-bottom:18px; }
.hint { font-size:.78em; color:var(--vscode-descriptionForeground); margin-bottom:6px; }
/* ── search ── */
.search-row { display:flex; gap:6px; margin-bottom:14px; }
.search-row input {
  flex:1; padding:7px 10px; font:inherit; font-size:.84em;
  background:var(--vscode-input-background,rgba(0,0,0,.3));
  color:var(--vscode-input-foreground,var(--vscode-foreground));
  border:1px solid var(--vscode-input-border,rgba(255,255,255,.2));
  border-radius:5px; outline:none;
}
.search-row input:focus { border-color:var(--vscode-focusBorder,#007fd4); }
.search-row input::placeholder { color:var(--vscode-input-placeholderForeground,rgba(255,255,255,.3)); }
/* ── scope toggle ── */
.scope-lbl-row { margin-bottom:6px; }
.scope-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-bottom:14px; }
.scope-btn.active { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border-color:transparent; }
/* ── buttons ── */
.actions { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px; }
button {
  display:inline-flex; align-items:center; gap:6px;
  border:none; border-radius:5px; cursor:pointer;
  font:inherit; font-size:.84em; font-weight:500;
  padding:7px 13px; transition:filter .12s, opacity .12s;
}
button:hover:not(:disabled) { filter:brightness(1.15); }
button:active:not(:disabled) { filter:brightness(.88); }
button:disabled { opacity:.35; cursor:not-allowed; }
.bp  { background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
.bs  {
  background:var(--vscode-button-secondaryBackground, rgba(255,255,255,.08));
  color:var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border:1px solid var(--vscode-widget-border, rgba(255,255,255,.12));
}
.bsm { padding:4px 10px; font-size:.78em; background:var(--vscode-button-secondaryBackground, rgba(255,255,255,.08)); color:var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border:1px solid var(--vscode-widget-border, rgba(255,255,255,.12)); }
.bdanger { padding:4px 9px; font-size:.76em; background:transparent; color:var(--vscode-errorForeground,#f38ba8); border:1px solid currentColor; }
.blink { background:none; border:none; padding:0; color:var(--vscode-textLink-foreground,#74b9ff); font-size:.84em; text-decoration:underline; cursor:pointer; }
.blink:hover { filter:brightness(1.2); }
.bicon { padding:4px 8px; font-size:.8em; background:var(--vscode-button-secondaryBackground, rgba(255,255,255,.08)); color:var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border:1px solid var(--vscode-widget-border, rgba(255,255,255,.12)); border-radius:4px; }
/* ── Discogs main button (bigger) ── */
.bdiscogs {
  background:var(--vscode-button-background); color:var(--vscode-button-foreground);
  font-size:.95em; font-weight:600; padding:10px 20px; border-radius:6px; gap:8px;
}
/* ── status bar ── */
.sbar {
  display:flex; align-items:center; gap:8px;
  background:var(--vscode-editor-inactiveSelectionBackground, rgba(255,255,255,.05));
  border:1px solid var(--vscode-widget-border, rgba(255,255,255,.1));
  border-radius:5px; padding:8px 12px; margin-bottom:16px;
  font-size:.8em; color:var(--vscode-descriptionForeground);
}
.sbar.hidden { display:none; }
.sbar.err { border-color:var(--vscode-errorForeground,#f38ba8); color:var(--vscode-errorForeground,#f38ba8); }
.sbar.err .spin { display:none; }
.spin { width:13px; height:13px; border-radius:50%; flex-shrink:0; border:2px solid rgba(255,255,255,.15); border-top-color:var(--vscode-button-background); animation:spin .7s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
/* ── sections ── */
.sec { margin-bottom:20px; }
.theme-discogs-row { display:flex; gap:16px; flex-wrap:wrap; margin-bottom:20px; }
.theme-discogs-row .sec { flex:1 1 260px; min-width:0; margin-bottom:0; display:flex; flex-direction:column; }
.theme-discogs-row .sec > .card { flex:1; }
#dsec.hidden + .sec { flex:1 1 100%; }
.sec-hd { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
.lbl { font-size:.68em; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--vscode-descriptionForeground); }
/* ── card ── */
.card { background:var(--vscode-editor-inactiveSelectionBackground,rgba(255,255,255,.04)); border:1px solid var(--vscode-widget-border,rgba(255,255,255,.1)); border-radius:6px; padding:15px; }
/* ── theme name ── */
.tname { font-size:1.08em; font-weight:600; margin-bottom:3px; }
.tmeta { font-size:.76em; color:var(--vscode-descriptionForeground); margin-bottom:11px; }
.badge { display:inline-block; font-size:.67em; font-weight:600; padding:2px 6px; border-radius:999px; vertical-align:middle; margin-left:5px; position:relative; top:-1px; }
.bd { background:#2d2d40; color:#a29bfe; }
.bl { background:#eeeeff; color:#6c5ce7; }
.bdisc { background:rgba(255,255,255,.1); color:var(--vscode-foreground); }
.erow { display:flex; flex-wrap:wrap; gap:6px; }
.erow.hidden { display:none; }
/* ── discogs card ── */
.dcrd { background:var(--vscode-editor-inactiveSelectionBackground,rgba(255,255,255,.04)); border:1px solid var(--vscode-widget-border,rgba(255,255,255,.1)); border-radius:6px; padding:13px; overflow:hidden; }
.dcrd.hidden { display:none; }
#dsec.hidden { display:none; }
.dcrd-top { display:flex; gap:14px; align-items:flex-start; margin-bottom:12px; }
.dart { width:180px; height:180px; object-fit:cover; border-radius:5px; flex-shrink:0; background:var(--vscode-widget-border,rgba(255,255,255,.08)); }
.dinf { flex:1; min-width:0; }
.dart-nm { font-size:.8em; color:var(--vscode-descriptionForeground); margin-bottom:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dtitle { font-size:1em; font-weight:700; margin-bottom:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dyear  { font-size:.78em; color:var(--vscode-descriptionForeground); margin-bottom:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dmeta2 { font-size:.75em; color:var(--vscode-descriptionForeground); margin-bottom:5px; display:flex; flex-wrap:wrap; gap:4px 10px; overflow:hidden; }
.dmeta2 span { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; }
.dtags  { display:flex; flex-wrap:wrap; gap:4px; margin-bottom:7px; }
.tag    { font-size:.68em; padding:2px 6px; border-radius:999px; background:rgba(255,255,255,.08); border:1px solid var(--vscode-widget-border,rgba(255,255,255,.1)); }
.dtracks { font-size:.73em; color:var(--vscode-descriptionForeground); margin-bottom:7px; line-height:1.6; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
/* ── album art lightbox ── */
.dart { cursor:zoom-in; }
.lightbox {
  position:fixed; inset:0; z-index:9999;
  background:rgba(0,0,0,.88); display:flex; align-items:center; justify-content:center;
  cursor:zoom-out;
}
.lightbox.hidden { display:none; }
.lightbox img { max-width:90vw; max-height:90vh; object-fit:contain; border-radius:6px; box-shadow:0 8px 48px rgba(0,0,0,.7); }
.lb-close {
  position:fixed; top:14px; right:18px;
  background:rgba(255,255,255,.12); border:none; border-radius:50%;
  width:34px; height:34px; font-size:1.1em; color:#fff; cursor:pointer; line-height:1;
  display:flex; align-items:center; justify-content:center;
}
.lb-close:hover { background:rgba(255,255,255,.25); }
/* ── Discogs/YouTube links ── */
.discogs-links { display:flex; flex-direction:column; gap:4px; align-items:flex-start; }
.yt-wrap.hidden { display:none; }
.yt-open { font-size:.76em; color:var(--vscode-textLink-foreground,#74b9ff); background:none; border:none; padding:0; cursor:pointer; text-decoration:underline; }
.yt-open:hover { filter:brightness(1.2); }

/* ── Vibrant debug (inside Current Theme) ── */
.dbg-wrap { margin-top:12px; padding-top:10px; border-top:1px solid var(--vscode-widget-border,rgba(255,255,255,.08)); }
.dbg-wrap.hidden { display:none; }
.dbg-hd { display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; }
.dbg-swatches { display:flex; flex-wrap:wrap; gap:6px; }
.dbg-sw { display:flex; flex-direction:column; align-items:center; gap:3px; }
.dbg-dot { width:24px; height:24px; border-radius:50%; border:2px solid rgba(255,255,255,.15); }
.dbg-label { font-size:.6em; color:var(--vscode-descriptionForeground); text-align:center; }
.dbg-hex { font-size:.62em; color:var(--vscode-descriptionForeground); font-family:monospace; }
/* ── history ── */
.hemp { font-size:.8em; color:var(--vscode-descriptionForeground); padding:10px 0; }
.hent {
  display:flex; align-items:center; gap:8px;
  padding:8px 9px; border-radius:5px; margin-bottom:4px;
  background:var(--vscode-editor-inactiveSelectionBackground,rgba(255,255,255,.03));
  border:1px solid transparent; transition:background .13s, border-color .13s;
}
.hent:hover { background:var(--vscode-list-hoverBackground,rgba(255,255,255,.07)); border-color:var(--vscode-widget-border,rgba(255,255,255,.1)); }
.hsws { display:flex; gap:3px; flex-shrink:0; }
.hsw  { width:12px; height:12px; border-radius:50%; border:1px solid rgba(255,255,255,.12); flex-shrink:0; }
.hthumb { width:28px; height:28px; border-radius:3px; object-fit:cover; flex-shrink:0; background:rgba(255,255,255,.08); }
.hinf { flex:1; min-width:0; }
.hname { font-size:.82em; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.hmeta { font-size:.7em; color:var(--vscode-descriptionForeground); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.hact  { display:flex; gap:4px; flex-shrink:0; }
/* ── auto-refresh ── */
.ar-card { background:var(--vscode-editor-inactiveSelectionBackground,rgba(255,255,255,.04)); border:1px solid var(--vscode-widget-border,rgba(255,255,255,.1)); border-radius:6px; padding:14px; }
.ar-row { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.ar-btn {
  padding:5px 12px; font-size:.8em; border-radius:5px; border:1px solid var(--vscode-widget-border,rgba(255,255,255,.15));
  background:transparent; color:var(--vscode-foreground); cursor:pointer; transition:background .12s,color .12s;
}
.ar-btn.active { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border-color:transparent; }
.ar-btn:hover:not(.active) { background:var(--vscode-list-hoverBackground,rgba(255,255,255,.06)); }
.ar-intv { display:flex; align-items:center; gap:6px; }
.ar-intv.hidden { display:none; }
.ar-intv input[type=number] {
  width:56px; padding:4px 7px; font:inherit; font-size:.82em;
  background:var(--vscode-input-background,rgba(0,0,0,.3));
  color:var(--vscode-input-foreground,var(--vscode-foreground));
  border:1px solid var(--vscode-input-border,rgba(255,255,255,.2));
  border-radius:4px; text-align:center;
}
.ar-intv span { font-size:.82em; color:var(--vscode-descriptionForeground); }
.ar-hint { margin-top:8px; font-size:.74em; color:var(--vscode-descriptionForeground); }
</style>
</head>
<body>

<div class="hdr">
  <img class="hdr-icon" src="${iconUri}" alt="Discogs Theme Generator icon">
  <div class="hdr-text">
    <h1>Discogs Theme Generator</h1>
    <span class="version">v${version} · <a href="#" id="credits-link" class="credits-link">created by martin barker</a></span>
  </div>
</div>
<p class="sub">Generate themes from real Discogs album art.</p>

<!-- Primary action -->
<div class="primary-action">
  <div class="hint">click to set color theme</div>
  <button class="bdiscogs" id="bd">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
      <circle cx="12" cy="12" r="10"/>
      <circle cx="12" cy="12" r="4.5"/>
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>
      <line x1="12" y1="7.5" x2="12" y2="2"/>
    </svg>
    Randomly Refresh Discogs Theme
  </button>
</div>

<!-- Search row -->
<div class="hint">or search for specific release:</div>
<div class="search-row">
  <input type="text" id="search-input" placeholder="Release ID or search (e.g. Pink Floyd Wish You Were Here)">
  <button class="bp" id="search-btn">Search</button>
</div>

<!-- Scope toggle + Reset -->
<div class="scope-lbl-row"><span class="lbl">Apply to</span></div>
<div class="scope-row">
  <button class="bs scope-btn active" id="scope-ws" title="Apply theme only to this window">
    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="2" width="14" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M1 5h14" stroke="currentColor" stroke-width="1"/></svg>
    This window
  </button>
  <button class="bs scope-btn" id="scope-gl" title="Apply theme to all VS Code windows">
    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="2" width="9" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="6" y="7" width="9" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
    All windows
  </button>
  <button class="bs" id="br" disabled style="margin-left:auto">
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 3a5 5 0 1 1-4.546 2.914.5.5 0 0 0-.908-.417A6 6 0 1 0 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 0-.41-.192L5.23 2.308a.25.25 0 0 0 0 .384l2.36 1.966A.25.25 0 0 0 8 4.466z"/></svg>
    Reset
  </button>
</div>

<div class="sbar hidden" id="sb"><div class="spin"></div><span id="st"></span></div>

<!-- Discogs release + Current theme (side by side when space allows) -->
<div class="theme-discogs-row">
<!-- Discogs release card (hidden until release loaded) -->
<div class="sec hidden" id="dsec">
  <div class="sec-hd"><span class="lbl">Discogs Release</span></div>
  <div class="dcrd hidden" id="dcrd">
    <div class="dcrd-top">
      <img class="dart" id="dimg" src="" alt="Album art">
      <div class="dinf">
        <div class="dart-nm" id="dart"></div>
        <div class="dtitle"  id="dttl"></div>
        <div class="dyear"   id="dyr"></div>
        <div class="dmeta2"  id="dmeta2"></div>
        <div class="dtags"   id="dtgs"></div>
        <div class="dtracks" id="dtks"></div>
        <div class="discogs-links">
          <button class="blink" id="dlnk">View on Discogs ↗</button>
          <div class="yt-wrap hidden" id="yt-wrap">
            <button class="yt-open" id="yt-ext">▶ Watch on YouTube ↗</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Current theme -->
<div class="sec">
  <div class="sec-hd"><span class="lbl">Current Theme</span></div>
  <div class="card">
    <div class="tname" id="tn">— No theme generated yet —</div>
    <div class="tmeta" id="tm"></div>
    <div class="erow hidden" id="er">
      <button class="bsm" id="bcp">📋 Copy JSON</button>
      <button class="bsm hidden" id="btoggle">🌙 Dark Mode</button>
      <button class="bsm hidden" id="breroll">🎲 Re-roll Colors</button>
    </div>
    <div class="dbg-wrap hidden" id="dbg-wrap">
      <div class="dbg-hd">
        <span class="lbl" style="font-size:.62em">Vibrant Extraction</span>
        <button class="blink" style="font-size:.72em" id="dbg-hide">Hide</button>
      </div>
      <div class="dbg-swatches" id="dbg-swatches"></div>
    </div>
  </div>
</div>
</div>

<!-- History -->
<div class="sec">
  <div class="sec-hd">
    <span class="lbl">History</span>
    <button class="bdanger" id="bclr">Clear All</button>
  </div>
  <div id="hlist"><div class="hemp">No themes generated yet.</div></div>
</div>

<!-- Auto-Refresh -->
<div class="sec">
  <div class="sec-hd"><span class="lbl">Auto-Refresh</span></div>
  <div class="ar-card">
    <div class="ar-row">
      <button class="ar-btn active" data-mode="off">Off</button>
      <button class="ar-btn" data-mode="onOpen">On workspace open</button>
      <button class="ar-btn" data-mode="interval">Every</button>
      <div class="ar-intv hidden" id="ar-intv">
        <input type="number" id="ar-hours" min="0" max="168" value="2">
        <span>h</span>
        <input type="number" id="ar-mins" min="0" max="59" value="0">
        <span>min</span>
      </div>
    </div>
    <div class="ar-hint" id="ar-hint"></div>
  </div>
</div>

<!-- Image lightbox -->
<div class="lightbox hidden" id="lightbox">
  <button class="lb-close" id="lb-close" title="Close">✕</button>
  <img id="lb-img" src="" alt="Full-size album art">
</div>

<script nonce="${nonce}">
(function () {
  const vsc = acquireVsCodeApi();

  // ── state ──────────────────────────────────────────────────────────────────
  let current   = null;
  let curImgUri = null;

  // ── refs ───────────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const bd=$('bd'), br=$('br'), bcp=$('bcp'), bclr=$('bclr'), btoggle=$('btoggle'), breroll=$('breroll');
  const sb=$('sb'), st=$('st');
  const tn=$('tn'), tm=$('tm'), er=$('er');
  const dcrd=$('dcrd'), dimg=$('dimg');
  const hlist=$('hlist');
  const scopeWs=$('scope-ws'), scopeGl=$('scope-gl');
  const ytWrap=$('yt-wrap');
  const arHoursWrap=$('ar-intv'), arHoursInput=$('ar-hours'), arMinsInput=$('ar-mins'), arHint=$('ar-hint');
  const lightbox=$('lightbox'), lbImg=$('lb-img');
  const dbgWrap=$('dbg-wrap'), dbgSwatches=$('dbg-swatches');

  // current YouTube video ID
  let currentVideoId = null;

  // ── button handlers ────────────────────────────────────────────────────────
  bd.onclick   = () => vsc.postMessage({ command:'fromDiscogs' });
  br.onclick   = () => vsc.postMessage({ command:'reset' });

  // ── search ─────────────────────────────────────────────────────────────────
  function doSearch() {
    const q = $('search-input').value.trim();
    if (!q) { vsc.postMessage({ command:'fromDiscogs' }); return; }
    vsc.postMessage({ command:'fromDiscogsSearch', query: q });
  }
  $('search-btn').onclick = doSearch;
  $('search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { doSearch(); } });
  bcp.onclick     = () => { if (current) vsc.postMessage({ command:'copyJson', tokens:current.tokens, name:current.name }); };
  btoggle.onclick = () => vsc.postMessage({ command:'toggleDarkLight' });
  breroll.onclick = () => vsc.postMessage({ command:'rerollColors' });
  bclr.onclick    = () => vsc.postMessage({ command:'clearHistory' });
  $('dlnk').onclick = () => { if (current?.discogs) vsc.postMessage({ command:'openUrl', url:current.discogs.uri }); };
  $('credits-link').onclick = (e) => { e.preventDefault(); vsc.postMessage({ command:'openUrl', url:'https://www.martinbarker.me' }); };

  // ── lightbox ───────────────────────────────────────────────────────────────
  dimg.onclick = () => {
    if (!curImgUri && !dimg.src) { return; }
    lbImg.src = curImgUri || dimg.src;
    lightbox.classList.remove('hidden');
  };
  lightbox.onclick = (e) => {
    if (e.target === lightbox || e.target.id === 'lb-close') {
      lightbox.classList.add('hidden');
      lbImg.src = '';
    }
  };

  // ── YouTube link ───────────────────────────────────────────────────────────
  $('yt-ext').onclick = () => {
    if (currentVideoId) {
      vsc.postMessage({ command:'openUrl', url:\`https://www.youtube.com/watch?v=\${currentVideoId}\` });
    } else if (current?.discogs) {
      const q = encodeURIComponent(\`\${current.discogs.artists} \${current.discogs.title}\`);
      vsc.postMessage({ command:'openUrl', url:\`https://www.youtube.com/results?search_query=\${q}\` });
    }
  };
  $('dbg-hide').onclick = () => { dbgWrap.classList.add('hidden'); };

  // ── scope toggle ───────────────────────────────────────────────────────────
  scopeWs.onclick = () => setScopeUI(true);
  scopeGl.onclick = () => setScopeUI(false);

  function setScopeUI(useWorkspace) {
    scopeWs.classList.toggle('active', useWorkspace);
    scopeGl.classList.toggle('active', !useWorkspace);
    vsc.postMessage({ command:'setScope', useWorkspace });
  }

  // ── auto-refresh controls ──────────────────────────────────────────────────
  document.querySelectorAll('.ar-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      document.querySelectorAll('.ar-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      arHoursWrap.classList.toggle('hidden', mode !== 'interval');
      updateArHint(mode, +arHoursInput.value || 0, +arMinsInput.value || 0);
      sendAutoRefresh(mode);
    });
  });

  arHoursInput.addEventListener('change', () => {
    const hrs = Math.max(0, Math.min(168, +arHoursInput.value || 0));
    arHoursInput.value = hrs;
    const mode = document.querySelector('.ar-btn.active')?.dataset?.mode || 'off';
    updateArHint(mode, hrs, +arMinsInput.value || 0);
    sendAutoRefresh(mode);
  });

  arMinsInput.addEventListener('change', () => {
    const mins = Math.max(0, Math.min(59, +arMinsInput.value || 0));
    arMinsInput.value = mins;
    const mode = document.querySelector('.ar-btn.active')?.dataset?.mode || 'off';
    updateArHint(mode, +arHoursInput.value || 0, mins);
    sendAutoRefresh(mode);
  });

  function sendAutoRefresh(mode) {
    vsc.postMessage({
      command: 'setAutoRefresh',
      config: { mode, intervalHours: +arHoursInput.value || 0, intervalMinutes: +arMinsInput.value || 0 },
    });
  }

  function updateArHint(mode, hrs, mins) {
    if (mode === 'off')    { arHint.textContent = ''; return; }
    if (mode === 'onOpen') { arHint.textContent = 'A new Discogs theme will load each time this workspace opens.'; return; }
    if (mode === 'interval') {
      const total = hrs * 60 + mins;
      const parts = [];
      if (hrs)  { parts.push(\`\${hrs}h\`); }
      if (mins) { parts.push(\`\${mins}min\`); }
      const label = parts.length ? parts.join(' ') : '5min';
      arHint.textContent = \`A new Discogs theme will load every \${label}\${total < 5 ? ' (minimum 5 min)' : ''}.\`;
    }
  }

  // ── extension messages ─────────────────────────────────────────────────────
  window.addEventListener('message', ({ data: msg }) => {
    switch (msg.command) {

      case 'statusUpdate':
        showStatus(msg.message, false);
        break;

      case 'discogsError':
        showStatus(msg.message, true);
        setTimeout(hideStatus, 5000);
        break;

      case 'discogsImageReady': {
        curImgUri = msg.imageDataUri;
        renderDiscogsCard(msg.release, msg.imageDataUri);
        break;
      }

      case 'themeApplied': {
        hideStatus();
        current = msg.entry;
        br.disabled = false;
        renderCurrent(msg.entry);
        if (msg.entry.discogs) {
          const imgSrc = curImgUri || msg.entry.discogs.thumbDataUri || '';
          renderDiscogsCard(msg.entry.discogs, imgSrc);
        } else {
          hideDiscogs();
          curImgUri = null;
        }
        break;
      }

      case 'themeReset':
        current = null; curImgUri = null;
        br.disabled = true;
        clearCurrent();
        hideDiscogs();
        break;

      case 'historyUpdated':
        renderHistory(msg.history);
        break;

      case 'copySuccess':
        flashBtn(bcp, '✓ Copied!');
        break;

      case 'vibrantDebug': {
        const { palette } = msg;
        dbgSwatches.innerHTML = '';
        const swatchOrder = [
          ['Vibrant',      palette.vibrant],
          ['Dark Vibrant', palette.darkVibrant],
          ['Light Vibrant',palette.lightVibrant],
          ['Muted',        palette.muted],
          ['Dark Muted',   palette.darkMuted],
          ['Light Muted',  palette.lightMuted],
        ];
        swatchOrder.forEach(([label, hex]) => {
          if (!hex) { return; }
          const d = document.createElement('div');
          d.className = 'dbg-sw';
          d.innerHTML = \`<div class="dbg-dot" style="background:\${hex}"></div>
            <div class="dbg-label">\${label}</div>
            <div class="dbg-hex">\${hex}</div>\`;
          dbgSwatches.appendChild(d);
        });
        dbgWrap.classList.remove('hidden');
        break;
      }

      case 'stateSync':
        // Restore scope toggle
        if (msg.scope === 'workspace') { scopeWs.classList.add('active'); scopeGl.classList.remove('active'); }
        else { scopeGl.classList.add('active'); scopeWs.classList.remove('active'); }
        // Restore auto-refresh
        if (msg.autoRefresh) {
          const { mode, intervalHours, intervalMinutes } = msg.autoRefresh;
          document.querySelectorAll('.ar-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.mode === mode);
          });
          arHoursInput.value = intervalHours ?? 2;
          arMinsInput.value  = intervalMinutes ?? 0;
          arHoursWrap.classList.toggle('hidden', mode !== 'interval');
          updateArHint(mode, intervalHours ?? 2, intervalMinutes ?? 0);
        }
        break;
    }
  });

  // ── current theme card ─────────────────────────────────────────────────────
  function renderCurrent(e) {
    const mc = e.isDark ? 'bd' : 'bl';
    const ml = e.isDark ? 'Dark' : 'Light';
    const sb2 = e.source==='discogs' ? ' <span class="badge bdisc">Discogs</span>' : '';
    tn.innerHTML = esc(e.name) + \` <span class="badge \${mc}">\${ml}</span>\` + sb2;
    tm.textContent = relT(e.timestamp);
    er.classList.remove('hidden');
    const isDiscogs = e.source === 'discogs';
    btoggle.classList.toggle('hidden', !isDiscogs);
    breroll.classList.toggle('hidden', !isDiscogs);
    if (isDiscogs) { btoggle.textContent = e.isDark ? '☀️ Light Mode' : '🌙 Dark Mode'; }
  }

  function clearCurrent() {
    tn.textContent = '— No theme generated yet —';
    tm.textContent = '';
    er.classList.add('hidden');
    btoggle.classList.add('hidden');
    breroll.classList.add('hidden');
    dbgWrap.classList.add('hidden');
  }

  // ── discogs card ────────────────────────────────────────────────────────────
  function renderDiscogsCard(rel, imgSrc) {
    $('dsec').classList.remove('hidden');
    dcrd.classList.remove('hidden');
    dimg.src = imgSrc || '';
    $('dart').textContent  = rel.artists || '';
    $('dttl').textContent  = rel.title   || '';
    $('dyr').textContent   = [rel.year, rel.country].filter(Boolean).join(' · ');

    // Format + Label line
    const meta2 = $('dmeta2');
    meta2.innerHTML = '';
    if (rel.format) {
      const s = document.createElement('span'); s.textContent = '💿 ' + rel.format; meta2.appendChild(s);
    }
    if (rel.label) {
      const s = document.createElement('span'); s.textContent = '🏷 ' + rel.label; meta2.appendChild(s);
    }

    // Genre + Style tags
    const tgs = $('dtgs'); tgs.innerHTML = '';
    [...(rel.genres||[]), ...(rel.styles||[])].slice(0,8).forEach(t => {
      const s = document.createElement('span'); s.className = 'tag'; s.textContent = t; tgs.appendChild(s);
    });

    const tkEl = $('dtks');
    tkEl.textContent = rel.tracklist?.length ? rel.tracklist.slice(0,6).join(' · ') : '';

    // YouTube link (smart)
    currentVideoId = rel.videoId || null;
    const ytBtn = $('yt-ext');
    if (currentVideoId) {
      ytBtn.textContent = '▶ Watch on YouTube ↗';
    } else {
      ytBtn.textContent = '🔍 Search on YouTube ↗';
    }
    ytWrap.classList.remove('hidden');
  }

  function hideDiscogs() {
    $('dsec').classList.add('hidden');
    dcrd.classList.add('hidden');
    ytWrap.classList.add('hidden');
    currentVideoId = null;
    dbgWrap.classList.add('hidden');
  }

  // ── history ─────────────────────────────────────────────────────────────────
  function renderHistory(hist) {
    if (!hist.length) { hlist.innerHTML='<div class="hemp">No themes generated yet.</div>'; return; }
    hlist.innerHTML = '';
    hist.forEach(e => {
      const el = document.createElement('div');
      el.className = 'hent';
      const mc = e.isDark ? 'bd' : 'bl';
      const srcTxt = e.source==='discogs' ? ' <span class="badge bdisc" style="font-size:.62em">●</span>' : '';
      const thumbHtml = e.discogs?.thumbDataUri
        ? \`<img class="hthumb" src="\${e.discogs.thumbDataUri}" alt="">\`
        : '';
      const meta = e.discogs
        ? \`\${relT(e.timestamp)} · \${esc(e.discogs.artists)} — \${esc(e.discogs.title)} (\${e.discogs.year})\`
        : relT(e.timestamp);

      el.innerHTML = \`
        <div class="hsws">\${e.swatches.map(c=>\`<div class="hsw" style="background:\${c}"></div>\`).join('')}</div>
        \${thumbHtml}
        <div class="hinf">
          <div class="hname"><span class="badge \${mc}">\${e.isDark?'◆':'◇'}</span> \${esc(e.name)}\${srcTxt}</div>
          <div class="hmeta">\${meta}</div>
        </div>
        <div class="hact">
          <button class="bicon" title="Load theme" data-act="load">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/><path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/></svg>
          </button>
          <button class="bicon" title="Copy JSON" data-act="copy">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/><path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg>
          </button>
          <button class="bicon" title="Delete" data-act="delete" style="color:var(--vscode-errorForeground,#f38ba8)">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
          </button>
        </div>\`;

      el.querySelector('[data-act="load"]').onclick = () => vsc.postMessage({ command:'loadEntry', id:e.id });
      el.querySelector('[data-act="copy"]').onclick = (ev) => {
        vsc.postMessage({ command:'copyJson', id:e.id });
        flashBtn(ev.currentTarget, '✓');
      };
      el.querySelector('[data-act="delete"]').onclick = () => {
        el.style.opacity = '.4';
        vsc.postMessage({ command:'deleteEntry', id:e.id });
      };

      hlist.appendChild(el);
    });
  }

  // ── status bar ──────────────────────────────────────────────────────────────
  function showStatus(msg, isErr) {
    sb.classList.remove('hidden','err');
    if (isErr) sb.classList.add('err');
    st.textContent = msg;
  }
  function hideStatus() { sb.classList.add('hidden'); }

  // ── utils ───────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function relT(ts) {
    const d = Date.now()-ts;
    if (d<60000)    return 'just now';
    if (d<3600000)  return Math.floor(d/60000)+'m ago';
    if (d<86400000) return Math.floor(d/3600000)+'h ago';
    return Math.floor(d/86400000)+'d ago';
  }
  function flashBtn(btn, label) {
    const orig = btn.innerHTML;
    btn.textContent = label;
    setTimeout(() => { btn.innerHTML = orig; }, 1500);
  }
}());
</script>
</body>
</html>`;
  }
}
