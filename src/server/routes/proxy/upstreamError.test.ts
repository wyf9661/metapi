import { describe, expect, it } from 'vitest';
import { summarizeUpstreamError } from './upstreamError.js';

describe('summarizeUpstreamError', () => {
  it('extracts concise message from JSON error payload', () => {
    const message = summarizeUpstreamError(400, JSON.stringify({
      error: {
        message: 'messages is required',
        type: 'bad_request',
      },
    }));

    expect(message).toBe('Upstream returned HTTP 400: messages is required');
  });

  it('summarizes Cloudflare 5xx HTML page without dumping full body', () => {
    const html = '<!DOCTYPE html><html><head><title>qaq.al | 502: Bad gateway</title></head><body>Cloudflare Ray ID: abc</body></html>';
    const message = summarizeUpstreamError(502, html);

    expect(message).toContain('Upstream returned HTTP 502');
    expect(message).toContain('Cloudflare 502: Bad gateway');
    expect(message).not.toContain('<!DOCTYPE html>');
  });

  it('truncates oversized plain text payloads', () => {
    const longText = 'x'.repeat(800);
    const message = summarizeUpstreamError(500, longText);

    expect(message).toContain('Upstream returned HTTP 500:');
    expect(message).toContain('...(truncated)');
    expect(message.length).toBeLessThan(500);
  });
});

