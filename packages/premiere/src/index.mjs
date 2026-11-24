#!/usr/bin/env node
// premiere-mcp — an MCP (stdio) server that drives a local Adobe Premiere Pro.
//
// Premiere has no command-line scripting entry point (After Effects has `-r`), so
// ExtendScript only exists inside the running application. A CEP panel hosts a TCP
// socket and evals JSX on request; this server is the client.
//
//   MCP client → node index.mjs → 127.0.0.1:3021 → CEP panel → CSInterface.evalScript
//
// Zero third-party dependencies. Node 18+.

import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PR_PORT || 3021);
const HOST = process.env.PR_HOST || '127.0.0.1';
const DEFAULT_TIMEOUT = Number(process.env.PR_TIMEOUT_MS || 120000);
const CONNECT_TIMEOUT = Number(process.env.PR_CONNECT_TIMEOUT_MS || 5000);

// The CEP panel generates a per-session token and writes it here; every request must
// carry it. That socket executes arbitrary ExtendScript, so binding to 127.0.0.1 alone
// is not enough — without a token any local process could drive Premiere.
const TOKEN_FILE = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'agent-adobe-mcp',
  'bridge.token'
);

function readToken() {
  let raw;
  try {
    raw = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    raw = '';
  }
  if (!raw) {
    throw new Error(
      'no bridge token at ' +
        TOKEN_FILE +
        ' — open the AGENT-ADOBE-MCP Bridge panel in Premiere (Window > Extensions); ' +
        'the panel writes the token when it starts.'
    );
  }
  return raw;
}

const log = (...a) => process.stderr.write('[premiere] ' + a.join(' ') + '\n');

// Premiere's ExtendScript has no JSON object: results travel as key=value lines.
const PRELUDE = `
function prKV(o){var s="",k,v;for(k in o){if(o.hasOwnProperty(k)){v=o[k];if(v===null||v===undefined){v="";}
s+=k+"="+String(v).replace(/[\\r\\n]+/g,"\\\\n")+"\\n";}}return s;}
function prEsc(v){return String(v).replace(/[\\r\\n]+/g,"\\\\n");}
`;

function parseKv(text) {
  const out = {};
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

class Bridge {
  constructor() {
    this.socket = null;
    this.connecting = null;
    this.buffer = '';
    this.seq = 0;
    this.token = null;
    this.waiters = new Map();
    this.queue = Promise.resolve();
  }

  connect() {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: HOST, port: PORT });
      const timer = setTimeout(() => {
        socket.destroy();
        this.connecting = null;
        reject(
          new Error(
            `could not reach the Premiere bridge on ${HOST}:${PORT}. ` +
              'Open Premiere Pro, then Window > Extensions > AGENT-ADOBE-MCP Bridge, and leave the panel open.'
          )
        );
      }, CONNECT_TIMEOUT);

      socket.setEncoding('utf8');
      socket.once('connect', () => {
        clearTimeout(timer);
        // Read the token on every connect: a restarted panel issues a new one, and the
        // previous value would be rejected.
        try {
          this.token = readToken();
        } catch (e) {
          socket.destroy();
          this.connecting = null;
          reject(e);
          return;
        }
        this.socket = socket;
        this.connecting = null;
        log(`connected to the Premiere bridge on ${HOST}:${PORT}`);
        resolve();
      });
      socket.once('error', (e) => {
        clearTimeout(timer);
        this.connecting = null;
        reject(
          new Error(
            `bridge connection failed (${e.code || e.message}). ` +
              'Is the AGENT-ADOBE-MCP Bridge panel open in Premiere Pro?'
          )
        );
      });

      socket.on('data', (chunk) => {
        this.buffer += chunk;
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            log('bridge noise:', line.slice(0, 160));
            continue;
          }
          const w = this.waiters.get(msg.id);
          if (w) {
            this.waiters.delete(msg.id);
            w(msg);
          }
        }
      });

      socket.on('close', () => {
        log('bridge connection closed');
        this.socket = null;
        for (const [, w] of this.waiters) w({ ok: false, error: 'bridge connection closed' });
        this.waiters.clear();
      });
    });

    return this.connecting;
  }

  call(jsx, timeoutMs = DEFAULT_TIMEOUT) {
    const run = async () => {
      await this.connect();
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiters.delete(id);
          reject(
            new Error(
              `Premiere did not answer within ${timeoutMs}ms — a modal dialog may be open, ` +
                'or the bridge panel was closed'
            )
          );
        }, timeoutMs);

        this.waiters.set(id, (msg) => {
          clearTimeout(timer);
          if (!msg.ok) return reject(new Error(msg.error || 'ExtendScript error'));
          resolve(parseKv(msg.result));
        });

        try {
          this.socket.write(JSON.stringify({ id, token: this.token, jsx: PRELUDE + jsx }) + '\n');
        } catch (e) {
          clearTimeout(timer);
          this.waiters.delete(id);
          reject(e);
        }
      });
    };
    // Premiere's ExtendScript engine is single-threaded; serialize the calls.
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  close() {
    try {
      this.socket?.destroy();
    } catch {}
    this.socket = null;
  }
}

