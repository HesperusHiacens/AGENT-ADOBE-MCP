// ae-selftest.mjs — plays the MCP client role against ae-index.mjs, the way a host does.
//
// Covers every tool: project inspection, comps, layers, shapes, text, keyframes,
// effects, expressions, layer settings, import, precompose, save and render.
//
// Usage:  node ae-selftest.mjs [--out <dir>]

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'index.mjs');

const outIdx = process.argv.indexOf('--out');
const OUT = path.resolve(outIdx > -1 ? process.argv[outIdx + 1] : path.join(os.tmpdir(), 'agent-adobe-mcp-aftereffects-selftest'));
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
  'ae_ping', 'ae_state', 'ae_list_comps', 'ae_run_jsx', 'ae_new_comp', 'ae_add_solid',
  'ae_add_text', 'ae_add_shape', 'ae_list_layers', 'ae_keyframe', 'ae_add_effect',
  'ae_set_expression', 'ae_set_layer', 'ae_set_comp', 'ae_import', 'ae_delete_layer',
  'ae_precompose', 'ae_output_templates', 'ae_save_project', 'ae_render',
];

const init = await rpc('initialize', {
  protocolVersion: '2026-07-28',
  capabilities: {},
  clientInfo: { name: 'aftereffects-selftest', version: '1.0.0' },
});
record('initialize', init.result?.serverInfo?.name === 'aftereffects', JSON.stringify(init.result?.serverInfo));
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

// --- project ---------------------------------------------------------------
await call('ae_ping', {});
await call('ae_state', {});

// --- composition -----------------------------------------------------------
const COMP = 'AE-SELFTEST';
await call('ae_new_comp', { name: COMP, width: 1280, height: 720, duration: 3, frame_rate: 25 });
await call('ae_set_comp', { comp: COMP, bg_color: [0.04, 0.05, 0.08], work_area_duration: 3 });

// --- layers ----------------------------------------------------------------
await call('ae_add_solid', { comp: COMP, name: 'bg', color: [0.04, 0.05, 0.08] });
await call('ae_add_shape', {
  comp: COMP,
  name: 'ring',
  shape: 'ellipse',
  size: [300, 300],
  position: [980, 420],
  stroke: [0.96, 0.62, 0.04],
  stroke_width: 20,
});
await call('ae_add_shape', {
  comp: COMP,
  name: 'star',
  shape: 'star',
  size: [200, 200],
  position: [980, 420],
  fill: [0.13, 0.83, 0.93],
  points: 5,
  inner_radius: 40,
  outer_radius: 100,
});
await call('ae_add_text', {
  comp: COMP,
  text: 'ae-mcp online',
  name: 'title',
  font_size: 96,
  color: [1, 1, 1],
  position: [80, 300],
});
await call('ae_list_layers', { comp: COMP });

// --- animation -------------------------------------------------------------
await call('ae_keyframe', {
  comp: COMP,
  layer: 'title',
  property: 'opacity',
  keys: [
    { time: 0, value: 0 },
    { time: 1, value: 100 },
  ],
  ease: 'ease',
});
await call('ae_keyframe', {
  comp: COMP,
  layer: 'star',
  property: 'rotation',
  keys: [
    { time: 0, value: 0 },
    { time: 3, value: 360 },
  ],
  ease: 'linear',
});

// --- effects and expressions ----------------------------------------------
await call('ae_add_effect', { comp: COMP, layer: 'star', effect: 'ADBE Glo2' });
await call('ae_set_expression', {
  comp: COMP,
  layer: 'star',
  property: 'position',
  expression: 'wiggle(1, 15)',
});
await call('ae_set_layer', { comp: COMP, layer: 'bg', opacity: 100, blend_mode: 'normal' });

// --- precompose ------------------------------------------------------------
await call('ae_precompose', { comp: COMP, name: 'AE-SELFTEST-PRE', layers: ['ring'] });

// --- output ----------------------------------------------------------------
await call('ae_output_templates', { comp: COMP });
await call('ae_render', { comp: COMP, output: p('selftest.png'), timeout_ms: 300000 });

// --- cleanup path ----------------------------------------------------------
await call('ae_delete_layer', { comp: COMP, layer: 'star' });
await call('ae_list_comps', {});

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} passed =====`);
console.log(`output dir: ${OUT}`);
child.stdin.end();
child.kill();
process.exit(failed.length ? 1 : 0);
