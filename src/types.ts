export type Bindings = {
  DB: D1Database;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  /** 匿名投票の投票者IDをハッシュ化するためのシークレット。未設定なら SLACK_SIGNING_SECRET を使う */
  VOTER_HASH_SECRET?: string;
};

export type ResultsVisibility = 'realtime' | 'hidden';
export type PollStatus = 'open' | 'closed';

export interface Poll {
  id: string;
  question: string;
  channel_id: string;
  message_ts: string | null;
  creator_id: string;
  anonymous: number;
  results_visibility: ResultsVisibility;
  status: PollStatus;
  created_at: string;
  closed_at: string | null;
}

export interface PollOption {
  id: string;
  poll_id: string;
  position: number;
  label: string;
}

export interface OptionResult extends PollOption {
  count: number;
  /** 匿名投票では常に空 */
  voters: string[];
}

export interface PollView {
  poll: Poll;
  options: OptionResult[];
  totalVotes: number;
}

export interface CreatePollInput {
  question: string;
  channelId: string;
  creatorId: string;
  anonymous: boolean;
  resultsVisibility: ResultsVisibility;
  optionLabels: string[];
}

/** waitUntil だけを必要とする最小限の実行コンテキスト (Hono / Workers 双方の型と互換) */
export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}
