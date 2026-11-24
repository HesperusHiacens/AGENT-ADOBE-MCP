// pr-selftest.mjs — plays the MCP client role against pr-index.mjs, the way a host does.
//
// Requires Premiere Pro to be running with the AGENT-ADOBE-MCP Bridge panel open
// (Window > Extensions > AGENT-ADOBE-MCP Bridge). The panel owns the TCP socket the
// server talks to, so nothing works until that panel is open.
//
// Usage: node pr-selftest.mjs [--preset <path>] [--media <path>]

import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// This script lives in scripts/, the server in src/.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'index.mjs');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// Find a 1080p preset on this install rather than hardcoding a vendor path.
// Premiere is frequently installed outside Program Files (any drive, any folder
// name), so ask the uninstall registry where it went before guessing.
function installRoots() {
  const roots = [];
  if (process.env.PR_PRESETS) roots.push(process.env.PR_PRESETS);
  try {
    const ps = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Premiere*' -and $_.InstallLocation } | Select-Object -ExpandProperty InstallLocation",
      ],
      { encoding: 'utf8', timeout: 20000, windowsHide: true }
    );
    for (const line of ps.split(/\r?\n/)) {
      const loc = line.trim();
      if (!loc) continue;
      // InstallLocation points at the vendor folder; the app folder sits under it.
      for (const name of ['Adobe Premiere Pro 2026', 'Adobe Premiere Pro 2025', 'Adobe Premiere Pro']) {
        roots.push(path.join(loc, name, 'Settings/SequencePresets'));
        roots.push(path.join(loc.replace(/[\\/]$/, ''), name, 'Settings/SequencePresets'));
      }
      roots.push(path.join(loc, 'Settings/SequencePresets'));
    }
  } catch {
    // No registry, not Windows, or PowerShell unavailable — fall through to guesses.
  }
  for (const base of ['C:/Program Files/Adobe', 'D:/Program Files/Adobe', 'D:/adobe', 'C:/adobe', 'E:/adobe']) {
    for (const name of ['Adobe Premiere Pro 2026', 'Adobe Premiere Pro 2025']) {
      roots.push(path.join(base, name, 'Settings/SequencePresets'));
    }
  }
  return [...new Set(roots.filter(Boolean))];
}

function findPreset() {
  const roots = installRoots();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const hit = [];
    (function walk(dir) {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.sqpreset') && /1080p/i.test(e.name)) hit.push(full);
      }
    })(root);
    if (hit.length) return hit.sort((a, b) => a.length - b.length)[0];
  }
  return null;
}

const PRESET = arg('preset', findPreset() || '');
const MEDIA = arg('media', path.join(ROOT, '..', '..', 'assets', 'photoshop.png'));
const OUT = path.join(os.tmpdir(), 'agent-adobe-mcp-premiere-selftest');

fs.mkdirSync(OUT, { recursive: true });

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

let buf = '';
const pending = new Map();
let seq = 0;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log('[noise]', line.slice(0, 200));
      continue;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => d.trim() && console.log('[server] ' + d.trim()));

function rpc(method, params, timeoutMs = 300000) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error('rpc timeout ' + method));
    }, timeoutMs);
    pending.set(id, {
      resolve: (m) => {
        clearTimeout(t);
        resolve(m);
      },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}  ${detail ?? ''}`);
}

const EXPECTED = [
  'pr_ping', 'pr_state', 'pr_list_sequences', 'pr_list_media', 'pr_list_tracks',
  'pr_run_jsx', 'pr_new_sequence', 'pr_import', 'pr_add_to_timeline',
  'pr_export', 'pr_save_project',
];

const init = await rpc('initialize', {
  protocolVersion: '2026-07-28',
  capabilities: {},
  clientInfo: { name: 'premiere-selftest', version: '1.0.0' },
});
record('initialize', init.result?.serverInfo?.name === 'premiere', JSON.stringify(init.result?.serverInfo));
notify('notifications/initialized', {});

const list = await rpc('tools/list', {});
const names = (list.result?.tools || []).map((t) => t.name);
const missing = EXPECTED.filter((n) => !names.includes(n));
const extra = names.filter((n) => !EXPECTED.includes(n));
record(
  'tools/list',
  missing.length === 0 && extra.length === 0,
  `${names.length} tools${missing.length ? ' missing: ' + missing.join(',') : ''}${extra.length ? ' unexpected: ' + extra.join(',') : ''}`
);

async function call(name, args, showLen = 200) {
  const t0 = Date.now();
  const r = await rpc('tools/call', { name, arguments: args });
  const ms = Date.now() - t0;
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error);
  record(`call ${name}`, Boolean(r.result) && !r.result.isError, `${ms}ms -> ${text.replace(/\s+/g, ' ').slice(0, showLen)}`);
  return r.result?.structuredContent;
}

// --- read state -------------------------------------------------------------
await call('pr_ping', {});
await call('pr_state', {});
await call('pr_list_sequences', {});
await call('pr_list_media', { limit: 20 });

// --- escape hatch -----------------------------------------------------------
await call('pr_run_jsx', {
  code: 'prKV({version: app.version, project: app.project ? app.project.name : ""});',
});

// --- sequence: the QE route needs an explicit preset ------------------------
if (!PRESET) {
  record('call pr_new_sequence', false, 'no .sqpreset found — pass --preset <path>');
}
const seqName = 'PR-SELFTEST-' + Date.now().toString().slice(-6);
const created = PRESET
  ? await call('pr_new_sequence', { name: seqName, preset_path: PRESET })
  : null;

if (created) {
  await call('pr_list_sequences', {});
  await call('pr_list_tracks', {});

  // --- media: import then place on the timeline -----------------------------
  if (fs.existsSync(MEDIA)) {
    const imported = await call('pr_import', { path: MEDIA });
    if (imported) {
      await call('pr_add_to_timeline', { item: path.basename(MEDIA), track: 0, time: 0 });
      await call('pr_list_tracks', {});
    }
  } else {
    record('call pr_import', false, `test media missing: ${MEDIA}`);
  }
}

// --- save -------------------------------------------------------------------
await call('pr_save_project', {});

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} passed =====`);
if (failed.length) console.log('failed: ' + failed.map((f) => f.step).join(', '));
child.stdin.end();
child.kill();
process.exit(failed.length ? 1 : 0);
