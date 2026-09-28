import { describe, expect, it } from 'vitest';
import {
  ACTION_CLOSE,
  ACTION_VOTE_PREFIX,
  buildPollMessage,
  buildPollModal,
  parseOptions,
  renderBar,
} from '../src/slack/blocks';
import type { PollView } from '../src/types';

function makeView(overrides: Partial<PollView['poll']> = {}, counts = [2, 1]): PollView {
  const poll: PollView['poll'] = {
    id: 'p1',
    question: 'ランチどこ行く？',
    channel_id: 'C1',
    message_ts: '1.2',
    creator_id: 'U_OWNER',
    anonymous: 0,
    results_visibility: 'realtime',
    status: 'open',
    created_at: '2026-09-28T00:00:00.000Z',
    closed_at: null,
    ...overrides,
  };
  const options = counts.map((count, i) => ({
    id: `o${i}`,
    poll_id: 'p1',
    position: i,
    label: `選択肢${i}`,
    count,
    voters: poll.anonymous ? [] : Array.from({ length: count }, (_, k) => `U${i}_${k}`),
  }));
  return { poll, options, totalVotes: counts.reduce((a, b) => a + b, 0) };
}

const text = (blocks: unknown[]) => JSON.stringify(blocks);

describe('parseOptions', () => {
  it('splits by line, trims, drops blanks and duplicates', () => {
    expect(parseOptions('  A \n\nB\r\nA\n C')).toEqual(['A', 'B', 'C']);
  });
});

describe('renderBar', () => {
  it('renders an empty bar when there are no votes', () => {
    expect(renderBar(0, 0)).toBe('░'.repeat(12));
  });
  it('fills proportionally', () => {
    expect(renderBar(1, 2)).toBe('█'.repeat(6) + '░'.repeat(6));
    expect(renderBar(2, 2)).toBe('█'.repeat(12));
  });
});

describe('buildPollModal', () => {
  it('prefills the question and channel from the slash command', () => {
    const modal = buildPollModal({ question: 'Q?', channelId: 'C9', userId: 'U9' }) as any;
    expect(modal.callback_id).toBe('poll_create');
    expect(JSON.parse(modal.private_metadata)).toEqual({ channel_id: 'C9', user_id: 'U9' });
    expect(modal.blocks[0].element.initial_value).toBe('Q?');
    expect(modal.blocks[2].element.initial_conversation).toBe('C9');
  });
});

describe('buildPollMessage', () => {
  it('shows realtime results with voter names for open, non-anonymous polls', () => {
    const { blocks } = buildPollMessage(makeView());
    const s = text(blocks);
    expect(s).toContain('2票 (67%)');
    expect(s).toContain('<@U0_0>');
    expect(s).toContain(`${ACTION_VOTE_PREFIX}o0`);
    expect(s).toContain(ACTION_CLOSE);
  });

  it('hides per-option results while a hidden poll is open, but still shows the total', () => {
    const { blocks } = buildPollMessage(makeView({ results_visibility: 'hidden' }));
    const s = text(blocks);
    expect(s).not.toContain('票 (');
    expect(s).toContain('投票数: 3');
    expect(s).toContain('投票終了後に表示');
  });

  it('reveals results and removes buttons once a hidden poll is closed', () => {
    const { blocks } = buildPollMessage(
      makeView({ results_visibility: 'hidden', status: 'closed', closed_at: '2026-09-28T01:00:00.000Z' }),
    );
    const s = text(blocks);
    expect(s).toContain('2票 (67%)');
    expect(s).not.toContain(ACTION_VOTE_PREFIX);
    expect(s).not.toContain(ACTION_CLOSE);
    expect(s).toContain('投票終了');
  });

  it('never renders voter mentions for anonymous polls', () => {
    const { blocks } = buildPollMessage(makeView({ anonymous: 1 }));
    const s = text(blocks);
    expect(s).toContain('2票');
    expect(s).not.toMatch(/<@U\d_\d>/);
    expect(s).toContain('匿名投票');
  });

  it('escapes mrkdwn special characters in labels', () => {
    const view = makeView();
    view.options[0]!.label = 'a < b & c';
    const { blocks } = buildPollMessage(view);
    expect(text(blocks)).toContain('a &lt; b &amp; c');
  });
});
