// poster.jsx — a complete poster, as a single ExtendScript payload for ps_run_jsx.
//
// Run it through ps_new_document + ps_run_jsx, or save it as a .jsx and use
// File > Scripts > Browse in Photoshop.
//
// Every block draws on its OWN pixel layer: filling or stroking while a TEXT layer
// is active fails with `command "Fill" is not currently available`.
//
// Circles are 96-point polygons. The Action Manager route (setd + fsel + Elps) is
// rejected on some Photoshop builds, so this is the portable way.

var W = 1600, H = 900;
var d = app.documents.length > 0 ? app.activeDocument : app.documents.add(W, H, 72, "poster", NewDocumentMode.RGB, DocumentFill.WHITE);
var prevDialogs = app.displayDialogs;
app.displayDialogs = DialogModes.NO;

function rgb(hex) {
  var c = new SolidColor();
  c.rgb.hexValue = hex;
  return c;
}

// New pixel layer + make it active. Never draw on the currently active layer.
function pixelLayer(name) {
  var l = d.artLayers.add();
  l.name = name;
  d.activeLayer = l;
  return l;
}

function fillRect(x1, y1, x2, y2, hex, opacity) {
  d.selection.select([[x1, y1], [x2, y1], [x2, y2], [x1, y2]]);
  d.selection.fill(rgb(hex), ColorBlendMode.NORMAL, opacity === undefined ? 100 : opacity, false);
  d.selection.deselect();
}

function fillCircle(cx, cy, r, hex, opacity) {
  var pts = [];
  for (var i = 0; i < 96; i++) {
    var a = (2 * Math.PI * i) / 96;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  d.selection.select(pts);
  d.selection.fill(rgb(hex), ColorBlendMode.NORMAL, opacity === undefined ? 100 : opacity, false);
  d.selection.deselect();
}

function textLayer(name, content, size, hex, x, y) {
  var t = d.artLayers.add();
  t.kind = LayerKind.TEXT;
  t.name = name;
  t.textItem.contents = content;
  t.textItem.size = size;
  t.textItem.color = rgb(hex);
  t.textItem.position = [UnitValue(x, "px"), UnitValue(y, "px")];
  return t;
}

// --- background: a vertical gradient faked with bands -----------------------
pixelLayer("bg");
var bands = ["0B0D16", "0D1019", "0F131D", "111622", "131926", "151C2A", "171F2E", "192232"];
for (var i = 0; i < bands.length; i++) {
  var top = Math.round((i * H) / bands.length);
  var bottom = Math.round(((i + 1) * H) / bands.length);
  fillRect(0, top, W, bottom, bands[i]);
}

// --- accent bar -------------------------------------------------------------
pixelLayer("accent-bar");
fillRect(0, 0, W, 10, "22D3EE");

// --- ring -------------------------------------------------------------------
pixelLayer("ring");
fillCircle(1300, 700, 175, "F59E0B", 90);
pixelLayer("ring-inner");
fillCircle(1300, 700, 150, "111622");
pixelLayer("ring-core");
fillCircle(1300, 700, 110, "22D3EE");
pixelLayer("ring-dot");
fillCircle(1300, 700, 46, "0B0D16");

// --- rule -------------------------------------------------------------------
pixelLayer("rule");
fillRect(95, 585, 780, 589, "22D3EE");

// --- type -------------------------------------------------------------------
textLayer("title", "AGENT-PHOTOSHOP-MCP online", 132, "FFFFFF", 92, 235);
textLayer("sub", "local Photoshop via MCP", 52, "22D3EE", 97, 425);
textLayer("meta", "COM bridge . ExtendScript . no plugin", 32, "94A3B8", 99, 500);

// --- border -----------------------------------------------------------------
pixelLayer("border");
d.selection.select([[44, 44], [1556, 44], [1556, 856], [44, 856]]);
d.selection.stroke(rgb("1E293B"), 3, StrokeLocation.INSIDE);
d.selection.deselect();

app.displayDialogs = prevDialogs;

// Structured result for the MCP caller.
psKV({ width: d.width.as("px"), height: d.height.as("px"), layers: d.artLayers.length });
