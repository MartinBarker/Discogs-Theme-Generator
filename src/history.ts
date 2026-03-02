import * as vscode from 'vscode';
import { ColorTokens } from './colorTheme';
import { DiscogsRelease } from './discogsApi';

const KEY = 'discogsThemeGenerator.history';
const MAX = 20;

export interface StoredDiscogsInfo {
  id:           number;
  title:        string;
  artists:      string;
  year:         number;
  imageUrl:     string;
  thumb:        string;
  thumbDataUri?: string;
  uri:          string;
  genres:       string[];
  styles:       string[];
  country?:     string;
  tracklist?:   string[];
  format?:      string;
  label?:       string;
  videoId?:     string;
}

export interface HistoryEntry {
  id:        string;
  name:      string;
  isDark:    boolean;
  swatches:  string[];
  tokens:    ColorTokens;
  timestamp: number;
  source:    'random' | 'discogs';
  discogs?:  StoredDiscogsInfo;
}

export interface HistorySummary {
  id:        string;
  name:      string;
  isDark:    boolean;
  swatches:  string[];
  timestamp: number;
  source:    'random' | 'discogs';
  discogs?:  {
    id:          number;
    title:       string;
    artists:     string;
    year:        number;
    thumb:       string;
    thumbDataUri?: string;
    uri:         string;
    format?:     string;
    label?:      string;
    videoId?:    string;
  };
}

export function getHistory(ctx: vscode.ExtensionContext): HistoryEntry[] {
  return ctx.globalState.get<HistoryEntry[]>(KEY, []);
}

export async function pushHistory(ctx: vscode.ExtensionContext, entry: HistoryEntry): Promise<void> {
  const history = getHistory(ctx);
  history.unshift(entry);
  if (history.length > MAX) { history.splice(MAX); }
  await ctx.globalState.update(KEY, history);
}

export async function deleteEntry(ctx: vscode.ExtensionContext, id: string): Promise<void> {
  const history = getHistory(ctx).filter((e) => e.id !== id);
  await ctx.globalState.update(KEY, history);
}

export async function clearHistory(ctx: vscode.ExtensionContext): Promise<void> {
  await ctx.globalState.update(KEY, []);
}

export function toSummary(e: HistoryEntry): HistorySummary {
  return {
    id:        e.id,
    name:      e.name,
    isDark:    e.isDark,
    swatches:  e.swatches,
    timestamp: e.timestamp,
    source:    e.source,
    discogs:   e.discogs ? {
      id:          e.discogs.id,
      title:       e.discogs.title,
      artists:     e.discogs.artists,
      year:        e.discogs.year,
      thumb:       e.discogs.thumb,
      thumbDataUri: e.discogs.thumbDataUri,
      uri:         e.discogs.uri,
      format:      e.discogs.format,
      label:       e.discogs.label,
      videoId:     e.discogs.videoId,
    } : undefined,
  };
}

export function discogsFromRelease(
  r: DiscogsRelease & { thumbDataUri?: string }
): StoredDiscogsInfo {
  return {
    id:          r.id,
    title:       r.title,
    artists:     r.artists,
    year:        r.year,
    imageUrl:    r.imageUrl,
    thumb:       r.thumb,
    thumbDataUri: r.thumbDataUri,
    uri:         r.uri,
    genres:      r.genres,
    styles:      r.styles,
    country:     r.country,
    tracklist:   r.tracklist,
    format:      r.format,
    label:       r.label,
    videoId:     r.videoId,
  };
}
