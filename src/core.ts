import os from "node:os";
import process from "node:process";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import * as pty from "node-pty";
import {
  PaneSnapshot,
  SessionSnapshot,
  SpawnOptions,
  SplitDirection,
  WindowSnapshot,
} from "./types.js";

const ANSI_PATTERN =
  // Matches common CSI/OSC/control-sequence patterns well enough for agent output cleanup.
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]|(?:].*?(?:\u0007|\u001B\\)))/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);

  return parts.join("");
}

async function postExitCallback(
  urlString: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const url = new URL(urlString);
  const transport = url.protocol === "https:" ? https : http;
  const body = JSON.stringify(payload);

  await new Promise<void>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        response.on("end", resolve);
      },
    );

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

export class Pane {
  private readonly terminal: pty.IPty;
  private readonly outputLines: string[] = [];
  private partialLine = "";
  private readonly startedAtDate = new Date();
  private endedAtDate: Date | null = null;
  private exitCodeValue: number | null = null;

  public readonly id: number;
  public readonly command: string;
  public readonly cwd?: string;
  public readonly onExitUrl?: string;
  public readonly direction?: SplitDirection;

  public constructor(
    id: number,
    private readonly sessionName: string,
    command: string,
    options: SpawnOptions,
  ) {
    this.id = id;
    this.command = command;
    this.cwd = options.cwd;
    this.onExitUrl = options.onExitUrl;
    this.direction = undefined;

    const shell = options.shell ?? process.env.SHELL ?? "/bin/sh";
    const env = { ...process.env, ...options.env } as Record<string, string>;
    this.terminal = pty.spawn(shell, ["-lc", command], {
      name: "xterm-color",
      cols: options.cols ?? 120,
      rows: options.rows ?? 30,
      cwd: options.cwd ?? process.cwd(),
      env,
    });

    this.terminal.onData((chunk) => {
      this.capture(chunk);
    });

    this.terminal.onExit(({ exitCode }) => {
      this.flushPartialLine();
      this.exitCodeValue = exitCode;
      this.endedAtDate = new Date();
      void this.notifyExit();
    });

    if (options.input) {
      this.write(options.input.endsWith("\n") ? options.input : `${options.input}\n`);
    }
  }

  public get pid(): number {
    return this.terminal.pid;
  }

  public get running(): boolean {
    return this.exitCodeValue === null;
  }

  public get exitCode(): number | null {
    return this.exitCodeValue;
  }

  public get durationMs(): number {
    const end = this.endedAtDate ?? new Date();
    return end.getTime() - this.startedAtDate.getTime();
  }

  public write(data: string): void {
    this.terminal.write(data);
  }

  public kill(signal?: string): void {
    this.terminal.kill(signal);
  }

  public tail(lines = 20, shouldStripAnsi = false): string[] {
    const visibleLines = [...this.outputLines];

    if (this.partialLine.length > 0) {
      visibleLines.push(this.partialLine);
    }

    const selected = visibleLines.slice(-Math.max(lines, 0));
    return shouldStripAnsi ? selected.map((line) => stripAnsi(line)) : selected;
  }

  public snapshot(): PaneSnapshot {
    return {
      id: this.id,
      command: this.command,
      pid: this.pid,
      cwd: this.cwd,
      running: this.running,
      exitCode: this.exitCode,
      startedAt: this.startedAtDate.toISOString(),
      endedAt: this.endedAtDate?.toISOString() ?? null,
      durationMs: this.durationMs,
      lineCount: this.outputLines.length + (this.partialLine.length > 0 ? 1 : 0),
      onExitUrl: this.onExitUrl,
    };
  }

  private capture(chunk: string): void {
    const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const segments = normalized.split("\n");
    const [first, ...rest] = segments;

    this.partialLine += first ?? "";

    for (const segment of rest) {
      this.outputLines.push(this.partialLine);
      this.partialLine = segment;
    }
  }

  private flushPartialLine(): void {
    if (this.partialLine.length > 0) {
      this.outputLines.push(this.partialLine);
      this.partialLine = "";
    }
  }

  private async notifyExit(): Promise<void> {
    if (!this.onExitUrl) {
      return;
    }

    const lastOutput = this.tail(20, true).join("\n");
    const payload = {
      session: this.sessionName,
      pane: this.id,
      exitCode: this.exitCode,
      lastOutput,
      duration: formatDuration(this.durationMs),
    };

    try {
      await postExitCallback(this.onExitUrl, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.outputLines.push(`[amux] exit callback failed: ${message}`);
    }
  }
}

export class Window {
  private readonly panes = new Map<number, Pane>();
  private nextPaneId = 0;

  public readonly id: number;
  public readonly name: string;

  public constructor(id: number, name: string) {
    this.id = id;
    this.name = name;
  }

