#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { WebSocket } from "ws";
import { getDefaultShell } from "./core.js";
import { renderTuiScreenshot, writeScreenshotPng } from "./screenshot.js";
import { getSocketPath, getStreamPortFromConfig, startServer } from "./server.js";
import { ApiRequest, ApiResponse, SessionSnapshot, StreamMessage } from "./types.js";
import type { PaneScreenSnapshot } from "./core.js";

interface TuiScreenshotResponse {
  session: SessionSnapshot;
  sessions: SessionSnapshot[];
  paneScreens: Record<string, PaneScreenSnapshot>;
  cols?: number;
  rows?: number;
}

function printUsage(): void {
  console.log(
    [
      "amux — Agent-Native Terminal Multiplexer\n",
      "Usage:",
      "  amux                                          Launch TUI (auto-start daemon)",
      "  amux start [-d|--daemon]                      Start daemon (foreground, or -d for background)",
      "  amux status                                   Show daemon & session status",
      "  amux stop                                     Stop the daemon",
      "  amux restart                                  Restart the daemon",
      "  amux install                                  Install `amux` executable into a system bin directory",
      "  amux uninstall                                Remove installed `amux` executable",
      "  amux new [name]                               New session in current directory (+ attach)",
      "  amux attach -t <session>                      Attach TUI to session",
      "  amux spawn -s <name> -e <cmd> [options]       Create session & run command",
      "      --cwd <dir>                               Working directory",
      "      --on-exit <url>                            Webhook on process exit",
      "      --input <text>                             Send input after spawn",
      "  amux list                                     List all sessions",
      "  amux tail <session> [--lines N] [--strip-ansi] Get pane output",
      "  amux screenshot <session> [--tui] [-p <pane>] [-o <output.png>] [--cols N] [--rows N] Capture pane screen as PNG",
      "  amux stream <session> [--pane N]              Live stream pane output",
      "  amux write <session> <data>                     Send text input to session",
      "  amux send-keys <session> <key> [<key>...]       Send keypresses (Enter, C-c, Escape, Tab, Space, ...)",
      "  amux kill <session>                           Kill a session",
      "  amux help                                     Show this help",
    ].join("\n"),
  );
}

