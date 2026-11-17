#!/usr/bin/env node
// ps-mcp — MCP (stdio) server that drives a local Adobe Photoshop through a persistent
// PowerShell COM bridge (ExtendScript / DoJavaScript). No third-party dependencies.
//
// Tools: ps_ping ps_state ps_layers ps_run_jsx ps_open ps_new_document ps_save ps_export
// Wire: MCP stdio transport = newline-delimited JSON-RPC 2.0. All diagnostics go to stderr.

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, 'bridge.ps1');
const PS_EXE = process.env.PS_EXE || '';
const POWERSHELL =
  process.env.PS_POWERSHELL || 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const DEFAULT_TIMEOUT = Number(process.env.PS_TIMEOUT_MS || 120000);
const BRIDGE_READY_TIMEOUT = Number(process.env.PS_READY_TIMEOUT_MS || 180000);

const log = (...a) => process.stderr.write('[photoshop] ' + a.join(' ') + '\n');

// ExtendScript has no JSON object: every JSX result is a "key=value" line block.
const PRELUDE = `
function psKV(o){var s="",k,v;for(k in o){if(o.hasOwnProperty(k)){v=o[k];if(v===null||v===undefined){v="";}
s+=k+"="+String(v).replace(/[\\r\\n]+/g,"\\\\n")+"\\n";}}return s;}
function psEsc(v){return String(v).replace(/[\\r\\n]+/g,"\\\\n");}
// Aliases so scripts written against the earlier helper name keep working.
var dshKV = psKV;
var dshEsc = psEsc;
`;

function parseKv(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i)] = line.slice(i + 1).replace(/\\n/g, '\n');
  }
  return out;
}

const num = (v) => (v === '' || v === undefined || v === null ? null : Number(v));
const bool = (v) => String(v).toLowerCase() === 'true';

class Bridge {
  constructor() {
    this.child = null;
    this.ready = null;
    this.seq = 0;
    this.waiters = new Map();
    this.buffer = '';
    this.queue = Promise.resolve();
  }

  async ensure() {
    if (this.ready) return this.ready;
    this.ready = this._start();
    return this.ready;
  }

  _start() {
    return new Promise((resolve, reject) => {
      if (!fs.existsSync(BRIDGE)) return reject(new Error(`bridge script missing: ${BRIDGE}`));

      const child = spawn(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BRIDGE], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;

      const timer = setTimeout(() => {
        reject(new Error(`bridge did not become ready in ${BRIDGE_READY_TIMEOUT}ms`));
        try { child.kill(); } catch {}
        this.child = null;
        this.ready = null;
      }, BRIDGE_READY_TIMEOUT);

      const onLine = (line) => {
        line = line.trim();
        if (!line) return;
        let msg;
        try { msg = JSON.parse(line); } catch { log('bridge noise:', line.slice(0, 200)); return; }

        if (msg.type === 'ready') {
          clearTimeout(timer);
          if (!msg.ok) {
            reject(new Error(`COM attach failed: ${msg.error}`));
            this.child = null;
            this.ready = null;
            return;
          }
          log(`bridge ready: photoshop ${msg.version} (attach ${msg.attachMs}ms)`);
          resolve({ version: msg.version, attachMs: msg.attachMs });
          return;
        }
        const w = this.waiters.get(msg.id);
        if (w) { this.waiters.delete(msg.id); w(msg); }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        this.buffer += chunk;
        let idx;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          onLine(this.buffer.slice(0, idx));
          this.buffer = this.buffer.slice(idx + 1);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => log('ps-stderr:', d.trim().slice(0, 400)));

      child.on('exit', (code) => {
        log(`bridge exited (${code})`);
        this.child = null;
        this.ready = null;
        for (const [, w] of this.waiters) w({ ok: false, error: 'bridge exited' });
        this.waiters.clear();
      });
    });
  }

  async call(jsx, timeoutMs = DEFAULT_TIMEOUT, attempt = 0) {
    const MAX_ATTEMPTS = 4;
    const run = async () => {
      await this.ensure();
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiters.delete(id);
          log(`call ${id} timed out after ${timeoutMs}ms — recycling bridge`);
          try { this.child?.kill(); } catch {}
          this.child = null;
          this.ready = null;
          reject(new Error(`Photoshop did not answer within ${timeoutMs}ms (a modal dialog may be open)`));
        }, timeoutMs);

        this.waiters.set(id, (msg) => {
          clearTimeout(timer);
          if (!msg.ok) {
            const err = new Error(msg.error || 'unknown Photoshop error');
            err.busy = /0x8001010A|RPC_E_SERVERCALL_RETRYLATER|正在使用中|servercall_retrylater/i.test(err.message);
            return reject(err);
          }
          resolve(parseKv(msg.result));
        });

