/**
 * anomaly.fm radio core — the invariant runtime behind every player skin.
 *
 * Skins are self-contained HTML pages that include this script and mark
 * elements with data-radio attributes (see web/skins/README.md). The core
 * owns ALL behavior: audio, autoplay, reconnect, volume persistence, status
 * polling. Skins own ONLY looks. Do not fork this file per skin.
 *
 * Contract (all optional; core skips what a skin omits):
 *   [data-radio="toggle"]     click target for tune in/out (gets aria-pressed)
 *   [data-radio="status"]     textContent = ON AIR / RERUN / INTERMISSION line
 *                             (add data-ticker for auto-scrolling overflow)
 *   [data-radio="signal"]     textContent = RECEIVING / TUNING… / SIGNAL LOST…
 *   [data-radio="listeners"]  textContent = combined listener count ("6" / "–")
 *   [data-radio="volume"]     an <input type="range" min="0" max="100">
 *
 * State classes maintained on <html> for CSS styling:
 *   radio-on / radio-off      user intent (tuned in or not)
 *   radio-tuning              connecting/buffering/retrying
 *   radio-receiving           audio flowing
 *   radio-live                humans on air        (status: ON AIR)
 *   radio-rerun               rerun playing        (status: RERUN)
 *   radio-idle                music through static (status: INTERMISSION)
 *   radio-offair              bot disconnected     (status: OFF AIR)
 */
