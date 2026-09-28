import type { OptionResult, Poll, PollView, ResultsVisibility } from '../types';

export const MODAL_CALLBACK_ID = 'poll_create';
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 10;
export const MAX_OPTION_LENGTH = 100;
export const MAX_QUESTION_LENGTH = 300;
export const ACTION_VOTE_PREFIX = 'vote:';
export const ACTION_CLOSE = 'close_poll';

export const BLOCK_QUESTION = 'question';
export const BLOCK_OPTIONS = 'options';
export const BLOCK_CHANNEL = 'channel';
export const BLOCK_SETTINGS = 'settings';
export const INPUT_ACTION = 'value';
export const SETTING_ANONYMOUS = 'anonymous';
export const SETTING_HIDDEN = 'hidden';

export interface ModalMetadata {
  channel_id: string;
  user_id: string;
}

/** 1 行 1 選択肢のテキストをパースする。空行は無視し、前後の空白を除去、重複は除去。 */
export function parseOptions(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const label = raw.trim();
    if (!label) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

export function buildPollModal(params: {
  question: string;
  channelId: string;
  userId: string;
}): Record<string, unknown> {
  const metadata: ModalMetadata = { channel_id: params.channelId, user_id: params.userId };
  const question = params.question.slice(0, MAX_QUESTION_LENGTH);
  return {
    type: 'modal',
    callback_id: MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(metadata),
    title: { type: 'plain_text', text: 'アンケートを作成' },
    submit: { type: 'plain_text', text: '投稿する' },
    close: { type: 'plain_text', text: 'キャンセル' },
    blocks: [
      {
        type: 'input',
        block_id: BLOCK_QUESTION,
        label: { type: 'plain_text', text: '質問' },
        element: {
          type: 'plain_text_input',
          action_id: INPUT_ACTION,
          max_length: MAX_QUESTION_LENGTH,
          placeholder: { type: 'plain_text', text: '例: 次の懇親会はいつにしますか？' },
          ...(question ? { initial_value: question } : {}),
        },
      },
      {
        type: 'input',
        block_id: BLOCK_OPTIONS,
        label: { type: 'plain_text', text: '選択肢' },
        hint: {
          type: 'plain_text',
          text: `1 行に 1 つずつ入力してください (${MIN_OPTIONS}〜${MAX_OPTIONS} 個)`,
        },
        element: {
          type: 'plain_text_input',
          action_id: INPUT_ACTION,
          multiline: true,
          placeholder: { type: 'plain_text', text: '金曜日\n土曜日\n日曜日' },
        },
      },
      {
        type: 'input',
        block_id: BLOCK_CHANNEL,
        label: { type: 'plain_text', text: '投稿先チャンネル' },
        element: {
          type: 'conversations_select',
          action_id: INPUT_ACTION,
          default_to_current_conversation: true,
          initial_conversation: params.channelId,
          filter: { include: ['public', 'private', 'mpim', 'im'], exclude_bot_users: true },
        },
      },
      {
        type: 'input',
        block_id: BLOCK_SETTINGS,
        optional: true,
        label: { type: 'plain_text', text: 'オプション' },
        element: {
          type: 'checkboxes',
          action_id: INPUT_ACTION,
          options: [
            {
              value: SETTING_ANONYMOUS,
              text: { type: 'plain_text', text: '匿名投票にする' },
              description: { type: 'plain_text', text: '誰が何に投票したかを表示しません' },
            },
            {
              value: SETTING_HIDDEN,
              text: { type: 'plain_text', text: '結果を投票終了まで非公開にする' },
              description: {
                type: 'plain_text',
                text: '作成者が「投票を終了」するまで集計結果を表示しません',
              },
            },
          ],
        },
      },
    ],
  };
}

const BAR_WIDTH = 12;
const MAX_VOTER_MENTIONS = 20;

export function renderBar(count: number, total: number): string {
  if (total <= 0) return '░'.repeat(BAR_WIDTH);
  const filled = Math.round((count / total) * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

export function percent(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 100);
}

function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderOptionText(opt: OptionResult, view: PollView, showResults: boolean): string {
  const label = `*${escapeMrkdwn(opt.label)}*`;
  if (!showResults) return label;

  const total = view.totalVotes;
  const lines = [label, `${renderBar(opt.count, total)}  ${opt.count}票 (${percent(opt.count, total)}%)`];
  if (!view.poll.anonymous && opt.voters.length > 0) {
    const shown = opt.voters.slice(0, MAX_VOTER_MENTIONS).map((u) => `<@${u}>`);
    const rest = opt.voters.length - shown.length;
    lines.push(shown.join(' ') + (rest > 0 ? ` 他${rest}名` : ''));
  }
  return lines.join('\n');
}

export function shouldShowResults(poll: Poll): boolean {
  return poll.status === 'closed' || poll.results_visibility === 'realtime';
}

export function describeSettings(anonymous: boolean, visibility: ResultsVisibility): string[] {
  const tags: string[] = [];
  tags.push(anonymous ? '匿名投票' : '記名投票');
  tags.push(visibility === 'hidden' ? '結果は投票終了まで非公開' : '結果はリアルタイム表示');
  return tags;
}

/** チャンネルに投稿するアンケートメッセージを組み立てる。 */
export function buildPollMessage(view: PollView): { text: string; blocks: unknown[] } {
  const { poll, options } = view;
  const showResults = shouldShowResults(poll);
  const isOpen = poll.status === 'open';
  const blocks: unknown[] = [];

  if (poll.question.length <= 150) {
    blocks.push({ type: 'header', text: { type: 'plain_text', text: poll.question, emoji: true } });
  } else {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${escapeMrkdwn(poll.question)}*` } });
  }

  const tags = describeSettings(Boolean(poll.anonymous), poll.results_visibility);
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `作成者: <@${poll.creator_id}>  ·  ${tags.join('  ·  ')}${isOpen ? '' : '  ·  *投票終了*'}`,
      },
    ],
  });
  blocks.push({ type: 'divider' });

  for (const opt of options) {
    const section: Record<string, unknown> = {
      type: 'section',
      block_id: `opt:${opt.id}`,
      text: { type: 'mrkdwn', text: renderOptionText(opt, view, showResults) },
    };
    if (isOpen) {
      section.accessory = {
        type: 'button',
        action_id: `${ACTION_VOTE_PREFIX}${opt.id}`,
        value: poll.id,
        text: { type: 'plain_text', text: '投票', emoji: true },
      };
    }
    blocks.push(section);
  }

  blocks.push({ type: 'divider' });

  const footer: string[] = [`投票数: ${view.totalVotes}`];
  if (!showResults && isOpen) footer.push('集計結果は投票終了後に表示されます');
  if (poll.closed_at) {
    const unix = Math.floor(new Date(poll.closed_at).getTime() / 1000);
    footer.push(`<!date^${unix}^{date_short} {time}|${poll.closed_at}> に終了`);
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footer.join('  ·  ') }] });

  if (isOpen) {
    blocks.push({
      type: 'actions',
      block_id: 'poll_controls',
      elements: [
        {
          type: 'button',
          action_id: ACTION_CLOSE,
          value: poll.id,
          style: 'danger',
          text: { type: 'plain_text', text: '投票を終了', emoji: true },
          confirm: {
            title: { type: 'plain_text', text: '投票を終了しますか？' },
            text: {
              type: 'mrkdwn',
              text: '終了すると以降の投票は受け付けられず、集計結果が全員に表示されます。',
            },
            confirm: { type: 'plain_text', text: '終了する' },
            deny: { type: 'plain_text', text: 'キャンセル' },
          },
        },
      ],
    });
  }

  const text = `アンケート: ${poll.question}${isOpen ? '' : ' (投票終了)'}`;
  return { text, blocks };
}
