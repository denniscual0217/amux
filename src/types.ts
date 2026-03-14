export type SplitDirection = "horizontal" | "vertical";

export interface SpawnOptions {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  onExitUrl?: string;
  shell?: string;
  cols?: number;
  rows?: number;
}

export interface PaneSnapshot {
  id: number;
  command: string;
  pid: number;
  cwd?: string;
  running: boolean;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  lineCount: number;
  onExitUrl?: string;
}

export interface WindowSnapshot {
  id: number;
  name: string;
  panes: PaneSnapshot[];
}

export interface SessionSnapshot {
  name: string;
  createdAt: string;
  windows: WindowSnapshot[];
}

export interface SpawnRequest {
  cmd: "spawn";
  session: string;
  exec: string;
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  onExit?: string;
  window?: string;
}

export interface ListRequest {
  cmd: "list";
}

export interface TailRequest {
  cmd: "tail";
  session: string;
  pane?: number;
  window?: string;
  lines?: number;
  stripAnsi?: boolean;
}

export interface WriteRequest {
  cmd: "write";
  session: string;
  data: string;
  pane?: number;
  window?: string;
}

export interface KillRequest {
  cmd: "kill";
  session: string;
}

export interface ListWindowsRequest {
  cmd: "list-windows";
  session: string;
}

export interface ListPanesRequest {
  cmd: "list-panes";
  session: string;
  window?: string;
}

export interface SplitRequest {
  cmd: "split";
  session: string;
  direction: SplitDirection;
  exec?: string;
  cwd?: string;
  env?: Record<string, string>;
  input?: string;
  onExit?: string;
  window?: string;
}

export type ApiRequest =
  | SpawnRequest
  | ListRequest
  | TailRequest
  | WriteRequest
  | KillRequest
  | ListWindowsRequest
  | ListPanesRequest
  | SplitRequest;

export interface ApiSuccess<T = unknown> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: string;
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

export interface StreamSubscribeCommand {
  cmd: "subscribe";
  session: string;
  pane?: number;
}

export interface StreamUnsubscribeCommand {
  cmd: "unsubscribe";
  session: string;
  pane?: number;
}

export interface StreamListCommand {
  cmd: "streams";
}

export type StreamCommand =
  | StreamSubscribeCommand
  | StreamUnsubscribeCommand
  | StreamListCommand;

export interface StreamOutputEvent {
  event: "output";
  session: string;
  pane: number;
  data: string;
}

export interface StreamExitEvent {
  event: "exit";
  session: string;
  pane: number;
  code: number | null;
  duration: string;
}

export interface StreamSubscribedEvent {
  event: "subscribed";
  session: string;
  pane: number;
}

export interface StreamUnsubscribedEvent {
  event: "unsubscribed";
  session: string;
  pane: number;
}

export interface StreamListEvent {
  event: "streams";
  streams: Array<{
    session: string;
    pane: number;
    subscribers: number;
  }>;
}

export interface StreamErrorEvent {
  event: "error";
  message: string;
}

export type StreamMessage =
  | StreamOutputEvent
  | StreamExitEvent
  | StreamSubscribedEvent
  | StreamUnsubscribedEvent
  | StreamListEvent
  | StreamErrorEvent;
