#!/usr/bin/env node
// ae-mcp — an MCP (stdio) server that drives a local Adobe After Effects on Windows.
//
// After Effects exposes no usable COM scripting surface: the AfterEffects.Project.26
// ProgID resolves to a bare IDispatch with no members. Automation therefore goes through
// the ExtendScript entry point:
//
//   AfterFX.exe -r <runner.jsx>
//
// Measured on After Effects 26.0: ~700 ms when AE is already running (the flag injects
// into the live process) versus ~12 s when AE has to start first.
//
// `-r` gives the script no stdout, no argv, and no environment inherited from the caller,
// and $.fileName does not reliably point at the file just handed to it once AE is live.
// So every call gets its own directory and a runner with the job and result paths baked
// in as absolute strings. The runner evals the job and writes key=value lines back.
//
// Zero third-party dependencies. Node 18+.

import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const AE_EXE = process.env.AE_EXE || findAeExe();
const DEFAULT_TIMEOUT = Number(process.env.AE_TIMEOUT_MS || 180000);
const COLD_START_TIMEOUT = Number(process.env.AE_COLD_START_TIMEOUT_MS || 180000);
const POLL_MS = 80;
// How long to wait before checking whether AE is stuck on a dialog rather than starting.
const STUCK_AFTER_MS = Number(process.env.AE_STUCK_AFTER_MS || 20000);
// Consecutive unchanged memory samples that mean "frozen on a dialog", not "still loading".
const FROZEN_SAMPLES = Number(process.env.AE_FROZEN_SAMPLES || 3);
// Gap between memory samples; FROZEN_SAMPLES x this is how long memory must sit still.
const PROBE_EVERY_MS = Number(process.env.AE_PROBE_EVERY_MS || 8000);

const log = (...a) => process.stderr.write('[ae-mcp] ' + a.join(' ') + '\n');

function findAeExe() {
  const candidates = [];
  const roots = [process.env.ProgramFiles || 'C:\\Program Files', 'C:\\Program Files', 'D:\\', 'E:\\'];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^Adobe After Effects/i.test(entry.name)) continue;
      candidates.push(path.join(root, entry.name, 'Support Files', 'AfterFX.exe'));
      candidates.push(path.join(root, entry.name, 'AfterFX.exe'));
    }
  }
  // Flat vendor layouts: <root>/<vendor folder>/Adobe After Effects <year>/Support Files
  for (const root of ['D:\\', 'E:\\', 'C:\\']) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^(AE|AfterEffects)/i.test(entry.name)) continue;
      let sub = [];
      try {
        sub = fs.readdirSync(path.join(root, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of sub) {
        if (s.isDirectory() && /^Adobe After Effects/i.test(s.name)) {
          candidates.push(path.join(root, entry.name, s.name, 'Support Files', 'AfterFX.exe'));
        }
      }
    }
  }
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

const PRELUDE = `
function aeKV(o){var s="",k,v;for(k in o){if(o.hasOwnProperty(k)){v=o[k];if(v===null||v===undefined){v="";}
s+=k+"="+String(v).replace(/[\\r\\n]+/g,"\\\\n")+"\\n";}}return s;}
function aeEsc(v){return String(v).replace(/[\\r\\n]+/g,"\\\\n");}
`;

const RUNNER_BODY = `(function () {
  var jobPath = "@@JOB@@";
  var resPath = "@@RES@@";
  var res = new File(resPath);
  res.encoding = "UTF-8";

  function write(okFlag, payload) {
    res.open("w");
    res.write("ok=" + okFlag + "\\n");
    if (payload) {
      for (var k in payload) {
        if (payload.hasOwnProperty(k)) {
          res.write(k + "=" + String(payload[k]).replace(/[\\r\\n]+/g, "\\\\n") + "\\n");
        }
      }
    }
    res.close();
  }

  var job = new File(jobPath);
  if (!job.exists) { write("false", { error: "job file missing", line: "" }); return; }

  var body = null;
  try { if (job.open("r")) body = job.read(); } catch (e) {
    write("false", { error: "cannot read job: " + e.toString(), line: e.line || "" }); return;
  }
  try { job.close(); } catch (e) {}

  if (body === null) { write("false", { error: "job file empty", line: "" }); return; }

  var out = null;
  try {
    out = eval(body);
  } catch (e) {
    write("false", { error: e.toString(), line: e.line || "" });
    return;
  }

  if (out === null || out === undefined) write("true", { result: "" });
  else if (typeof out === "object") write("true", out);
  else write("true", { result: String(out) });
})();
`;

function parseKv(text) {
  const out = {};
  // ExtendScript File.write in text mode emits CRLF; normalise before splitting,
  // otherwise every value keeps a trailing \r and 'ok=true' never matches.
  for (const line of String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i)] = line.slice(i + 1).replace(/\\n/g, '\n');
  }
  return out;
}

const num = (v) => (v === '' || v === undefined || v === null ? null : Number(v));
const bool = (v) => String(v).toLowerCase() === 'true';
const q = (v) => JSON.stringify(v);

const JOBS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-'));
let jobSeq = 0;

