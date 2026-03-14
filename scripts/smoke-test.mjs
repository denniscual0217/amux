import { SessionManager } from "../dist/core.js";

const manager = SessionManager.getInstance();
const sessionName = `smoke-${Date.now()}`;
const { pane } = manager.spawnInSession(sessionName, {
  command: "echo hello",
});

const deadline = Date.now() + 3000;

while (Date.now() < deadline) {
  if (pane.exitCode !== null) {
    break;
  }

  await new Promise((resolve) => setTimeout(resolve, 100));
}

const lines = pane.tail(10, true);

if (!lines.some((line) => line.includes("hello"))) {
  console.error(`Smoke test failed. Output: ${JSON.stringify(lines)}`);
  process.exit(1);
}

console.log(JSON.stringify({ session: sessionName, lines, exitCode: pane.exitCode }, null, 2));
