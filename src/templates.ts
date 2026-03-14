import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SessionManager } from "./core.js";

const TEMPLATES_DIR = join(homedir(), ".amux", "templates");

export interface TemplatePaneConfig {
  exec: string;
  cwd?: string;
}

export interface TemplateWindowConfig {
  name: string;
  panes: TemplatePaneConfig[];
}

export interface SessionTemplate {
  name: string;
  windows: TemplateWindowConfig[];
}

function ensureTemplatesDir(): void {
  mkdirSync(TEMPLATES_DIR, { recursive: true });
}

function templatePath(name: string): string {
  const safeName = name.replace(/[^a-z0-9._-]/gi, "-");
  return join(TEMPLATES_DIR, `${safeName}.json`);
}

/**
 * Save the current session layout as a template.
 */
export function saveTemplate(templateName: string, sessionName: string): SessionTemplate {
  const manager = SessionManager.getInstance();
  const session = manager.getSession(sessionName);

  const template: SessionTemplate = {
    name: templateName,
    windows: session.listWindows().map((w) => ({
      name: w.name,
      panes: w.listPanes().map((p) => ({
        exec: p.command,
        cwd: p.cwd,
      })),
    })),
  };

  ensureTemplatesDir();
  writeFileSync(templatePath(templateName), JSON.stringify(template, null, 2) + "\n", "utf-8");
  return template;
}

/**
 * Apply a template to create a new session.
 */
export function applyTemplate(
  templateName: string,
): { sessionName: string; template: SessionTemplate } {
  const template = loadTemplate(templateName);
  const manager = SessionManager.getInstance();
  const sessionName = `${template.name}-${Date.now()}`;
  const session = manager.createSession(sessionName);

  for (const windowConfig of template.windows) {
    const window = session.createWindow(windowConfig.name);
    for (const paneConfig of windowConfig.panes) {
      window.createSessionBoundPane(sessionName, {
        command: paneConfig.exec,
        cwd: paneConfig.cwd,
      });
    }
  }

  return { sessionName, template };
}

/**
 * Load a template from disk.
 */
export function loadTemplate(name: string): SessionTemplate {
  const filePath = templatePath(name);
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as SessionTemplate;
  } catch {
    throw new Error(`Template "${name}" not found`);
  }
}

/**
 * List all available templates.
 */
export function listTemplates(): string[] {
  ensureTemplatesDir();
  try {
    return readdirSync(TEMPLATES_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}
