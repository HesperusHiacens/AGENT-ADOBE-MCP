// host.jsx — loaded into Premiere Pro's ExtendScript engine by the CEP panel.
//
// Provides the result helper the MCP server expects. Premiere's ExtendScript has no
// JSON object either, so structured results travel as key=value lines.

/**
 * Flatten an object into key=value lines.
 * @param {Object} o
 * @returns {String}
 */
function prKV(o) {
  var s = '', k, v;
  for (k in o) {
    if (o.hasOwnProperty(k)) {
      v = o[k];
      if (v === null || v === undefined) v = '';
      s += k + '=' + String(v).replace(/[\r\n]+/g, '\\n') + '\n';
    }
  }
  return s;
}

/** Escape a value for a single key=value line. */
function prEsc(v) {
  return String(v).replace(/[\r\n]+/g, '\\n');
}

/** Return the active sequence, or throw a readable error. */
function prActiveSequence() {
  if (!app.project) throw new Error('no project open');
  var seq = app.project.activeSequence;
  if (!seq) throw new Error('no active sequence — open one in the timeline');
  return seq;
}

/** Find a project item by name. */
function prFindItem(name) {
  var items = app.project.rootItem.children;
  for (var i = 0; i < items.numItems; i++) {
    if (items[i].name === name) return items[i];
  }
  return null;
}
