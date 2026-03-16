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

const interactiveSessionName = `smoke-input-${Date.now()}`;
const { pane: interactivePane } = manager.spawnInSession(interactiveSessionName, {
  command: "bash",
});

interactivePane.write("echo interactive hello\n");

const interactiveDeadline = Date.now() + 3000;

while (Date.now() < interactiveDeadline) {
  const interactiveLines = interactivePane.tail(20, true);
  if (interactiveLines.some((line) => line.includes("interactive hello"))) {
    console.log(JSON.stringify({ session: interactiveSessionName, lines: interactiveLines }, null, 2));
    process.exit(0);
  }

  await new Promise((resolve) => setTimeout(resolve, 100));
}

console.error(`Interactive smoke test failed. Output: ${JSON.stringify(interactivePane.tail(20, true))}`);
process.exit(1);
