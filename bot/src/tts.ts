/** Safe, deliberately small TTS direction surface for untrusted AI scripts. */
export const ELEVENLABS_SPEECH_SPEED_MIN = 0.7;
export const ELEVENLABS_SPEECH_SPEED_MAX = 1.2;
export const MAX_TTS_DIRECTION_TOKENS = 6;
export const MAX_TTS_LONG_PAUSE_TOKENS = 2;

export class TtsScriptMarkupError extends Error {
  constructor(message: string) { super(message); this.name = 'TtsScriptMarkupError'; }
}

type UnsupportedMarkup = 'reject' | 'strip';
const allowedToken = /^\[(pause|long pause|sigh)\]$/iu;
const anyMarkup = /<[^>]*>|\[[^\]]*\]/gu;
const directionToken = /\[(pause|long pause|sigh)\]/giu;

/**
 * Produces the human-readable script retained in logs/audits. Only the three
 * documented station tokens survive; arbitrary square-bracket and SSML markup
 * can never reach ElevenLabs.
 */
export function normalizeTtsAuditText(input: string, unsupported: UnsupportedMarkup = 'reject'): string {
  let directions = 0;
  let longPauses = 0;
  // Detect unclosed markup before replacing allowed tokens; afterwards the
  // canonical station tokens themselves intentionally still contain brackets.
  const unclosed = input.replace(anyMarkup, '');
  if (/[\[\]<>]/u.test(unclosed)) {
    if (unsupported === 'reject') throw new TtsScriptMarkupError('unclosed or unsupported TTS markup is not allowed');
    input = input.replace(/[\[\]<>]/gu, '');
  }
  const normalized = input.replace(anyMarkup, (markup) => {
    const match = allowedToken.exec(markup);
    allowedToken.lastIndex = 0;
    if (!match) {
      if (unsupported === 'strip') return ' ';
      throw new TtsScriptMarkupError('only [pause], [long pause], and [sigh] TTS direction tokens are allowed');
    }
    const token = match[1];
    if (!token) throw new TtsScriptMarkupError('invalid TTS direction token');
    directions++;
    if (token.toLocaleLowerCase('en-US') === 'long pause') longPauses++;
    if (directions > MAX_TTS_DIRECTION_TOKENS || longPauses > MAX_TTS_LONG_PAUSE_TOKENS) {
      if (unsupported === 'strip') return ' ';
      throw new TtsScriptMarkupError(`TTS direction tokens exceed the ${MAX_TTS_DIRECTION_TOKENS} total / ${MAX_TTS_LONG_PAUSE_TOKENS} long-pause cap`);
    }
    return `[${token.toLocaleLowerCase('en-US')}]`;
  });
  return normalized.replace(/\s+/gu, ' ').trim();
}

/** Converts the safe audit representation into model-specific request text. */
export function ttsRequestText(auditText: string, modelId: string): string {
  const isV3 = modelId === 'eleven_v3';
  return auditText.replace(directionToken, (_token, raw: string) => {
    const token = raw.toLocaleLowerCase('en-US');
    if (isV3) {
      // v3 does not support SSML breaks. Its docs recommend ellipses for
      // pauses and list [sighs] as an audio tag.
      if (token === 'pause') return '…';
      if (token === 'long pause') return '… …';
      return '[sighs]';
    }
    // Eleven Multilingual v2 supports natural SSML breaks up to three seconds.
    if (token === 'pause') return '<break time="1.0s" />';
    if (token === 'long pause') return '<break time="2.0s" />';
    return '…';
  });
}

export function prepareElevenLabsTts(input: string, modelId: string, unsupported: UnsupportedMarkup = 'reject'): { auditText: string; requestText: string } {
  const auditText = normalizeTtsAuditText(input, unsupported);
  return { auditText, requestText: ttsRequestText(auditText, modelId) };
}

export function parseElevenLabsSpeechSpeed(value: string | undefined, name = 'ELEVENLABS_SPEECH_SPEED'): number {
  if (value === undefined || value.trim() === '') return 0.92;
  const speed = Number(value);
  if (!Number.isFinite(speed) || speed < ELEVENLABS_SPEECH_SPEED_MIN || speed > ELEVENLABS_SPEECH_SPEED_MAX) {
    console.warn(`[config] ${name} must be a number from ${ELEVENLABS_SPEECH_SPEED_MIN} to ${ELEVENLABS_SPEECH_SPEED_MAX}; using 0.92`);
    return 0.92;
  }
  return speed;
}
