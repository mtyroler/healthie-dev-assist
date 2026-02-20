/**
 * Setup script: adds healthie-dev-assist to Claude Desktop's MCP config.
 * Run with: npm run setup
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";

const projectRoot = resolve(import.meta.dirname);
const serverPath = resolve(projectRoot, "src", "server.ts");

// ── Locate Claude Desktop config ──────────────────────────────────────────────

function getConfigPath(): string {
  switch (process.platform) {
    case "darwin":
      return resolve(
        homedir(),
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json"
      );
    case "win32":
      return resolve(
        process.env.APPDATA ?? resolve(homedir(), "AppData", "Roaming"),
        "Claude",
        "claude_desktop_config.json"
      );
    default:
      return resolve(
        process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"),
        "Claude",
        "claude_desktop_config.json"
      );
  }
}

// ── Read existing config ───────────────────────────────────────────────────────

const configPath = getConfigPath();
let config: Record<string, unknown> = {};

if (existsSync(configPath)) {
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    const backupPath = configPath + ".backup";
    writeFileSync(backupPath, readFileSync(configPath));
    console.error(`Could not parse existing config — backed up to ${backupPath}`);
    config = {};
  }
}

// ── Add MCP entry ─────────────────────────────────────────────────────────────

if (!config.mcpServers || typeof config.mcpServers !== "object") {
  config.mcpServers = {};
}

const mcpServers = config.mcpServers as Record<string, unknown>;

const existing = mcpServers["healthie"];
mcpServers["healthie"] = {
  command: "npx",
  args: ["tsx", serverPath],
};

// ── Write back ────────────────────────────────────────────────────────────────

const configDir = dirname(configPath);
if (!existsSync(configDir)) {
  mkdirSync(configDir, { recursive: true });
}

writeFileSync(configPath, JSON.stringify(config, null, 2));

// ── Output ────────────────────────────────────────────────────────────────────

if (existing) {
  console.log("Updated healthie entry in Claude Desktop config.");
} else {
  console.log("Added healthie entry to Claude Desktop config.");
}
console.log(`Config: ${configPath}`);

if (!existsSync(resolve(projectRoot, ".env"))) {
  console.log("\nNext: copy .env.example to .env and add your HEALTHIE_API_KEY");
} else if (!existsSync(resolve(projectRoot, "schemas"))) {
  console.log("\nNext: run `npm run regenerate-schema` to download the schema");
} else {
  console.log("\nRestart Claude Desktop to apply changes.");
}