        try {
          this.child.stdin.write(JSON.stringify({ id, jsx: PRELUDE + jsx }) + '\n');
        } catch (e) {
          clearTimeout(timer);
          this.waiters.delete(id);
          reject(e);
        }
      });
    };
    // Serialize: Photoshop is single-threaded and DoJavaScript is not reentrant.
    const next = this.queue.then(run, run);
    this.queue = next.then(() => undefined, () => undefined);
    try {
      return await next;
    } catch (e) {
      // A busy application is transient; give it a moment and try again.
      if (e.busy && attempt < MAX_ATTEMPTS) {
        const wait = 400 * (attempt + 1);
        log(`Photoshop busy (${e.message.slice(0, 60)}) — retry ${attempt + 1}/${MAX_ATTEMPTS} in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        return this.call(jsx, timeoutMs, attempt + 1);
      }
      throw e;
    }
  }

  close() {
    try { this.child?.stdin.end(); } catch {}
    try { this.child?.kill(); } catch {}
    this.child = null;
    this.ready = null;
  }
}

const bridge = new Bridge();

const px = (v) => (v == null ? '' : JSON.stringify(v));

const TOOLS = [
  {
    name: 'ps_ping',
    description: 'Check that Photoshop is reachable through the COM bridge. Returns app name, version, open document count and locale.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await bridge.call(`dshKV({app: app.name, version: app.version, docs: app.documents.length, locale: $.locale});`, 60000);
      return { app: r.app, version: r.version, documents: num(r.docs), locale: r.locale };
    },
  },
  {
    name: 'ps_state',
    description: 'Describe the active Photoshop document: name, path, pixel size, resolution, colour mode, bit depth, layer counts, saved flag.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await bridge.call(`
        var o = {docs: app.documents.length};
        if (app.documents.length > 0) {
          var d = app.activeDocument;
          o.name = d.name;
          o.path = "";
          try { if (d.fullName) o.path = d.fullName.fsName; } catch (e) { o.path = ""; }
          o.width = d.width.as("px");
          o.height = d.height.as("px");
          o.resolution = d.resolution;
          o.mode = d.mode;
          o.bits = d.bitsPerChannel;
          o.layers = d.layers.length;
          o.artlayers = d.artLayers.length;
          o.saved = "";
          try { o.saved = d.saved; } catch (e) { o.saved = ""; }
        }
        dshKV(o);`, 60000);
      return {
        openDocuments: num(r.docs),
        document: r.name
          ? {
              name: r.name,
              path: r.path,
              width: num(r.width),
              height: num(r.height),
              resolution: num(r.resolution),
              mode: r.mode,
              bitsPerChannel: r.bits,
              topLevelLayers: num(r.layers),
              artLayers: num(r.artlayers),
              saved: bool(r.saved),
            }
          : null,
      };
    },
  },
  {
    name: 'ps_layers',
    description: 'List the layer tree of the active document (depth, type, name, visibility, opacity, kind).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const r = await bridge.call(`
        var out = [];
        function walk(c, depth) {
          for (var i = 0; i < c.layers.length; i++) {
            var L = c.layers[i];
            var kind = "";
            try { kind = L.kind ? String(L.kind) : ""; } catch (e) { kind = ""; }
            out.push(depth + "|" + L.typename + "|" + dshEsc(L.name) + "|" + L.visible + "|" + L.opacity + "|" + kind);
            if (L.typename == "LayerSet") walk(L, depth + 1);
          }
        }
        if (app.documents.length > 0) walk(app.activeDocument, 0);
        dshKV({count: out.length, tree: out.join(" ;; ")});`, 60000);
      const layers = (r.tree ? r.tree.split(' ;; ') : []).filter(Boolean).map((row) => {
        const [depth, type, name, visible, opacity, kind] = row.split('|');
        return { depth: Number(depth), type, name, visible: bool(visible), opacity: Number(opacity), kind };
      });
      return { count: layers.length, layers };
    },
  },
  {
    name: 'ps_run_jsx',
    description:
      'Escape hatch: run raw Adobe ExtendScript (JSX) inside Photoshop and get the returned value back. The script must end with an expression; object literals are not available — return a string, or build `key=value` lines for structured data. Any Photoshop DOM API is reachable here.',
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
      const r = await bridge.call(args.code, args.timeout_ms || DEFAULT_TIMEOUT);
      return { result: r, note: 'key=value lines parsed from the ExtendScript return value' };
    },
  },
  {
    name: 'ps_open',
    description: 'Open an image or PSD file in Photoshop and make it active.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to the file.' } },
      required: ['path'],
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await bridge.call(`
        var f = new File(${JSON.stringify(args.path)});
        if (!f.exists) { dshKV({ok: "false", error: "file not found: " + ${JSON.stringify(args.path)}}); }
        else {
          var d = app.open(f);
          dshKV({ok: "true", name: d.name, path: d.fullName.fsName, width: d.width.as("px"), height: d.height.as("px"), mode: d.mode});
        }`, 180000);
      if (r.ok !== 'true') throw new Error(r.error || 'open failed');
      return { opened: r.name, path: r.path, width: num(r.width), height: num(r.height), mode: r.mode };
    },
  },
  {
    name: 'ps_new_document',
    description: 'Create a new RGB document and make it active.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Width in pixels.' },
        height: { type: 'number', description: 'Height in pixels.' },
        dpi: { type: 'number', description: 'Resolution, default 72.' },
        name: { type: 'string', description: 'Document name.' },
        fill: { type: 'string', enum: ['white', 'transparent', 'background'], description: 'Initial fill, default white.' },
      },
      required: ['width', 'height'],
      additionalProperties: false,
    },
    run: async (args) => {
      const fillMap = { white: 'DocumentFill.WHITE', transparent: 'DocumentFill.TRANSPARENT', background: 'DocumentFill.BACKGROUNDCOLOR' };
      const fill = fillMap[String(args.fill || 'white')] || 'DocumentFill.WHITE';
      const r = await bridge.call(`
        var d = app.documents.add(${Number(args.width)}, ${Number(args.height)}, ${Number(args.dpi || 72)}, ${JSON.stringify(args.name || 'Untitled-DSH')}, NewDocumentMode.RGB, ${fill});
        dshKV({name: d.name, width: d.width.as("px"), height: d.height.as("px"), resolution: d.resolution});`, 120000);
      return { created: r.name, width: num(r.width), height: num(r.height), resolution: num(r.resolution) };
    },
  },
  {
    name: 'ps_save',
    description: 'Save the active document. Without `path` it saves in place; with `path` it writes PSD (or the extension you give) and optionally keeps the current document path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute target path, e.g. D:/out/render.psd.' },
        as_copy: { type: 'boolean', description: 'Save a copy and keep the original document open/unchanged (default true).' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const asCopy = args.as_copy === undefined ? true : Boolean(args.as_copy);
      const jsx = args.path
        ? `
        var d = app.activeDocument;
        var f = new File(${JSON.stringify(args.path)});
        d.saveAs(f, new PhotoshopSaveOptions(), ${asCopy}, Extension.LOWERCASE);
        dshKV({ok: "true", path: f.fsName, exists: f.exists, bytes: f.length});`
        : `
        var d = app.activeDocument;
        var p = "";
        try { if (d.fullName) p = d.fullName.fsName; } catch (e) { p = ""; }
        if (p === "") { dshKV({ok: "false", error: "document has never been saved (no path) - pass an explicit path"}); }
        else {
          d.save();
          var f = new File(p);
          dshKV({ok: "true", path: f.fsName, exists: f.exists, bytes: f.length});
        }`;
      const r = await bridge.call(jsx, 180000);
      if (r.ok !== 'true') throw new Error(r.error || 'save failed');
      return { path: r.path, exists: bool(r.exists), bytes: num(r.bytes) };
    },
  },
  {
    name: 'ps_export',
    description: 'Export the active document as a flattened raster or PSD file (png / jpg / psd).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute target path; its extension selects the format.' },
        format: { type: 'string', enum: ['png', 'jpg', 'psd'], description: 'Default: taken from the path extension, else png.' },
        quality: { type: 'number', description: 'JPEG quality 1-12, default 10.' },
        embed_profile: { type: 'boolean', description: 'PNG: embed the colour profile (default false).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    run: async (args) => {
      const ext = (args.format || path.extname(args.path).replace('.', '') || 'png').toLowerCase();
      const opt =
        ext === 'jpg' || ext === 'jpeg'
          ? `var o = new JPEGSaveOptions(); o.quality = ${Number(args.quality || 10)}; o.embedColorProfile = true;`
          : ext === 'psd'
          ? `var o = new PhotoshopSaveOptions();`
          : `var o = new PNGSaveOptions(); o.compression = 6; o.interlaced = false;`;
      const r = await bridge.call(`
        var d = app.activeDocument;
        var f = new File(${JSON.stringify(args.path)});
        ${opt}
        d.saveAs(f, o, true, Extension.LOWERCASE);
        dshKV({ok: "true", path: f.fsName, exists: f.exists, bytes: f.length, format: ${JSON.stringify(ext)}});`, 180000);
      if (r.ok !== 'true') throw new Error(r.error || 'export failed');
      return { path: r.path, format: r.format, exists: bool(r.exists), bytes: num(r.bytes) };
    },
  },
  {
    name: 'ps_resize',
    description:
      'Resize the image (resample pixels) or the canvas of the active document. In canvas mode the existing pixels keep their size and the canvas is re-anchored.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Target width in pixels (omit to keep current).' },
        height: { type: 'number', description: 'Target height in pixels (omit to keep current).' },
        resolution: { type: 'number', description: 'Target DPI (omit to keep current).' },
        mode: { type: 'string', enum: ['image', 'canvas'], description: 'image = resample, canvas = change canvas size. Default image.' },
        anchor: {
          type: 'string',
          enum: ['topLeft', 'top', 'topRight', 'left', 'center', 'right', 'bottomLeft', 'bottom', 'bottomRight'],
          description: 'Canvas anchor, default center.',
        },
        constrain: { type: 'boolean', description: 'Keep aspect ratio in image mode (default true).' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const mode = args.mode || 'image';
      if (mode === 'canvas') {
        const anchors = {
          topLeft: 'AnchorPosition.TOPLEFT',
          top: 'AnchorPosition.TOPCENTER',
          topRight: 'AnchorPosition.TOPRIGHT',
          left: 'AnchorPosition.MIDDLELEFT',
          center: 'AnchorPosition.MIDDLECENTER',
          right: 'AnchorPosition.MIDDLERIGHT',
          bottomLeft: 'AnchorPosition.BOTTOMLEFT',
          bottom: 'AnchorPosition.BOTTOMCENTER',
          bottomRight: 'AnchorPosition.BOTTOMRIGHT',
        };
        const anchor = anchors[args.anchor || 'center'] || 'AnchorPosition.MIDDLECENTER';
        const r = await bridge.call(
          `
          var d = app.activeDocument;
          d.resizeCanvas(${args.width ? `UnitValue(${Number(args.width)}, "px")` : 'd.width'}, ${
            args.height ? `UnitValue(${Number(args.height)}, "px")` : 'd.height'
          }, ${anchor});
          dshKV({width: d.width.as("px"), height: d.height.as("px"), resolution: d.resolution});`,
          180000
        );
        return { mode, width: num(r.width), height: num(r.height), resolution: num(r.resolution) };
      }

      const constrain = args.constrain === undefined ? true : Boolean(args.constrain);
      const r = await bridge.call(
        `
        var d = app.activeDocument;
        var w = ${args.width ? `UnitValue(${Number(args.width)}, "px")` : 'null'};
        var h = ${args.height ? `UnitValue(${Number(args.height)}, "px")` : 'null'};
        d.resizeImage(w, h, ${args.resolution ? Number(args.resolution) : 'd.resolution'}, ResampleMethod.BICUBICSHARPER);
        dshKV({width: d.width.as("px"), height: d.height.as("px"), resolution: d.resolution});`,
        300000
      );
      return { mode, width: num(r.width), height: num(r.height), resolution: num(r.resolution), constrained: constrain };
    },
  },
  {
    name: 'ps_crop',
    description: 'Crop the active document to a rectangle given in pixels from the top-left corner.',
    inputSchema: {
      type: 'object',
      properties: {
        left: { type: 'number', description: 'Left edge in pixels.' },
        top: { type: 'number', description: 'Top edge in pixels.' },
        right: { type: 'number', description: 'Right edge in pixels.' },
        bottom: { type: 'number', description: 'Bottom edge in pixels.' },
      },
      required: ['left', 'top', 'right', 'bottom'],
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await bridge.call(
        `
        var d = app.activeDocument;
        d.crop([UnitValue(${Number(args.left)}, "px"), UnitValue(${Number(args.top)}, "px"),
                UnitValue(${Number(args.right)}, "px"), UnitValue(${Number(args.bottom)}, "px")]);
        dshKV({width: d.width.as("px"), height: d.height.as("px")});`,
        180000
      );
      return { width: num(r.width), height: num(r.height) };
    },
  },
  {
    name: 'ps_filter',
    description:
      'Apply a destructive filter to the active layer. Only filters verified to work on this Photoshop build are listed: gaussian_blur, motion_blur, box_blur, high_pass, sharpen, sharpen_edges, sharpen_more, unsharp_mask, smart_blur, median, dust_and_scratches, add_noise, despeckle, blur, blur_more, lens_blur, radial_blur, maximum, minimum, offset.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: [
            'gaussian_blur',
            'motion_blur',
            'box_blur',
            'high_pass',
            'sharpen',
            'sharpen_edges',
            'sharpen_more',
            'unsharp_mask',
            'smart_blur',
            'median',
            'dust_and_scratches',
            'add_noise',
            'despeckle',
            'blur',
            'blur_more',
            'lens_blur',
            'radial_blur',
            'maximum',
            'minimum',
            'offset',
          ],
          description: 'Filter to apply.',
        },
        radius: { type: 'number', description: 'Radius in pixels (blur / high-pass / median / maximum / minimum).' },
        angle: { type: 'number', description: 'motion_blur: angle in degrees.' },
        distance: { type: 'number', description: 'motion_blur: distance in pixels.' },
        amount: { type: 'number', description: 'unsharp_mask / add_noise: amount.' },
        threshold: { type: 'number', description: 'unsharp_mask / smart_blur / dust_and_scratches: threshold.' },
        quality: { type: 'number', description: 'smart_blur quality: 1 = high, 2 = medium, 3 = low.' },
        x: { type: 'number', description: 'offset: horizontal shift in pixels.' },
        y: { type: 'number', description: 'offset: vertical shift in pixels.' },
        wrap: { type: 'boolean', description: 'offset: wrap around edges (default true).' },
      },
      required: ['filter'],
      additionalProperties: false,
    },
    run: async (args) => {
      const f = String(args.filter);
      const radius = Number(args.radius === undefined ? 5 : args.radius);
      const calls = {
        gaussian_blur: `layer.applyGaussianBlur(${radius});`,
        motion_blur: `layer.applyMotionBlur(${Number(args.angle || 0)}, ${Number(args.distance === undefined ? 20 : args.distance)});`,
        box_blur: `layer.applyBoxBlur(${radius});`,
        high_pass: `layer.applyHighPass(${radius});`,
        sharpen: `layer.applySharpen();`,
        sharpen_edges: `layer.applySharpenEdges();`,
        sharpen_more: `layer.applySharpenMore();`,
        unsharp_mask: `layer.applyUnSharpMask(${Number(args.amount === undefined ? 100 : args.amount)}, ${radius}, ${Number(args.threshold === undefined ? 0 : args.threshold)});`,
        smart_blur: `layer.applySmartBlur(${radius}, ${Number(args.threshold === undefined ? 25 : args.threshold)}, SmartBlurQuality.HIGH);`,
        median: `layer.applyMedianNoise(${radius});`,
        dust_and_scratches: `layer.applyDustAndScratches(${radius}, ${Number(args.threshold === undefined ? 0 : args.threshold)});`,
        add_noise: `layer.applyAddNoise(${Number(args.amount === undefined ? 10 : args.amount)}, NoiseDistribution.GAUSSIAN, true);`,
        despeckle: `layer.applyDespeckle();`,
        blur: `layer.applyBlur();`,
        blur_more: `layer.applyBlurMore();`,
        lens_blur: `layer.applyLensBlur();`,
        radial_blur: `layer.applyRadialBlur(${Number(args.amount === undefined ? 10 : args.amount)}, RadialBlurMethod.SPIN, RadialBlurQuality.GOOD);`,
        maximum: `layer.applyMaximum(${radius});`,
        minimum: `layer.applyMinimum(${radius});`,
        offset: `layer.applyOffset(${Number(args.x || 0)}, ${Number(args.y || 0)}, ${args.wrap === false ? 'OffsetUndefinedAreas.SETTOBACKGROUND' : 'OffsetUndefinedAreas.WRAPAROUND'});`,
      };
      const call = calls[f];
      if (!call) throw new Error(`unknown filter: ${f}`);
      const r = await bridge.call(
        `
        var d = app.activeDocument;
        var layer = d.activeLayer;
        var name = layer.name;
        ${call}
        psKV({layer: name, filter: ${JSON.stringify(f)}});`,
        600000
      );
      return { layer: r.layer, filter: r.filter, applied: true };
    },
  },
  {
    name: 'ps_adjust',
    description:
      'Apply a tonal or colour adjustment to the active layer. Only adjustments verified on this Photoshop build are exposed — the Action Manager "setd" route is unavailable on Photoshop 2026, so hue_saturation, vibrance and exposure are not offered: brightness_contrast, levels, curves, color_balance, threshold, posterize, photo_filter, shadow_highlight, desaturate, invert, auto_contrast, auto_levels, equalize.',
    inputSchema: {
      type: 'object',
      properties: {
        adjustment: {
          type: 'string',
          enum: [
            'brightness_contrast',
            'levels',
            'curves',
            'color_balance',
            'threshold',
            'posterize',
            'photo_filter',
            'shadow_highlight',
            'desaturate',
            'invert',
            'auto_contrast',
            'auto_levels',
            'equalize',
          ],
          description: 'Adjustment to apply.',
        },
        brightness: { type: 'number', description: 'brightness_contrast: -150..150.' },
        contrast: { type: 'number', description: 'brightness_contrast: -100..100.' },
        input_min: { type: 'number', description: 'levels: input black point 0..255.' },
        input_max: { type: 'number', description: 'levels: input white point 0..255.' },
        gamma: { type: 'number', description: 'levels: gamma, default 1.' },
        output_min: { type: 'number', description: 'levels: output black 0..255.' },
        output_max: { type: 'number', description: 'levels: output white 0..255.' },
        curve: {
          type: 'array',
          description: 'curves: array of [input, output] pairs in 0..255, e.g. [[0,0],[128,150],[255,255]].',
          items: { type: 'array', items: { type: 'number' } },
        },
        shadow_cyan: { type: 'number', description: 'color_balance: shadows cyan/red, -100..100.' },
        shadow_magenta: { type: 'number', description: 'color_balance: shadows magenta/green.' },
        shadow_yellow: { type: 'number', description: 'color_balance: shadows yellow/blue.' },
        mid_cyan: { type: 'number', description: 'color_balance: midtones cyan/red.' },
        mid_magenta: { type: 'number', description: 'color_balance: midtones magenta/green.' },
        mid_yellow: { type: 'number', description: 'color_balance: midtones yellow/blue.' },
        high_cyan: { type: 'number', description: 'color_balance: highlights cyan/red.' },
        high_magenta: { type: 'number', description: 'color_balance: highlights magenta/green.' },
        high_yellow: { type: 'number', description: 'color_balance: highlights yellow/blue.' },
        preserve_luminosity: { type: 'boolean', description: 'color_balance: default true.' },
        level: { type: 'number', description: 'threshold: 1..255.' },
        levels_count: { type: 'number', description: 'posterize: 2..255.' },
        filter_color: { type: 'string', description: 'photo_filter: hex colour, e.g. "EC8A00".' },
        density: { type: 'number', description: 'photo_filter: 1..100, default 25.' },
        shadows_amount: { type: 'number', description: 'shadow_highlight: shadows amount 0..100.' },
        highlights_amount: { type: 'number', description: 'shadow_highlight: highlights amount 0..100.' },
      },
      required: ['adjustment'],
      additionalProperties: false,
    },
    run: async (args) => {
      const a = String(args.adjustment);
      const n = (v, d) => Number(v === undefined ? d : v);

      const calls = {
        brightness_contrast: `layer.adjustBrightnessContrast(${n(args.brightness, 0)}, ${n(args.contrast, 0)});`,
        levels: `layer.adjustLevels(${n(args.input_min, 0)}, ${n(args.input_max, 255)}, ${n(args.gamma, 1)}, ${n(args.output_min, 0)}, ${n(args.output_max, 255)});`,
        curves: (() => {
          const pts = Array.isArray(args.curve) && args.curve.length >= 2 ? args.curve : [[0, 0], [255, 255]];
          const pairs = pts.map((p) => `[${Number(p[0])}, ${Number(p[1])}]`).join(', ');
          return `var pts = [${pairs}]; var cv = new Array(); for (var i = 0; i < pts.length; i++) cv[i] = pts[i]; layer.adjustCurves(cv);`;
        })(),
        color_balance: `layer.adjustColorBalance(
            [${n(args.shadow_cyan, 0)}, ${n(args.shadow_magenta, 0)}, ${n(args.shadow_yellow, 0)}],
            [${n(args.mid_cyan, 0)}, ${n(args.mid_magenta, 0)}, ${n(args.mid_yellow, 0)}],
            [${n(args.high_cyan, 0)}, ${n(args.high_magenta, 0)}, ${n(args.high_yellow, 0)}],
            ${args.preserve_luminosity === false ? 'false' : 'true'});`,
        threshold: `layer.threshold(${n(args.level, 128)});`,
        posterize: `layer.posterize(${n(args.levels_count, 4)});`,
        photo_filter: `var col = new SolidColor(); col.rgb.hexValue = ${JSON.stringify(args.filter_color || 'EC8A00')}; layer.photoFilter(col, ${n(args.density, 25)}, true);`,
        shadow_highlight: `layer.shadowHighlight(${n(args.shadows_amount, 25)}, ${n(args.highlights_amount, 20)}, 30, 20);`,
        desaturate: 'layer.desaturate();',
        invert: 'layer.invert();',
        auto_contrast: 'layer.autoContrast();',
        auto_levels: 'layer.autoLevels();',
        equalize: 'layer.equalize();',
      };

      const call = calls[a];
      if (!call) throw new Error(`unknown adjustment: ${a} (not available on this Photoshop build)`);

      const r = await bridge.call(
        `
        var d = app.activeDocument;
        var layer = d.activeLayer;
        var nm = layer.name;
        ${call}
        psKV({layer: nm, adjustment: ${JSON.stringify(a)}});`,
        600000
      );
      return { layer: r.layer, adjustment: r.adjustment, applied: true };
    },
  },
  {
    name: 'ps_layer_mask',
    description:
      'Add or remove a layer mask: reveal_all, hide_all, from_selection, delete. Uses the Action Manager "Mk" command, which works on this build (the DOM has no mask methods).',
    inputSchema: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: 'Layer name (default: the active layer).' },
        action: {
          type: 'string',
          enum: ['reveal_all', 'hide_all', 'from_selection', 'delete'],
          description: 'Mask operation. Default reveal_all.',
        },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const action = args.action || 'reveal_all';
      const using = {
        reveal_all: 'charIDToTypeID("RvlA")',
        hide_all: 'charIDToTypeID("HdAl")',
        from_selection: 'charIDToTypeID("RvlS")',
      };
      let jsx;
      if (action === 'delete') {
        jsx = `
        var desc = new ActionDescriptor();
        var ref = new ActionReference();
        ref.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("Msk "));
        desc.putReference(charIDToTypeID("null"), ref);
        executeAction(charIDToTypeID("Dlt "), desc, DialogModes.NO);`;
      } else {
        const u = using[action];
        if (!u) throw new Error(`unknown action: ${action}`);
        jsx = `
        var desc = new ActionDescriptor();
        desc.putClass(charIDToTypeID("Nw  "), charIDToTypeID("Chnl"));
        var ref = new ActionReference();
        ref.putEnumerated(charIDToTypeID("Chnl"), charIDToTypeID("Chnl"), charIDToTypeID("Msk "));
        desc.putReference(charIDToTypeID("At  "), ref);
        desc.putEnumerated(charIDToTypeID("Usng"), charIDToTypeID("UsrM"), ${u});
        executeAction(charIDToTypeID("Mk  "), desc, DialogModes.NO);`;
      }

      const r = await bridge.call(
        `
        var d = app.activeDocument;
        var layer = ${args.layer ? `d.layers.getByName(${JSON.stringify(args.layer)})` : 'd.activeLayer'};
        var nm = layer.name;
        ${jsx}
        psKV({layer: nm, action: ${JSON.stringify(action)}});`,
        180000
      );
      return { layer: r.layer, action: r.action };
    },
  },
  {
    name: 'ps_place',
    description: 'Place an image or PSD into the active document as a smart object.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to place.' },
        scale: { type: 'number', description: 'Scale percentage applied after placing (default 100).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await bridge.call(
        `
        var d = app.activeDocument;
        var f = new File(${JSON.stringify(args.path)});
        if (!f.exists) { dshKV({ok: "false", error: "file not found: " + ${JSON.stringify(args.path)}}); }
        else {
          var desc = new ActionDescriptor();
          desc.putPath(charIDToTypeID("null"), f);
          desc.putEnumerated(charIDToTypeID("FTcs"), charIDToTypeID("QCSt"), charIDToTypeID("Qcsa"));
          executeAction(charIDToTypeID("Plc "), desc, DialogModes.NO);
          var placed = d.activeLayer;
          var scale = ${Number(args.scale || 100)};
          if (scale !== 100) { placed.resize(scale, scale, AnchorPosition.MIDDLECENTER); }
          dshKV({ok: "true", layer: placed.name, kind: String(placed.kind), layers: d.layers.length});
        }`,
        300000
      );
      if (r.ok !== 'true') throw new Error(r.error || 'place failed');
      return { layer: r.layer, kind: r.kind, layers: num(r.layers) };
    },
  },
  {
    name: 'ps_text',
    description: 'Add a text layer to the active document.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text content.' },
        name: { type: 'string', description: 'Layer name (default: the text itself).' },
        font_size: { type: 'number', description: 'Font size in points (default 48).' },
        color: { type: 'string', description: 'Hex colour, e.g. "FFFFFF" (default black).' },
        x: { type: 'number', description: 'Left position in pixels (default 40).' },
        y: { type: 'number', description: 'Baseline-ish top position in pixels (default 120).' },
        font: { type: 'string', description: 'PostScript font name, e.g. "ArialMT".' },
        justification: { type: 'string', enum: ['left', 'center', 'right'], description: 'Default left.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    run: async (args) => {
      const j = {
        left: 'Justification.LEFT',
        center: 'Justification.CENTER',
        right: 'Justification.RIGHT',
      }[args.justification || 'left'] || 'Justification.LEFT';
      const r = await bridge.call(
        `
        var d = app.activeDocument;
        var t = d.artLayers.add();
        t.kind = LayerKind.TEXT;
        t.name = ${JSON.stringify(args.name || args.text)};
        t.textItem.contents = ${JSON.stringify(args.text)};
        t.textItem.size = ${Number(args.font_size || 48)};
        var c = new SolidColor();
        c.rgb.hexValue = ${JSON.stringify(args.color || '000000')};
        t.textItem.color = c;
        t.textItem.justification = ${j};
        ${args.font ? `try { t.textItem.font = ${JSON.stringify(args.font)}; } catch (e) {}` : ''}
        t.textItem.position = [UnitValue(${Number(args.x === undefined ? 40 : args.x)}, "px"), UnitValue(${Number(args.y === undefined ? 120 : args.y)}, "px")];
        dshKV({layer: t.name, layers: d.layers.length});`,
        180000
      );
      return { layer: r.layer, layers: num(r.layers) };
    },
  },
  {
    name: 'ps_delete_layer',
    description: 'Delete a layer by name (default: the active layer).',
    inputSchema: {
      type: 'object',
      properties: { layer: { type: 'string', description: 'Layer name (default: the active layer).' } },
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await bridge.call(
        `
        var d = app.activeDocument;
        var layer = ${args.layer ? `d.layers.getByName(${JSON.stringify(args.layer)})` : 'd.activeLayer'};
        var nm = layer.name;
        layer.remove();
        dshKV({removed: nm, layers: d.layers.length});`,
        120000
      );
      return { removed: r.removed, layers: num(r.layers) };
    },
  },
  {
    name: 'ps_duplicate_layer',
    description: 'Duplicate a layer and optionally rename the copy.',
    inputSchema: {
      type: 'object',
      properties: {
        layer: { type: 'string', description: 'Layer name (default: the active layer).' },
        name: { type: 'string', description: 'Name for the copy.' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await bridge.call(
        `
        var d = app.activeDocument;
        var layer = ${args.layer ? `d.layers.getByName(${JSON.stringify(args.layer)})` : 'd.activeLayer'};
        var copy = layer.duplicate();
        ${args.name ? `copy.name = ${JSON.stringify(args.name)};` : ''}
        d.activeLayer = copy;
        dshKV({layer: copy.name, layers: d.layers.length});`,
        120000
      );
      return { layer: r.layer, layers: num(r.layers) };
    },
  },
  {
    name: 'ps_select_layer',
    description: 'Make a layer active by name.',
    inputSchema: {
      type: 'object',
      properties: { layer: { type: 'string', description: 'Layer name.' } },
      required: ['layer'],
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await bridge.call(
        `
        var d = app.activeDocument;
        d.activeLayer = d.layers.getByName(${JSON.stringify(args.layer)});
        dshKV({active: d.activeLayer.name, kind: String(d.activeLayer.kind)});`,
        120000
      );
      return { active: r.active, kind: r.kind };
    },
  },
  {
    name: 'ps_play_action',
    description:
      'Play a recorded Photoshop action. The action set must already be loaded in the Actions panel.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action name.' },
        set: { type: 'string', description: 'Action set name.' },
      },
      required: ['action', 'set'],
      additionalProperties: false,
    },
    run: async (args) => {
      const r = await bridge.call(
        `app.doAction(${JSON.stringify(args.action)}, ${JSON.stringify(args.set)}); dshKV({played: ${JSON.stringify(args.action + ' / ' + args.set)}});`,
        900000
      );
      return { played: r.played };
    },
  },
  {
    name: 'ps_flatten',
    description: 'Flatten the active document, or merge visible layers only.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['flatten', 'merge_visible'], description: 'Default flatten.' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const mode = args.mode || 'flatten';
      const op = mode === 'merge_visible' ? 'd.mergeVisibleLayers();' : 'd.flatten();';
      const r = await bridge.call(`var d = app.activeDocument; ${op} dshKV({layers: d.layers.length});`, 300000);
      return { mode, layers: num(r.layers) };
    },
  },
  {
    name: 'ps_history',
    description:
      'Step through the document history: undo, redo, or list the available history states. Undo/redo move activeHistoryState, because Document has no undo()/redo() in the DOM and the Action Manager "setd" route is unavailable on Photoshop 2026.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['undo', 'redo', 'list'], description: 'Default undo.' },
        steps: { type: 'number', description: 'How many steps to undo/redo (default 1).' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const action = args.action || 'undo';
      const steps = Number(args.steps || 1);

      if (action === 'list') {
        const r = await bridge.call(
          `
          var d = app.activeDocument;
          var h = d.historyStates;
          var names = [];
          var current = -1;
          for (var i = 0; i < h.length; i++) {
            names.push(h[i].name);
            if (h[i] === d.activeHistoryState) current = i;
          }
          psKV({count: names.length, currentIndex: current, states: names.join(" ;; ")});`,
          120000
        );
        const states = (r.states ? r.states.split(' ;; ') : []).filter(Boolean);
        return { count: states.length, currentIndex: num(r.currentIndex), current: states[num(r.currentIndex)], states };
      }

      const delta = action === 'redo' ? steps : -steps;
      const r = await bridge.call(
        `
        var d = app.activeDocument;
        var h = d.historyStates;
        var idx = -1;
        for (var i = 0; i < h.length; i++) { if (h[i] === d.activeHistoryState) idx = i; }
        var target = idx + (${delta});
        if (target < 0) target = 0;
        if (target > h.length - 1) target = h.length - 1;
        d.activeHistoryState = h[target];
        psKV({from: idx, to: target, current: d.activeHistoryState.name});`,
        180000
      );
      return { action, from: num(r.from), to: num(r.to), current: r.current };
    },
  },
  {
    name: 'ps_close',
    description: 'Close the active document, optionally saving first.',
    inputSchema: {
      type: 'object',
      properties: {
        save: { type: 'boolean', description: 'Save before closing (default false = discard changes).' },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const save = Boolean(args.save);
      const r = await bridge.call(
        `
        var d = app.activeDocument;
        var nm = d.name;
        d.close(${save ? 'SaveOptions.SAVECHANGES' : 'SaveOptions.DONOTSAVECHANGES'});
        dshKV({closed: nm, remaining: app.documents.length});`,
        300000
      );
      return { closed: r.closed, remaining: num(r.remaining) };
    },
  },
  {
    name: 'ps_batch',
    description:
      'Process every file in a folder: open, optionally play an action, optionally resize, export to another folder, close. Returns one row per file.',
    inputSchema: {
      type: 'object',
      properties: {
        input_dir: { type: 'string', description: 'Absolute source folder.' },
        output_dir: { type: 'string', description: 'Absolute destination folder.' },
        pattern: { type: 'string', description: 'Filename pattern, default "*.*".' },
        format: { type: 'string', enum: ['png', 'jpg', 'psd'], description: 'Output format, default png.' },
        quality: { type: 'number', description: 'JPEG quality 1-12, default 10.' },
        resize_width: { type: 'number', description: 'Resize to this width before export (keeps aspect).' },
        action: { type: 'string', description: 'Action to play on each file.' },
        set: { type: 'string', description: 'Action set for `action`.' },
      },
      required: ['input_dir', 'output_dir'],
      additionalProperties: false,
    },
    run: async (args) => {
      const fmt = (args.format || 'png').toLowerCase();
      const opt =
        fmt === 'jpg'
          ? `var o = new JPEGSaveOptions(); o.quality = ${Number(args.quality || 10)}; o.embedColorProfile = true;`
          : fmt === 'psd'
          ? `var o = new PhotoshopSaveOptions();`
          : `var o = new PNGSaveOptions(); o.compression = 6; o.interlaced = false;`;
      const r = await bridge.call(
        `
        var srcDir = new Folder(${JSON.stringify(args.input_dir)});
        var outDir = new Folder(${JSON.stringify(args.output_dir)});
        if (!srcDir.exists) { dshKV({ok: "false", error: "input folder not found"}); }
        else {
          if (!outDir.exists) outDir.create();
          var files = srcDir.getFiles(${JSON.stringify(args.pattern || '*.*')});
          var rows = [];
          var done = 0, failed = 0;
          for (var i = 0; i < files.length; i++) {
            var f = files[i];
            if (f instanceof Folder) continue;
            var doc = null;
            try {
              doc = app.open(f);
              ${args.action && args.set ? `app.doAction(${JSON.stringify(args.action)}, ${JSON.stringify(args.set)});` : ''}
              ${
                args.resize_width
                  ? `var ratio = ${Number(args.resize_width)} / doc.width.as("px"); doc.resizeImage(UnitValue(${Number(args.resize_width)}, "px"), null, doc.resolution, ResampleMethod.BICUBICSHARPER);`
                  : ''
              }
              var base = doc.name.replace(/\\.[^.]+$/, "");
              var outFile = new File(outDir.fsName + "/" + base + "." + ${JSON.stringify(fmt)});
              ${opt}
              doc.saveAs(outFile, o, true, Extension.LOWERCASE);
              rows.push(base + "|ok|" + outFile.length);
              done++;
              doc.close(SaveOptions.DONOTSAVECHANGES);
            } catch (e) {
              rows.push((doc ? doc.name : f.name) + "|fail|" + String(e.message).replace(/[\\r\\n|]+/g, " "));
              failed++;
              try { if (doc) doc.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {}
            }
          }
          dshKV({ok: "true", total: files.length, done: done, failed: failed, rows: rows.join(" ;; ")});
        }`,
        1800000
      );
      if (r.ok !== 'true') throw new Error(r.error || 'batch failed');
      const results = (r.rows ? r.rows.split(' ;; ') : []).filter(Boolean).map((row) => {
        const [file, status, detail] = row.split('|');
        return { file, status, detail: status === 'ok' ? Number(detail) : detail };
      });
      return { total: num(r.total), done: num(r.done), failed: num(r.failed), results };
    },
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------- MCP stdio loop ----------------

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const SERVER_INFO = { name: 'photoshop', version: '1.0.0' };
const INSTRUCTIONS =
  'Drives the local Adobe Photoshop on this Windows machine through COM + ExtendScript. ' +
  'Prefer the specific tools; use ps_run_jsx for anything not wrapped. Photoshop must be running ' +
  '(the bridge will launch it on first use, which can take ~30-60s).';

function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        if (isRequest) {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: requested || '2025-06-18',
              capabilities: { tools: { listChanged: false } },
              serverInfo: SERVER_INFO,
              instructions: INSTRUCTIONS,
            },
          });
        }
        return;
      }
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
              tools: TOOLS.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              })),
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
    } catch (e) {
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

log(`photoshop up. bridge=${BRIDGE}${PS_EXE ? ' ps=' + PS_EXE : ''}`);