import { PollRepository } from '../db';
import { SlackApiError, SlackClient } from '../slack/api';
import {
  ACTION_CLOSE,
  ACTION_VOTE_PREFIX,
  BLOCK_CHANNEL,
  BLOCK_OPTIONS,
  BLOCK_QUESTION,
  BLOCK_SETTINGS,
  INPUT_ACTION,
  MAX_OPTIONS,
  MAX_OPTION_LENGTH,
  MIN_OPTIONS,
  MODAL_CALLBACK_ID,
  SETTING_ANONYMOUS,
  SETTING_HIDDEN,
  buildPollMessage,
  parseOptions,
  type ModalMetadata,
} from '../slack/blocks';
import { hmacSha256Hex } from '../slack/verify';
import type { Bindings, ResultsVisibility, WaitUntilContext } from '../types';

// ---- Slack interaction payload の最低限の型 ----
interface BlockAction {
  action_id: string;
  value?: string;
}
interface BlockActionsPayload {
  type: 'block_actions';
  user: { id: string };
  channel?: { id: string };
  container?: { channel_id?: string; message_ts?: string };
  actions: BlockAction[];
}
interface ViewSubmissionPayload {
  type: 'view_submission';
  user: { id: string };
  view: {
    callback_id: string;
    private_metadata: string;
    state: { values: Record<string, Record<string, ViewStateValue>> };
  };
}
interface ViewStateValue {
  type: string;
  value?: string | null;
  selected_conversation?: string | null;
  selected_options?: { value: string }[] | null;
}
type InteractionPayload = BlockActionsPayload | ViewSubmissionPayload | { type: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export function handleInteraction(env: Bindings, ctx: WaitUntilContext, raw: string): Response {
  let payload: InteractionPayload;
  try {
    payload = JSON.parse(raw) as InteractionPayload;
  } catch {
    return new Response('bad payload', { status: 400 });
  }

  switch (payload.type) {
    case 'view_submission':
      return handleViewSubmission(env, ctx, payload as ViewSubmissionPayload);
    case 'block_actions':
      return handleBlockActions(env, ctx, payload as BlockActionsPayload);
    default:
      // view_closed など、処理不要なものは 200 で受け流す
      return new Response('', { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// モーダル送信: アンケート作成
// ---------------------------------------------------------------------------

export interface ParsedSubmission {
  question: string;
  optionLabels: string[];
  channelId: string;
  anonymous: boolean;
  resultsVisibility: ResultsVisibility;
}

export function validateSubmission(
  values: Record<string, Record<string, ViewStateValue>>,
  fallbackChannel: string,
): { ok: true; data: ParsedSubmission } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const question = (values[BLOCK_QUESTION]?.[INPUT_ACTION]?.value ?? '').trim();
  if (!question) errors[BLOCK_QUESTION] = '質問を入力してください';

  const optionLabels = parseOptions(values[BLOCK_OPTIONS]?.[INPUT_ACTION]?.value ?? '');
  if (optionLabels.length < MIN_OPTIONS) {
    errors[BLOCK_OPTIONS] = `選択肢は ${MIN_OPTIONS} つ以上入力してください (1 行に 1 つ)`;
  } else if (optionLabels.length > MAX_OPTIONS) {
    errors[BLOCK_OPTIONS] = `選択肢は ${MAX_OPTIONS} 個までです`;
  } else if (optionLabels.some((l) => l.length > MAX_OPTION_LENGTH)) {
    errors[BLOCK_OPTIONS] = `各選択肢は ${MAX_OPTION_LENGTH} 文字以内にしてください`;
  }

  const channelId = values[BLOCK_CHANNEL]?.[INPUT_ACTION]?.selected_conversation ?? fallbackChannel;
  if (!channelId) errors[BLOCK_CHANNEL] = '投稿先チャンネルを選択してください';

  const selected = new Set((values[BLOCK_SETTINGS]?.[INPUT_ACTION]?.selected_options ?? []).map((o) => o.value));

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    data: {
      question,
      optionLabels,
      channelId,
      anonymous: selected.has(SETTING_ANONYMOUS),
      resultsVisibility: selected.has(SETTING_HIDDEN) ? 'hidden' : 'realtime',
    },
  };
}

function handleViewSubmission(env: Bindings, ctx: WaitUntilContext, payload: ViewSubmissionPayload): Response {
  if (payload.view.callback_id !== MODAL_CALLBACK_ID) return new Response('', { status: 200 });

  let metadata: ModalMetadata = { channel_id: '', user_id: payload.user.id };
  try {
    metadata = { ...metadata, ...(JSON.parse(payload.view.private_metadata) as Partial<ModalMetadata>) };
  } catch {
    /* metadata が壊れていてもフォームの値で続行できる */
  }

  const result = validateSubmission(payload.view.state.values, metadata.channel_id);
  if (!result.ok) return json({ response_action: 'errors', errors: result.errors });

  const creatorId = payload.user.id;
  ctx.waitUntil(createAndPostPoll(env, creatorId, result.data));

  // 空レスポンスでモーダルを閉じる
  return new Response('', { status: 200 });
}

async function createAndPostPoll(env: Bindings, creatorId: string, data: ParsedSubmission): Promise<void> {
  const repo = new PollRepository(env.DB);
  const slack = new SlackClient(env.SLACK_BOT_TOKEN);

  const { poll } = await repo.createPoll({
    question: data.question,
    channelId: data.channelId,
    creatorId,
    anonymous: data.anonymous,
    resultsVisibility: data.resultsVisibility,
    optionLabels: data.optionLabels,
  });

  const view = await repo.getPollView(poll.id);
  if (!view) return;
  const { text, blocks } = buildPollMessage(view);

  try {
    const posted = await slack.postMessage(data.channelId, text, blocks);
    await repo.setMessageTs(poll.id, posted.ts);
  } catch (e) {
    console.error('chat.postMessage failed', e);
    await repo.deletePoll(poll.id);
    const reason =
      e instanceof SlackApiError && (e.code === 'not_in_channel' || e.code === 'channel_not_found')
        ? 'アプリが投稿先チャンネルに参加していません。`/invite @poll` でアプリを招待してからもう一度お試しください。'
        : `アンケートの投稿に失敗しました (${e instanceof SlackApiError ? e.code : 'unknown'})。`;
    await slack.notifyUser(data.channelId, creatorId, reason);
  }
}

// ---------------------------------------------------------------------------
// ボタン操作: 投票 / 投票終了
// ---------------------------------------------------------------------------

function handleBlockActions(env: Bindings, ctx: WaitUntilContext, payload: BlockActionsPayload): Response {
  const action = payload.actions[0];
  if (!action) return new Response('', { status: 200 });

  const channelId = payload.channel?.id ?? payload.container?.channel_id ?? '';
  const userId = payload.user.id;

  if (action.action_id.startsWith(ACTION_VOTE_PREFIX)) {
    const optionId = action.action_id.slice(ACTION_VOTE_PREFIX.length);
    const pollId = action.value ?? '';
    ctx.waitUntil(processVote(env, { pollId, optionId, userId, channelId }));
  } else if (action.action_id === ACTION_CLOSE) {
    const pollId = action.value ?? '';
    ctx.waitUntil(processClose(env, { pollId, userId, channelId }));
  }

  // block_actions は 3 秒以内に 200 を返す必要がある。メッセージ更新は非同期で行う。
  return new Response('', { status: 200 });
}

/** 匿名投票では Slack のユーザー ID を保存せず HMAC で不可逆化したキーを使う。 */
export async function voterKeyFor(env: Bindings, pollId: string, userId: string, anonymous: boolean): Promise<string> {
  if (!anonymous) return userId;
  const secret = env.VOTER_HASH_SECRET || env.SLACK_SIGNING_SECRET;
  return 'anon:' + (await hmacSha256Hex(secret, `${pollId}:${userId}`));
}

async function processVote(
  env: Bindings,
  args: { pollId: string; optionId: string; userId: string; channelId: string },
): Promise<void> {
  const repo = new PollRepository(env.DB);
  const slack = new SlackClient(env.SLACK_BOT_TOKEN);
  const { pollId, optionId, userId } = args;

  try {
    const poll = await repo.getPoll(pollId);
    if (!poll) {
      await slack.notifyUser(args.channelId, userId, 'このアンケートは見つかりませんでした。');
      return;
    }
    const channelId = poll.channel_id || args.channelId;
    if (poll.status !== 'open') {
      await slack.notifyUser(channelId, userId, 'このアンケートは既に終了しています。');
      await refreshMessage(repo, slack, pollId);
      return;
    }
    const option = await repo.getOption(optionId);
    if (!option || option.poll_id !== pollId) {
      await slack.notifyUser(channelId, userId, '選択肢が見つかりませんでした。');
      return;
    }

    const voterKey = await voterKeyFor(env, pollId, userId, Boolean(poll.anonymous));
    const outcome = await repo.castVote(pollId, voterKey, optionId);
    await refreshMessage(repo, slack, pollId);

    // 名前が表示されない (匿名 or 結果非公開) 場合は本人にだけ確認を送る
    if (poll.anonymous || poll.results_visibility === 'hidden') {
      const msg =
        outcome === 'removed'
          ? `「${option.label}」への投票を取り消しました。`
          : outcome === 'changed'
            ? `投票先を「${option.label}」に変更しました。`
            : `「${option.label}」に投票しました。`;
      await slack.notifyUser(channelId, userId, msg);
    }
  } catch (e) {
    console.error('processVote failed', e);
    await slack.notifyUser(args.channelId, userId, '投票の処理中にエラーが発生しました。');
  }
}

async function processClose(
  env: Bindings,
  args: { pollId: string; userId: string; channelId: string },
): Promise<void> {
  const repo = new PollRepository(env.DB);
  const slack = new SlackClient(env.SLACK_BOT_TOKEN);
  const { pollId, userId } = args;

  try {
    const poll = await repo.getPoll(pollId);
    if (!poll) {
      await slack.notifyUser(args.channelId, userId, 'このアンケートは見つかりませんでした。');
      return;
    }
    const channelId = poll.channel_id || args.channelId;
    if (poll.creator_id !== userId) {
      await slack.notifyUser(channelId, userId, '投票を終了できるのはアンケートの作成者だけです。');
      return;
    }
    const closed = await repo.closePoll(pollId);
    await refreshMessage(repo, slack, pollId);
    if (!closed) await slack.notifyUser(channelId, userId, 'このアンケートは既に終了しています。');
  } catch (e) {
    console.error('processClose failed', e);
    await slack.notifyUser(args.channelId, userId, '投票終了の処理中にエラーが発生しました。');
  }
}

async function refreshMessage(repo: PollRepository, slack: SlackClient, pollId: string): Promise<void> {
  const view = await repo.getPollView(pollId);
  if (!view || !view.poll.message_ts) return;
  const { text, blocks } = buildPollMessage(view);
  await slack.updateMessage(view.poll.channel_id, view.poll.message_ts, text, blocks);
}
