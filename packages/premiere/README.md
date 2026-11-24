# agent-premiere-mcp

> Part of [AGENT-ADOBE-MCP](../../README.md). The Photoshop server lives in [`packages/photoshop`](../photoshop), the After Effects one in [`packages/aftereffects`](../aftereffects).

**Drive your local Adobe Premiere Pro from any MCP client — through a CEP bridge panel.**

Premiere is the awkward one. It has **no COM automation object** (Photoshop has one), **no `-r` command-line scripting entry** (After Effects has one), and **no timers at all** in ExtendScript (no `setInterval`, no `setTimeout`, no `app.scheduleTask`). So the only way to reach its scripting engine from another process is a **CEP panel that hosts a local socket**.

```
MCP client
 └─ node src/index.mjs                  ← 11 tools, zero deps, serialized queue
     └─ TCP 127.0.0.1:3021              ← newline-delimited JSON
         └─ CEP panel (src/cep)         ← Node.js inside the panel, owns the socket
             └─ CSInterface.evalScript  ← reaches Premiere's ExtendScript engine
                 └─ Premiere Pro 26.0
```

The panel is the **server**, the MCP server is the **client** — the reverse of the usual shape, because ExtendScript only exists inside the Premiere process.

Measured on Premiere **26.0.0.72**: 3–320 ms per call, because the panel already lives in the process.

### Requests are authenticated

This socket runs arbitrary ExtendScript, which is equivalent to running code as you. Binding to `127.0.0.1` keeps it off the network but not away from other local processes, so every request must carry a shared token:

1. The panel generates a random 192-bit token when it starts and writes it to
   `%LOCALAPPDATA%\agent-adobe-mcp\bridge.token`.
2. The MCP server reads that file on each connect and sends the value with every request.
3. The panel compares it and **closes the connection** on a mismatch, so a caller cannot
   sit there guessing.

```
request   {"id":1,"token":"<48 hex chars>","jsx":"app.version"}
response  {"id":1,"ok":true,"result":"26.0.0"}
          {"id":1,"ok":false,"error":"unauthorized"}   ← then the socket is closed
```

What this does and does not buy you: it stops an unrelated process from driving Premiere opportunistically. It does **not** stop a process that already runs as your user, because such a process can read the token file. That is the honest limit of a local bridge — the boundary is "code running as your user", not "code you meant to run".

If the panel cannot write the token file it **refuses to listen** rather than falling back to an open socket, and says so on the panel.

---

## Requirements

| | |
|---|---|
| OS | Windows |
| Premiere Pro | Verified on **2026 (26.0.0.72)**; CEP 12 engine present |
| Node | 18 or newer |
| Permission | None needed for the user-scope install; the app-scope one wants admin |

---

## Install

```bash
git clone https://github.com/HesperusHiacens/AGENT-ADOBE-MCP.git
cd AGENT-ADOBE-MCP/packages/premiere

node scripts/install.mjs --print    # see what it would do
node scripts/install.mjs            # copy the panel + enable unsigned extensions
```

The installer does two things:

1. **Copies `src/cep/` to** `<Premiere>/CEP/extensions/com.agentadobe.premiere.bridge/`
   (or the shared `%APPDATA%\Adobe\CEP\extensions\` when the app folder is not writable).
   Premiere scans its own application folder first.
2. **Sets `HKCU\Software\Adobe\CSXS.12\PlayerDebugMode = "1"`** — unsigned CEP extensions are silently skipped without it.

### Then open the panel once

In Premiere:

1. **Open or create a project.** The `Window → Extensions` submenu **only exists when a project is open** — an empty Premiere shows no Extensions entry at all, which reads like "CEP is not supported". It is.
2. **Window → Extensions → AGENT-ADOBE-MCP Bridge**
3. Leave the panel open. It owns the socket, so closing it disconnects the MCP server.

Verify:

```bash
node scripts/selftest.mjs
# ===== 14/14 passed =====
```

---

## Register with your MCP client

```json
{
  "mcpServers": {
    "premiere": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\path\\to\\AGENT-ADOBE-MCP\\packages\\premiere\\src\\index.mjs"]
    }
  }
}
```

> Use an **absolute** `command`. Hosts launch MCP servers with a scrubbed environment, and some drop any variable whose name matches `TOKEN|KEY|SECRET|PASSWORD`.

For DSH:

```yaml
- insert:
    - id: agent-adobe-mcp-premiere
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: premiere
        transport: stdio
        command: D:\nodejs\node.exe
        args:
          - D:\path\to\AGENT-ADOBE-MCP\packages\premiere\src\index.mjs
        toolCallTimeoutMs: 900000
        failOnStartupError: false
