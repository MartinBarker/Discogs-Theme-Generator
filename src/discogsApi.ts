import * as https from 'https';
import * as http from 'http';

const UA = 'DiscogsThemeGenerator/0.0.1 +https://github.com/example/discogs-theme-generator';

export interface DiscogsRelease {
  id: number;
  title: string;
  artists: string;
  year: number;
  imageUrl: string;
  thumb: string;
  thumbDataUri?: string;
  uri: string;
  genres: string[];
  styles: string[];
  country?: string;
  tracklist?: string[];
  format?: string;     // e.g. "Vinyl (LP, Gatefold)"
  label?: string;      // e.g. "Blue Note"
  videoId?: string;    // YouTube video ID extracted from Discogs videos list
}

export interface VibrantPaletteColors {
  vibrant:      string | null;
  darkVibrant:  string | null;
  lightVibrant: string | null;
  muted:        string | null;
  darkMuted:    string | null;
  lightMuted:   string | null;
}

// ─── Generic HTTP GET (text) ──────────────────────────────────────────────────

function getText(url: string, redirectCount = 0): Promise<string> {
  if (redirectCount > 5) { return Promise.reject(new Error('Too many redirects')); }
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = (lib as typeof https).get(url, { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return getText(res.headers.location, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', (c: string) => { data += c; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// ─── Image → raw buffer + content-type ───────────────────────────────────────

export function fetchImageBuffer(
  url: string,
  redirectCount = 0,
): Promise<{ buffer: Buffer; contentType: string }> {
  if (redirectCount > 5) { return Promise.reject(new Error('Too many image redirects')); }
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = (lib as typeof https).get(url, { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return fetchImageBuffer(res.headers.location, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Image HTTP ${res.statusCode}`));
      }
      const contentType = (res.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Image request timed out')); });
  });
}

// ─── Image → base64 data URI ──────────────────────────────────────────────────

export async function fetchImageDataUri(url: string): Promise<string> {
  const { buffer, contentType } = await fetchImageBuffer(url);
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

// ─── Vibrant palette extraction (Node.js side — no canvas needed) ─────────────

export async function extractVibrantPalette(buffer: Buffer): Promise<VibrantPaletteColors> {
  const { Vibrant } = require('node-vibrant/node') as { Vibrant: typeof import('node-vibrant/node').Vibrant };
  const palette = await Vibrant.from(buffer).getPalette();
  return {
    vibrant:      palette.Vibrant?.hex      ?? null,
    darkVibrant:  palette.DarkVibrant?.hex  ?? null,
    lightVibrant: palette.LightVibrant?.hex ?? null,
    muted:        palette.Muted?.hex        ?? null,
    darkMuted:    palette.DarkMuted?.hex    ?? null,
    lightMuted:   palette.LightMuted?.hex   ?? null,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cleanArtist(name: string): string {
  return name.replace(/\s*\(\d+\)\s*$/, '').trim();
}

function extractYouTubeId(uri: string): string | undefined {
  const m = uri.match(/(?:youtube\.com\/watch\?.*v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m?.[1];
}

function parseReleaseData(id: number, data: any): DiscogsRelease | null {
  if (!data.images?.length) { return null; }
  const primary = data.images.find((i: any) => i.type === 'primary') ?? data.images[0];
  if (!primary?.uri) { return null; }

  const artists = (data.artists ?? [])
    .map((a: any) => cleanArtist(a.name))
    .join(', ') || 'Unknown Artist';

  const tracklist = (data.tracklist ?? [])
    .filter((t: any) => t.type_ === 'track' && t.title)
    .slice(0, 8)
    .map((t: any) => t.title as string);

  const formats = (data.formats ?? []) as any[];
  const format = formats.length > 0
    ? formats.slice(0, 2).map((f: any) => {
        const desc = (f.descriptions ?? []).join(', ');
        return desc ? `${f.name} (${desc})` : (f.name as string);
      }).join(', ')
    : undefined;

  const labels = (data.labels ?? []) as any[];
  const label = labels.length > 0 ? (labels[0].name as string) : undefined;

  let videoId: string | undefined;
  for (const v of (data.videos ?? []) as any[]) {
    videoId = extractYouTubeId(v.uri ?? '');
    if (videoId) { break; }
  }

  return {
    id,
    title:     data.title  ?? 'Unknown Title',
    artists,
    year:      data.year   ?? 0,
    imageUrl:  primary.uri,
    thumb:     primary.uri150 ?? primary.uri,
    uri:       data.uri    ?? `https://www.discogs.com/release/${id}`,
    genres:    data.genres ?? [],
    styles:    data.styles ?? [],
    country:   data.country,
    tracklist,
    format,
    label,
    videoId,
  };
}

// ─── Fetch a specific release by ID ──────────────────────────────────────────

export async function fetchReleaseById(id: number): Promise<DiscogsRelease> {
  const json = await getText(`https://api.discogs.com/releases/${id}`);
  const data = JSON.parse(json);
  const release = parseReleaseData(id, data);
  if (!release) { throw new Error(`Release #${id} has no usable images`); }
  return release;
}

// ─── Search Discogs and fetch the best matching release ───────────────────────

export async function searchAndFetchRelease(query: string): Promise<DiscogsRelease> {
  const url = `https://api.discogs.com/database/search?q=${encodeURIComponent(query)}&type=release&per_page=5`;
  const json = await getText(url);
  const data = JSON.parse(json);
  if (!data.results?.length) {
    throw new Error(`No Discogs results found for "${query}"`);
  }
  for (const result of (data.results as any[]).slice(0, 5)) {
    if (result.id) {
      try { return await fetchReleaseById(result.id as number); } catch { continue; }
    }
  }
  throw new Error(`No usable releases found for "${query}"`);
}

// ─── Fetch a random release ───────────────────────────────────────────────────

export async function fetchRandomRelease(maxAttempts = 10): Promise<DiscogsRelease> {
  const errors: string[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const id = Math.floor(Math.random() * 7_900_000) + 100_000;
    try {
      const json = await getText(`https://api.discogs.com/releases/${id}`);
      const release = parseReleaseData(id, JSON.parse(json));
      if (!release) { errors.push(`#${id}: no images`); continue; }
      return release;
    } catch (e: any) {
      errors.push(`#${id}: ${e.message}`);
    }
  }

  throw new Error(
    `Could not fetch a valid release after ${maxAttempts} attempts. ` +
    `Last errors: ${errors.slice(-3).join(' | ')}`,
  );
}
