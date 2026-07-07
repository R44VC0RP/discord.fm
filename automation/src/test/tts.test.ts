import assert from 'node:assert/strict';
import test from 'node:test';
import { TtsScriptMarkupError, normalizeTtsAuditText, parseElevenLabsSpeechSpeed, prepareElevenLabsTts } from '../tts.js';

test('TTS request text is model-specific while audit text stays readable', () => {
  const v2 = prepareElevenLabsTts('A [pause] B [long pause] C [sigh]', 'eleven_multilingual_v2');
  assert.equal(v2.auditText, 'A [pause] B [long pause] C [sigh]');
  assert.equal(v2.requestText, 'A <break time="1.0s" /> B <break time="2.0s" /> C …');
  assert.equal(prepareElevenLabsTts(v2.auditText, 'eleven_v3').requestText, 'A … B … … C [sighs]');
});

test('TTS rejects arbitrary markup and safely defaults invalid speed configuration', () => {
  assert.throws(() => normalizeTtsAuditText('No [laughs] or <emphasis>markup</emphasis>'), TtsScriptMarkupError);
  assert.throws(() => normalizeTtsAuditText('No [unclosed audio direction'), TtsScriptMarkupError);
  assert.equal(normalizeTtsAuditText('No [laughs] or <emphasis>markup</emphasis>', 'strip'), 'No or markup');
  assert.equal(parseElevenLabsSpeechSpeed(undefined), 0.92);
  assert.equal(parseElevenLabsSpeechSpeed('0.1'), 0.92);
});
