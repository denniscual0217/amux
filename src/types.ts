export type SplitDirection = "horizontal" | "vertical";

export type FocusDirection = "left" | "right" | "up" | "down";

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

export interface PaneLayoutLeafSnapshot {
  type: "pane";
  paneId: number;
}

export interface PaneLayoutSplitSnapshot {
  type: "split";
  direction: SplitDirection;
  first: PaneLayoutSnapshot;
  second: PaneLayoutSnapshot;
}

export type PaneLayoutSnapshot = PaneLayoutLeafSnapshot | PaneLayoutSplitSnapshot;

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
  activePaneId: number | null;
  zoomedPaneId: number | null;
  panes: PaneSnapshot[];
  layout: PaneLayoutSnapshot | null;
}

export interface SessionSnapshot {
  name: string;
  createdAt: string;
  activeWindowId: number | null;
  windows: WindowSnapshot[];
  tags: Record<string, string>;
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
  tags?: Record<string, string>;
}

export interface CreateSessionRequest {
  cmd: "create-session";
  session: string;
  window?: string;
  exec?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface GetSessionRequest {
  cmd: "get-session";
  session: string;
}

export interface ListRequest {
  cmd: "list";
  filter?: { tag?: string };
  includeDead?: boolean;
}

export interface TailRequest {
  cmd: "tail";
  session: string;
  pane?: number;
  window?: string;
  lines?: number;
  stripAnsi?: boolean;
}

export interface ScreenshotRequest {
  cmd: "screenshot";
  session: string;
  pane?: number;
  tui?: boolean;
  cols?: number;
  rows?: number;
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

export interface CreateWindowRequest {
  cmd: "create-window";
  session: string;
  name?: string;
  exec?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface SelectWindowRequest {
  cmd: "select-window";
  session: string;
  id?: number;
  window?: string;
}

export interface RenameWindowRequest {
  cmd: "rename-window";
  session: string;
  window?: string;
  name: string;
}

export interface RenameSessionRequest {
  cmd: "rename-session";
  session: string;
  name: string;
}

export interface SelectPaneRequest {
  cmd: "select-pane";
  session: string;
  window?: string;
  pane: number;
}

export interface MovePaneFocusRequest {
  cmd: "move-pane-focus";
  session: string;
  window?: string;
  direction: FocusDirection;
}

export interface KillPaneRequest {
  cmd: "kill-pane";
  session: string;
  window?: string;
  pane?: number;
}

export interface ToggleZoomRequest {
  cmd: "toggle-zoom";
  session: string;
  window?: string;
}

export interface ResizeWindowRequest {
  cmd: "resize-window";
  session: string;
  window?: string;
  panes: Array<{
    pane: number;
    cols: number;
    rows: number;
  }>;
}

export interface GrepRequest {
  cmd: "grep";
  session: string;
  pattern: string;
  pane?: number;
  window?: string;
  lastLines?: number;
  context?: number;
}

export interface DiffRequest {
  cmd: "diff";
  session: string;
  pane?: number;
  window?: string;
  clientId?: string;
}

export interface CleanRequest {
  cmd: "clean";
}

export interface TemplateApplyRequest {
  cmd: "template-apply";
  name: string;
}

export interface TemplateListRequest {
  cmd: "template-list";
}

export interface TemplateSaveRequest {
  cmd: "template-save";
  name: string;
  session: string;
}

export interface AttachTuiRequest {
  cmd: "attach-tui";
  session: string;
  cols: number;
  rows: number;
  showSessionPicker?: boolean;
}

export interface AttachInputRequest {
  cmd: "attach-input";
  data: string;
}

export interface AttachResizeRequest {
  cmd: "attach-resize";
  cols: number;
  rows: number;
}

export interface AttachDetachRequest {
  cmd: "attach-detach";
}

export type ApiRequest =
  | SpawnRequest
  | CreateSessionRequest
  | GetSessionRequest
  | ListRequest
  | TailRequest
  | ScreenshotRequest
  | WriteRequest
  | KillRequest
  | ListWindowsRequest
  | ListPanesRequest
  | SplitRequest
  | CreateWindowRequest
  | SelectWindowRequest
  | RenameWindowRequest
  | RenameSessionRequest
  | SelectPaneRequest
  | MovePaneFocusRequest
  | KillPaneRequest
  | ToggleZoomRequest
  | ResizeWindowRequest
  | GrepRequest
  | DiffRequest
  | CleanRequest
  | TemplateApplyRequest
  | TemplateListRequest
  | TemplateSaveRequest;

export type AttachMessage =
  | AttachTuiRequest
  | AttachInputRequest
  | AttachResizeRequest
  | AttachDetachRequest;

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
  window?: number;
  pane?: number;
}

export interface StreamUnsubscribeCommand {
  cmd: "unsubscribe";
  session: string;
  window?: number;
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