  public createPane(options: SpawnOptions): Pane {
    const pane = new Pane(this.nextPaneId, "", options.command, options);
    this.panes.set(pane.id, pane);
    this.nextPaneId += 1;
    return pane;
  }

  public createSessionBoundPane(sessionName: string, options: SpawnOptions): Pane {
    const pane = new Pane(this.nextPaneId, sessionName, options.command, options);
    this.panes.set(pane.id, pane);
    this.nextPaneId += 1;
    return pane;
  }

  public destroyPane(paneId: number): boolean {
    const pane = this.panes.get(paneId);
    if (!pane) {
      return false;
    }

    pane.kill();
    return this.panes.delete(paneId);
  }

  public getPane(paneId = 0): Pane {
    const pane = this.panes.get(paneId);
    if (!pane) {
      throw new Error(`Pane ${paneId} not found in window ${this.name}`);
    }

    return pane;
  }

  public listPanes(): Pane[] {
    return [...this.panes.values()];
  }

  public snapshot(): WindowSnapshot {
    return {
      id: this.id,
      name: this.name,
      panes: this.listPanes().map((pane) => pane.snapshot()),
    };
  }
}

export class Session {
  private readonly windows = new Map<string, Window>();
  private nextWindowId = 0;
  private readonly createdAtDate = new Date();

  public readonly name: string;

  public constructor(name: string) {
    this.name = name;
  }

  public createWindow(name = `window-${this.nextWindowId}`): Window {
    if (this.windows.has(name)) {
      throw new Error(`Window ${name} already exists in session ${this.name}`);
    }

    const window = new Window(this.nextWindowId, name);
    this.windows.set(name, window);
    this.nextWindowId += 1;
    return window;
  }

  public getWindow(name?: string): Window {
    if (name) {
      const window = this.windows.get(name);
      if (!window) {
        throw new Error(`Window ${name} not found in session ${this.name}`);
      }

      return window;
    }

    const first = this.listWindows()[0];
    if (!first) {
      throw new Error(`Session ${this.name} has no windows`);
    }

    return first;
  }

  public listWindows(): Window[] {
    return [...this.windows.values()];
  }

  public destroyWindow(name: string): boolean {
    const window = this.windows.get(name);
    if (!window) {
      return false;
    }

    for (const pane of window.listPanes()) {
      pane.kill();
    }

    return this.windows.delete(name);
  }

  public snapshot(): SessionSnapshot {
    return {
      name: this.name,
      createdAt: this.createdAtDate.toISOString(),
      windows: this.listWindows().map((window) => window.snapshot()),
    };
  }
}

export class SessionManager {
  private static instanceValue: SessionManager | null = null;
  private readonly sessions = new Map<string, Session>();

  public static getInstance(): SessionManager {
    if (!SessionManager.instanceValue) {
      SessionManager.instanceValue = new SessionManager();
    }

    return SessionManager.instanceValue;
  }

  public createSession(name: string): Session {
    if (this.sessions.has(name)) {
      throw new Error(`Session ${name} already exists`);
    }

    const session = new Session(name);
    this.sessions.set(name, session);
    return session;
  }

  public getSession(name: string): Session {
    const session = this.sessions.get(name);
    if (!session) {
      throw new Error(`Session ${name} not found`);
    }

    return session;
  }

  public getOrCreateSession(name: string): Session {
    return this.sessions.get(name) ?? this.createSession(name);
  }

  public listSessions(): SessionSnapshot[] {
    return [...this.sessions.values()].map((session) => session.snapshot());
  }

  public destroySession(name: string): boolean {
    const session = this.sessions.get(name);
    if (!session) {
      return false;
    }

    for (const window of session.listWindows()) {
      session.destroyWindow(window.name);
    }

    return this.sessions.delete(name);
  }

  public spawnInSession(
    sessionName: string,
    options: SpawnOptions & { windowName?: string },
  ): { session: Session; window: Window; pane: Pane } {
    const session = this.getOrCreateSession(sessionName);
    const windowName = options.windowName ?? "main";
    const window = session.listWindows().find((candidate) => candidate.name === windowName)
      ?? session.createWindow(windowName);
    const pane = window.createSessionBoundPane(sessionName, options);
    return { session, window, pane };
  }

  public splitPane(
    sessionName: string,
    direction: SplitDirection,
    options: SpawnOptions & { windowName?: string },
  ): { session: Session; window: Window; pane: Pane; direction: SplitDirection } {
    const session = this.getSession(sessionName);
    const window = session.getWindow(options.windowName);
    const pane = window.createSessionBoundPane(sessionName, options);
    return { session, window, pane, direction };
  }
}

export function getDefaultShell(): string {
  return process.env.SHELL ?? (os.platform() === "win32" ? "powershell.exe" : "/bin/sh");
}