(() => {
  'use strict';

  // Same-origin in production; localhost/file testing talks to the live
  // station automatically (CORS is open on status + stream endpoints).
  const STATION =
    window.STATION_ORIGIN ||
    (location.protocol === 'file:' || ['localhost', '127.0.0.1'].includes(location.hostname)
      ? 'https://anomaly.fm'
      : '');

  const root = document.documentElement;
  const el = (role) => document.querySelector('[data-radio="' + role + '"]');
  const toggleBtn = el('toggle');
  const statusEl = el('status');
  const signalEl = el('signal');
  const listenersEl = el('listeners');
  const volumeEl = el('volume');

  const audio = new Audio();
  audio.preload = 'none';
  let wantPlaying = false;

  // --- state classes ---
  const PLAY_STATES = ['radio-on', 'radio-off', 'radio-tuning', 'radio-receiving'];
  const AIR_STATES = ['radio-live', 'radio-rerun', 'radio-idle', 'radio-offair'];
  const setPlayState = (...classes) => {
    root.classList.remove(...PLAY_STATES);
    root.classList.add(...classes);
    toggleBtn?.setAttribute('aria-pressed', String(wantPlaying));
  };
  const setAirState = (cls) => {
    root.classList.remove(...AIR_STATES);
    if (cls) root.classList.add(cls);
  };
  const setSignal = (text) => { if (signalEl) signalEl.textContent = text; };

  // --- status line with optional ticker (data-ticker on the status element) ---
  let tickerStyleInjected = false;
  const setStatusLine = (text) => {
    if (!statusEl) return;
    statusEl.title = text;
    statusEl.textContent = text;
    if (!statusEl.hasAttribute('data-ticker')) return;
    requestAnimationFrame(() => {
      if (statusEl.scrollWidth <= statusEl.clientWidth + 2) return;
      if (!tickerStyleInjected) {
        tickerStyleInjected = true;
        const style = document.createElement('style');
        style.textContent =
          '@keyframes rc-ticker{to{transform:translateX(-50%)}}' +
          '[data-radio="status"][data-ticker]{overflow:hidden;white-space:nowrap;}' +
          '.rc-ticker-track{display:inline-block;white-space:nowrap;animation:rc-ticker var(--rc-ticker-dur,12s) linear infinite;}' +
          '.rc-ticker-track>span{padding-right:3em;}' +
          '@media (prefers-reduced-motion: reduce){.rc-ticker-track{animation:none;}}';
        document.head.appendChild(style);
      }
      const track = document.createElement('span');
      track.className = 'rc-ticker-track';
      for (let i = 0; i < 2; i += 1) {
        const copy = document.createElement('span');
        copy.textContent = text;
        track.appendChild(copy);
      }
      statusEl.textContent = '';
      statusEl.appendChild(track);
      track.style.setProperty('--rc-ticker-dur', Math.max(9, Math.round(track.scrollWidth / 2 / 35)) + 's');
    });
  };

  // --- volume (persisted) ---
  const applyVolume = () => { audio.volume = volumeEl ? Number(volumeEl.value) / 100 : 0.8; };
  if (volumeEl) {
    const saved = localStorage.getItem('anomalyfm-vol');
    if (saved !== null) {
      const v = Number(saved);
      if (Number.isFinite(v) && v >= 0 && v <= 100) volumeEl.value = String(v);
    }
    volumeEl.addEventListener('input', () => {
      applyVolume();
      localStorage.setItem('anomalyfm-vol', volumeEl.value);
    });
  }
  applyVolume();

  // --- play / stop / reconnect ---
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let lastProgress = Date.now();

  function start() {
    wantPlaying = true;
    reconnectAttempts = 0;
    lastProgress = Date.now();
    setPlayState('radio-on', 'radio-tuning');
    setSignal('TUNING\u2026');
    audio.src = STATION + '/radio?t=' + Date.now();
    applyVolume();
    audio.play().catch(() => {
      wantPlaying = false;
      setPlayState('radio-off');
      setSignal('TAP TO TUNE IN');
      document.addEventListener('pointerdown', (e) => {
        if (!wantPlaying && !(toggleBtn && toggleBtn.contains(e.target)) && !(volumeEl && volumeEl.contains(e.target))) start();
      }, { once: true });
    });
  }

  function stop() {
    wantPlaying = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempts = 0;
    setPlayState('radio-off');
    setSignal('RECEIVER OFF');
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }

  function scheduleReconnect() {
    if (!wantPlaying || reconnectTimer) return;
    reconnectAttempts += 1;
    setPlayState('radio-on', 'radio-tuning');
    setSignal('SIGNAL LOST \u2014 RETRYING');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!wantPlaying) return;
      lastProgress = Date.now();
      audio.src = STATION + '/radio?t=' + Date.now();
      applyVolume();
      audio.play().catch(() => scheduleReconnect());
    }, Math.min(3000 * reconnectAttempts, 15000));
  }

  audio.addEventListener('timeupdate', () => { lastProgress = Date.now(); });
  audio.addEventListener('error', scheduleReconnect);
  audio.addEventListener('ended', scheduleReconnect);
  audio.addEventListener('playing', () => {
    if (!wantPlaying) return;
    reconnectAttempts = 0;
    lastProgress = Date.now();
    setPlayState('radio-on', 'radio-receiving');
    setSignal('RECEIVING');
  });
  audio.addEventListener('waiting', () => {
    if (wantPlaying) { setPlayState('radio-on', 'radio-tuning'); setSignal('TUNING\u2026'); }
  });
  setInterval(() => {
    if (!wantPlaying || reconnectTimer) return;
    if (Date.now() - lastProgress > 15000) {
      try { audio.pause(); } catch { /* already dead */ }
      scheduleReconnect();
    }
  }, 5000);

  toggleBtn?.addEventListener('click', () => (wantPlaying ? stop() : start()));

  // --- station status polling ---
  async function poll() {
    try {
      const res = await fetch(STATION + '/feed/status.json', { cache: 'no-store' });
      const s = await res.json();
      if (s.humans > 0) {
        setAirState('radio-live');
        setStatusLine('ON AIR \u2014 ' + (s.members || []).join(', '));
      } else if (s.rerun) {
        setAirState('radio-rerun');
        setStatusLine('RERUN \u2014 ' + s.rerun);
      } else if (s.live) {
        setAirState('radio-idle');
        setStatusLine('INTERMISSION \u2014 music through the static');
      } else {
        setAirState('radio-offair');
        setStatusLine('OFF AIR \u2014 static');
      }
      if (listenersEl && typeof s.listeners === 'number') {
        listenersEl.textContent = String(s.listeners);
        return;
      }
    } catch {
      setAirState(null);
      setStatusLine('status unavailable');
    }
    // Fallback listener count straight from icecast (raw, unfiltered).
    try {
      const res = await fetch(STATION + '/status-json.xsl', { cache: 'no-store' });
      const ice = await res.json();
      const raw = ice.icestats && ice.icestats.source;
      const sources = (Array.isArray(raw) ? raw : [raw]).filter(Boolean);
      const mount = sources.find((x) => x.listenurl && x.listenurl.endsWith('/radio'));
      if (mount && listenersEl) listenersEl.textContent = String(mount.listeners ?? 0);
    } catch { /* keep last value */ }
  }

  // --- boot ---
  setPlayState('radio-off');
  setSignal('\u00a0');
  poll();
  setInterval(poll, 15000);
  start(); // best-effort autoplay; falls back to first-interaction tune-in

  // Escape hatch for exotic skins.
  window.RadioCore = { start, stop, toggle: () => (wantPlaying ? stop() : start()) };
})();
