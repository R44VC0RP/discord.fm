/**
 * Web-player skin policy and materialization. The bot is the sole writer of
 * <webDir>/current.html; the admin API only asks this manager to change policy.
 */

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type SkinMode = 'daily' | 'manual';

export interface SkinState {
  mode: SkinMode;
  active: string | null;
  daily: string | null;
  available: string[];
  control: { available: boolean; message: string | null };
}

interface PersistedSkinPolicy {
  mode: SkinMode;
  skin?: string;
}

export interface SkinManagerOptions {
  now?: () => Date;
  intervalMs?: number;
}

export class InvalidSkinError extends Error {}
export class SkinControlUnavailableError extends Error {}

/** Preserve the original rotation formula exactly. */
export function dailySkin(skins: string[], timeZone: string, now = new Date()): string | null {
  if (skins.length === 0) return null;
  const dayStamp = new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
  const day = Math.floor(Date.parse(dayStamp) / 86_400_000);
  return skins[day % skins.length] ?? null;
}

async function atomicWrite(path: string, contents: Buffer | string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class SkinManager {
  private policy: PersistedSkinPolicy = { mode: 'daily' };
  private current: SkinState;
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;
  private serial: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly intervalMs: number;

  constructor(
    private readonly webDir: string,
    private readonly timeZone: string,
    private readonly stateFile: string,
    options: SkinManagerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? 3_600_000;
    this.current = {
      mode: 'daily',
      active: null,
      daily: null,
      available: [],
      control: this.controlState(),
    };
  }

  async start(): Promise<void> {
    await this.enqueue(async () => {
      await this.loadPolicy();
      await this.reconcile();
    }).catch((error) => this.warn('initialization failed', error));
    if (!this.timer) {
      this.timer = setInterval(() => void this.refresh(), this.intervalMs);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-enumerates on every call, so new/deleted skins appear without restart. */
  async state(): Promise<SkinState> {
    await this.refresh();
    return this.snapshot();
  }

  async setDaily(): Promise<SkinState> {
    return this.enqueue(async () => {
      this.requireControl();
      await this.loadPolicy();
      this.policy = { mode: 'daily' };
      await this.persistPolicy();
      await this.reconcile();
      return this.snapshot();
    });
  }

  async setManual(skin: string): Promise<SkinState> {
    return this.enqueue(async () => {
      this.requireControl();
      await this.loadPolicy();
      const available = await this.listSkins();
      if (!available.includes(skin)) throw new InvalidSkinError(`unknown skin: ${skin}`);
      this.policy = { mode: 'manual', skin };
      await this.persistPolicy();
      await this.reconcile(available);
      if (this.current.mode !== 'manual') {
        throw new InvalidSkinError(`skin became unavailable: ${skin}`);
      }
      return this.snapshot();
    });
  }

  private async refresh(): Promise<void> {
    await this.enqueue(async () => {
      await this.loadPolicy();
      await this.reconcile();
    }).catch((error) => this.warn('refresh failed', error));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  private async loadPolicy(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.stateFile) return;
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as Record<string, unknown>;
      if (parsed.mode === 'daily') this.policy = { mode: 'daily' };
      else if (parsed.mode === 'manual' && typeof parsed.skin === 'string') {
        this.policy = { mode: 'manual', skin: parsed.skin };
      } else {
        throw new Error('unrecognized skin policy');
      }
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code !== 'ENOENT') this.warn('invalid skin-state.json; restoring daily rotation', error);
      this.policy = { mode: 'daily' };
      await this.persistPolicy().catch((persistError) => this.warn('could not repair skin-state.json', persistError));
    }
  }

  private async listSkins(): Promise<string[]> {
    return (await readdir(join(this.webDir, 'skins'), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
      .map((entry) => entry.name)
      .sort();
  }

  private async reconcile(knownAvailable?: string[]): Promise<void> {
    let available = knownAvailable ?? await this.listSkins();
    let daily = dailySkin(available, this.timeZone, this.now());

    if (this.policy.mode === 'manual' && (!this.policy.skin || !available.includes(this.policy.skin))) {
      this.warn(`pinned skin ${JSON.stringify(this.policy.skin ?? '')} is unavailable; restoring daily rotation`);
      this.policy = { mode: 'daily' };
      await this.persistPolicy().catch((error) => this.warn('could not persist daily fallback', error));
    }

    let active = this.policy.mode === 'manual' ? this.policy.skin! : daily;
    if (active) {
      try {
        await this.materialize(active);
      } catch (error) {
        this.warn(`selected skin ${JSON.stringify(active)} changed or became unreadable; restoring daily rotation`, error);
        if (this.policy.mode === 'manual') {
          this.policy = { mode: 'daily' };
          await this.persistPolicy().catch((persistError) => this.warn('could not persist daily fallback', persistError));
        }
        available = await this.listSkins();
        daily = dailySkin(available, this.timeZone, this.now());
        active = daily;
        if (active) await this.materialize(active);
      }
    }
    this.current = {
      mode: this.policy.mode,
      active: active ?? null,
      daily,
      available: [...available],
      control: this.controlState(),
    };
  }

  private async materialize(skin: string): Promise<void> {
    const sourcePath = join(this.webDir, 'skins', skin);
    // O_NOFOLLOW closes the enumeration/apply race for symlink swaps. Opening
    // first also lets us verify the actual object, rather than stale Dirent data.
    const handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let source: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new InvalidSkinError(`not a regular skin file: ${skin}`);
      source = await handle.readFile();
    } finally {
      await handle.close();
    }
    const target = join(this.webDir, 'current.html');
    const existing = await readFile(target).catch(() => null);
    if (!existing?.equals(source)) {
      await atomicWrite(target, source);
      console.log(`[skins] homepage -> ${skin} (${this.policy.mode})`);
    }
    // If the name disappeared or stopped being a regular file while its open
    // descriptor was being copied, force reconciliation to a current daily pick.
    if (!(await this.listSkins()).includes(skin)) throw new InvalidSkinError(`skin changed while applying: ${skin}`);
  }

  private async persistPolicy(): Promise<void> {
    if (!this.stateFile) return;
    await atomicWrite(this.stateFile, `${JSON.stringify(this.policy, null, 2)}\n`);
  }

  private snapshot(): SkinState {
    return { ...this.current, available: [...this.current.available], control: { ...this.current.control } };
  }

  private controlState(): SkinState['control'] {
    return this.stateFile
      ? { available: true, message: null }
      : { available: false, message: 'Skin controls require durable FEED_DIR storage; daily rotation remains active.' };
  }

  private requireControl(): void {
    if (!this.stateFile) throw new SkinControlUnavailableError(this.controlState().message!);
  }

  private warn(message: string, error?: unknown): void {
    const detail = error ? `: ${error instanceof Error ? error.message : String(error)}` : '';
    console.warn(`[skins] ${message}${detail}`);
  }
}
