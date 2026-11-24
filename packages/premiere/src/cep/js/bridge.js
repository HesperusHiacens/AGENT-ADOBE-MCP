// bridge.js — CEP panel side of the Premiere Pro MCP bridge.
//
// The panel hosts a TCP server (Node.js is available inside CEP) and evals JSX in
// Premiere's ExtendScript engine on request. The MCP server connects as a client.
//
// Why a socket rather than the usual CEP `evalScript` from an external process:
// Premiere Pro has no `-r` command line, so ExtendScript only exists inside the app.
// A socket owned by the panel is the only way for another process to reach it.
//
// Authentication: this socket executes arbitrary ExtendScript, which is equivalent to
// running code as the logged-in user. Binding to 127.0.0.1 keeps it off the network but
// does NOT keep it away from other local processes, so every request must carry a
// shared token. The panel generates it once, writes it to a per-user file, and the MCP
// server reads that file. A local process can still read the file if it runs as the
// same user — this raises the bar from "any process" to "a process that already has
// your file access", which is the honest limit of what a local bridge can do.
//
// Protocol: newline-delimited JSON.
//   request   {"id":<n>,"token":"<token>","jsx":"<source>"}
//   response  {"id":<n>,"ok":true,"result":"<string>"}
//             {"id":<n>,"ok":false,"error":"<message>"}
//             {"id":<n>,"ok":false,"error":"unauthorized"}   then the socket is closed

(function () {
  'use strict';

  var PORT = 3021;
  var HOST = '127.0.0.1';

  var dot = document.getElementById('dot');
  var stateEl = document.getElementById('state');
  var portEl = document.getElementById('port');
  var logEl = document.getElementById('log');

  function setState(text, cls) {
    stateEl.textContent = text;
    dot.className = 'dot' + (cls ? ' ' + cls : '');
  }

  function log(msg) {
    var line = document.createElement('div');
    line.textContent = new Date().toLocaleTimeString() + '  ' + msg;
    logEl.appendChild(line);
    while (logEl.childNodes.length > 40) logEl.removeChild(logEl.firstChild);
  }

  portEl.textContent = String(PORT);

  if (typeof cep_node === 'undefined' || !cep_node.require) {
    setState('no node runtime', 'err');
    log('CEP Node.js is unavailable — check --enable-nodejs in manifest.xml');
    return;
  }

  var net, fs, pathMod, osMod, crypto;
  try {
    net = cep_node.require('net');
    fs = cep_node.require('fs');
    pathMod = cep_node.require('path');
    osMod = cep_node.require('os');
    crypto = cep_node.require('crypto');
  } catch (e) {
    setState('node require failed', 'err');
    log(String(e && e.message));
    return;
  }

  // The MCP server reads this same path; keep the two in sync.
  var tokenDir = pathMod.join(
    process.env.LOCALAPPDATA || pathMod.join(osMod.homedir(), 'AppData', 'Local'),
    'agent-adobe-mcp'
  );
  var tokenFile = pathMod.join(tokenDir, 'bridge.token');

  var TOKEN = null;
  try {
    fs.mkdirSync(tokenDir, { recursive: true });
    TOKEN = crypto.randomBytes(24).toString('hex');
    // mode is advisory on Windows, but harmless; the file lives under the user profile.
    fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600, encoding: 'utf8' });
    log('token written for this session');
  } catch (e) {
    setState('cannot write token', 'err');
    log('refusing to listen without a token: ' + String(e && e.message));
    log('expected path: ' + tokenFile);
    return;
  }

  // Constant-time-ish compare. A length mismatch short-circuits, which leaks only length.
  function tokenOk(given) {
    if (typeof given !== 'string' || given.length !== TOKEN.length) return false;
    var diff = 0;
    for (var i = 0; i < TOKEN.length; i++) diff |= given.charCodeAt(i) ^ TOKEN.charCodeAt(i);
    return diff === 0;
  }

  // The ExtendScript engine in Premiere is reached through CSInterface.evalScript.
  var cs = new CSInterface();

  function evalInPremiere(jsx, callback) {
    try {
      cs.evalScript(jsx, function (result) {
        // EvalScript returns the string "EvalScript error." on a script failure.
        if (result === 'EvalScript error.') {
          callback(new Error('ExtendScript error (see Premiere for the line)'), null);
        } else {
          callback(null, result === undefined || result === null ? '' : String(result));
        }
      });
    } catch (e) {
      callback(e, null);
    }
  }

  var server = net.createServer(function (socket) {
    log('client connected');
    socket.setEncoding('utf8');

    var buffer = '';
    socket.on('data', function (chunk) {
      buffer += chunk;
      var idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        var line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;

        var req;
        try {
          req = JSON.parse(line);
        } catch (e) {
          socket.write(JSON.stringify({ id: null, ok: false, error: 'bad json' }) + '\n');
          continue;
        }

        if (!tokenOk(req.token)) {
          // Do not execute anything. Drop the connection so a caller cannot sit there
          // guessing tokens against a live socket.
          log('rejected a client without a valid token');
          try {
            socket.write(JSON.stringify({ id: req.id, ok: false, error: 'unauthorized' }) + '\n');
            socket.end();
          } catch (e) {}
          return;
        }

        // Each request is answered once; evalScript is async, so the write happens
        // inside the callback.
        (function (id, jsx) {
          evalInPremiere(jsx, function (err, result) {
            if (err) {
              socket.write(JSON.stringify({ id: id, ok: false, error: String(err.message || err) }) + '\n');
            } else {
              socket.write(JSON.stringify({ id: id, ok: true, result: result }) + '\n');
            }
          });
        })(req.id, String(req.jsx || ''));
      }
    });

    socket.on('error', function (e) {
      log('socket error: ' + (e && e.message));
    });
    socket.on('close', function () {
      log('client disconnected');
    });
  });

  server.on('error', function (e) {
    if (e && e.code === 'EADDRINUSE') {
      setState('port ' + PORT + ' in use', 'err');
      log('another instance already listens on ' + PORT);
    } else {
      setState('server error', 'err');
      log(String(e && e.message));
    }
  });

  server.listen(PORT, HOST, function () {
    setState('listening', 'on');
    log('listening on ' + HOST + ':' + PORT + ' (token required)');
  });

  // Keep the panel alive when Premiere hides it.
  window.onunload = function () {
    try {
      server.close();
    } catch (e) {}
  };
})();
