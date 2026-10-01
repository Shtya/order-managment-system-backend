export type AiDashboardQuery = {
  range?: string;
  startDate?: string;
  endDate?: string;
  compare?: string | boolean;
  agentId?: string;
  model?: string;
  mediaType?: string;
  status?: string;
  search?: string;
  source?: string;
  billedBy?: string;
  granularity?: string;
  page?: string | number;
  limit?: string | number;
  sort?: string;
  order?: string;
};

export type ResolvedWindow = {
  start?: Date;
  end?: Date;
};

export type TokenTotals = {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
};
