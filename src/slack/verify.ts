const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return toHex(sig);
}

/**
 * Slack の署名検証 (https://api.slack.com/authentication/verifying-requests-from-slack)
 * 5 分以上古いリクエストはリプレイ対策として拒否する。
 */
export async function verifySlackSignature(params: {
  signingSecret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowSeconds?: number;
}): Promise<boolean> {
  const { signingSecret, timestamp, signature, rawBody } = params;
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 60 * 5) return false;

  const expected = 'v0=' + (await hmacSha256Hex(signingSecret, `v0:${timestamp}:${rawBody}`));
  return timingSafeEqual(expected, signature);
}
