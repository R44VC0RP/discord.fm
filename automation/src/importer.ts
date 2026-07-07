import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ProbeResult } from './types.js';
import type { AutomationStore } from './store.js';
import { text } from './validation.js';

export type Probe = (filePath: string) => Promise<ProbeResult & { title?: string | null; artist?: string | null; album?: string | null }>;

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

export async function ffprobe(filePath: string): Promise<ProbeResult & { title?: string | null; artist?: string | null; album?: string | null }> {
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '--', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (stdout.length < 2_000_000) stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { if (stderr.length < 4000) stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`ffprobe exited ${code}: ${stderr.slice(0, 500)}`)); });
  });
  const parsed = JSON.parse(raw) as { format?: { duration?: string; bit_rate?: string; format_name?: string; tags?: Record<string, unknown> }; streams?: Array<Record<string, unknown>> };
  const audio = parsed.streams?.find((stream) => stream.codec_type === 'audio');
  const durationMs = Math.round(Number(parsed.format?.duration) * 1000);
  if (!audio || !Number.isFinite(durationMs) || durationMs <= 0) throw new Error('ffprobe found no decodable audio duration');
  const safeTag = (name: string, max: number) => {
    const value = parsed.format?.tags?.[name] ?? parsed.format?.tags?.[name.toUpperCase()];
    try { return value === undefined ? null : text(String(value), name, max, false); } catch { return null; }
  };
  return {
    durationMs,
    codecName: typeof audio.codec_name === 'string' ? audio.codec_name : null,
    sampleRateHz: Number.isFinite(Number(audio.sample_rate)) ? Number(audio.sample_rate) : null,
    channels: Number.isFinite(Number(audio.channels)) ? Number(audio.channels) : null,
    bitRate: Number.isFinite(Number(parsed.format?.bit_rate)) ? Number(parsed.format?.bit_rate) : null,
    mimeType: 'audio/mpeg',
    title: safeTag('title', 256), artist: safeTag('artist', 256), album: safeTag('album', 256),
    raw: { format_name: parsed.format?.format_name, codec_name: audio.codec_name, sample_rate: audio.sample_rate, channels: audio.channels, bit_rate: parsed.format?.bit_rate },
  };
}

export async function importMusic(store: AutomationStore, musicDir: string, probe: Probe = ffprobe): Promise<{ discovered: number; created: number; existing: number; failed: Array<{ file: string; error: string }> }> {
  const entries = await fsp.readdir(musicDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const files = entries.filter((entry) => entry.isFile() && entry.name.toLocaleLowerCase('en-US').endsWith('.mp3')).map((entry) => entry.name).sort();
  let created = 0; let existing = 0;
  const failed: Array<{ file: string; error: string }> = [];
  for (const file of files) {
    const filePath = path.resolve(musicDir, file);
    try {
      const [checksum, metadata] = await Promise.all([sha256File(filePath), probe(filePath)]);
      const fallbackTitle = path.basename(file, path.extname(file)).normalize('NFC').replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 256).trim() || 'Untitled';
      const result = store.putAsset({
        kind: 'music', checksum, sourceLocator: filePath, playoutLocator: filePath,
        title: metadata.title || fallbackTitle, artist: metadata.artist, album: metadata.album,
        durationMs: metadata.durationMs, codecName: metadata.codecName, sampleRateHz: metadata.sampleRateHz,
        channels: metadata.channels, bitRate: metadata.bitRate, mimeType: metadata.mimeType, raw: metadata.raw,
        provenance: { source: 'existing_music_import', original_filename: file, license_status: 'UNKNOWN' },
      });
      result.created ? created++ : existing++;
    } catch (error) {
      failed.push({ file, error: error instanceof Error ? error.message.slice(0, 500) : 'unknown import error' });
    }
  }
  return { discovered: files.length, created, existing, failed };
}
