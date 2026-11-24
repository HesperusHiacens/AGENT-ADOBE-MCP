# ExtendScript cookbook for `ps_run_jsx`

Patterns that are verified to work through the bridge, and the traps behind them.
Everything here assumes `var d = app.activeDocument;`.

---

## 1. Never draw on a text layer

The most common failure. If the active layer is a `LayerKind.TEXT`, every fill and
stroke fails with:

```
Error 8800: command "Fill" is not currently available
```

Always create a pixel layer and select it first:

```javascript
var l = d.artLayers.add();
l.name = "bar";
d.activeLayer = l;          // <- the line people forget
```

## 2. Colours

```javascript
function rgb(hex) { var c = new SolidColor(); c.rgb.hexValue = hex; return c; }

d.selection.fill(rgb("22D3EE"), ColorBlendMode.NORMAL, 100, false);
```

Four arguments matter: the second is the blend mode, the third opacity 0–100, the
fourth "preserve transparency". Passing only one argument works on some builds and
silently behaves differently on others — always pass all four.

## 3. Rectangles and circles

```javascript
// rectangle
d.selection.select([[x1,y1],[x2,y1],[x2,y2],[x1,y2]]);
d.selection.fill(rgb("FFFFFF"));
d.selection.deselect();

// circle — 96-point polygon, portable across builds
var pts = [];
for (var i = 0; i < 96; i++) {
  var a = 2 * Math.PI * i / 96;
  pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
}
d.selection.select(pts);
```

Do **not** rely on `executeAction(charIDToTypeID("setd"), ...)` with `fsel` + `Elps`
to make an elliptical selection: on Photoshop 2026 it fails with
`command "Set" is not currently available`, and completing the four-character keys
(`"Top "`, `"Btm "`) turns it into `invalid argument`.

## 4. Text

```javascript
var t = d.artLayers.add();
t.kind = LayerKind.TEXT;
t.name = "title";
t.textItem.contents = "hello";
t.textItem.size = 96;                    // points
t.textItem.color = rgb("FFFFFF");
t.textItem.position = [UnitValue(90, "px"), UnitValue(240, "px")];   // TOP-LEFT of the line
```

`position` is the **top-left** corner of the text line, not the baseline. Useful extras:
`t.textItem.justification = Justification.CENTER;`, `t.textItem.tracking = 50;`,
`t.textItem.font = "ArialMT";`.

Changing `contents` after `size` can reset metrics on some builds — set contents first.

## 5. Saving and exporting

```javascript
d.saveAs(new File("D:/out/poster.psd"), new PhotoshopSaveOptions(), true, Extension.LOWERCASE);
d.saveAs(new File("D:/out/poster.png"), new PNGSaveOptions(), true, Extension.LOWERCASE);

var j = new JPEGSaveOptions();
j.quality = 10;
d.saveAs(new File("D:/out/poster.jpg"), j, true, Extension.LOWERCASE);
```

Use forward slashes or `File.encode()`; ExtendScript string literals treat `\` as an
escape. `true` as the third argument means "save a copy" and keeps the document open.

## 6. Unsaved documents

`d.fullName` throws `Error 8103: the document has not yet been saved` until the
document has a path. Guard it:

```javascript
var p = "";
try { if (d.fullName) p = d.fullName.fsName; } catch (e) { p = ""; }
```

## 7. Returning data to the model

ExtendScript has **no `JSON` object** — `JSON.stringify` fails with
`Error 2: JSON is undefined`. The server injects a helper in front of every script:

```javascript
psKV({ width: d.width.as("px"), layers: d.artLayers.length, name: d.name });
```

It produces `key=value` lines that the server parses into an object. Values arrive as
strings. To return one bare value, end the script with an expression:

```javascript
app.version;
```

## 8. Silent modal dialogs

Any prompt blocks `DoJavaScript` until it is dismissed, and the bridge will time out:

```javascript
var prev = app.displayDialogs;
app.displayDialogs = DialogModes.NO;
// ... work ...
app.displayDialogs = prev;
```

## 9. Layers and groups

```javascript
var g = d.layerSets.add(); g.name = "group";        // group
var l = g.artLayers.add(); l.name = "inside";       // layer inside the group

d.activeLayer = d.layers.getByName("bg");           // select by name
d.layers.getByName("bg").visible = false;           // toggle
d.layers.getByName("bg").opacity = 60;              // 0-100
d.layers.getByName("bg").blendMode = BlendMode.MULTIPLY;
d.artLayers.getByName("bg").applyGaussianBlur(8);   // destructive, pixels only
```

## 10. Smart objects and placing files

```javascript
var f = new File("D:/assets/photo.jpg");
app.activeDocument.activeLayer = app.activeDocument.layers[0];
var placed = app.open(f);                       // opens in its own window
placed.activeLayer = placed.layers[0];
// move it as a layer into the target document:
placed.layers[0].duplicate(d);
placed.close(SaveOptions.DONOTSAVECHANGES);
```

## 11. Running recorded actions

Anything Photoshop can record can be replayed, which is the fastest way to reach
features with no scriptable API:

```javascript
app.doAction("My Action", "My Action Set");     // set must be loaded in the Actions panel
```

## 12. Batch over a folder

```javascript
var dir = new Folder("D:/in");
var files = dir.getFiles("*.psd");
for (var i = 0; i < files.length; i++) {
  var doc = app.open(files[i]);
  var out = new File("D:/out/" + doc.name.replace(/\.psd$/i, ".png"));
  doc.saveAs(out, new PNGSaveOptions(), true, Extension.LOWERCASE);
  doc.close(SaveOptions.DONOTSAVECHANGES);
}
psKV({ processed: files.length });
```

Long batches belong in one `ps_run_jsx` call with a raised `timeout_ms`, not in a loop
of tool calls — each round trip costs tens of milliseconds and re-queues behind other
work.
