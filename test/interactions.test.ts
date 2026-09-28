import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleInteraction, validateSubmission, voterKeyFor } from '../src/handlers/interactions';
import type { Bindings } from '../src/types';

const env = {
  SLACK_SIGNING_SECRET: 'sig',
  SLACK_BOT_TOKEN: 'xoxb',
  VOTER_HASH_SECRET: 'salt',
} as unknown as Bindings;

const noopCtx = { waitUntil: () => {} };

function values(q: string, opts: string, settings: string[] = [], channel: string | null = 'C1') {
  return {
    question: { value: { type: 'plain_text_input', value: q } },
    options: { value: { type: 'plain_text_input', value: opts } },
    channel: { value: { type: 'conversations_select', selected_conversation: channel } },
    settings: { value: { type: 'checkboxes', selected_options: settings.map((value) => ({ value })) } },
  };
}

describe('validateSubmission', () => {
  it('accepts a well-formed submission', () => {
    const r = validateSubmission(values('Q', 'A\nB\nC', ['anonymous', 'hidden']), '');
    expect(r).toEqual({
      ok: true,
      data: {
        question: 'Q',
        optionLabels: ['A', 'B', 'C'],
        channelId: 'C1',
        anonymous: true,
        resultsVisibility: 'hidden',
      },
    });
  });

  it('defaults to non-anonymous, realtime results', () => {
    const r = validateSubmission(values('Q', 'A\nB'), '');
    expect(r.ok && r.data.anonymous).toBe(false);
    expect(r.ok && r.data.resultsVisibility).toBe('realtime');
  });

  it('rejects fewer than two options', () => {
    const r = validateSubmission(values('Q', 'A'), '');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.errors.options).toMatch(/2 つ以上/);
  });

  it('rejects more than ten options and an empty question', () => {
    const many = Array.from({ length: 11 }, (_, i) => `o${i}`).join('\n');
    const r = validateSubmission(values('  ', many), '');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.question).toBeTruthy();
      expect(r.errors.options).toMatch(/10 個まで/);
    }
  });

  it('falls back to the originating channel when none is selected', () => {
    const r = validateSubmission(values('Q', 'A\nB', [], null), 'C_FALLBACK');
    expect(r.ok && r.data.channelId).toBe('C_FALLBACK');
  });
});

describe('voterKeyFor', () => {
  it('uses the plain user id for non-anonymous polls', async () => {
    expect(await voterKeyFor(env, 'p', 'U1', false)).toBe('U1');
  });

  it('hashes deterministically per poll for anonymous polls', async () => {
    const a = await voterKeyFor(env, 'p', 'U1', true);
    const b = await voterKeyFor(env, 'p', 'U1', true);
    const other = await voterKeyFor(env, 'p2', 'U1', true);
    expect(a).toBe(b);
    expect(a).not.toBe(other);
    expect(a.startsWith('anon:')).toBe(true);
    expect(a).not.toContain('U1');
  });
});

describe('handleInteraction', () => {
  it('returns validation errors as a response_action for the modal', async () => {
    const payload = {
      type: 'view_submission',
      user: { id: 'U1' },
      view: {
        callback_id: 'poll_create',
        private_metadata: JSON.stringify({ channel_id: 'C1', user_id: 'U1' }),
        state: { values: values('Q', 'only-one') },
      },
    };
    const res = handleInteraction(env, noopCtx, JSON.stringify(payload));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.response_action).toBe('errors');
    expect(body.errors.options).toBeTruthy();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('acknowledges block_actions immediately and defers the work', async () => {
    // バックグラウンド処理は DB/Slack に触るので、ここでは呼び出されたことだけを検証する
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }))));
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); } };
    const payload = {
      type: 'block_actions',
      user: { id: 'U1' },
      channel: { id: 'C1' },
      actions: [{ action_id: 'vote:o1', value: 'p1' }],
    };
    const res = handleInteraction(env, ctx, JSON.stringify(payload));
    expect(res.status).toBe(200);
    expect(pending).toHaveLength(1);
    await Promise.allSettled(pending);
  });

  it('rejects malformed JSON', () => {
    expect(handleInteraction(env, noopCtx, '{not json').status).toBe(400);
  });
});
