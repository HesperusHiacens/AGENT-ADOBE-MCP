// CSInterface-lite — the small subset of Adobe's CSInterface that this bridge needs.
//
// Adobe does not ship CSInterface.js anywhere on disk; every CEP extension bundles its
// own copy. Rather than vendor a few thousand lines, this implements only what the
// bridge uses: evalScript, and the extension/host paths.
//
// If you already vendor the official CSInterface.js, this file can be dropped in its
// place — the API surface used here is identical.

(function (global) {
  'use strict';

  function CSInterface() {}

  CSInterface.prototype.getSystemPath = function (pathType) {
    if (pathType !== 'extension') return '';
    // The panel URL looks like file:///C:/.../com.agentadobe.premiere.bridge/index.html
    var url = decodeURI(window.location.href);
    var idx = url.lastIndexOf('/');
    return url.slice(8, idx).replace(/\//g, '\\');
  };

  CSInterface.prototype.getHostEnvironment = function () {
    if (typeof window.__adobe_cep__ !== 'undefined') {
      try {
        return JSON.parse(window.__adobe_cep__.getHostEnvironment());
      } catch (e) {
        return {};
      }
    }
    return {};
  };

  /**
   * Run ExtendScript inside the host application.
   * @param {String} script   JSX source
   * @param {Function} callback  receives the result as a string
   */
  CSInterface.prototype.evalScript = function (script, callback) {
    if (typeof window.__adobe_cep__ === 'undefined') {
      // Outside a CEP host (a plain browser preview), fail loudly instead of hanging.
      if (callback) callback('EvalScript error.');
      return;
    }
    window.__adobe_cep__.evalScript(script, callback || function () {});
  };

  CSInterface.prototype.getApplicationID = function () {
    return this.getHostEnvironment().appId || '';
  };

  CSInterface.prototype.getHostCapabilities = function () {
    return this.getHostEnvironment().appVersion ? {} : {};
  };

  global.CSInterface = CSInterface;
})(window);
