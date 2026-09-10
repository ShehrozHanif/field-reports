export type QueueStatus = 'queued' | 'sending' | 'sent' | 'rejected';

export interface ReportPayload {
  outlet_name: string;
  finding: string;
  action_needed: string;
  captured_at: string;
  lat: number;
  lng: number;
}

export type ReportInput = Omit<ReportPayload, 'captured_at'>;

export interface QueueItem {
  client_report_id: string;
  payload: ReportPayload;
  status: QueueStatus;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  server_report_id: string | null;
  deduped: boolean;
  created_at: number;
  settled_at: number | null;
}

export interface HttpResult {
  status: number;
  body: any;
  retryAfter: string | null;
}

export type Outcome =
  | { kind: 'accepted'; report_id: string | null; deduped: boolean }
  | { kind: 'permanent'; reason: string }
  | { kind: 'retry'; reason: string; retryAfterMs?: number };

export const BASE_BACKOFF_MS: number;
export const MAX_BACKOFF_MS: number;
export const REQUEST_TIMEOUT_MS: number;
export const NO_ANSWER: 0;

export function classify(result: HttpResult): Outcome;
export function backoffMs(attempts: number, random?: () => number): number;
export function applyOutcome(
  item: QueueItem,
  outcome: Outcome,
  now: number,
  random?: () => number
): QueueItem;
export function pickNext(items: QueueItem[], now: number): QueueItem | null;
export function recoverInterrupted(items: QueueItem[], now: number): QueueItem[];
export function newItem(input: ReportInput, clientReportId: string, now: number): QueueItem;
export function wireBody(item: QueueItem): Record<string, unknown>;
export function validate(input: {
  outlet_name: string;
  finding: string;
  action_needed: string;
  lat: unknown;
  lng: unknown;
}): Record<string, string>;
export function isPending(i: QueueItem): boolean;