```

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PR_PORT` | `3021` | Bridge port; must match `js/bridge.js` |
| `PR_HOST` | `127.0.0.1` | Bridge host |
| `PR_TIMEOUT_MS` | `120000` | Per-call timeout |
| `PR_CONNECT_TIMEOUT_MS` | `5000` | Socket connect budget |

---

## Tools — 11

| Tool | What it does |
|---|---|
| `pr_ping` | version, build, project name/path, bridge address |
| `pr_state` | project + active sequence (size, timebase, track counts, duration) |
| `pr_list_sequences` | every sequence with dimensions, track counts, duration |
| `pr_list_media` | project-bin items (name, type, media path, node id) |
| `pr_list_tracks` | tracks of the active sequence, with each clip and its time range |
| `pr_new_sequence` | create a sequence from a `.sqpreset` (QE DOM route) |
| `pr_import` | import media, optionally into a named bin |
| `pr_add_to_timeline` | overwrite a project item onto a track at a time |
| `pr_export` | export the active sequence to a path |
| `pr_save_project` | save in place, or write a copy |
| `pr_run_jsx` | **escape hatch** — run any Premiere ExtendScript |

---

## Two traps worth knowing

### 1. `app.project.createNewSequence()` deadlocks the ExtendScript engine

```javascript
// Don't. The bridge stops responding until Premiere restarts.
var seq = app.project.createNewSequence("name", presetPath);
```

It wants UI interaction, and there is no UI in a socket call — so it blocks forever. With no preset it hung past 180 s; with a valid preset it still hung, and afterwards even `prKV({probe:"start"})` got no answer.

`pr_new_sequence` uses the **QE DOM** instead, and is deliberately given a **30 s** timeout so a regression fails fast rather than freezing the panel:

```javascript
var created = qe.project.newSequence(name, preset.fsName);
```

### 2. The object QE returns has no readable `name`

```javascript
var seq = qe.project.newSequence("X", preset);
seq.name                       // undefined
seq.frameSizeHorizontal        // undefined
app.project.activeSequence.name  // "X"   ← the real one
```

So the tool reads the sequence back from `app.project.activeSequence` after creating it.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `could not reach the Premiere bridge on 127.0.0.1:3021` | The panel is not open. `Window → Extensions → AGENT-ADOBE-MCP Bridge` |
| `Window` menu has no **Extensions** entry | No project is open. Create or open a `.prproj` first |
| Extensions submenu does not list this panel | Check `%TEMP%\CEP12-PPRO.log` (set `LogLevel` to `6` under `HKCU\Software\Adobe\CSXS.12`), search for the bundle id |
| Panel opens but the port is not listening | CEP's Node runtime did not start — confirm `--enable-nodejs` survived in `CSXS/manifest.xml` |
| `Premiere did not answer within Nms` | A modal dialog is up (export settings, missing font, relink media). Dismiss it; the bridge reconnects next call |
| Every call times out after one call | A blocking API was hit (see trap 1). Restart Premiere |
| Preset / template names look wrong | Sequence presets and output modules are **localised**; pass the name that exists on disk |

Debug order: `%TEMP%\CEP12-PPRO.log` → is `127.0.0.1:3021` listening → `pr_ping` → `pr_run_jsx` → the specific tool.

---

## ExtendScript notes

| Symptom | Cause |
|---|---|
| `JSON is undefined` | ExtendScript has no `JSON`. Use `prKV({...})` (injected by the server) or return a string |
| `Array.indexOf is not a function` | ExtendScript is ES3 — no `indexOf`, no `map` |
| `setInterval` / `setTimeout` undefined | Premiere exposes neither, globally or on `app` in a usable way. `app.setTimeout` exists but never fires without UI activity |

## License

MIT — see [LICENSE](../../LICENSE).
