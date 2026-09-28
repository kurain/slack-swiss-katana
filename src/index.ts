import { Hono } from 'hono';
import { handleSlashCommand, parseSlashCommand } from './handlers/command';
import { handleInteraction } from './handlers/interactions';
import { verifySlackSignature } from './slack/verify';
import type { Bindings } from './types';

type Variables = { rawBody: string; form: URLSearchParams };

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.get('/', (c) => c.text('slack-swiss-katana: ok'));
app.get('/health', (c) => c.json({ ok: true }));

// Slack からのリクエストはすべて署名検証を通す
app.use('/slack/*', async (c, next) => {
  const rawBody = await c.req.text();
  const valid = await verifySlackSignature({
    signingSecret: c.env.SLACK_SIGNING_SECRET,
    timestamp: c.req.header('x-slack-request-timestamp') ?? null,
    signature: c.req.header('x-slack-signature') ?? null,
    rawBody,
  });
  if (!valid) return c.text('invalid signature', 401);
  c.set('rawBody', rawBody);
  c.set('form', new URLSearchParams(rawBody));
  await next();
});

// スラッシュコマンド: /poll <質問>
app.post('/slack/commands', (c) => {
  const payload = parseSlashCommand(c.get('form'));
  return handleSlashCommand(c.env, c.executionCtx, payload);
});

// インタラクティブコンポーネント: モーダル送信、ボタン押下
app.post('/slack/interactions', (c) => {
  const payload = c.get('form').get('payload');
  if (!payload) return c.text('missing payload', 400);
  return handleInteraction(c.env, c.executionCtx, payload);
});

export default app;
