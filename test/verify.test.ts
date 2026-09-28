import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, verifySlackSignature } from '../src/slack/verify';

describe('verifySlackSignature', () => {
  const secret = 'test-secret';
  const body = 'command=%2Fpoll&text=hello';

  it('accepts a valid signature within the time window', async () => {
    const ts = '1700000000';
    const sig = 'v0=' + (await hmacSha256Hex(secret, `v0:${ts}:${body}`));
    const ok = await verifySlackSignature({
      signingSecret: secret,
      timestamp: ts,
      signature: sig,
      rawBody: body,
      nowSeconds: 1700000010,
    });
    expect(ok).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const ts = '1700000000';
    const sig = 'v0=' + (await hmacSha256Hex(secret, `v0:${ts}:${body}`));
    const ok = await verifySlackSignature({
      signingSecret: secret,
      timestamp: ts,
      signature: sig,
      rawBody: body + '&x=1',
      nowSeconds: 1700000010,
    });
    expect(ok).toBe(false);
  });

  it('rejects stale timestamps (replay protection)', async () => {
    const ts = '1700000000';
    const sig = 'v0=' + (await hmacSha256Hex(secret, `v0:${ts}:${body}`));
    const ok = await verifySlackSignature({
      signingSecret: secret,
      timestamp: ts,
      signature: sig,
      rawBody: body,
      nowSeconds: 1700000000 + 6 * 60,
    });
    expect(ok).toBe(false);
  });

  it('rejects missing headers', async () => {
    expect(
      await verifySlackSignature({ signingSecret: secret, timestamp: null, signature: null, rawBody: body }),
    ).toBe(false);
  });
});
