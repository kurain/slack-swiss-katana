export class SlackApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: string,
    public readonly response: unknown,
  ) {
    super(`Slack API ${method} failed: ${code}`);
  }
}

export class SlackClient {
  constructor(private readonly token: string) {}

  async call<T = Record<string, unknown>>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!json.ok) throw new SlackApiError(method, json.error ?? 'unknown_error', json);
    return json;
  }

  viewsOpen(triggerId: string, view: unknown) {
    return this.call('views.open', { trigger_id: triggerId, view });
  }

  postMessage(channel: string, text: string, blocks?: unknown[]) {
    return this.call<{ ts: string; channel: string }>('chat.postMessage', {
      channel,
      text,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    });
  }

  updateMessage(channel: string, ts: string, text: string, blocks?: unknown[]) {
    return this.call('chat.update', { channel, ts, text, blocks });
  }

  postEphemeral(channel: string, user: string, text: string) {
    return this.call('chat.postEphemeral', { channel, user, text });
  }

  /** ユーザーへ通知する。まずチャンネルで ephemeral を試し、失敗したら DM に送る。 */
  async notifyUser(channel: string, user: string, text: string): Promise<void> {
    try {
      await this.postEphemeral(channel, user, text);
    } catch {
      try {
        await this.postMessage(user, text);
      } catch (e) {
        console.error('failed to notify user', e);
      }
    }
  }
}