function runJobOnce(jsx, timeoutMs) {
  const dir = path.join(JOBS_ROOT, 'job-' + ++jobSeq);
  fs.mkdirSync(dir, { recursive: true });

  const jobFile = path.join(dir, 'job.jsx');
  const resFile = path.join(dir, 'result.txt');
  const runnerFile = path.join(dir, 'runner.jsx');

  fs.writeFileSync(jobFile, PRELUDE + jsx, 'utf8');
  fs.writeFileSync(
    runnerFile,
    RUNNER_BODY.replace('@@JOB@@', jobFile.split(path.sep).join('/')).replace(
      '@@RES@@',
      resFile.split(path.sep).join('/')
    ),
    'utf8'
  );

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(AE_EXE, ['-r', runnerFile], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return reject(e);
    }

    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (e) => reject(new Error(`could not start After Effects: ${e.message}`)));

    const started = Date.now();
    let done = false;
    let stuckChecked = false;
    let lastMem = 0;
    let frozenSamples = 0;
    let lastProbe = 0;
    let autoDismissed = false;

    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      fn(arg);
    };

    // After any previous crash, After Effects opens a "Crash Repair Options" dialog and
    // waits for a click indefinitely. The process is alive but has no window title, which
    // looks exactly like a slow start — except it never finishes. Every ae_* call then
    // burns the full timeout and the caller restarts AE, which shows the dialog again:
    // a loop that looks like AE crashing repeatedly. Detect it once, mid-wait, and say so.
    const aeState = () => {
      try {
        const out = execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            "$p = Get-Process AfterFX -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { Write-Output ('' + $p.WorkingSet64 + '|' + $p.MainWindowTitle) } else { Write-Output '0|' }",
          ],
          { encoding: 'utf8', timeout: 10000, windowsHide: true }
        ).trim();
        const [mem, title] = out.split('|');
        return { mem: Number(mem) || 0, title: (title || '').trim() };
      } catch {
        return null;
      }
    };

    // Premiere has no dialog like this; After Effects has two, and both block forever:
    // the "Crash Repair Options" dialog and a "Save changes?" prompt. Both are modal with
    // the default button focused, so focusing the window and pressing Enter answers them.
    // Doing it here means a caller never has to know they exist.
    const dismissDialog = () => {
      try {
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            [
              "Add-Type -AssemblyName System.Windows.Forms",
              "$sig = '[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int n);'",
              'Add-Type -MemberDefinition $sig -Name AeWin -Namespace Ae -ErrorAction SilentlyContinue',
              '$p = Get-Process AfterFX -ErrorAction SilentlyContinue | Select-Object -First 1',
              'if ($p) {',
              '  [Ae.AeWin]::ShowWindow($p.MainWindowHandle, 9) | Out-Null',
              '  [Ae.AeWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null',
              '  Start-Sleep -Milliseconds 500',
              "  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
              "  Write-Output 'sent'",
              '}',
            ].join('; '),
          ],
          { encoding: 'utf8', timeout: 25000, windowsHide: true }
        );
        return true;
      } catch {
        return false;
      }
    };

    const poll = setInterval(() => {
      let text;
      try {
        text = fs.readFileSync(resFile, 'utf8');
      } catch {
        // No result yet. Two states look identical from outside (process alive, no window
        // title) but mean opposite things:
        //   starting  — memory climbs on every sample, so keep waiting
        //   dialog    — memory is frozen, because AE is waiting on a click
        // Early on, AE legitimately takes 60-120 s and sits at ~155 MB, so the memory
        // trend is the only honest signal.
        const nowMs = Date.now();
        const probeDue = nowMs - started > STUCK_AFTER_MS && nowMs - lastProbe >= PROBE_EVERY_MS;
        if (!stuckChecked && probeDue) {
          lastProbe = nowMs;
          const snap = aeState();
          if (snap && snap.mem > 0) {
            if (snap.mem === lastMem) frozenSamples++;
            else {
              frozenSamples = 0;
              lastMem = snap.mem;
            }
            if (frozenSamples >= FROZEN_SAMPLES && snap.title === '') {
              // Frozen with no window: a modal dialog is up. Answer it and keep waiting —
              // once. If it freezes again after that, something else is wrong, and saying so
              // is more useful than pressing Enter forever.
              if (!autoDismissed) {
                autoDismissed = true;
                log('After Effects is waiting on a dialog, answering it');
                dismissDialog();
                frozenSamples = 0;
                lastMem = 0;
              } else {
                stuckChecked = true;
                return finish(
                  reject,
                  new Error(
                    'After Effects is frozen with no window even after its dialog was dismissed ' +
                      '(memory stuck at ' +
                      Math.round(snap.mem / 1048576) +
                      ' MB). Open After Effects and look at it — something is blocking startup, ' +
                      'and every ae_* call will time out until it is cleared.'
                  )
                );
              }
            }
          }
        }
        return;
      }
      if (!/^ok=(true|false)$/m.test(text.replace(/\r/g, ''))) return;
      const r = parseKv(text);
      if (r.ok !== 'true') {
        const err = new Error(r.error || 'After Effects script failed (no message)');
        if (r.line) err.aeLine = r.line;
        return finish(reject, err);
      }
      delete r.ok;
      // A job that ends with aeKV({...}) returns a string of key=value lines; unwrap it
      // so callers see the fields instead of one opaque "result" entry.
      if (typeof r.result === 'string' && r.result.indexOf('=') > 0 && Object.keys(r).length === 1) {
        const inner = parseKv(r.result.replace(/\\n/g, '\n'));
        Object.assign(r, inner);
        delete r.result;
      }
      r._ms = Date.now() - started;
      finish(resolve, r);
    }, POLL_MS);

    const timer = setTimeout(() => {
      const noise = stderr.replace(/SPL-LOG-\d+:.*$/gm, '').trim().slice(0, 300);
      finish(
        reject,
        new Error(
          `After Effects did not answer within ${timeoutMs}ms` +
            (noise ? ` (${noise})` : '') +
            ' — a modal dialog may be open, or AE is still starting'
        )
      );
    }, timeoutMs);
  });
}

