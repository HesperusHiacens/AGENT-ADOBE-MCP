// install.mjs — register this server into a DSH / Claude Desktop / Cursor style MCP config.
// It never writes secrets and never touches a file it did not create without a backup.
//
// Usage:
//   node scripts/install.mjs --target dsh     [--config <path>] [--dry-run]
//   node scripts/install.mjs --target claude  [--config <path>] [--dry-run]
//   node scripts/install.mjs --target cursor  [--config <path>] [--dry-run]
//   node scripts/install.mjs --print          # just print the snippet for any client
//
// Targets:
//   dsh     DSH plugin list, i.e. $DSH_HOME/cordis.patch.yml (YAML, needs an `insert:` block)
//   claude  claude_desktop_config.json  (mcpServers.<name>)
//   cursor  ~/.cursor/mcp.json          (mcpServers.<name>)
//   vscode  .vscode/mcp.json            (servers.<name>)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'index.mjs');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const target = String(arg('target', 'dsh'));
const dryRun = Boolean(arg('dry-run', false));
const printOnly = Boolean(arg('print', false));
const NAME = 'photoshop';

const stdio = {
  command: process.execPath,
  args: [SERVER],
  env: { PS_TIMEOUT_MS: '120000' },
};

const snippets = {
  claude: { mcpServers: { [NAME]: stdio } },
  cursor: { mcpServers: { [NAME]: stdio } },
  vscode: { servers: { [NAME]: { type: 'stdio', ...stdio } } },
};

if (printOnly || target === 'print') {
  console.log(JSON.stringify(snippets.claude, null, 2));
  process.exit(0);
}

function defaultConfig(t) {
  const home = os.homedir();
  switch (t) {
    case 'claude':
      return process.platform === 'win32'
        ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
        : path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'cursor':
      return path.join(home, '.cursor', 'mcp.json');
    case 'vscode':
      return path.join(process.cwd(), '.vscode', 'mcp.json');
    case 'dsh': {
      // DSH_HOME wins; otherwise probe the usual locations before giving up.
      if (process.env.DSH_HOME) return path.join(process.env.DSH_HOME, 'cordis.patch.yml');
      const candidates = [
        path.join(home, '.dsh', 'cordis.patch.yml'),
        path.join(home, 'dsh', 'cordis.patch.yml'),
        path.join(home, 'AppData', 'Roaming', 'dsh', 'cordis.patch.yml'),
      ];
      const hit = candidates.find((p) => fs.existsSync(p));
      if (hit) return hit;
      throw new Error(
        'could not find the DSH config. Set DSH_HOME, or pass --config <path to cordis.patch.yml>.\n' +
          'Tried:\n  ' +
          candidates.join('\n  ')
      );
    }
    default:
      throw new Error(`unknown target: ${t} (dsh|claude|cursor|vscode|print)`);
  }
}

const cfgPath = String(arg('config', defaultConfig(target)));

function backup(p) {
  if (!fs.existsSync(p)) return null;
  const b = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(p, b);
  return b;
}

if (target === 'dsh') {
  const yaml = `- insert:
    - id: agent-photoshop-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ${NAME}
        transport: stdio
        command: ${stdio.command}
        args:
          - ${SERVER}
        toolCallTimeoutMs: 300000
        failOnStartupError: false
        reconnect:
          enabled: true
          maxAttempts: 10
`;
  if (dryRun) {
    console.log(`# would write ${cfgPath}\n${yaml}`);
    process.exit(0);
  }
  const b = backup(cfgPath);
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, yaml, 'utf8');
  console.log(`wrote ${cfgPath}`);
  if (b) console.log(`backup ${b}`);
  console.log('restart DSH (or reload plugins) to pick it up');
  process.exit(0);
}

const snippet = snippets[target];
if (!snippet) throw new Error(`unknown target: ${target}`);
const key = Object.keys(snippet)[0];
const value = snippet[key][NAME];

let cfg = {};
if (fs.existsSync(cfgPath)) {
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    throw new Error(`${cfgPath} is not valid JSON: ${e.message}`);
  }
}
cfg[key] = cfg[key] || {};
cfg[key][NAME] = value;

if (dryRun) {
  console.log(`# would write ${cfgPath}\n${JSON.stringify(cfg, null, 2)}`);
  process.exit(0);
}
const b = backup(cfgPath);
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
console.log(`wrote ${cfgPath}`);
if (b) console.log(`backup ${b}`);
console.log('restart the client to pick it up');