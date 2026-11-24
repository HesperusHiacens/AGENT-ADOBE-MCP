# agent-photoshop-mcp

> Part of [AGENT-ADOBE-MCP](../../README.md). The After Effects server lives in [`packages/aftereffects`](../aftereffects).

**Drive your local Adobe Photoshop from any MCP client — with a persistent COM bridge instead of a fresh script process per call.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)](#requirements)

An [MCP](https://modelcontextprotocol.io) server (stdio) that talks to Photoshop over COM + ExtendScript. No UXP plugin, no CEP panel, no Developer Mode, no `.ccx` to install — Photoshop just has to be installed (and it will even be launched by COM on first use).

Measured on Photoshop 27.0.0: **COM attach 44–78 ms once, then 50–90 ms per tool call**. Servers that spawn `cscript` per call typically take seconds — on Photoshop 2026 some of them stall for ~30 s.

---

## Why this exists

Photoshop's automation surface on Windows is COM (`Photoshop.Application`) plus `DoJavaScript` for ExtendScript. That works well, but every call to `New-Object -ComObject` / `CreateObject` pays for a process spawn and a COM handshake, and a fresh `cscript` per tool call makes an agent feel like it is thinking when it is really waiting.

This project keeps **one** PowerShell process alive holding **one** COM connection, and streams ExtendScript over a newline-delimited JSON pipe. The MCP layer on top is a hand-written JSON-RPC loop with zero dependencies.

```
MCP client (DSH / Claude Desktop / Cursor / ...)
  └─ node src/index.mjs              ← MCP server, 8 tools, no deps
       └─ powershell -File src/bridge.ps1   ← long-lived, COM attach once
            └─ Photoshop.Application
                 └─ app.DoJavaScript(<ExtendScript>)
```

---

## Requirements

| | |
|---|---|
| OS | Windows (COM automation; macOS uses AppleScript and is not covered here) |
| Photoshop | Any version that still registers the `Photoshop.Application` ProgID — verified on **Photoshop 2026 (27.0.0)** |
| Node | 18 or newer |
| PowerShell | Windows PowerShell 5.1 (built in) |

Check that the ProgID is registered:

```powershell
Get-ItemProperty 'Registry::HKEY_CLASSES_ROOT\Photoshop.Application\CLSID'
```

---

## Install

```bash
git clone https://github.com/<you>/AGENT-PHOTOSHOP-MCP.git
cd AGENT-PHOTOSHOP-MCP
node scripts/selftest.mjs      # 9 checks, creates and deletes a throwaway document
```

There is nothing to build and nothing to `npm install`.

### Register with your MCP client

**DSH** (writes `cordis.patch.yml`, backs up the previous file):

```bash
node scripts/install.mjs --target dsh            # add --dry-run to preview
```

**Claude Desktop / Cursor / VS Code:**

```bash
node scripts/install.mjs --target claude         # claude_desktop_config.json
node scripts/install.mjs --target cursor         # ~/.cursor/mcp.json
node scripts/install.mjs --target vscode         # .vscode/mcp.json
```

**Anything else** — print the snippet and paste it in:

```bash
node scripts/install.mjs --print
```

```json
{
  "mcpServers": {
    "photoshop": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\path\\to\\AGENT-ADOBE-MCP\\packages\\photoshop\\src\\index.mjs"],
      "env": { "PS_TIMEOUT_MS": "120000" }
    }
  }
}
```

> Use an **absolute** `command`. Hosts launch MCP servers with a scrubbed environment, and some (DSH included) drop any variable whose name matches `TOKEN|KEY|SECRET|PASSWORD`, so `npx`/`node` may not resolve from `PATH`.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PS_PROGID` | `Photoshop.Application` | COM ProgID. Set a versioned one (e.g. `Photoshop.Application.200`) if several versions are registered |
| `PS_POWERSHELL` | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` | PowerShell executable |
| `PS_TIMEOUT_MS` | `120000` | Per-call timeout |
| `PS_READY_TIMEOUT_MS` | `180000` | How long to wait for COM to attach (first launch of Photoshop is slow) |

---

## Tools

**23 tools.** `ps_run_jsx` is the whole Photoshop DOM; the rest are shortcuts for the calls you make constantly.

### Documents

| Tool | What it does |
|---|---|
| `ps_ping` | app name, version, open document count, locale |
| `ps_state` | active document: name, path, pixel size, resolution, mode, bit depth, layer counts, saved flag |
| `ps_open` | open an image/PSD and make it active |
| `ps_new_document` | new RGB document (white / transparent / background fill) |
| `ps_resize` | resample the image, or resize the canvas with an anchor |
| `ps_crop` | crop to a pixel rectangle |
| `ps_save` | save in place, or `saveAs` a PSD (`as_copy` keeps the original) |
| `ps_export` | export as PNG / JPEG / PSD |
| `ps_close` | close the document, optionally saving first |

### Layers

| Tool | What it does |
|---|---|
| `ps_layers` | layer tree: depth, type, name, visibility, opacity, kind |
| `ps_text` | add a text layer (size, colour, font, justification, position) |
| `ps_select_layer` | make a layer active by name |
| `ps_duplicate_layer` | duplicate a layer, optionally renaming the copy |
| `ps_delete_layer` | delete a layer by name |
| `ps_layer_mask` | add or remove a mask: reveal_all, hide_all, from_selection, delete |
| `ps_place` | place a file as a smart object, optionally scaled |
| `ps_flatten` | flatten, or merge visible layers only |

### Colour and filters

| Tool | What it does |
|---|---|
| `ps_filter` | 20 destructive filters: gaussian/motion/box/lens/radial blur, high pass, sharpen, unsharp mask, smart blur, median, dust & scratches, noise, maximum/minimum, offset |
| `ps_adjust` | 13 adjustments: brightness/contrast, levels, curves, colour balance, threshold, posterize, photo filter, shadow/highlight, desaturate, invert, auto contrast/levels, equalize |

### Automation

| Tool | What it does |
|---|---|
| `ps_run_jsx` | **escape hatch** — run any ExtendScript, get its return value back |
| `ps_play_action` | play a recorded action from the Actions panel |
| `ps_history` | list history states, or step back and forward |
| `ps_batch` | process a whole folder: open → action → resize → export → close, one row per file |

### What is deliberately missing

`hue_saturation`, `vibrance` and `exposure` are **not** exposed. Their only route on Windows is the Action Manager `setd` command, and Photoshop 2026 rejects it (`command "Set" is not currently available`) regardless of how the descriptor is built — the DOM has no `adjustHueSaturation` either. Everything listed above was verified against Photoshop 27.0 by `scripts/selftest.mjs`; if a method is in this README, it runs.

---

## Examples

### Poster in one call

```json
{
  "name": "ps_new_document",
  "arguments": { "width": 1600, "height": 900, "name": "poster" }
}
```

```json
{
  "name": "ps_run_jsx",
  "arguments": {
    "code": "var d = app.activeDocument;\nfunction rgb(h){var c=new SolidColor();c.rgb.hexValue=h;return c;}\nvar bg = d.artLayers.add(); bg.name = 'bg'; d.activeLayer = bg;\nd.selection.selectAll(); d.selection.fill(rgb('0B0D16')); d.selection.deselect();\nvar t = d.artLayers.add(); t.kind = LayerKind.TEXT; t.name = 'title';\nt.textItem.contents = 'hello from MCP';\nt.textItem.size = 120;\nt.textItem.color = rgb('FFFFFF');\nt.textItem.position = [UnitValue(90,'px'), UnitValue(240,'px')];\npsKV({layers: d.artLayers.length});"
  }
}
```

```json
{ "name": "ps_export", "arguments": { "path": "D:/out/poster.png", "format": "png" } }
```

### Returning structured data from JSX

ExtendScript has **no `JSON` object**. Every script this server sends is prefixed with a helper, `psKV({...})`, which flattens an object into `key=value` lines that the server parses back into JSON:

```javascript
psKV({ width: d.width.as("px"), layers: d.artLayers.length, name: d.name });
// -> { "width": "1600", "layers": "3", "name": "poster" }
```

Values come back as strings; the built-in tools coerce them. If you need a single value, just end the script with an expression:

```javascript
app.version;   // -> "27.0.0"
```

### A circle (and why not `setd`)

`d.selection.select([[x,y],...])` with a polygon is the portable way to make an ellipse. The Action Manager route (`setd` + `fsel` + `Elps`) is rejected on some builds (`command "Set" is not currently available`), so this server's examples use a 96-point polygon:

```javascript
var pts = [];
for (var i = 0; i < 96; i++) { var a = 2 * Math.PI * i / 96; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
d.selection.select(pts);
d.selection.fill(rgb("F59E0B"), ColorBlendMode.NORMAL, 90, false);
d.selection.deselect();
```

More in [examples/](examples).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `command "Fill" is not currently available` | The active layer is a **text** layer. Add a pixel layer and select it first: `var l = d.artLayers.add(); d.activeLayer = l;` |
| `Error 8103: the document has not yet been saved` | `d.fullName` throws on unsaved documents — wrap it in `try/catch` (the built-in tools already do) |
| `Error 2: JSON is undefined` | ExtendScript has no `JSON`; use `psKV({...})` or return a string |
| `Photoshop did not answer within Nms` | A modal dialog is open (Camera Raw, Save As, a script prompt). Dismiss it; the bridge reconnects on the next call |
| First call takes ~2 s | PowerShell cold start + COM attach. Later calls are tens of milliseconds |
| Tool names never appear | Host could not start the server. Run `node scripts/selftest.mjs` — it prints the server's stderr |
| `bridge.ps1` fails to parse with a token error | The file must stay **pure ASCII**: Windows PowerShell 5.1 reads `.ps1` as ANSI |
| `command "Set" is not currently available` | The Action Manager `setd` command is unavailable on Photoshop 2026. Use the DOM methods the tools wrap instead |
| `Array.indexOf is not a function` | ExtendScript is ES3. No `indexOf`, no `Array.map`, no `JSON` — write plain `for` loops |
| `Fill` fails on a shape or text layer | Photoshop only fills pixel layers. Rasterise first, or add a pixel layer and select it |

Debugging order: `scripts/probe.mjs` (COM only) → `scripts/selftest.mjs` (full MCP path) → the host.

---

## Design notes

- **One COM connection, serialized calls.** Photoshop is single-threaded and `DoJavaScript` is not reentrant, so calls are queued. A timeout kills the bridge and the next call re-attaches.
- **stdout is protocol-only.** Every diagnostic goes to stderr.
- **ASCII-only PowerShell.** Non-ASCII bytes in `bridge.ps1` break the Windows PowerShell 5.1 parser, which is why comments are plain English.
- **No install-path guessing.** COM resolves the ProgID itself; there is no hard-coded `C:\Program Files\Adobe\...` list to go stale on the next release.
- **`failOnStartupError: false`** in the DSH snippet so a closed Photoshop never blocks the host from starting.

## Related

Adobe previewed **official local MCP integrations for Creative Cloud** at MAX 2026 (Photoshop, Illustrator, Premiere, After Effects), announced for private beta in early 2027. Until that ships, COM + ExtendScript is the only way to drive a local Photoshop, and this server is a thin, dependency-free wrapper around it.

## License

MIT — see [LICENSE](LICENSE).
