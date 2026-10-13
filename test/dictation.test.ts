import { describe, expect, it } from 'vitest';
import { parseDictationEvent } from '../src/shared/dictation.js';

describe('opt-in Windows dictation IPC contract', () => {
  it('accepts only the expected status, final and interim speech events', () => {
    expect(parseDictationEvent('{"type":"status","status":"listening"}')).toEqual({
      type: 'status', status: 'listening'
    });
    expect(parseDictationEvent('{"type":"partial","text":"Hola"}')).toEqual({
      type: 'partial', text: 'Hola'
    });
    expect(parseDictationEvent('{"type":"final","text":"  Hola, mundo  "}')).toEqual({
      type: 'final', text: 'Hola, mundo'
    });
    expect(parseDictationEvent('{"type":"status","status":"recording secret"}')).toBeNull();
    expect(parseDictationEvent('{"type":"start","text":"ignore"}')).toBeNull();
  });

  it('says which Windows engine is listening, and nothing else', () => {
    expect(parseDictationEvent('{"type":"status","status":"listening","engine":"modern"}')).toEqual({
      type: 'status', status: 'listening', engine: 'modern'
    });
    expect(parseDictationEvent('{"type":"status","status":"listening","engine":"legacy"}')).toEqual({
      type: 'status', status: 'listening', engine: 'legacy'
    });
    expect(parseDictationEvent('{"type":"status","status":"listening","engine":"cloud"}')).toEqual({
      type: 'status', status: 'listening'
    });
    expect(parseDictationEvent('{"type":"status","status":"stopped","engine":"legacy"}')).toEqual({
      type: 'status', status: 'stopped'
    });
  });

  it('rejects malformed messages and bounds transcript/error length', () => {
    expect(parseDictationEvent('not json')).toBeNull();
    expect(parseDictationEvent('null')).toBeNull();
    expect(parseDictationEvent('{"type":"final","text":12}')).toBeNull();
    expect(parseDictationEvent('{"type":"final","text":"  "}')).toBeNull();
    expect(parseDictationEvent('{"type":"final","text":"hi\\u0000there"}')).toEqual({
      type: 'final', text: 'hithere'
    });
    expect(parseDictationEvent(JSON.stringify({ type: 'final', text: 'x'.repeat(17_000) }))).toBeNull();
    const event = parseDictationEvent(JSON.stringify({ type: 'error', message: 'oops'.repeat(100) }));
    expect(event?.type).toBe('error');
    expect(event && 'message' in event ? event.message.length : 0).toBe(240);
  });
});