// After Effects is single-threaded and -r injects into one shared process, so calls are
// serialized: two jobs running at once would overwrite each other's results.
let queue = Promise.resolve();
function runJob(jsx, timeoutMs = DEFAULT_TIMEOUT) {
  const next = queue.then(
    () => runJobOnce(jsx, timeoutMs),
    () => runJobOnce(jsx, timeoutMs)
  );
  queue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

const FIND_COMP = `
function findComp(n) {
  if (!n) {
    var a = app.project.activeItem;
    if (a && a instanceof CompItem) return a;
    throw new Error("no active composition - pass comp explicitly");
  }
  for (var i = 1; i <= app.project.numItems; i++) {
    var it = app.project.item(i);
    if (it instanceof CompItem && it.name === n) return it;
  }
  throw new Error("composition not found: " + n);
}
`;

const TOOLS = [
  {
    name: 'ae_ping',
    description:
      'Check that After Effects is reachable. Returns version, language, project path and item count. The first call after AE has been closed pays a ~12 s cold start; later calls are ~0.7 s.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await runJob(
        `aeKV({
          version: app.version,
          build: app.buildName,
          language: app.isoLanguage,
          project: app.project.file ? app.project.file.fsName : "",
          items: app.project.numItems
        });`,
        COLD_START_TIMEOUT
      );
      return {
        version: r.version,
        build: r.build,
        language: r.language,
        project: r.project || null,
        items: num(r.items),
        elapsedMs: r._ms,
      };
    },
  },
  {
    name: 'ae_state',
    description:
      'Describe the open project: path, item count, composition count, and the active composition if one is open.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await runJob(`aeKV({
        project: app.project.file ? app.project.file.fsName : "",
        items: app.project.numItems,
        comps: (function () { var n = 0; for (var i = 1; i <= app.project.numItems; i++) { if (app.project.item(i) instanceof CompItem) n++; } return n; })(),
        activeComp: (app.project.activeItem && app.project.activeItem instanceof CompItem) ? app.project.activeItem.name : ""
      });`);
      return {
        project: r.project || null,
        items: num(r.items),
        compositions: num(r.comps),
        activeComposition: r.activeComp || null,
        elapsedMs: r._ms,
      };
    },
  },
  {
    name: 'ae_list_comps',
    description: 'List every composition in the project with size, duration, frame rate and layer count.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await runJob(`
        var rows = [];
        for (var i = 1; i <= app.project.numItems; i++) {
          var it = app.project.item(i);
          if (it instanceof CompItem) {
            rows.push([aeEsc(it.name), it.width, it.height, it.duration, it.frameRate, it.numLayers].join("~"));
          }
        }
        aeKV({count: rows.length, comps: rows.join(" ;; ")});`);
      const compositions = (r.comps ? r.comps.split(' ;; ') : []).filter(Boolean).map((row) => {
        const [name, width, height, duration, frameRate, layers] = row.split('~');
        return {
          name,
          width: Number(width),
          height: Number(height),
          duration: Number(duration),
          frameRate: Number(frameRate),
          layers: Number(layers),
        };
      });
      return { count: compositions.length, compositions, elapsedMs: r._ms };
    },
  },
  {
    name: 'ae_run_jsx',
    description:
      'Escape hatch: run raw Adobe After Effects ExtendScript and get the returned value back. The script must end with an expression; object literals are not available — return a string, or call aeKV({...}) to build `key=value` lines for structured data. The whole AE scripting DOM is reachable here.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'ExtendScript source; its final expression is returned as text.' },
        timeout_ms: { type: 'number', description: 'Per-call timeout in milliseconds (default 180000).' },
      },
      required: ['code'],
      additionalProperties: false,
    },
    run: async (args) => {
      if (typeof args.code !== 'string' || !args.code.trim()) throw new Error('code is required');
      const r = await runJob(args.code, args.timeout_ms || DEFAULT_TIMEOUT);
      return { result: r, note: 'key=value lines parsed from the ExtendScript return value' };
    },
  },
  {
    name: 'ae_new_comp',
    description: 'Create a new composition and make it active.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Composition name.' },
        width: { type: 'number', description: 'Width in pixels (default 1920).' },
        height: { type: 'number', description: 'Height in pixels (default 1080).' },
        duration: { type: 'number', description: 'Duration in seconds (default 5).' },
        frame_rate: { type: 'number', description: 'Frame rate (default 25).' },
        pixel_aspect: { type: 'number', description: 'Pixel aspect ratio (default 1).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await runJob(`
        var comp = app.project.items.addComp(
          ${q(args.name)},
          ${Number(args.width || 1920)},
          ${Number(args.height || 1080)},
          ${Number(args.pixel_aspect || 1)},
          ${Number(args.duration || 5)},
          ${Number(args.frame_rate || 25)}
        );
        comp.openInViewer();
        aeKV({name: comp.name, width: comp.width, height: comp.height, duration: comp.duration, frameRate: comp.frameRate, id: comp.id});`);
      return {
        created: r.name,
        width: num(r.width),
        height: num(r.height),
        duration: num(r.duration),
        frameRate: num(r.frameRate),
        id: num(r.id),
        elapsedMs: r._ms,
      };
    },
  },
  {
    name: 'ae_add_solid',
    description: 'Add a solid-colour layer to a composition. Colour is an [r,g,b] array in 0-1 range.',
    inputSchema: {
      type: 'object',
      properties: {
        comp: { type: 'string', description: 'Composition name (default: the active composition).' },
        name: { type: 'string', description: 'Layer name.' },
        color: { type: 'array', items: { type: 'number' }, description: 'RGB in 0-1, e.g. [0.06,0.07,0.09].' },
        width: { type: 'number', description: 'Width in pixels (default: comp width).' },
        height: { type: 'number', description: 'Height in pixels (default: comp height).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    run: async (args) => {
      const color = Array.isArray(args.color) && args.color.length === 3 ? args.color : [0.1, 0.1, 0.1];
      const r = await runJob(`
        ${FIND_COMP}
        var comp = findComp(${q(args.comp || '')});
        var w = ${args.width ? Number(args.width) : 'comp.width'};
        var h = ${args.height ? Number(args.height) : 'comp.height'};
        var layer = comp.layers.addSolid([${color.join(',')}], ${q(args.name)}, w, h, 1.0);
        aeKV({comp: comp.name, layer: layer.name, index: layer.index, layers: comp.numLayers});`);
      return {
        composition: r.comp,
        layer: r.layer,
        index: num(r.index),
        layers: num(r.layers),
        elapsedMs: r._ms,
      };
    },
  },
  {
    name: 'ae_add_text',
    description: 'Add a text layer to a composition.',
    inputSchema: {
      type: 'object',
      properties: {
        comp: { type: 'string', description: 'Composition name (default: the active composition).' },
        text: { type: 'string', description: 'Text content.' },
        font_size: { type: 'number', description: 'Font size in pixels (default 72).' },
        color: { type: 'array', items: { type: 'number' }, description: 'RGB in 0-1 (default white).' },
        position: { type: 'array', items: { type: 'number' }, description: '[x,y] in pixels.' },
        name: { type: 'string', description: 'Layer name (default: the text itself).' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    run: async (args) => {
      const color = Array.isArray(args.color) && args.color.length === 3 ? args.color : [1, 1, 1];
      const pos = Array.isArray(args.position) && args.position.length === 2 ? args.position : null;
      const r = await runJob(`
        ${FIND_COMP}
        var comp = findComp(${q(args.comp || '')});
        var layer = comp.layers.addText(${q(args.text)});
        ${args.name ? `layer.name = ${q(args.name)};` : ''}
        var src = layer.property("Source Text");
        var doc = src.value;
        doc.fontSize = ${Number(args.font_size || 72)};
        doc.fillColor = [${color.join(',')}];
        src.setValue(doc);
        ${pos ? `layer.property("Position").setValue([${pos[0]}, ${pos[1]}, 0]);` : ''}
        aeKV({comp: comp.name, layer: layer.name, index: layer.index, layers: comp.numLayers});`);
      return {
        composition: r.comp,
        layer: r.layer,
        index: num(r.index),
        layers: num(r.layers),
        elapsedMs: r._ms,
      };
    },
  },
  {
    name: 'ae_list_layers',
    description: 'List the layers of a composition (index, name, match name, in/out point, enabled).',
    inputSchema: {
      type: 'object',
      properties: {
        comp: { type: 'string', description: 'Composition name (default: the active composition).' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await runJob(`
        ${FIND_COMP}
        var comp = findComp(${q(args.comp || '')});
        var rows = [];
        for (var i = 1; i <= comp.numLayers; i++) {
          var L = comp.layer(i);
          rows.push([i, aeEsc(L.name), L.matchName || "", L.inPoint, L.outPoint, L.enabled].join("~"));
        }
        aeKV({comp: comp.name, count: rows.length, rows: rows.join(" ;; ")});`);
      const layers = (r.rows ? r.rows.split(' ;; ') : []).filter(Boolean).map((row) => {
        const [index, name, matchName, inPoint, outPoint, enabled] = row.split('~');
        return {
          index: Number(index),
          name,
          type: matchName,
          inPoint: Number(inPoint),
          outPoint: Number(outPoint),
          enabled: bool(enabled),
        };
      });
      return { composition: r.comp, count: layers.length, layers, elapsedMs: r._ms };
    },
  },
  {
    name: 'ae_output_templates',
    description:
      'List the output module templates available in this After Effects install, and which one the render queue currently uses. Template names are localised (e.g. "无损" instead of "Lossless"), so call this before passing output_module_template to ae_render.',
    inputSchema: {
      type: 'object',
      properties: {
        comp: { type: 'string', description: 'Composition name (default: the active composition).' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await runJob(`
        ${FIND_COMP}
        var comp = findComp(${q(args.comp || '')});
        var rq = app.project.renderQueue.items.add(comp);
        var om = rq.outputModule(1);
        var list = om.templates;
        var current = om.name;
        rq.remove();
        aeKV({current: current, count: list.length, templates: list.join("|")});`);
      const templates = (r.templates ? r.templates.split('|') : []).filter(Boolean);
      return {
        current: r.current,
        count: templates.length,
        templates,
        elapsedMs: r._ms,
      };
    },
  },
  {
    name: 'ae_save_project',
    description: 'Save the project. Without `path` it saves in place; with `path` it writes a copy.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute .aep target path (omit to save in place).' } },
      additionalProperties: false,
    },
    run: async (args) => {
      const jsx = args.path
        ? `
        var f = new File(${q(args.path)});
        app.project.save(f);
        aeKV({ok: "true", path: f.fsName, exists: f.exists, bytes: f.exists ? f.length : 0});`
        : `
        if (!app.project.file) { aeKV({ok: "false", error: "project has never been saved - pass an explicit path"}); }
        else {
          app.project.save();
          aeKV({ok: "true", path: app.project.file.fsName, exists: app.project.file.exists, bytes: app.project.file.length});
        }`;
      const r = await runJob(jsx);
      if (r.ok !== 'true') throw new Error(r.error || 'save failed');
      return { path: r.path, exists: bool(r.exists), bytes: num(r.bytes), elapsedMs: r._ms };
    },
  },
  {
    name: 'ae_render',
    description:
      'Queue a composition for rendering and start it. Returns once the render finishes or the timeout expires. Uses the active composition when `comp` is omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        comp: { type: 'string', description: 'Composition name (default: the active composition).' },
        output: { type: 'string', description: 'Absolute output path, e.g. D:/out/render.png.' },
        output_module_template: {
          type: 'string',
          description:
            'Output module template name as shown in the Render Queue. Names are localised, so query them first with ae_run_jsx if unsure. Default: whatever the project uses.',
        },
        render_settings_template: { type: 'string', description: 'Render settings template, e.g. "Best Settings".' },
        timeout_ms: { type: 'number', description: 'Render timeout in milliseconds (default 900000).' },
      },
      required: ['output'],
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await runJob(
        `
        ${FIND_COMP}
        var comp = findComp(${q(args.comp || '')});
        var outFile = new File(${q(args.output)});
        var rq = app.project.renderQueue.items.add(comp);
        ${args.render_settings_template ? `rq.applyTemplate(${q(args.render_settings_template)});` : ''}
        var om = rq.outputModule(1);
        ${args.output_module_template ? `om.applyTemplate(${q(args.output_module_template)});` : ''}
        // The output module format must match the file extension, and template names are
        // localised, so match on substrings rather than exact names.
        var ext = outFile.name.match(/\.[^.]+$/);
        ext = ext ? ext[0].toLowerCase() : "";
        var want = null;
        if (ext === ".png" || ext === ".psd" || ext === ".tif" || ext === ".tiff") want = ["photoshop"];
        else if (ext === ".avi" || ext === ".mov") want = ["无损", "lossless", "无损耗", "uncompressed"];
        else if (ext === ".mp4" || ext === ".m4v") want = ["h.264", "h264"];
        var chosen = null;
        if (want) {
          var avail = om.templates;
          for (var wi = 0; wi < want.length && chosen === null; wi++) {
            for (var ti = 0; ti < avail.length; ti++) {
              if (String(avail[ti]).toLowerCase().indexOf(want[wi]) >= 0) { chosen = avail[ti]; break; }
            }
          }
          if (chosen !== null) om.applyTemplate(chosen);
        }
        om.file = outFile;
        app.project.renderQueue.render();

        // A sequence template writes <base>_00000.ext, not the path we asked for, so
        // report what actually landed on disk.
        var found = [];
        if (outFile.exists) {
          found.push(outFile.fsName);
        } else {
          var dir = outFile.parent;
          var base = outFile.name.replace(/\\.[^.]+$/, "");
          if (dir && dir.exists) {
            // Match on the base name only: an output module may write a different
            // extension than the one in the requested path.
            var all = dir.getFiles(base + "_*");
            for (var fi = 0; fi < all.length; fi++) found.push(all[fi].fsName);
            if (found.length === 0) {
              var alt = dir.getFiles(base + ".*");
              for (var ai = 0; ai < alt.length; ai++) found.push(alt[ai].fsName);
            }
          }
        }
        var firstBytes = 0;
        if (found.length > 0) {
          var f0 = new File(found[0]);
          firstBytes = f0.exists ? f0.length : 0;
        }
        aeKV({
          outputModule: chosen === null ? om.name : chosen,
          comp: comp.name,
          status: rq.status,
          path: found.length > 0 ? found[0] : outFile.fsName,
          files: found.length,
          sequence: found.length > 1,
          exists: found.length > 0,
          bytes: firstBytes
        });`,
        Number(args.timeout_ms || 900000)
      );
      return {
        composition: r.comp,
        status: r.status,
        outputModule: r.outputModule,
        path: r.path,
        files: num(r.files),
        sequence: bool(r.sequence),
        exists: bool(r.exists),
        bytes: num(r.bytes),
        note: bool(r.exists)
          ? (bool(r.sequence) ? "this output module writes an image sequence; path is the first frame" : undefined)
          : "the render queue finished but nothing appeared on disk — call ae_output_templates and pass a matching output_module_template",
        elapsedMs: r._ms,
      };
    },
  },
  {
    name: 'ae_add_shape',
    description:
      'Add a vector shape layer (rectangle, ellipse, star or polygon) to a composition, with fill and optional stroke.',
    inputSchema: {
      type: 'object',
      properties: {
        comp: { type: 'string', description: 'Composition name (default: the active composition).' },
        name: { type: 'string', description: 'Layer name.' },
        shape: { type: 'string', enum: ['rectangle', 'ellipse', 'star', 'polygon'], description: 'Default rectangle.' },
        size: { type: 'array', items: { type: 'number' }, description: '[width, height] in pixels.' },
        position: { type: 'array', items: { type: 'number' }, description: '[x, y] in pixels (default centre).' },
        fill: { type: 'array', items: { type: 'number' }, description: 'Fill RGB 0-1.' },
        stroke: { type: 'array', items: { type: 'number' }, description: 'Stroke RGB 0-1 (omit for no stroke).' },
        stroke_width: { type: 'number', description: 'Stroke width in pixels (default 4).' },
        points: { type: 'number', description: 'star/polygon: number of points (default 5).' },
        inner_radius: { type: 'number', description: 'star: inner radius in pixels (default 40).' },
        outer_radius: { type: 'number', description: 'star: outer radius in pixels (default 100).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    run: async (args) => {
      const shape = args.shape || 'rectangle';
      const size = Array.isArray(args.size) && args.size.length === 2 ? args.size : [200, 200];
      const fill = Array.isArray(args.fill) && args.fill.length === 3 ? args.fill : [1, 1, 1];
      const hasStroke = Array.isArray(args.stroke) && args.stroke.length === 3;
      const stroke = hasStroke ? args.stroke : [0, 0, 0];
      const pos = Array.isArray(args.position) && args.position.length === 2 ? args.position : null;

      let shapeJsx;
      if (shape === 'rectangle') {
        shapeJsx = `var sh = vec.addProperty("ADBE Vector Shape - Rect");
          sh.property("ADBE Vector Rect Size").setValue([${size[0]}, ${size[1]}]);`;
      } else if (shape === 'ellipse') {
        shapeJsx = `var sh = vec.addProperty("ADBE Vector Shape - Ellipse");
          sh.property("ADBE Vector Ellipse Size").setValue([${size[0]}, ${size[1]}]);`;
      } else if (shape === 'star') {
        shapeJsx = `var sh = vec.addProperty("ADBE Vector Shape - Star");
          sh.property("ADBE Vector Star Type").setValue(1);
          sh.property("ADBE Vector Star Points").setValue(${Number(args.points || 5)});
          sh.property("ADBE Vector Star Inner Radius").setValue(${Number(args.inner_radius || 40)});
          sh.property("ADBE Vector Star Outer Radius").setValue(${Number(args.outer_radius || 100)});`;
      } else {
        shapeJsx = `var sh = vec.addProperty("ADBE Vector Shape - Star");
          sh.property("ADBE Vector Star Type").setValue(2);
          sh.property("ADBE Vector Star Points").setValue(${Number(args.points || 6)});
          sh.property("ADBE Vector Star Outer Radius").setValue(${Number(args.outer_radius || 100)});`;
      }

      const r = await runJob(`
        ${FIND_COMP}
        var comp = findComp(${q(args.comp || '')});
        var layer = comp.layers.addShape();
        layer.name = ${q(args.name)};
        var root = layer.property("ADBE Root Vectors Group");
        var grp = root.addProperty("ADBE Vector Group");
        var vec = grp.property("ADBE Vectors Group");
        ${shapeJsx}
        var f = vec.addProperty("ADBE Vector Graphic - Fill");
        f.property("ADBE Vector Fill Color").setValue([${fill.join(',')}]);
        ${
          hasStroke
            ? `var st = vec.addProperty("ADBE Vector Graphic - Stroke");
        st.property("ADBE Vector Stroke Color").setValue([${stroke.join(',')}]);
        st.property("ADBE Vector Stroke Width").setValue(${Number(args.stroke_width || 4)});`
            : ''
        }
        ${pos ? `layer.property("Position").setValue([${pos[0]}, ${pos[1]}, 0]);` : ''}
        aeKV({comp: comp.name, layer: layer.name, index: layer.index, layers: comp.numLayers, shape: ${q(shape)}});`);
      return {
        composition: r.comp,
        layer: r.layer,
        index: num(r.index),
        layers: num(r.layers),
        shape: r.shape,
        elapsedMs: r._ms,
      };
    },
  },
  {
    name: 'ae_keyframe',
    description:
      'Set a keyframe on a layer property. Supports the common transform and effect properties, and creates the keyframes needed for a simple animation.',
    inputSchema: {
      type: 'object',
      properties: {
        comp: { type: 'string', description: 'Composition name (default: the active composition).' },
        layer: { type: 'string', description: 'Layer name (default: layer 1).' },
        property: {
          type: 'string',
          enum: ['position', 'scale', 'rotation', 'opacity', 'anchor_point', 'effect'],
          description: 'Property to animate.',
        },
        effect_name: { type: 'string', description: 'property=effect: the effect name to animate (its first property is used).' },
        keys: {
          type: 'array',
          description: 'Keyframes: [{time, value}], value is a number or [x,y] array.',
          items: {
            type: 'object',
            properties: {
              time: { type: 'number' },
              value: {},
            },
            required: ['time', 'value'],
          },
        },
        ease: { type: 'string', enum: ['linear', 'ease'], description: 'Keyframe interpolation (default ease).' },
      },
      required: ['property', 'keys'],
      additionalProperties: false,
    },
    run: async (args) => {
      const propMap = {
        position: 'Position',
        scale: 'Scale',
        rotation: 'Rotation',
        opacity: 'Opacity',
        anchor_point: 'Anchor Point',
      };
      const keys = Array.isArray(args.keys) ? args.keys : [];
      if (keys.length === 0) throw new Error('keys is required');

      const keyLines = keys
        .map((k) => {
          const v = Array.isArray(k.value) ? `[${k.value.join(',')}]` : String(Number(k.value));
          return `prop.setValueAtTime(${Number(k.time)}, ${v});`;
        })
        .join('\n        ');

      const easeLines =
        args.ease === 'linear'
          ? `for (var i = 1; i <= prop.numKeys; i++) { prop.setInterpolationTypeAtKey(i, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR); }`
          : `for (var i = 1; i <= prop.numKeys; i++) { prop.setInterpolationTypeAtKey(i, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER); prop.setTemporalEaseAtKey(i, [new KeyframeEase(0, 33)], [new KeyframeEase(0, 33)]); }`;

      const propJsx =
        args.property === 'effect'
          ? `var fx = layer.property("ADBE Effect Parade").property(${q(args.effect_name || '')});
             if (!fx) throw new Error("effect not found: " + ${q(args.effect_name || '')});
             var prop = fx.property(1);`
          : `var prop = layer.property(${q(propMap[args.property])});`;

      const r = await runJob(`
        ${FIND_COMP}
        var comp = findComp(${q(args.comp || '')});
        var layer = ${args.layer ? `comp.layer(${q(args.layer)})` : 'comp.layer(1)'};
        ${propJsx}
        ${keyLines}
        ${easeLines}
        aeKV({comp: comp.name, layer: layer.name, property: ${q(args.property)}, keys: prop.numKeys});`);
      return {
        composition: r.comp,
        layer: r.layer,
        property: r.property,
        keyframes: num(r.keys),
        elapsedMs: r._ms,
      };
    },
  },
  {
    name: 'ae_add_effect',
    description:
      'Add an effect to a layer by its After Effects match name or display name, e.g. "ADBE Fill", "ADBE Gaussian Blur 2", "Glow", "Curves".',
    inputSchema: {
      type: 'object',
      properties: {
        comp: { type: 'string', description: 'Composition name (default: the active composition).' },
        layer: { type: 'string', description: 'Layer name (default: layer 1).' },
        effect: { type: 'string', description: 'Effect match name or display name.' },
      },
      required: ['effect'],
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await runJob(`
        ${FIND_COMP}
        var comp = findComp(${q(args.comp || '')});
        var layer = ${args.layer ? `comp.layer(${q(args.layer)})` : 'comp.layer(1)'};
        var fx = layer.property("ADBE Effect Parade").addProperty(${q(args.effect)});
        var props = [];
        for (var i = 1; i <= fx.numProperties; i++) props.push(fx.property(i).name);
        aeKV({comp: comp.name, layer: layer.name, effect: fx.name, matchName: fx.matchName, properties: props.join("|")});`);
      return {
        composition: r.comp,
        layer: r.layer,
        effect: r.effect,
        matchName: r.matchName,
        properties: (r.properties ? r.properties.split('|') : []).filter(Boolean),
        elapsedMs: r._ms,
      };
    },
  },
  {
    name: 'ae_set_expression',
    description: 'Attach an expression to a layer property, e.g. wiggle(2, 30) on Position.',
    inputSchema: {
      type: 'object',
      properties: {
        comp: { type: 'string', description: 'Composition name (default: the active composition).' },
        layer: { type: 'string', description: 'Layer name (default: layer 1).' },
        property: {
          type: 'string',
          enum: ['position', 'scale', 'rotation', 'opacity', 'anchor_point', 'time_remap'],
          description: 'Property to drive.',
        },
        expression: { type: 'string', description: 'ExtendScript expression source, e.g. "wiggle(2, 30)".' },
      },
      required: ['property', 'expression'],
      additionalProperties: false,
    },
    run: async (args) => {
      const propMap = {
        position: 'Position',
        scale: 'Scale',
        rotation: 'Rotation',
        opacity: 'Opacity',
        anchor_point: 'Anchor Point',
        time_remap: 'Time Remap',
      };
      const r = await runJob(`
        ${FIND_COMP}
        var comp = findComp(${q(args.comp || '')});
        var layer = ${args.layer ? `comp.layer(${q(args.layer)})` : 'comp.layer(1)'};
        var prop = layer.property(${q(propMap[args.property])});
        prop.expression = ${q(args.expression)};
        aeKV({comp: comp.name, layer: layer.name, property: ${q(args.property)}, enabled: prop.expressionEnabled});`);
      return {
        composition: r.comp,
        layer: r.layer,
        property: r.property,
        expressionEnabled: bool(r.enabled),
        elapsedMs: r._ms,
      };
    },
  },
  {
    name: 'ae_set_layer',
    description:
      'Change a layer: visibility, in/out point, opacity, blend mode, parent, or time stretch.',
    inputSchema: {
      type: 'object',
      properties: {
        comp: { type: 'string', description: 'Composition name (default: the active composition).' },
        layer: { type: 'string', description: 'Layer name (default: layer 1).' },
        enabled: { type: 'boolean', description: 'Layer visibility.' },
        in_point: { type: 'number', description: 'In point in seconds.' },
        out_point: { type: 'number', description: 'Out point in seconds.' },
        opacity: { type: 'number', description: 'Opacity 0-100.' },
        blend_mode: {
          type: 'string',
          enum: ['normal', 'add', 'multiply', 'screen', 'overlay', 'soft_light', 'hard_light', 'difference', 'exclusion'],
          description: 'Blend mode.',
        },
        parent: { type: 'string', description: 'Parent layer name.' },
        start_time: { type: 'number', description: 'Layer start time in seconds.' },
        stretch: { type: 'number', description: 'Time stretch percentage (100 = normal).' },
        solo: { type: 'boolean', description: 'Solo the layer.' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const blend = {
        normal: 'BlendingMode.NORMAL',
        add: 'BlendingMode.ADD',
        multiply: 'BlendingMode.MULTIPLY',
        screen: 'BlendingMode.SCREEN',
        overlay: 'BlendingMode.OVERLAY',
        soft_light: 'BlendingMode.SOFT_LIGHT',
        hard_light: 'BlendingMode.HARD_LIGHT',
        difference: 'BlendingMode.DIFFERENCE',
        exclusion: 'BlendingMode.EXCLUSION',
      };
      const changes = [];
      if (args.enabled !== undefined) changes.push(`layer.enabled = ${Boolean(args.enabled)};`);
      if (args.in_point !== undefined) changes.push(`layer.inPoint = ${Number(args.in_point)};`);
      if (args.out_point !== undefined) changes.push(`layer.outPoint = ${Number(args.out_point)};`);
      if (args.opacity !== undefined) changes.push(`layer.property("Opacity").setValue(${Number(args.opacity)});`);
      if (args.blend_mode) changes.push(`layer.blendingMode = ${blend[args.blend_mode] || 'BlendingMode.NORMAL'};`);
      if (args.start_time !== undefined) changes.push(`layer.startTime = ${Number(args.start_time)};`);
      if (args.stretch !== undefined) changes.push(`layer.stretch = ${Number(args.stretch)};`);
      if (args.solo !== undefined) changes.push(`layer.solo = ${Boolean(args.solo)};`);
      if (args.parent) {
        changes.push(`var par = null;
        for (var pi = 1; pi <= comp.numLayers; pi++) { if (comp.layer(pi).name === ${q(args.parent)}) { par = comp.layer(pi); break; } }
        if (par) layer.parent = par;`);
      }
      if (changes.length === 0) throw new Error('nothing to change — pass at least one field');

      const r = await runJob(`
        ${FIND_COMP}
        var comp = findComp(${q(args.comp || '')});
        var layer = ${args.layer ? `comp.layer(${q(args.layer)})` : 'comp.layer(1)'};
        ${changes.join('\n        ')}
        aeKV({
          comp: comp.name, layer: layer.name, enabled: layer.enabled,
          inPoint: layer.inPoint, outPoint: layer.outPoint,
          opacity: layer.property("Opacity").value, blend: String(layer.blendingMode)
        });`);
      return {
        composition: r.comp,
        layer: r.layer,
        enabled: bool(r.enabled),
        inPoint: num(r.inPoint),
        outPoint: num(r.outPoint),
        opacity: num(r.opacity),
        blendMode: r.blend,
        elapsedMs: r._ms,
      };
    },
  },
  {
    name: 'ae_import',
    description: 'Import a file (image, video, audio, PSD) into the project and optionally add it to a composition as a layer.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to import.' },
        comp: { type: 'string', description: 'Composition to add it to (omit to only import).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await runJob(`
        var f = new File(${q(args.path)});
        if (!f.exists) throw new Error("file not found: " + ${q(args.path)});
        var opts = new ImportOptions(f);
        var item = app.project.importFile(opts);
        var out = {name: item.name, id: item.id, type: item.typeName};
        ${args.comp ? `
        ${FIND_COMP}
        var comp = findComp(${q(args.comp)});
        var layer = comp.layers.add(item);
        out.comp = comp.name;
        out.layer = layer.name;
        out.layers = comp.numLayers;
        out.duration = layer.source.duration;` : ''}
        aeKV(out);`);
      return {
        item: r.name,
        id: num(r.id),
        type: r.type,
        composition: r.comp || null,
        layer: r.layer || null,
        layers: r.layers === undefined ? null : num(r.layers),
        sourceDuration: r.duration === undefined ? null : num(r.duration),
        elapsedMs: r._ms,
      };
    },
  },
  {
    name: 'ae_set_comp',
    description: 'Change composition settings: size, duration, frame rate, background colour, or work area.',
    inputSchema: {
      type: 'object',
      properties: {
        comp: { type: 'string', description: 'Composition name (default: the active composition).' },
        width: { type: 'number', description: 'New width in pixels.' },
        height: { type: 'number', description: 'New height in pixels.' },
        duration: { type: 'number', description: 'New duration in seconds.' },
        frame_rate: { type: 'number', description: 'New frame rate.' },
        bg_color: { type: 'array', items: { type: 'number' }, description: 'Background RGB 0-1.' },
        work_area_start: { type: 'number', description: 'Work area start in seconds.' },
        work_area_duration: { type: 'number', description: 'Work area duration in seconds.' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const changes = [];
      if (args.width !== undefined) changes.push(`comp.width = ${Number(args.width)};`);
      if (args.height !== undefined) changes.push(`comp.height = ${Number(args.height)};`);
      if (args.duration !== undefined) changes.push(`comp.duration = ${Number(args.duration)};`);
      if (args.frame_rate !== undefined) changes.push(`comp.frameRate = ${Number(args.frame_rate)};`);
      if (Array.isArray(args.bg_color) && args.bg_color.length === 3) {
        changes.push(`comp.bgColor = [${args.bg_color.join(',')}];`);
      }
      if (args.work_area_start !== undefined) changes.push(`comp.workAreaStart = ${Number(args.work_area_start)};`);
      if (args.work_area_duration !== undefined) changes.push(`comp.workAreaDuration = ${Number(args.work_area_duration)};`);
      if (changes.length === 0) throw new Error('nothing to change — pass at least one field');

      const r = await runJob(`
        ${FIND_COMP}
        var comp = findComp(${q(args.comp || '')});
        ${changes.join('\n        ')}
        aeKV({name: comp.name, width: comp.width, height: comp.height, duration: comp.duration, frameRate: comp.frameRate});`);
      return {
        composition: r.name,
        width: num(r.width),
        height: num(r.height),
        duration: num(r.duration),
        frameRate: num(r.frameRate),
        elapsedMs: r._ms,
      };
    },
  },
  {
    name: 'ae_delete_layer',
    description: 'Delete a layer from a composition by name or index.',
    inputSchema: {
      type: 'object',
      properties: {
        comp: { type: 'string', description: 'Composition name (default: the active composition).' },
        layer: { type: 'string', description: 'Layer name.' },
        index: { type: 'number', description: 'Layer index (used when `layer` is omitted).' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await runJob(`
        ${FIND_COMP}
        var comp = findComp(${q(args.comp || '')});
        var layer = ${args.layer ? `comp.layer(${q(args.layer)})` : `comp.layer(${Number(args.index || 1)})`};
        var nm = layer.name;
        layer.remove();
        aeKV({removed: nm, layers: comp.numLayers});`);
      return { removed: r.removed, layers: num(r.layers), elapsedMs: r._ms };
    },
  },
  {
    name: 'ae_precompose',
    description: 'Pre-compose the listed layers of a composition into a new composition.',
    inputSchema: {
      type: 'object',
      properties: {
        comp: { type: 'string', description: 'Composition name (default: the active composition).' },
        name: { type: 'string', description: 'Name for the new composition.' },
        layers: { type: 'array', items: { type: 'string' }, description: 'Layer names to include (omit for all).' },
        move_all_attributes: { type: 'boolean', description: 'Move all attributes into the new comp (default true).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    run: async (args) => {
      const moveAll = args.move_all_attributes === false ? 'false' : 'true';
      const r = await runJob(`
        ${FIND_COMP}
        var comp = findComp(${q(args.comp || '')});
        var indices = [];
        ${args.layers && args.layers.length
          ? `var wanted = ${JSON.stringify(args.layers)};
                for (var i = 1; i <= comp.numLayers; i++) {
                  var nm = comp.layer(i).name;
                  for (var wi = 0; wi < wanted.length; wi++) {
                    if (wanted[wi] === nm) { indices.push(i); break; }
                  }
                }`
          : `for (var i = 1; i <= comp.numLayers; i++) indices.push(i);`}
        if (indices.length === 0) throw new Error("no matching layers");
        var newComp = comp.layers.precompose(indices, ${q(args.name)}, ${moveAll});
        aeKV({source: comp.name, comp: newComp.name, layers: newComp.numLayers, id: newComp.id});`);
      return {
        source: r.source,
        composition: r.comp,
        layers: num(r.layers),
        id: num(r.id),
        elapsedMs: r._ms,
      };
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------- MCP stdio loop ----------------

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const SERVER_INFO = { name: 'ae-mcp', version: '1.0.0' };
const INSTRUCTIONS =
  'Drives the local Adobe After Effects through its ExtendScript entry point (AfterFX.exe -r). ' +
  'Prefer the specific tools; use ae_run_jsx for anything not wrapped. The first call after ' +
  'After Effects has been closed pays a ~12 s cold start; later calls are ~0.7 s because -r ' +
  'injects into the running process.';

function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  try {
    switch (method) {
      case 'initialize':
        if (isRequest) {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: params?.protocolVersion || '2025-06-18',
              capabilities: { tools: { listChanged: false } },
              serverInfo: SERVER_INFO,
              instructions: INSTRUCTIONS,
            },
          });
        }
        return;
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        if (isRequest) send({ jsonrpc: '2.0', id, result: {} });
        return;
      case 'tools/list':
        if (isRequest) {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
            },
          });
        }
        return;
      case 'tools/call': {
        if (!isRequest) return;
        const name = params?.name;
        const tool = TOOL_MAP.get(name);
        if (!tool) {
          send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } });
          return;
        }
        Promise.resolve()
          .then(() => tool.run(params?.arguments || {}))
          .then((result) => {
            send({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                structuredContent: result,
                isError: false,
              },
            });
          })
          .catch((e) => {
            log(`tool ${name} failed:`, e.message + (e.aeLine ? ` (line ${e.aeLine})` : ''));
            send({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: `${name} failed: ${e.message}` }],
                isError: true,
              },
            });
          });
        return;
      }
      default:
        if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message || e) } });
  }
}

let inbuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inbuf += chunk;
  let idx;
  while ((idx = inbuf.indexOf('\n')) >= 0) {
    const line = inbuf.slice(0, idx).trim();
    inbuf = inbuf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log('bad json on stdin:', line.slice(0, 160));
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      continue;
    }
    Array.isArray(msg) ? msg.forEach(handle) : handle(msg);
  }
});

process.stdin.on('end', () => process.exit(0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

log(`ae-mcp up (exe=${AE_EXE})`);