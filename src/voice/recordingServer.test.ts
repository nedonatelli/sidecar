import { describe, it, expect } from 'vitest';
import { VoiceRecordingSession } from './recordingServer.js';

// These tests create real HTTP servers on random ports and make real requests.
// No mocking needed — the module has no VS Code or external dependencies.

describe('VoiceRecordingSession', () => {
  it('creates a session with a valid localhost URL and 32-char hex token', async () => {
    const session = await VoiceRecordingSession.create();
    try {
      expect(session.url).toMatch(/^http:\/\/localhost:\d+\/\?token=[0-9a-f]{32}$/);
    } finally {
      session.dispose();
    }
  });

  it('serves the recording HTML page for a valid token GET request', async () => {
    const session = await VoiceRecordingSession.create();
    try {
      const res = await fetch(session.url);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      const body = await res.text();
      expect(body).toContain('SideCar Voice Input');
      expect(body).toContain('/audio?token=');
    } finally {
      session.dispose();
    }
  });

  it('returns 403 for a GET with wrong token', async () => {
    const session = await VoiceRecordingSession.create();
    try {
      const url = new URL(session.url);
      const res = await fetch(`${url.origin}/?token=badtoken`);
      expect(res.status).toBe(403);
    } finally {
      session.dispose();
    }
  });

  it('returns 403 for a POST /audio with wrong token', async () => {
    const session = await VoiceRecordingSession.create();
    try {
      const url = new URL(session.url);
      const res = await fetch(`${url.origin}/audio?token=badtoken`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/webm' },
        body: Buffer.from('fake'),
      });
      expect(res.status).toBe(403);
    } finally {
      session.dispose();
    }
  });

  it('resolves waitForAudio with the posted buffer and mime type', async () => {
    const session = await VoiceRecordingSession.create();
    const url = new URL(session.url);
    const token = url.searchParams.get('token')!;
    const audioData = Buffer.from('fake audio bytes');

    const waitPromise = session.waitForAudio(5_000);

    const postRes = await fetch(`${url.origin}/audio?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm' },
      body: audioData,
    });
    expect(postRes.status).toBe(200);

    const result = await waitPromise;
    expect(Buffer.compare(result.buffer, audioData)).toBe(0);
    expect(result.mimeType).toBe('audio/webm');
    session.dispose();
  });

  it('strips codec suffix from content-type when storing mimeType', async () => {
    const session = await VoiceRecordingSession.create();
    const url = new URL(session.url);
    const token = url.searchParams.get('token')!;

    const waitPromise = session.waitForAudio(5_000);
    await fetch(`${url.origin}/audio?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm;codecs=opus' },
      body: Buffer.from('x'),
    });

    const { mimeType } = await waitPromise;
    expect(mimeType).toBe('audio/webm');
    session.dispose();
  });

  it('rejects waitForAudio after the timeout elapses', async () => {
    const session = await VoiceRecordingSession.create();
    await expect(session.waitForAudio(50)).rejects.toThrow('timed out');
    session.dispose();
  });

  it('dispose() is idempotent — calling twice does not throw', async () => {
    const session = await VoiceRecordingSession.create();
    session.dispose();
    expect(() => session.dispose()).not.toThrow();
  });
});
