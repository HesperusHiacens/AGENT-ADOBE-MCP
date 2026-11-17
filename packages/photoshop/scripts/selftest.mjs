// selftest.mjs — plays the MCP client role against index.mjs exactly like DSH does.
// initialize -> notifications/initialized -> tools/list -> tools/call ...
//
// Covers every tool, not just the happy path: drawing, filters, adjustments, masks,
// resize/crop, history, export/save/close, and a folder batch.
//
// Usage: node selftest.mjs [--out <dir>]

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// This script lives in scripts/, the server in src/.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'index.mjs');

const outIdx = process.argv.indexOf('--out');
const OUT = path.resolve(outIdx > -1 ? process.argv[outIdx + 1] : path.join(os.tmpdir(), 'ps-mcp-selftest'));
fs.mkdirSync(OUT, { recursive: true });
const p = (name) => path.join(OUT, name).split(path.sep).join('/');

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
  'ps_ping', 'ps_state', 'ps_layers', 'ps_run_jsx', 'ps_open', 'ps_new_document', 'ps_save', 'ps_export',
  'ps_resize', 'ps_crop', 'ps_filter', 'ps_adjust', 'ps_layer_mask', 'ps_place', 'ps_text',
  'ps_delete_layer', 'ps_duplicate_layer', 'ps_select_layer', 'ps_play_action', 'ps_flatten',
  'ps_history', 'ps_close', 'ps_batch',
];

const init = await rpc('initialize', {
  protocolVersion: '2026-07-28',
  capabilities: {},
  clientInfo: { name: 'photoshop-selftest', version: '1.0.0' },
});
record('initialize', init.result?.serverInfo?.name === 'photoshop', JSON.stringify(init.result?.serverInfo));
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

async function call(name, args) {
  const t0 = Date.now();
  const r = await rpc('tools/call', { name, arguments: args });
  const ms = Date.now() - t0;
  const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error);
  record(`call ${name}`, Boolean(r.result) && !r.result.isError, `${ms}ms -> ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
  return r;
}

// --- lifecycle -------------------------------------------------------------
await call('ps_ping', {});
await call('ps_new_document', { width: 1200, height: 800, dpi: 72, name: 'ps-mcp-selftest', fill: 'white' });

// --- drawing ---------------------------------------------------------------
await call('ps_run_jsx', {
  code: `
    var d = app.activeDocument;
    function rgb(h){ var c = new SolidColor(); c.rgb.hexValue = h; return c; }
    var bg = d.artLayers.add(); bg.name = "bg"; d.activeLayer = bg;
    d.selection.selectAll(); d.selection.fill(rgb("0B0D16")); d.selection.deselect();
    var box = d.artLayers.add(); box.name = "box"; d.activeLayer = box;
    d.selection.select([[100,100],[500,100],[500,400],[100,400]]);
    d.selection.fill(rgb("F59E0B")); d.selection.deselect();
    psKV({layers: d.artLayers.length});`,
  timeout_ms: 120000,
});

await call('ps_text', { text: 'ps-mcp online', name: 'headline', font_size: 64, color: 'FFFFFF', x: 90, y: 560 });
await call('ps_layers', {});
await call('ps_select_layer', { layer: 'box' });
await call('ps_duplicate_layer', { layer: 'box', name: 'box-copy' });
await call('ps_delete_layer', { layer: 'box-copy' });

// --- edits -----------------------------------------------------------------
await call('ps_filter', { filter: 'gaussian_blur', radius: 6 });
await call('ps_adjust', { adjustment: 'brightness_contrast', brightness: 10, contrast: 15 });
await call('ps_adjust', { adjustment: 'color_balance', mid_cyan: 10, mid_yellow: -10 });
await call('ps_adjust', { adjustment: 'levels', input_min: 5, input_max: 250, gamma: 1.1 });
await call('ps_adjust', { adjustment: 'photo_filter', filter_color: 'EC8A00', density: 25 });
await call('ps_adjust', { adjustment: 'curves', curve: [[0,0],[128,140],[255,255]] });
await call('ps_layer_mask', { layer: 'headline', action: 'reveal_all' });
await call('ps_resize', { width: 900, height: 600, mode: 'image' });
await call('ps_resize', { width: 1000, height: 700, mode: 'canvas', anchor: 'center' });
await call('ps_crop', { left: 0, top: 0, right: 1000, bottom: 700 });

// --- state / history -------------------------------------------------------
await call('ps_state', {});
await call('ps_history', { action: 'list' });
await call('ps_history', { action: 'undo', steps: 1 });
await call('ps_history', { action: 'redo', steps: 1 });

// --- output ----------------------------------------------------------------
await call('ps_flatten', { mode: 'flatten' });
await call('ps_export', { path: p('selftest.png'), format: 'png' });
await call('ps_save', { path: p('selftest.psd'), as_copy: true });
await call('ps_close', { save: false });

// --- batch -----------------------------------------------------------------
const batchIn = path.join(OUT, 'batch-in');
const batchOut = path.join(OUT, 'batch-out');
fs.mkdirSync(batchIn, { recursive: true });
const tints = { a: '22D3EE', b: 'F59E0B', c: '94A3B8' };
for (const name of Object.keys(tints)) {
  await call('ps_new_document', { width: 400, height: 300, dpi: 72, name: name, fill: 'white' });
  await call('ps_run_jsx', {
    code: `
      var d = app.activeDocument;
      var l = d.artLayers.add(); l.name = "tint"; d.activeLayer = l;
      var c = new SolidColor(); c.rgb.hexValue = ${JSON.stringify(tints[name])};
      d.selection.selectAll(); d.selection.fill(c); d.selection.deselect();
      psKV({ok: "true"});`,
    timeout_ms: 120000,
  });
  await call('ps_export', { path: path.join(batchIn, name + '.png').split(path.sep).join('/'), format: 'png' });
  await call('ps_close', { save: false });
}
await call('ps_batch', {
  input_dir: batchIn.split(path.sep).join('/'),
  output_dir: batchOut.split(path.sep).join('/'),
  format: 'jpg',
  quality: 9,
});

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} passed =====`);
console.log(`output dir: ${OUT}`);
child.stdin.end();
child.kill();
process.exit(failed.length ? 1 : 0);
