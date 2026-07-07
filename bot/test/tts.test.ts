import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_TTS_DIRECTION_TOKENS,
  TtsScriptMarkupError,
  normalizeTtsAuditText,
  parseElevenLabsSpeechSpeed,
  prepareElevenLabsTts,
} from '../src/tts.js';

test('TTS keeps readable audit tokens but maps only approved directions per model', () => {
  const v2 = prepareElevenLabsTts('Wait [pause] now [long pause] [sigh]', 'eleven_multilingual_v2');
  assert.equal(v2.auditText, 'Wait [pause] now [long pause] [sigh]');
  assert.equal(v2.requestText, 'Wait <break time="1.0s" /> now <break time="2.0s" /> …');

  const v3 = prepareElevenLabsTts('Wait [pause] now [long pause] [sigh]', 'eleven_v3');
  assert.equal(v3.auditText, v2.auditText);
  assert.equal(v3.requestText, 'Wait … now … … [sighs]');
});

test('TTS strips or rejects arbitrary markup and caps direction tokens', () => {
  assert.throws(() => normalizeTtsAuditText('hello [whispers] <break time="9s" />'), TtsScriptMarkupError);
  assert.throws(() => normalizeTtsAuditText('hello [unclosed direction'), TtsScriptMarkupError);
  assert.equal(normalizeTtsAuditText('hello [whispers] <break time="9s" /> world', 'strip'), 'hello world');
  assert.throws(() => normalizeTtsAuditText(`${'[pause] '.repeat(MAX_TTS_DIRECTION_TOKENS + 1)}end`), TtsScriptMarkupError);
});

test('native ElevenLabs speech speed defaults safely, accepts official boundaries, and falls back outside them', () => {
  assert.equal(parseElevenLabsSpeechSpeed(undefined), 0.92);
  assert.equal(parseElevenLabsSpeechSpeed('0.7'), 0.7);
  assert.equal(parseElevenLabsSpeechSpeed('1.2'), 1.2);
  assert.equal(parseElevenLabsSpeechSpeed('0.92'), 0.92);
  assert.equal(parseElevenLabsSpeechSpeed('0.69'), 0.92);
  assert.equal(parseElevenLabsSpeechSpeed('1.21'), 0.92);
  assert.equal(parseElevenLabsSpeechSpeed('fast'), 0.92);
});
