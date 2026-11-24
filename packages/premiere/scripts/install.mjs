// install.mjs — put the CEP bridge panel where Premiere will find it, and enable
// unsigned extensions so the panel actually loads.
//
//   node scripts/install.mjs            # copy + set registry
//   node scripts/install.mjs --print    # show what it would do
//   node scripts/install.mjs --remove   # uninstall
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'cep');
const EXT_ID = 'com.agentadobe.premiere.bridge';

const print = process.argv.includes('--print');
const remove = process.argv.includes('--remove');

function say(msg) {
  console.log((print ? '[print] ' : '') + msg);
}
function run(cmd, args) {
  if (print) return say(`would run: ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', windowsHide: true });
}

// Premiere scans its own application-level CEP folder first. Ask the uninstall
// registry where the application actually lives — it is often not under Program Files.
function findInstallLocations() {
  const found = [];
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Premiere*' -and $_.InstallLocation } | Select-Object -ExpandProperty InstallLocation",
      ],
      { encoding: 'utf8', timeout: 20000, windowsHide: true }
    );
    for (const line of out.split(/\r?\n/)) {
      const loc = line.trim();
      if (!loc) continue;
      // InstallLocation points at the vendor folder; the app folder sits under it.
      for (const name of ['Adobe Premiere Pro 2026', 'Adobe Premiere Pro 2025', 'Adobe Premiere Pro']) {
        const appDir = path.join(loc, name);
        if (fs.existsSync(appDir)) found.push(appDir);
      }
      if (fs.existsSync(path.join(loc, 'CEP'))) found.push(loc);
    }
  } catch {
    // no registry / not Windows
  }
  return [...new Set(found)];
}

const targets = findInstallLocations()
  .map((app) => {
    const cep = path.join(app, 'CEP', 'extensions');
    return fs.existsSync(cep) ? path.join(cep, EXT_ID) : null;
  })
  .filter(Boolean);

// The shared user folder always works and needs no admin rights.
const userDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Adobe', 'CEP', 'extensions', EXT_ID);

if (remove) {
  for (const dir of [...targets, userDir]) {
    if (fs.existsSync(dir)) {
      say('removing ' + dir);
      if (!print) fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  say('done. Reopen Premiere.');
  process.exit(0);
}

say('bridge panel source : ' + SRC);
if (!fs.existsSync(SRC)) {
  console.error('missing ' + SRC + ' — this install is incomplete');
  process.exit(1);
}

const destinations = targets.length ? targets : [userDir];
for (const dir of destinations) {
  say('installing to       : ' + dir);
  if (!print) {
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(SRC, dir, { recursive: true });
  }
}

// Unsigned CEP extensions are skipped unless PlayerDebugMode is set. Premiere 2026
// ships CEP 12, so the key is CSXS.12.
for (const version of ['12', '11']) {
  const key = `HKCU:\\Software\\Adobe\\CSXS.${version}`;
  say(`registry            : ${key}\\PlayerDebugMode = 1`);
  run('powershell.exe', [
    '-NoProfile',
    '-Command',
    `New-Item -Path '${key}' -Force | Out-Null; Set-ItemProperty -Path '${key}' -Name 'PlayerDebugMode' -Value '1' -Type String`,
  ]);
}

console.log(`
Next, in Premiere Pro:

  1. Open or create a project.   (the Window > Extensions submenu only exists then)
  2. Window > Extensions > AGENT-ADOBE-MCP Bridge
  3. Leave the panel open — it owns the local socket the MCP server connects to.
`);