const bridge = new Bridge();

const TOOLS = [
  {
    name: 'pr_ping',
    description:
      'Check that Premiere Pro is reachable through the CEP bridge. Returns the app version and whether a project is open. Requires the AGENT-ADOBE-MCP Bridge panel to be open in Premiere (Window > Extensions).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await bridge.call(
        `prKV({version: app.version, build: app.build, project: app.project ? app.project.name : "", path: (app.project && app.project.path) ? app.project.path : ""});`,
        60000
      );
      return {
        version: r.version,
        build: r.build,
        project: r.project || null,
        projectPath: r.path || null,
        bridge: `${HOST}:${PORT}`,
      };
    },
  },
  {
    name: 'pr_state',
    description:
      'Describe the open project: name, path, sequence count, and the active sequence with its settings.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await bridge.call(`
        var out = {project: "", path: "", sequences: 0, active: ""};
        if (app.project) {
          out.project = app.project.name || "";
          out.path = app.project.path || "";
          try {
            var seqs = app.project.sequences;
            out.sequences = seqs ? seqs.numSequences : 0;
          } catch (e) { out.sequences = 0; }
          var seq = app.project.activeSequence;
          if (seq) {
            out.active = seq.name;
            out.width = seq.frameSizeHorizontal;
            out.height = seq.frameSizeVertical;
            out.fps = seq.timebase;
            out.videoTracks = seq.videoTracks.numTracks;
            out.audioTracks = seq.audioTracks.numTracks;
            out.end = seq.end;
          }
        }
        prKV(out);`, 60000);
      return {
        project: r.project || null,
        projectPath: r.path || null,
        sequences: num(r.sequences),
        activeSequence: r.active
          ? {
              name: r.active,
              width: num(r.width),
              height: num(r.height),
              ticksPerFrame: num(r.fps),
              videoTracks: num(r.videoTracks),
              audioTracks: num(r.audioTracks),
              endTicks: r.end,
            }
          : null,
      };
    },
  },
  {
    name: 'pr_list_sequences',
    description: 'List every sequence in the project with its dimensions, track counts and duration.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await bridge.call(`
        var rows = [];
        if (app.project && app.project.sequences) {
          var seqs = app.project.sequences;
          for (var i = 0; i < seqs.numSequences; i++) {
            var s = seqs[i];
            rows.push([prEsc(s.name), s.frameSizeHorizontal, s.frameSizeVertical, s.videoTracks.numTracks, s.audioTracks.numTracks, s.end].join("~"));
          }
        }
        prKV({count: rows.length, rows: rows.join(" ;; ")});`, 60000);
      const sequences = (r.rows ? r.rows.split(' ;; ') : []).filter(Boolean).map((row) => {
        const [name, width, height, videoTracks, audioTracks, end] = row.split('~');
        return {
          name,
          width: Number(width),
          height: Number(height),
          videoTracks: Number(videoTracks),
          audioTracks: Number(audioTracks),
          endTicks: end,
        };
      });
      return { count: sequences.length, sequences };
    },
  },
  {
    name: 'pr_list_media',
    description: 'List the clips in the project bin (name, type, media path, duration).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of items to return (default 200).' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const limit = Number(args.limit || 200);
      const r = await bridge.call(`
        var rows = [];
        function walk(bin, depth) {
          for (var i = 0; i < bin.children.numItems; i++) {
            var it = bin.children[i];
            if (it.type === ProjectItemType.BIN) { walk(it, depth + 1); continue; }
            rows.push([depth, prEsc(it.name), it.type, prEsc(it.getMediaPath() || ""), it.nodeId].join("~"));
          }
        }
        if (app.project) walk(app.project.rootItem, 0);
        prKV({count: rows.length, rows: rows.join(" ;; ")});`, 120000);
      const items = (r.rows ? r.rows.split(' ;; ') : []).filter(Boolean).slice(0, limit).map((row) => {
        const [depth, name, type, mediaPath, nodeId] = row.split('~');
        return { depth: Number(depth), name, type, mediaPath: mediaPath || null, nodeId };
      });
      return { total: num(r.count), returned: items.length, items };
    },
  },
  {
    name: 'pr_list_tracks',
    description: 'List the tracks of the active sequence, with the clips on each track.',
    inputSchema: {
      type: 'object',
      properties: {
        comp: { type: 'string', description: 'Sequence name (default: the active sequence).' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await bridge.call(`
        var seq = ${args.comp ? `null` : 'app.project.activeSequence'};
        ${args.comp
          ? `var seqs = app.project.sequences;
        for (var si = 0; si < seqs.numSequences; si++) { if (seqs[si].name === ${q(args.comp)}) { seq = seqs[si]; break; } }`
          : ''}
        if (!seq) { prKV({ok: "false", error: "no active sequence"}); }
        else {
          var rows = [];
          for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var tr = seq.videoTracks[t];
            var clips = [];
            for (var c = 0; c < tr.clips.numItems; c++) {
              var cl = tr.clips[c];
              clips.push(prEsc(cl.name) + "@" + cl.start.ticks + "-" + cl.end.ticks);
            }
            rows.push(["V" + (t + 1), tr.name, clips.length, clips.join(",")].join("~"));
          }
          for (var a = 0; a < seq.audioTracks.numTracks; a++) {
            var ar = seq.audioTracks[a];
            rows.push(["A" + (a + 1), ar.name, ar.clips.numItems, ""].join("~"));
          }
          prKV({ok: "true", seq: seq.name, count: rows.length, rows: rows.join(" ;; ")});
        }`, 120000);
      if (r.ok !== 'true') throw new Error(r.error || 'no active sequence');
      const tracks = (r.rows ? r.rows.split(' ;; ') : []).filter(Boolean).map((row) => {
        const [id, name, clips, list] = row.split('~');
        return { id, name, clipCount: Number(clips), clips: list ? list.split(',') : [] };
      });
      return { sequence: r.seq, count: tracks.length, tracks };
    },
  },
  {
    name: 'pr_run_jsx',
    description:
      'Escape hatch: run raw Adobe Premiere Pro ExtendScript and get the returned value back. The script must end with an expression; object literals are not available — return a string, or call prKV({...}) to build `key=value` lines for structured data. The whole Premiere scripting DOM is reachable here.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'ExtendScript source; its final expression is returned as text.' },
        timeout_ms: { type: 'number', description: 'Per-call timeout in milliseconds (default 120000).' },
      },
      required: ['code'],
      additionalProperties: false,
    },
    run: async (args) => {
      if (typeof args.code !== 'string' || !args.code.trim()) throw new Error('code is required');
      const r = await bridge.call(args.code, args.timeout_ms || DEFAULT_TIMEOUT);
      return { result: r, note: 'key=value lines parsed from the ExtendScript return value' };
    },
  },
  {
    name: 'pr_new_sequence',
    description:
      'Create a new sequence from a .sqpreset file. Uses the QE DOM, because app.project.createNewSequence() blocks the ExtendScript engine on Premiere 26 and takes the whole bridge down with it. Pick a preset from <Premiere install>/Settings/SequencePresets/.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Sequence name.' },
        preset_path: {
          type: 'string',
          description:
            'Absolute path to a .sqpreset file, e.g. <Premiere>/Settings/SequencePresets/HD 1080p/HD 1080p 25 fps.sqpreset. Required: the QE route needs an explicit preset.',
        },
      },
      required: ['name', 'preset_path'],
      additionalProperties: false,
    },
    run: async (args) => {
      if (!args.preset_path) throw new Error('preset_path is required (e.g. "HD 1080p 25 fps.sqpreset")');
      const r = await bridge.call(
        `
        if (typeof qe === "undefined" || !qe || !qe.project || !qe.project.newSequence) {
          prKV({ok: "false", error: "QE DOM is not available in this Premiere build"});
        } else {
          var preset = new File(${q(args.preset_path)});
          if (!preset.exists) {
            prKV({ok: "false", error: "preset not found: " + ${q(args.preset_path)}});
          } else {
            var created = qe.project.newSequence(${q(args.name)}, preset.fsName);
            if (!created) {
              prKV({ok: "false", error: "QE newSequence returned null"});
            } else {
              // The object qe.project.newSequence() hands back is not a plain Sequence:
              // name/frameSizeHorizontal are undefined on it. Read the real one back.
              var seq = app.project.activeSequence;
              var n = 0;
              try { n = app.project.sequences.numSequences; } catch (e) {}
              prKV({
                ok: "true",
                name: seq ? seq.name : ${q(args.name)},
                width: seq ? seq.frameSizeHorizontal : "",
                height: seq ? seq.frameSizeVertical : "",
                sequences: n
              });
            }
          }
        }`,
        // Deliberately short: a blocking call must fail fast, not hang the panel.
        30000
      );
      if (r.ok !== 'true') throw new Error(r.error || 'could not create the sequence');
      return { created: r.name, width: num(r.width), height: num(r.height) };
    },
  },
  {
    name: 'pr_import',
    description: 'Import a file into the project bin, optionally targeting a bin by name.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the media file to import.' },
        bin: { type: 'string', description: 'Target bin name (omit for the project root).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await bridge.call(
        `
        var f = new File(${q(args.path)});
        if (!f.exists) { prKV({ok: "false", error: "file not found: " + ${q(args.path)}}); }
        else {
          var target = app.project.rootItem;
          ${
            args.bin
              ? `for (var i = 0; i < app.project.rootItem.children.numItems; i++) {
            var it = app.project.rootItem.children[i];
            if (it.name === ${q(args.bin)} && it.type === ProjectItemType.BIN) { target = it; break; }
          }`
              : ''
          }
          var ok = target.createBin ? true : false;
          var imported = app.project.importFiles([f.fsName], true, target, false);
          prKV({ok: imported ? "true" : "false", path: f.fsName, bin: target.name});
        }`,
        300000
      );
      if (r.ok !== 'true') throw new Error(r.error || 'import failed');
      return { imported: r.path, bin: r.bin };
    },
  },
  {
    name: 'pr_add_to_timeline',
    description:
      'Insert a project item onto a track of the active sequence at a given time. Uses overwrite semantics.',
    inputSchema: {
      type: 'object',
      properties: {
        item: { type: 'string', description: 'Project item name (as shown in the bin).' },
        track: { type: 'number', description: 'Video track index, 0-based (default 0).' },
        time: { type: 'number', description: 'Insert time in seconds (default 0).' },
      },
      required: ['item'],
      additionalProperties: false,
    },
    run: async (args) => {
      const track = Number(args.track || 0);
      const seconds = Number(args.time || 0);
      const r = await bridge.call(
        `
        var seq = app.project.activeSequence;
        if (!seq) throw new Error("no active sequence");
        var item = null;
        function find(bin) {
          for (var i = 0; i < bin.children.numItems; i++) {
            var it = bin.children[i];
            if (it.name === ${q(args.item)}) { item = it; return; }
            if (it.type === ProjectItemType.BIN) find(it);
            if (item) return;
          }
        }
        find(app.project.rootItem);
        if (!item) throw new Error("project item not found: " + ${q(args.item)});
        var ticks = String(Math.round(${seconds} * 254016000000));
        var ok = seq.videoTracks[${track}].overwriteClip(item, ticks);
        prKV({ok: ok ? "true" : "false", sequence: seq.name, track: ${track}, item: item.name});`,
        300000
      );
      if (r.ok !== 'true') throw new Error('overwriteClip failed');
      return { sequence: r.sequence, track, item: r.item };
    },
  },
  {
    name: 'pr_export',
    description:
      'Export the active sequence. Returns once the encode finishes or the timeout expires.',
    inputSchema: {
      type: 'object',
      properties: {
        output: { type: 'string', description: 'Absolute output path, e.g. D:/out/render.mp4.' },
        preset_path: {
          type: 'string',
          description: 'Absolute path to an .epr preset (omit to use the sequence default).',
        },
        timeout_ms: { type: 'number', description: 'Encode timeout in milliseconds (default 900000).' },
      },
      required: ['output'],
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await bridge.call(
        `
        var seq = app.project.activeSequence;
        if (!seq) throw new Error("no active sequence");
        var outFile = ${q(args.output)};
        var preset = ${q(args.preset_path || '')};
        if (preset && !(new File(preset)).exists) throw new Error("preset not found: " + preset);
        seq.exportAsMediaDirect(outFile, preset, 1);
        var f = new File(outFile);
        prKV({ok: "true", sequence: seq.name, path: outFile, exists: f.exists, bytes: f.exists ? f.length : 0});`,
        Number(args.timeout_ms || 900000)
      );
      if (r.ok !== 'true') throw new Error('export failed');
      return {
        sequence: r.sequence,
        path: r.path,
        exists: bool(r.exists),
        bytes: num(r.bytes),
        note: bool(r.exists) ? undefined : 'the export call returned but no file appeared yet — check Premiere\'s progress panel',
      };
    },
  },
  {
    name: 'pr_save_project',
    description: 'Save the project. Without `path` it saves in place; with `path` it writes a copy.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute .prproj target path (omit to save in place).' } },
      additionalProperties: false,
    },
    run: async (args) => {
      const jsx = args.path
        ? `
        var f = new File(${q(args.path)});
        app.project.saveAs(f.fsName);
        prKV({ok: "true", path: f.fsName, exists: f.exists, bytes: f.exists ? f.length : 0});`
        : `
        if (!app.project.path) { prKV({ok: "false", error: "project has never been saved - pass an explicit path"}); }
        else {
          app.project.save();
          var f = new File(app.project.path);
          prKV({ok: "true", path: app.project.path, exists: f.exists, bytes: f.exists ? f.length : 0});
        }`;
      const r = await bridge.call(jsx, 300000);
      if (r.ok !== 'true') throw new Error(r.error || 'save failed');
      return { path: r.path, exists: bool(r.exists), bytes: num(r.bytes) };
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------- MCP stdio loop ----------------

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const SERVER_INFO = { name: 'premiere', version: '1.0.0' };
const INSTRUCTIONS =
  'Drives the local Adobe Premiere Pro through a CEP bridge panel. Premiere has no command-line ' +
  'scripting entry point, so the AGENT-ADOBE-MCP Bridge panel must be open inside Premiere ' +
  '(Window > Extensions) before any tool works. Prefer the specific tools; use pr_run_jsx for ' +
  'anything not wrapped.';

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
            log(`tool ${name} failed:`, e.message);
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

process.stdin.on('end', () => {
  bridge.close();
  process.exit(0);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    bridge.close();
    process.exit(0);
  });
}

log(`premiere-mcp up (bridge ${HOST}:${PORT})`);