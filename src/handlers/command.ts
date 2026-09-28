import { SlackClient } from '../slack/api';
import { buildPollModal } from '../slack/blocks';
import type { Bindings, WaitUntilContext } from '../types';

export interface SlashCommandPayload {
  command: string;
  text: string;
  trigger_id: string;
  channel_id: string;
  user_id: string;
  response_url: string;
}

export function parseSlashCommand(form: URLSearchParams): SlashCommandPayload {
  return {
    command: form.get('command') ?? '',
    text: form.get('text') ?? '',
    trigger_id: form.get('trigger_id') ?? '',
    channel_id: form.get('channel_id') ?? '',
    user_id: form.get('user_id') ?? '',
    response_url: form.get('response_url') ?? '',
  };
}

/**
 * `/poll <質問>` を受け取り、アンケート作成モーダルを開く。
 * trigger_id は 3 秒で失効するため、views.open はバックグラウンドで即座に実行する。
 */
export function handleSlashCommand(
  env: Bindings,
  ctx: WaitUntilContext,
  payload: SlashCommandPayload,
): Response {
  const slack = new SlackClient(env.SLACK_BOT_TOKEN);
  const view = buildPollModal({
    question: payload.text.trim(),
    channelId: payload.channel_id,
    userId: payload.user_id,
  });

  ctx.waitUntil(
    slack.viewsOpen(payload.trigger_id, view).catch(async (e) => {
      console.error('views.open failed', e);
      await postToResponseUrl(payload.response_url, 'モーダルを開けませんでした。もう一度お試しください。');
    }),
  );

  // 空の 200 を返すとユーザーには何も表示されない (モーダルだけが開く)
  return new Response('', { status: 200 });
}

async function postToResponseUrl(url: string, text: string): Promise<void> {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response_type: 'ephemeral', text }),
    });
  } catch (e) {
    console.error('response_url post failed', e);
  }
}
