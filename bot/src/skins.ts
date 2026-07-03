/**
 * Daily player-skin rotation. Skins live in <webDir>/skins/*.html; the pick
 * is deterministic per station-timezone day (so every visitor sees the same
 * skin, and it flips at station midnight). The chosen skin is copied to
 * <webDir>/current.html, which icecast serves at "/".
 *
 * Checked hourly (cheap + DST-proof) and on boot, so deploys/restarts always
 * converge on the right skin. Adding a skin file IS the deployment.
 */

import { copyFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export function startSkinRotation(webDir: string, timeZone: string): void {
  let lastApplied = '';

  const apply = async (): Promise<void> => {
    try {
      const skins = (await readdir(join(webDir, 'skins')))
        .filter((name) => name.endsWith('.html'))
        .sort();
      if (skins.length === 0) return;
      // Day number in the station timezone (en-CA gives YYYY-MM-DD).
      const dayStamp = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
      const day = Math.floor(Date.parse(dayStamp) / 86_400_000);
      const pick = skins[day % skins.length]!;
      if (pick === lastApplied) return;
      await copyFile(join(webDir, 'skins', pick), join(webDir, 'current.html'));
      lastApplied = pick;
      console.log(`[skins] today's homepage: ${pick} (${skins.length} in rotation)`);
    } catch (error) {
      console.warn('[skins] rotation failed:', error instanceof Error ? error.message : error);
    }
  };

  void apply();
  setInterval(() => void apply(), 3_600_000);
}
