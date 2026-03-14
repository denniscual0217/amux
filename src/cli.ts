#!/usr/bin/env node
import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";
import { WebSocket } from "ws";
import { getDefaultShell } from "./core.js";
import { getSocketPath, getStreamPortFromConfig, startServer } from "./server.js";
import { attachTui } from "./tui/app.js";
import { ApiRequest, ApiResponse, SessionSnapshot, StreamMessage } from "./types.js";

function printUsage(): void {
  console.error(
    [
      "Usage:",
      "  amux",
      "  amux start",
      "  amux attach -t <session>",
      "  amux spawn -s <name> -e <command> [--cwd dir] [--on-exit url] [--input text]",
      "  amux list",
      "  amux tail <session> [--lines N] [--strip-ansi]",
      "  amux stream <session> [--pane N]",
      "  amux write <session> <data>",
      "  amux kill <session>",
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

  if (sessions.length === 0) {
    const created = await send<{ session: SessionSnapshot }>({
      cmd: "create-session",
      session: "main",
      window: "main",
      exec: `exec ${getDefaultShell()}`,
    });
    await attachTui(created.session.name);
    return;
  }

  const initial = sessions[0];
  await attachTui(initial.name, { showSessionPicker: true });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();

  if (!command) {
    await handleDefaultAttach();
    return;
  }

  if (command === "start") {
    const socketPath = getSocketPath();
    const streamPort = getStreamPortFromConfig();
    await startServer(socketPath, streamPort);
    process.stdout.write(`amux listening on ${socketPath} and ws://127.0.0.1:${streamPort}\n`);
    return await new Promise(() => undefined);
  }

  if (command === "attach") {
    await ensureServerRunning();
    const session = takeOption(args, ["-t", "--target"]);
    if (!session) {
      throw new Error("attach requires -t <session>");
    }
    await send({ cmd: "get-session", session });
    await attachTui(session);
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
    case "write": {
      const session = args.shift();
      const data = args.shift();
      if (!session || data === undefined) {
        throw new Error("write requires <session> <data>");
      }

      response = await send({ cmd: "write", session, data });
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

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
