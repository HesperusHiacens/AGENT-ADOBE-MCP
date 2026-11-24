# agent-aftereffects-mcp

> Part of [AGENT-ADOBE-MCP](../../README.md). The Photoshop server lives in [`packages/photoshop`](../photoshop).

**Drive your local Adobe After Effects from any MCP client — through the ExtendScript entry point, with no plugins.**

`AfterEffects.Project.26` is a bare `IDispatch`: `Get-Member` shows only the four .NET base methods, and there is no scripting entry point on the COM object. So this server drives After Effects the way it can actually be driven:

```
AfterFX.exe -r runner.jsx
```

Measured on After Effects 26.0: **~700 ms** per call when AE is already running (the flag injects into the live process — process count stays at 1), versus **12 358 ms** when AE has to start first. Keep After Effects open.

---

## Requirements

| | |
|---|---|
| OS | Windows |
| After Effects | Verified on **2026 (26.0)**; `AE_EXE` overrides auto-detection |
| Node | 18 or newer |

### One preference must be changed

`Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network` must be **on**. With it off, every script that writes its result file fails with *permission denied*, and the result file is the only return channel `-r` gives you.

Set it with After Effects closed, in `%APPDATA%\Adobe\After Effects\<version>\Adobe After Effects <version> 设置.txt`:

```
"Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "1"
```

Then start After Effects again.

---

## Install

```bash
git clone https://github.com/HesperusHiacens/AGENT-ADOBE-MCP.git
cd AGENT-ADOBE-MCP/packages/aftereffects
node scripts/selftest.mjs        # 21 checks, needs After Effects installed
```

Nothing to build, nothing to `npm install`.

### Register with your MCP client

```json
{
  "mcpServers": {
    "aftereffects": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\path\\to\\AGENT-ADOBE-MCP\\packages\\aftereffects\\src\\index.mjs"]
    }
  }
}
```

> Use an **absolute** `command`. Hosts launch MCP servers with a scrubbed environment, and some drop any variable whose name matches `TOKEN|KEY|SECRET|PASSWORD`, so `npx`/`node` may not resolve from `PATH`.

For DSH, the plugin entry is the same shape as the Photoshop one:

```yaml
- insert:
    - id: agent-adobe-mcp-aftereffects
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: aftereffects
        transport: stdio
        command: D:\nodejs\node.exe
        args:
          - D:\path\to\AGENT-ADOBE-MCP\packages\aftereffects\src\index.mjs
        toolCallTimeoutMs: 900000
        failOnStartupError: false
```

`toolCallTimeoutMs` is generous because `ae_render` can run for minutes.

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `AE_EXE` | auto-detected | Path to `AfterFX.exe` |
| `AE_TIMEOUT_MS` | `180000` | Per-call timeout |
| `AE_COLD_START_TIMEOUT_MS` | `180000` | Budget for the first call, when AE has to start |

---

## Tools — 20

| Tool | What it does |
|---|---|
| `ae_ping` | version, build, language, project path, item count |
| `ae_state` | project path, item count, composition count, active composition |
| `ae_list_comps` | every composition with size, duration, frame rate, layer count |
| `ae_new_comp` | create a composition and open it |
| `ae_set_comp` | change size, duration, frame rate, background colour, work area |
| `ae_add_solid` | solid-colour layer |
| `ae_add_text` | text layer (size, colour, position) |
| `ae_add_shape` | vector rectangle / ellipse / star / polygon, with fill and stroke |
| `ae_list_layers` | layer index, name, match name, in/out point, enabled |
| `ae_set_layer` | visibility, in/out point, opacity, blend mode, parent, stretch, solo |
| `ae_delete_layer` | delete a layer by name or index |
| `ae_keyframe` | keyframes on position / scale / rotation / opacity / anchor point / an effect property, linear or eased |
| `ae_add_effect` | add an effect by match name or display name, and list its properties |
| `ae_set_expression` | attach an expression, e.g. `wiggle(2, 30)` |
| `ae_import` | import a file, optionally adding it to a composition as a layer |
| `ae_precompose` | pre-compose selected layers into a new composition |
| `ae_output_templates` | list this install's output module templates (names are localised) |
| `ae_save_project` | save in place, or write a copy |
| `ae_render` | queue a composition and render, auto-picking a template that matches the extension |
| `ae_run_jsx` | **escape hatch** — run any After Effects ExtendScript |

### Rendering notes

Output module template names are **localised**. On a Chinese install they are `无损`, `Photoshop`, `H.264 - 匹配渲染设置 - 15 Mbps`, `多机序列` — not `Lossless` or `PNG Sequence`. Call `ae_output_templates` first if you plan to pass one explicitly.

`ae_render` matches the template to the extension you ask for: `.png/.psd/.tif` → `Photoshop`, `.mov/.avi` → lossless, `.mp4` → H.264. Sequence templates write `<base>_00000.ext` rather than the exact path, so the result reports `files` (count), `sequence` (bool) and `path` (first frame).

---

## ExtendScript gotchas

These are not style notes; each one cost a debugging session.

| Symptom | Cause |
|---|---|
| `JSON is undefined` | ExtendScript has no `JSON`. Use `aeKV({...})` (injected by the server) or return a string |
| `Array.indexOf is not a function` | ExtendScript is ES3. No `indexOf`, no `map`, no `filter` — write `for` loops |
| `permission denied` on file writes | `Pref_SCRIPTING_FILE_NETWORK_SECURITY` is `0` |
| Script hangs forever | A modal dialog is open (missing font, missing footage, render settings) |
| `app.arguments` is undefined | `-r` passes nothing. Use the job file the server writes |
| `$.getenv("X")` returns null | `-r` injects into the running process, which does not inherit your environment |

---

## How a call works

```
MCP client
 └─ node src/index.mjs                    ← 20 tools, zero dependencies, serialized queue
     └─ AfterFX.exe -r <job>/runner.jsx    ← injects into the running AE
          ├─ reads <job>/job.jsx           (paths baked in as absolute strings)
          ├─ eval(job)                     → runs in the live AE process
          └─ writes <job>/result.txt       → key=value lines
     └─ polls result.txt every 80 ms
```

Calls are serialized because `-r` injects into one shared process: two concurrent jobs would overwrite each other's results.

## License

MIT — see [LICENSE](../../LICENSE).