function takeOption(args: string[], names: string[]): string | undefined {
  const index = args.findIndex((arg) => names.includes(arg));
  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${args[index]}`);
  }

  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index === -1) {
    return false;
  }

  args.splice(index, 1);
  return true;
}

function sanitizeFileSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "session";
}

function defaultScreenshotPath(session: string): string {
  const dir = "/tmp/amux/screenshots";
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(dir, `screenshot-${sanitizeFileSegment(session)}-${timestamp}.png`);
}

async function send<T = unknown>(request: ApiRequest): Promise<T> {
  const socketPath = getSocketPath();
  return await new Promise<T>((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let buffer = "";

    client.setEncoding("utf8");
    client.once("error", reject);
    client.once("connect", () => {
      client.write(`${JSON.stringify(request)}\n`);
    });
    client.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index === -1) {
        return;
      }

      const raw = buffer.slice(0, index);
      client.end();
      const response = JSON.parse(raw) as ApiResponse<T>;
      if (!response.ok) {
        reject(new Error(response.error));
        return;
      }
      resolve(response.data);
    });
  });
}

async function ensureServerRunning(): Promise<void> {
  try {
    await send({ cmd: "list" });
    return;
  } catch {
    // Start a detached daemon and wait until it is ready.
  }

  const cliPath = process.argv[1];
  const child = spawn(process.execPath, [cliPath, "start"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    try {
      await send({ cmd: "list" });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(`amux server did not start on ${getSocketPath()}`);
}

function formatOutput(response: unknown): void {
  if (
    response &&
    typeof response === "object" &&
    "lines" in response &&
    Array.isArray((response as { lines: unknown[] }).lines)
  ) {
    process.stdout.write(`${(response as { lines: string[] }).lines.join("\n")}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

async function handleDefaultAttach(): Promise<void> {
  await ensureServerRunning();
  const sessions = await send<SessionSnapshot[]>({ cmd: "list" });

  const mainSession = sessions.find((session) => session.name === "main");
  if (mainSession) {
    const hasRunningPane = mainSession.windows.some((window) => window.panes.some((pane) => pane.running));
    if (hasRunningPane) {
      await attachSession(mainSession.name);
      return;
    }
    await send({ cmd: "kill", session: mainSession.name });
  }

  if (sessions.length === 0 || (sessions.length === 1 && mainSession)) {
    const created = await send<{ session: SessionSnapshot }>({
      cmd: "create-session",
      session: "main",
      window: "main",
      exec: `exec ${getDefaultShell()}`,
      cwd: process.cwd(),
    });
    await attachSession(created.session.name);
    return;
  }

  const runningSession = sessions.find((session) =>
    session.windows.some((window) => window.panes.some((pane) => pane.running)),
  );
  const initial = runningSession ?? sessions[0];
  await attachSession(initial.name);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();

  if (!command) {
    await handleDefaultAttach();
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "status") {
    const socketPath = getSocketPath();
    try {
      const sessions = await send<SessionSnapshot[]>({ cmd: "list" });
      const running = sessions.filter(s => s.windows.some(w => w.panes.some(p => p.running)));
      const exited = sessions.filter(s => !s.windows.some(w => w.panes.some(p => p.running)));
      const totalPanes = sessions.reduce((sum, s) => sum + s.windows.reduce((ws, w) => ws + w.panes.length, 0), 0);
      console.log(`amux is running`);
      console.log(`  Socket:   ${socketPath}`);
      console.log(`  Sessions: ${sessions.length} (${running.length} active, ${exited.length} exited)`);
      console.log(`  Panes:    ${totalPanes}`);
      if (sessions.length > 0) {
        console.log("");
        for (const s of sessions) {
          const panes = s.windows.reduce((sum, w) => sum + w.panes.length, 0);
          const active = s.windows.some(w => w.panes.some(p => p.running));
          console.log(`  ${active ? "●" : "○"} ${s.name}  ${s.windows.length} window(s), ${panes} pane(s)`);
        }
      }
    } catch {
      console.log("amux is not running");
    }
    return;
  }

  if (command === "start") {
    const isDaemon = args.includes("-d") || args.includes("--daemon");

    if (isDaemon) {
      // Spawn detached background process
      const cliPath = process.argv[1];
      const child = spawn(process.execPath, [cliPath, "start"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      // Wait for socket to appear
      const socketPath = getSocketPath();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          await send({ cmd: "list" });
          console.log(`amux daemon started (pid ${child.pid})`);
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      console.error("amux daemon failed to start");
      process.exit(1);
    }

    const socketPath = getSocketPath();
    const streamPort = getStreamPortFromConfig();
    await startServer(socketPath, streamPort);
    process.stdout.write(`amux listening on ${socketPath} and ws://127.0.0.1:${streamPort}\n`);
    return await new Promise(() => undefined);
  }

  if (command === "install" || command === "uninstall") {
    const scriptName = command === "install" ? "install-bin.mjs" : "uninstall-bin.mjs";
    const scriptPath = path.resolve(path.dirname(process.argv[1]), "..", "scripts", scriptName);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath], {
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`amux ${command} failed with exit code ${code ?? 1}`));
      });
    });
    return;
  }

  if (command === "stop") {
    const socketPath = getSocketPath();
    try {
      await send({ cmd: "list" }); // check if running
      const fs = await import("node:fs");
      // Find and kill the daemon process
      const { execSync } = await import("node:child_process");
      try {
        execSync(`fuser -k ${socketPath} 2>/dev/null`, { stdio: "ignore" });
      } catch { /* ignore */ }
      try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
      console.log("amux stopped");
    } catch {
      console.log("amux is not running");
    }
    return;
  }

  if (command === "restart") {
    const socketPath = getSocketPath();
    // Stop
    try {
      const { execSync } = await import("node:child_process");
      try {
        execSync(`fuser -k ${socketPath} 2>/dev/null`, { stdio: "ignore" });
      } catch { /* ignore */ }
      const fs = await import("node:fs");
      try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1000));
    } catch { /* wasn't running */ }
    // Start as detached daemon
    const cliPath = process.argv[1];
    const child = spawn(process.execPath, [cliPath, "start"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    // Wait for ready
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5000) {
      try {
        await send({ cmd: "list" });
        console.log("amux restarted");
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    console.error("amux restart failed — daemon did not come up");
    process.exit(1);
  }

  if (command === "attach") {
    await ensureServerRunning();
    const session = takeOption(args, ["-t", "--target"]);
    if (!session) {
      throw new Error("attach requires -t <session>");
    }
    await send({ cmd: "get-session", session });
    await attachSession(session);
    return;
  }

  if (command === "stream") {
    const session = args.shift();
    if (!session) {
      throw new Error("stream requires <session>");
    }

    const paneValue = takeOption(args, ["--pane"]);
    const pane = paneValue ? Number.parseInt(paneValue, 10) : 0;
    if (Number.isNaN(pane)) {
      throw new Error("--pane must be a number");
    }
    await streamSession(session, pane);
    return;
  }

  await ensureServerRunning();

  let response: unknown;

  switch (command) {
    case "new": {
      const name = args.shift() || `s${Date.now() % 10000}`;
      const cwd = process.cwd();
      response = await send({
        cmd: "spawn",
        session: name,
        exec: getDefaultShell(),
        cwd,
      });
      // Auto-attach if running in a TTY
      if (process.stdout.isTTY) {
        console.log(JSON.stringify(response, null, 2));
        await attachSession(name);
        return;
      }
      break;
    }
    case "spawn": {
      const session = takeOption(args, ["-s", "--session"]);
      const exec = takeOption(args, ["-e", "--exec"]);
      const cwd = takeOption(args, ["--cwd"]);
      const onExit = takeOption(args, ["--on-exit"]);
      const input = takeOption(args, ["--input"]);

      if (!session || !exec) {
        throw new Error("spawn requires -s <name> and -e <command>");
      }

      response = await send({ cmd: "spawn", session, exec, cwd, onExit, input });
      break;
    }
    case "list":
      response = await send({ cmd: "list" });
      break;
    case "tail": {
      const session = args.shift();
      if (!session) {
        throw new Error("tail requires <session>");
      }

      const linesValue = takeOption(args, ["--lines"]);
      const stripAnsi = takeFlag(args, "--strip-ansi");
      response = await send({
        cmd: "tail",
        session,
        lines: linesValue ? Number.parseInt(linesValue, 10) : undefined,
        stripAnsi,
      });
      break;
    }
    case "screenshot": {
      const session = args.shift();
      if (!session) {
        throw new Error("screenshot requires <session>");
      }

      const tui = takeFlag(args, "--tui");
      const paneValue = takeOption(args, ["-p", "--pane"]);
      const output = takeOption(args, ["-o", "--output"]) ?? defaultScreenshotPath(session);
      const colsValue = takeOption(args, ["--cols"]);
      const rowsValue = takeOption(args, ["--rows"]);
      const pane = paneValue === undefined ? undefined : Number.parseInt(paneValue, 10);
      if (paneValue !== undefined && Number.isNaN(pane)) {
        throw new Error("--pane must be a number");
      }
      const cols = colsValue === undefined ? undefined : Number.parseInt(colsValue, 10);
      const rows = rowsValue === undefined ? undefined : Number.parseInt(rowsValue, 10);
      if (colsValue !== undefined && (!Number.isInteger(cols) || (cols ?? 0) <= 0)) {
        throw new Error("--cols must be a positive number");
      }
      if (rowsValue !== undefined && (!Number.isInteger(rows) || (rows ?? 0) <= 0)) {
        throw new Error("--rows must be a positive number");
      }

      if (tui) {
        const snapshot = await send<TuiScreenshotResponse>({
          cmd: "screenshot",
          session,
          tui: true,
          cols,
          rows,
        });
        const writtenPath = await renderTuiScreenshot(
          snapshot.session,
          snapshot.sessions,
          new Map(
            Object.entries(snapshot.paneScreens).map(([paneId, paneScreen]) => [Number.parseInt(paneId, 10), paneScreen]),
          ),
          output,
          {
            title: `${snapshot.session.name} TUI`,
            cols,
            rows,
          },
        );
        process.stdout.write(`${writtenPath}\n`);
        return;
      }

      const snapshot = await send<PaneScreenSnapshot>({ cmd: "screenshot", session, pane });
      const writtenPath = writeScreenshotPng(snapshot, output, { title: pane === undefined ? session : `${session} pane ${pane}` });
      process.stdout.write(`${writtenPath}\n`);
      return;
    }
    case "write": {
      const session = args.shift();
      const data = args.shift();
      if (!session || data === undefined) {
        throw new Error("write requires <session> <data>");
      }

      response = await send({ cmd: "write", session, data });
      break;
    }
    case "send-keys": {
      const session = args.shift();
      if (!session) {
        throw new Error("send-keys requires <session> <key> [<key>...]");
      }
      const keys = args.splice(0);
      if (keys.length === 0) {
        throw new Error("send-keys requires at least one key");
      }

      response = await send({ cmd: "send-keys", session, keys });
      break;
    }
    case "kill": {
      const session = args.shift();
      if (!session) {
        throw new Error("kill requires <session>");
      }

      response = await send({ cmd: "kill", session });
      break;
    }
    default:
      printUsage();
      throw new Error(`Unknown command: ${command}`);
  }

  formatOutput(response);
}

async function streamSession(session: string, pane: number): Promise<void> {
  const port = getStreamPortFromConfig();
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  socket.send(JSON.stringify({ cmd: "subscribe", session, pane }));

  await new Promise<void>((resolve, reject) => {
    socket.on("message", (chunk) => {
      const message = JSON.parse(chunk.toString("utf8")) as StreamMessage;

      switch (message.event) {
        case "output":
          process.stdout.write(message.data);
          break;
        case "exit":
          process.stderr.write(
            `\n[amux] pane ${message.session}:${message.pane} exited with code ${message.code ?? "null"} after ${message.duration}\n`,
          );
          socket.close();
          break;
        case "error":
          reject(new Error(message.message));
          socket.close();
          break;
        default:
          break;
      }
    });

    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
}

async function attachSession(
  session: string,
  options: { showSessionPicker?: boolean } = {},
): Promise<void> {
  const socketPath = getSocketPath();
  await new Promise<void>((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;

    const cleanup = (): void => {
      process.stdin.off("data", onInput);
      process.stdout.off("resize", onResize);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    };

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };

    const sendMessage = (message: Record<string, unknown>): void => {
      client.write(`${JSON.stringify(message)}\n`);
    };

    const onInput = (chunk: Buffer | string): void => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      sendMessage({ cmd: "attach-input", data: data.toString("base64") });
    };

    const onResize = (): void => {
      sendMessage({
        cmd: "attach-resize",
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
      });
    };

    const onSignal = (): void => {
      sendMessage({ cmd: "attach-detach" });
    };

    client.setEncoding("utf8");
    client.once("error", finish);
    client.once("connect", () => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();
      process.stdin.on("data", onInput);
      process.stdout.on("resize", onResize);
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      sendMessage({
        cmd: "attach-tui",
        session,
        showSessionPicker: options.showSessionPicker,
        cols: process.stdout.columns || 80,
        rows: process.stdout.rows || 24,
      });
    });
    client.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const raw = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!raw) {
          continue;
        }

        const message = JSON.parse(raw) as
          | { event: "frame"; data: string }
          | { event: "exit" }
          | { event: "error"; message: string };
        if (message.event === "frame") {
          process.stdout.write(Buffer.from(message.data, "base64").toString("utf8"));
          continue;
        }
        if (message.event === "error") {
          finish(new Error(message.message));
          client.end();
          return;
        }
        finish();
        client.end();
        return;
      }
    });
    client.once("close", () => finish());
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
