import { describe, it, expect } from 'vitest';
import { isPrivateUrl } from './workspace.js';

describe('SSRF private IP detection', () => {
  it('blocks localhost', () => {
    expect(isPrivateUrl('http://localhost/admin')).toBe(true);
    expect(isPrivateUrl('http://127.0.0.1/api')).toBe(true);
    expect(isPrivateUrl('http://[::1]/test')).toBe(true);
  });

  it('blocks private IPv4 ranges', () => {
    expect(isPrivateUrl('http://10.0.0.1/')).toBe(true);
    expect(isPrivateUrl('http://10.255.255.255/')).toBe(true);
    expect(isPrivateUrl('http://172.16.0.1/')).toBe(true);
    expect(isPrivateUrl('http://172.31.255.255/')).toBe(true);
    expect(isPrivateUrl('http://192.168.1.1/')).toBe(true);
    expect(isPrivateUrl('http://192.168.0.100/')).toBe(true);
  });

  it('blocks cloud metadata endpoint', () => {
    expect(isPrivateUrl('http://169.254.169.254/latest/meta-data/')).toBe(true);
  });

  it('allows public IPs', () => {
    expect(isPrivateUrl('https://example.com/')).toBe(false);
    expect(isPrivateUrl('https://8.8.8.8/')).toBe(false);
    expect(isPrivateUrl('https://1.1.1.1/')).toBe(false);
  });

  it('allows public domains', () => {
    expect(isPrivateUrl('https://github.com/org/repo')).toBe(false);
    expect(isPrivateUrl('https://stackoverflow.com/questions/123')).toBe(false);
    expect(isPrivateUrl('https://docs.python.org/3/library/')).toBe(false);
  });

  it('blocks malformed URLs', () => {
    expect(isPrivateUrl('not-a-url')).toBe(true);
    expect(isPrivateUrl('')).toBe(true);
  });

  it('does not block 172.x outside the private range', () => {
    expect(isPrivateUrl('http://172.15.0.1/')).toBe(false);
    expect(isPrivateUrl('http://172.32.0.1/')).toBe(false);
  });
});
