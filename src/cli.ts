#!/usr/bin/env node
import net from "node:net";
import process from "node:process";
import { WebSocket } from "ws";
import { getSocketPath, getStreamPortFromConfig, startServer } from "./server.js";
import { ApiRequest, ApiResponse, StreamMessage } from "./types.js";

function printUsage(): void {
  console.error(
    [
      "Usage:",
      "  amux start",
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

async function send(request: ApiRequest): Promise<ApiResponse> {
  const socketPath = getSocketPath();
  return await new Promise<ApiResponse>((resolve, reject) => {
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
      resolve(JSON.parse(raw) as ApiResponse);
    });
  });
}

function formatOutput(response: ApiResponse): void {
  if (!response.ok) {
    console.error(response.error);
    process.exitCode = 1;
    return;
  }

  const payload = response.data;
  if (
    payload &&
    typeof payload === "object" &&
    "lines" in payload &&
    Array.isArray((payload as { lines: unknown[] }).lines)
  ) {
    process.stdout.write(`${(payload as { lines: string[] }).lines.join("\n")}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();

  if (!command) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (command === "start") {
    const socketPath = getSocketPath();
    const streamPort = getStreamPortFromConfig();
    await startServer(socketPath, streamPort);
    process.stdout.write(`amux listening on ${socketPath} and ws://127.0.0.1:${streamPort}\n`);
    return await new Promise(() => undefined);
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

  let request: ApiRequest;

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

      request = { cmd: "spawn", session, exec, cwd, onExit, input };
      break;
    }
    case "list":
      request = { cmd: "list" };
      break;
    case "tail": {
      const session = args.shift();
      if (!session) {
        throw new Error("tail requires <session>");
      }

      const linesValue = takeOption(args, ["--lines"]);
      const stripAnsi = takeFlag(args, "--strip-ansi");
      request = {
        cmd: "tail",
        session,
        lines: linesValue ? Number.parseInt(linesValue, 10) : undefined,
        stripAnsi,
      };
      break;
    }
    case "write": {
      const session = args.shift();
      const data = args.shift();
      if (!session || data === undefined) {
        throw new Error("write requires <session> <data>");
      }

      request = { cmd: "write", session, data };
      break;
    }
    case "kill": {
      const session = args.shift();
      if (!session) {
        throw new Error("kill requires <session>");
      }

      request = { cmd: "kill", session };
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }

  const response = await send(request);
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
