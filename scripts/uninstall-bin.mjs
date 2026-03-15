import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const candidates = process.platform === "darwin"
  ? ["/opt/homebrew/bin/amux", "/usr/local/bin/amux", path.join(os.homedir(), ".local", "bin", "amux")]
  : ["/usr/local/bin/amux", path.join(os.homedir(), ".local", "bin", "amux")];

let removedAny = false;

for (const candidate of candidates) {
  try {
    if (fs.existsSync(candidate)) {
      fs.unlinkSync(candidate);
      console.log(`removed ${candidate}`);
      removedAny = true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`failed to remove ${candidate}: ${message}`);
  }
}

if (!removedAny) {
  console.log("amux executable not found in standard install locations");
}
