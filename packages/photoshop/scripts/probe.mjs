// probe.mjs — bypass the MCP layer and talk to src/bridge.ps1 directly.
// Useful when you want to know whether a problem is in Photoshop/COM or in the server.
//
// Usage:  node scripts/probe.mjs [--out <dir>]

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(ROOT, 'src', 'bridge.ps1');

const outIdx = process.argv.indexOf('--out');
const OUT = path.resolve(outIdx > -1 ? process.argv[outIdx + 1] : path.join(os.tmpdir(), 'agent-photoshop-mcp-probe'));
fs.mkdirSync(OUT, { recursive: true });

const POWERSHELL =
  process.env.PS_POWERSHELL ||
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const PROGID = process.env.PS_PROGID || 'Photoshop.Application';

const PRELUDE = `
function psKV(o){var s="",k,v;for(k in o){if(o.hasOwnProperty(k)){v=o[k];if(v===null||v===undefined){v="";}
s+=k+"="+String(v).replace(/[\\r\\n]+/g,"\\\\n")+"\\n";}}return s;}
`;

const child = spawn(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BRIDGE, '-ProgId', PROGID], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let buf = '';
const waiters = new Map();
let readyResolve;
const ready = new Promise((r) => (readyResolve = r));

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.log('[bridge-noise]', line);
      continue;
    }
    if (msg.type === 'ready') {
      readyResolve(msg);
      continue;
    }
    const w = waiters.get(msg.id);
    if (w) {
      waiters.delete(msg.id);
      w(msg);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => process.stderr.write('[ps-stderr] ' + d));

function parseKv(s) {
  const out = {};
  for (const line of String(s || '').split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i)] = line.slice(i + 1).replace(/\\n/g, '\n');
  }
  return out;
}

let seq = 0;
function call(jsx, timeoutMs = 120000) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error('timeout ' + timeoutMs + 'ms'));
    }, timeoutMs);
    waiters.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.ok) msg.parsed = parseKv(msg.result);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ id, jsx: PRELUDE + jsx }) + '\n');
  });
}

const t0 = Date.now();
const r = await ready;
console.log('READY', JSON.stringify(r), `(${Date.now() - t0}ms)`);
if (!r.ok) process.exit(1);

let t = Date.now();
console.log('T1 (read)', JSON.stringify(await call(`psKV({app: app.name, version: app.version, docs: app.documents.length, locale: $.locale});`, 60000)), `(${Date.now() - t}ms)`);

const pngPath = path.join(OUT, 'probe.png').split(path.sep).join('/');
t = Date.now();
console.log(
  'T2 (write)',
  JSON.stringify(
    await call(
      `
var prev = app.displayDialogs;
app.displayDialogs = DialogModes.NO;
var out = {};
try {
  var d = app.documents.add(1200, 630, 72, "agent-photoshop-mcp-probe", NewDocumentMode.RGB, DocumentFill.WHITE);
  function rgb(hex){ var c = new SolidColor(); c.rgb.hexValue = hex; return c; }
  var bg = d.artLayers.add(); bg.name = "bg"; d.activeLayer = bg;
  d.selection.selectAll(); d.selection.fill(rgb("11141C")); d.selection.deselect();
  var t = d.artLayers.add();
  t.kind = LayerKind.TEXT; t.name = "headline";
  t.textItem.contents = "bridge ok";
  t.textItem.size = 96;
  t.textItem.color = rgb("FFFFFF");
  t.textItem.position = [UnitValue(80, "px"), UnitValue(240, "px")];
  var outPath = new File("${pngPath}");
  d.saveAs(outPath, new PNGSaveOptions(), true, Extension.LOWERCASE);
  var names = [];
  for (var i = 0; i < d.artLayers.length; i++) names.push(d.artLayers[i].name + ":" + d.artLayers[i].kind);
  out = {
    name: d.name, w: d.width.as("px"), h: d.height.as("px"),
    layers: names.join(","), saved: outPath.fsName,
    exists: outPath.exists, bytes: outPath.exists ? outPath.length : 0
  };
  d.close(SaveOptions.DONOTSAVECHANGES);
} catch (e) {
  out = { failed: e.message, line: e.line };
}
app.displayDialogs = prev;
psKV(out);`,
      180000
    )
  ),
  `(${Date.now() - t}ms)`
);

t = Date.now();
console.log('T3 (reuse connection)', JSON.stringify(await call('psKV({docs: app.documents.length});', 30000)), `(${Date.now() - t}ms)`);
console.log(`output dir: ${OUT}`);

child.stdin.end();
child.kill();