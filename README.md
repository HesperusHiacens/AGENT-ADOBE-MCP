# AGENT-ADOBE-MCP

**Drive your local Adobe desktop apps from any MCP client — Photoshop and After Effects, no plugins, no Developer Mode.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)](#requirements)
[![Tools](https://img.shields.io/badge/tools-43-blue)](#what-is-in-the-box)

Two MCP servers that talk to the real applications on your machine:

| Package | App | Tools | Bridge | Latency |
|---|---|---|---|---|
| [`packages/photoshop`](packages/photoshop) | Photoshop | **23** | persistent COM bridge (`DoJavaScript`) | **50–90 ms** per call |
| [`packages/aftereffects`](packages/aftereffects) | After Effects | **20** | `AfterFX.exe -r` injection | **~700 ms** per call |

Verified against **Photoshop 27.0** and **After Effects 26.0** on Windows. Both suites have their own self-test that exercises every tool: `npm run selftest`.

![Photoshop output](assets/photoshop.png)

---

## Why two different bridges

This is the interesting part, and it is not a stylistic choice.

**Photoshop** exposes a real COM automation object (`Photoshop.Application`) with `DoJavaScript`. So the server keeps **one** PowerShell process alive holding **one** COM connection and streams ExtendScript down a pipe. COM attach costs 44–78 ms once; after that a call is tens of milliseconds. Servers that spawn `cscript` per call take seconds — on Photoshop 2026 some of them stall for ~30 s.

**After Effects** does not. `AfterEffects.Project.26` resolves to a bare `IDispatch` with no members at all — `Get-Member` shows only the four .NET base methods. There is no scripting entry point on the COM object. So automation goes through the command line instead:

```
AfterFX.exe -r runner.jsx
```

Measured: **706 ms** when AE is already running (the flag injects into the live process — process count stays at 1), versus **12 358 ms** when AE has to start first. That is why the tools tell you to keep After Effects open.

The `-r` script also gets no stdout, no argv, and no environment from the caller. So each call writes its own directory with a runner whose job and result paths are baked in as absolute strings, and the result comes back as `key=value` lines that the server parses.

---

## Requirements

| | |
|---|---|
| OS | Windows (both apps are automated through Windows-only entry points) |
| Photoshop | Any version that registers `Photoshop.Application` — verified on **2026 (27.0)** |
| After Effects | Verified on **2026 (26.0)** |
| Node | 18 or newer |
| PowerShell | Windows PowerShell 5.1 (built in) |

Check the Photoshop ProgID is registered:

```powershell
Get-ItemProperty 'Registry::HKEY_CLASSES_ROOT\Photoshop.Application\CLSID'
```

### After Effects needs one preference changed

`Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network` must be **on**, otherwise every script that writes its result file fails with *permission denied*.

The preference lives in `%APPDATA%\Adobe\After Effects\<version>\Adobe After Effects <version> 设置.txt`:

```
"Pref_SCRIPTING_FILE_NETWORK_SECURITY" = "1"
```

Set it with the app closed, then start After Effects again. This repository's tools cannot work around it — the result file is the only return channel.

---

## Install

```bash
git clone https://github.com/HesperusHiacens/AGENT-ADOBE-MCP.git
cd AGENT-ADOBE-MCP
npm run selftest          # both packages; needs the apps installed
```

Nothing to build, nothing to `npm install`.

### Register with your MCP client

Each package ships an installer that writes the client config and backs up the old one.

```bash
# Photoshop
node packages/photoshop/scripts/install.mjs --target dsh      # or claude | cursor | vscode
node packages/photoshop/scripts/install.mjs --print           # just print the snippet
```

For After Effects, copy the same shape and point `args` at
`packages/aftereffects/src/index.mjs`:

```json
{
  "mcpServers": {
    "photoshop": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\path\\to\\AGENT-ADOBE-MCP\\packages\\photoshop\\src\\index.mjs"]
    },
    "aftereffects": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["D:\\path\\to\\AGENT-ADOBE-MCP\\packages\\aftereffects\\src\\index.mjs"]
    }
  }
}
```

> Use an **absolute** `command`. Hosts launch MCP servers with a scrubbed environment, and some (DSH included) drop any variable whose name matches `TOKEN|KEY|SECRET|PASSWORD`, so `npx`/`node` may not resolve from `PATH`.

### Environment variables

| Variable | Package | Default | Meaning |
|---|---|---|---|
| `PS_PROGID` | photoshop | `Photoshop.Application` | COM ProgID; use a versioned one if several versions are registered |
| `PS_POWERSHELL` | photoshop | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` | PowerShell executable |
| `PS_TIMEOUT_MS` | photoshop | `120000` | Per-call timeout |
| `PS_READY_TIMEOUT_MS` | photoshop | `180000` | COM attach budget |
| `AE_EXE` | aftereffects | auto-detected | Path to `AfterFX.exe` |
| `AE_TIMEOUT_MS` | aftereffects | `180000` | Per-call timeout |
| `AE_COLD_START_TIMEOUT_MS` | aftereffects | `180000` | Budget for the first call, when AE has to start |

---

## What is in the box

### Photoshop — 23 tools

**Documents** `ps_ping` `ps_state` `ps_open` `ps_new_document` `ps_resize` `ps_crop` `ps_save` `ps_export` `ps_close`
**Layers** `ps_layers` `ps_text` `ps_select_layer` `ps_duplicate_layer` `ps_delete_layer` `ps_layer_mask` `ps_place` `ps_flatten`
**Colour** `ps_filter` (20 filters) `ps_adjust` (13 adjustments)
**Automation** `ps_run_jsx` `ps_play_action` `ps_history` `ps_batch`

`ps_run_jsx` is the whole Photoshop DOM — everything else is a shortcut for calls you make constantly.

### After Effects — 20 tools

**Project** `ae_ping` `ae_state` `ae_list_comps` `ae_new_comp` `ae_set_comp` `ae_save_project` `ae_output_templates` `ae_render`
**Layers** `ae_add_solid` `ae_add_text` `ae_add_shape` `ae_list_layers` `ae_set_layer` `ae_delete_layer` `ae_precompose` `ae_import`
**Animation** `ae_keyframe` `ae_add_effect` `ae_set_expression`
**Escape hatch** `ae_run_jsx`

---

## Three things that do not work, and why

This section exists because shipping a tool that silently does nothing is worse than not shipping it.

**1. `hue_saturation`, `vibrance`, `exposure` — not exposed at all.**
On Windows their only route is the Action Manager `setd` command, and Photoshop 2026 rejects it outright:

```
Error 8800: command "Set" is not currently available
```

This holds for every descriptor shape we tried — `T`/`Adjs`, `HStr`/`hueSaturation`, list vs object, background layer vs pixel layer. The DOM has no `adjustHueSaturation` either; `reflect.methods` on an ArtLayer lists exactly four adjustments: `adjustLevels`, `adjustCurves`, `adjustBrightnessContrast`, `adjustColorBalance`. So the other three are simply absent from `ps_adjust`, and this README says why.

**2. Layer masks have no DOM method.** `reflect.methods` contains no mask methods. The Action Manager route works, but only in one specific form — `Mk` with `Nw Chnl`, not `null`:

```javascript
var desc = new ActionDescriptor();
desc.putClass(charIDToTypeID("Nw  "), charIDToTypeID("Chnl"));
// ... putReference(At) + putEnumerated(Usng/UsrM/RvlA)
executeAction(charIDToTypeID("Mk  "), desc, DialogModes.NO);
```

**3. `Document` has no `undo()` / `redo()`.** History is navigated by assigning `activeHistoryState`, which is what `ps_history` does.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `command "Fill" is not currently available` | The active layer is a **text** layer. Add a pixel layer and select it first: `var l = d.artLayers.add(); d.activeLayer = l;` |
| `command "Set" is not currently available` | The Action Manager `setd` command is unavailable on Photoshop 2026. Use the DOM methods the tools wrap |
| `Error 8103: the document has not yet been saved` | `d.fullName` throws on unsaved documents — wrap it in `try/catch` (the built-in tools do) |
| `Error 2: JSON is undefined` | ExtendScript has no `JSON`; use `psKV({...})` / `aeKV({...})` or return a string |
| `Array.indexOf is not a function` | ExtendScript is ES3. No `indexOf`, no `map`, no `JSON` — write plain `for` loops |
| `RPC_E_SERVERCALL_RETRYLATER` / `正在使用中` | Photoshop was briefly busy. The bridge retries with backoff; if it surfaces, dismiss the dialog |
| `Photoshop did not answer within Nms` | A modal dialog is open (Camera Raw, Save As, a script prompt). Dismiss it; the bridge reconnects on the next call |
| `bridge.ps1` fails to parse with a token error | It must stay **pure ASCII**: Windows PowerShell 5.1 reads `.ps1` as ANSI |
| After Effects: *permission denied* writing files | `Pref_SCRIPTING_FILE_NETWORK_SECURITY` is `0` — see above |
| After Effects: first call takes ~12 s | AE was not running. `-r` has to start it; later calls are ~0.7 s |
| After Effects: nothing appears on disk after a render | The output module format did not match the extension. Call `ae_output_templates` first |

Debugging order: `probe.mjs` (Photoshop COM only) → `selftest.mjs` (full MCP path) → the host.

---

## Design notes

- **One Photoshop COM connection, serialized calls.** Photoshop is single-threaded and `DoJavaScript` is not reentrant. A timeout kills the bridge; the next call re-attaches.
- **After Effects calls are serialized too.** `-r` injects into one shared process, so two concurrent jobs would overwrite each other's results.
- **stdout is protocol-only.** Every diagnostic goes to stderr.
- **ASCII-only PowerShell.** Non-ASCII bytes in `bridge.ps1` break the Windows PowerShell 5.1 parser.
- **No install-path guessing for Photoshop.** COM resolves the ProgID itself. After Effects *is* probed on disk, because there is no registry entry that points at `AfterFX.exe` reliably.

## Related

Adobe previewed **official local MCP integrations for Creative Cloud** at MAX 2026 (Photoshop, Illustrator, Premiere, After Effects), announced for private beta in early 2027. Until that ships, COM and the ExtendScript command line are the only ways to drive these apps locally.

## License

MIT — see [LICENSE](LICENSE).
