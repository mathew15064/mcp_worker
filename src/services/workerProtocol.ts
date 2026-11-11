/** Worker v2 messages. This is a compile-time contract; wire tags and fields
 * intentionally retain historical snake_case and authorization semantics. */
export interface WorkerErrorPayload {
  code?: string;
  message?: string;
}
export interface WorkerJobEnvelope {
  type: 'job';
  job_id: string;
  operation: string;
  payload: Record<string, unknown>;
  timeout_ms: number;
}
export interface WorkerStreamOpen {
  type: 'stream_open';
  stream_id: string;
  operation: string;
  payload: Record<string, unknown>;
}
export interface WorkerStreamInput {
  type: 'stream_input';
  stream_id: string;
  data: string;
}
export interface WorkerStreamResize {
  type: 'stream_resize';
  stream_id: string;
  cols: number;
  rows: number;
}
export interface WorkerStreamClose {
  type: 'stream_close';
  stream_id: string;
}
export type WorkerOutboundStream =
  WorkerStreamOpen | WorkerStreamInput | WorkerStreamResize | WorkerStreamClose;
export interface WorkerResultEnvelope {
  type: 'result';
  job_id: string;
  ok: boolean;
  result?: unknown;
  error?: WorkerErrorPayload;
}
export interface WorkerHeartbeat {
  type: 'heartbeat';
  capabilities?: unknown[];
}
export interface WorkerStreamEvent {
  type: 'stream_state' | 'stream_output' | 'stream_error' | 'stream_closed';
  stream_id: string;
  state?: string;
  data?: string;
  error?: WorkerErrorPayload;
  reason?: string;
}
export interface WorkerResourceAlert {
  type: 'resource_alert';
  code?: string;
  severity?: string;
  phase?: string;
  worker_name?: string;
  memory_used_percent?: number;
  memory_total_bytes?: number;
  memory_available_bytes?: number;
  threshold_percent?: number;
  resume_percent?: number;
  stopped?: Record<string, unknown>;
}
export type WorkerInbound =
  WorkerResultEnvelope | WorkerHeartbeat | WorkerStreamEvent | WorkerResourceAlert;
export interface WorkerConnectRequest {
  workerId: string;
  timestamp: string | number;
  nonce: string;
}
export interface WorkerStreamHandlers {
  onState?(state: string, event: Record<string, unknown>): void;
  onOutput?(data: Buffer): void;
  onError?(error: Error): void;
  onClose?(event: Record<string, unknown>): void;
}
export type WorkerPayload = Record<string, unknown>;

export function errorFields(error: unknown): WorkerErrorPayload {
  if (!error || typeof error !== 'object') return {};
  const fields = error as Record<string, unknown>;
  return {
    code: typeof fields.code === 'string' ? fields.code : undefined,
    message: typeof fields.message === 'string' ? fields.message : undefined,
  };
}

/** Unknown JSON stays untrusted until its message type and required fields are inspected. */
export function decodeWorkerMessage(data: unknown): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
