import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const packageRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cliPath = path.join(packageRoot, "dist", "cli.js");
const nodePath = process.execPath;

const preferredTargets = process.platform === "darwin"
  ? ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin")]
  : ["/usr/local/bin", path.join(os.homedir(), ".local", "bin")];

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function pickTargetDir() {
  const writable = preferredTargets.find((dir) => canWrite(dir));
  if (writable) {
    return { dir: writable, writable: true };
  }
  return { dir: preferredTargets[0], writable: false };
}

function wrapperContents() {
  return `#!/bin/sh
exec "${nodePath}" "${cliPath}" "$@"
`;
}

const target = pickTargetDir();
const targetPath = path.join(target.dir, "amux");

if (!fs.existsSync(cliPath)) {
  console.error(`amux build output not found: ${cliPath}`);
  console.error("Run `npm run build` first.");
  process.exit(1);
}

if (!target.writable) {
  console.error(`Cannot write to ${target.dir}`);
  console.error(`Create the executable manually with:`);
  console.error(`sudo mkdir -p ${target.dir}`);
  console.error(`sudo sh -c 'cat > ${targetPath} <<\"EOF\"\n${wrapperContents()}EOF\nchmod 755 ${targetPath}'`);
  process.exit(1);
}

fs.writeFileSync(targetPath, wrapperContents(), { mode: 0o755 });
fs.chmodSync(targetPath, 0o755);

console.log(`installed amux to ${targetPath}`);

if (!process.env.PATH?.split(":").includes(target.dir)) {
  console.log(`warning: ${target.dir} is not on PATH for this shell`);
}
