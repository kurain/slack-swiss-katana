import type { CreatePollInput, OptionResult, Poll, PollOption, PollView } from './types';

export type VoteOutcome = 'added' | 'changed' | 'removed';

export class PollRepository {
  constructor(private readonly db: D1Database) {}

  async createPoll(input: CreatePollInput): Promise<{ poll: Poll; options: PollOption[] }> {
    const now = new Date().toISOString();
    const poll: Poll = {
      id: crypto.randomUUID(),
      question: input.question,
      channel_id: input.channelId,
      message_ts: null,
      creator_id: input.creatorId,
      anonymous: input.anonymous ? 1 : 0,
      results_visibility: input.resultsVisibility,
      status: 'open',
      created_at: now,
      closed_at: null,
    };
    const options: PollOption[] = input.optionLabels.map((label, i) => ({
      id: crypto.randomUUID(),
      poll_id: poll.id,
      position: i,
      label,
    }));

    const stmts: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO polls (id, question, channel_id, message_ts, creator_id, anonymous, results_visibility, status, created_at, closed_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, 'open', ?, NULL)`,
        )
        .bind(poll.id, poll.question, poll.channel_id, poll.creator_id, poll.anonymous, poll.results_visibility, now),
      ...options.map((o) =>
        this.db
          .prepare(`INSERT INTO options (id, poll_id, position, label) VALUES (?, ?, ?, ?)`)
          .bind(o.id, o.poll_id, o.position, o.label),
      ),
    ];
    await this.db.batch(stmts);
    return { poll, options };
  }

  async setMessageTs(pollId: string, ts: string): Promise<void> {
    await this.db.prepare(`UPDATE polls SET message_ts = ? WHERE id = ?`).bind(ts, pollId).run();
  }

  /** メッセージ投稿に失敗した場合などに作成直後のアンケートを取り消す。 */
  async deletePoll(pollId: string): Promise<void> {
    await this.db.batch([
      this.db.prepare(`DELETE FROM votes WHERE poll_id = ?`).bind(pollId),
      this.db.prepare(`DELETE FROM options WHERE poll_id = ?`).bind(pollId),
      this.db.prepare(`DELETE FROM polls WHERE id = ?`).bind(pollId),
    ]);
  }

  async getPoll(pollId: string): Promise<Poll | null> {
    return await this.db.prepare(`SELECT * FROM polls WHERE id = ?`).bind(pollId).first<Poll>();
  }

  async getOption(optionId: string): Promise<PollOption | null> {
    return await this.db.prepare(`SELECT * FROM options WHERE id = ?`).bind(optionId).first<PollOption>();
  }

  /** 集計済みのアンケート表示用データを取得する。 */
  async getPollView(pollId: string): Promise<PollView | null> {
    const poll = await this.getPoll(pollId);
    if (!poll) return null;

    const [optionsRes, votesRes] = await this.db.batch<Record<string, unknown>>([
      this.db.prepare(`SELECT * FROM options WHERE poll_id = ? ORDER BY position ASC`).bind(pollId),
      this.db
        .prepare(`SELECT option_id, voter_key FROM votes WHERE poll_id = ? ORDER BY created_at ASC`)
        .bind(pollId),
    ]);
    const optionRows = (optionsRes?.results ?? []) as unknown as PollOption[];
    const voteRows = (votesRes?.results ?? []) as unknown as { option_id: string; voter_key: string }[];

    const byOption = new Map<string, string[]>();
    for (const v of voteRows) {
      const arr = byOption.get(v.option_id) ?? [];
      arr.push(v.voter_key);
      byOption.set(v.option_id, arr);
    }

    const options: OptionResult[] = optionRows.map((o) => {
      const voters = byOption.get(o.id) ?? [];
      return { ...o, count: voters.length, voters: poll.anonymous ? [] : voters };
    });

    return { poll, options, totalVotes: voteRows.length };
  }

  /**
   * 投票を記録する。同じ選択肢を再度押すと取り消し、別の選択肢を押すと変更になる。
   * (poll_id, voter_key) が主キーなので 1 ユーザー 1 票が DB レベルで保証される。
   */
  async castVote(pollId: string, voterKey: string, optionId: string): Promise<VoteOutcome> {
    const now = new Date().toISOString();
    const existing = await this.db
      .prepare(`SELECT option_id FROM votes WHERE poll_id = ? AND voter_key = ?`)
      .bind(pollId, voterKey)
      .first<{ option_id: string }>();

    if (existing && existing.option_id === optionId) {
      await this.db
        .prepare(`DELETE FROM votes WHERE poll_id = ? AND voter_key = ?`)
        .bind(pollId, voterKey)
        .run();
      return 'removed';
    }

    // 競合時 (同一ユーザーの連打など) も 1 票に収束するよう UPSERT を使う
    await this.db
      .prepare(
        `INSERT INTO votes (poll_id, voter_key, option_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(poll_id, voter_key) DO UPDATE SET option_id = excluded.option_id, updated_at = excluded.updated_at`,
      )
      .bind(pollId, voterKey, optionId, now, now)
      .run();
    return existing ? 'changed' : 'added';
  }

  /** 投票を終了する。既に終了済みなら false を返す。 */
  async closePoll(pollId: string): Promise<boolean> {
    const res = await this.db
      .prepare(`UPDATE polls SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'open'`)
      .bind(new Date().toISOString(), pollId)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }
}
