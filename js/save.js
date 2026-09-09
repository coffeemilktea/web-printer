/* ==========================================================================
   save.js — getting paper back off the screen.

   Sheets live in the tray as PNG blob URLs. This re-encodes one as JPEG or
   WebP on demand, and assembles the whole tray into a PDF: each sheet becomes
   one image XObject, deflated losslessly where the browser can deflate, and
   JPEG-compressed where it can't.
   ========================================================================== */

(function (global) {
  'use strict';

  var PX_PER_INCH = 100;                 // pages are rasterised at 100 px/inch
  var PT = 72 / PX_PER_INCH;             // …and PDF works in 72nds

  var FORMATS = [
    { id: 'png',  type: 'image/png',  ext: 'png',  label: 'PNG' },
    { id: 'jpeg', type: 'image/jpeg', ext: 'jpg',  label: 'JPEG', quality: 0.92 },
    { id: 'webp', type: 'image/webp', ext: 'webp', label: 'WebP', quality: 0.92 }
  ];

  /* Not every browser can encode every type; toDataURL quietly falls back to
     PNG, so compare what came back with what was asked for. */
  function supported(type) {
    if (type === 'image/png') return true;
    var c = document.createElement('canvas');
    c.width = c.height = 1;
    try { return c.toDataURL(type).indexOf('data:' + type) === 0; }
    catch (e) { return false; }
  }

  function formats() {
    return FORMATS.filter(function (f) { return supported(f.type); });
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Could not read that page.')); };
      img.src = url;
    });
  }

  function toCanvas(img) {
    var c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    var x = c.getContext('2d');
    x.fillStyle = '#ffffff';             // JPEG has no alpha to fall back on
    x.fillRect(0, 0, c.width, c.height);
    x.drawImage(img, 0, 0);
    return c;
  }

  /* One sheet, re-encoded. PNG is already what we hold, so it passes through. */
  async function pageAs(page, formatId) {
    var f = FORMATS.filter(function (x) { return x.id === formatId; })[0] || FORMATS[0];
    if (f.id === 'png') return { url: page.url, ext: 'png', revoke: false };

    var canvas = toCanvas(await loadImage(page.url));
    var blob = await new Promise(function (resolve) {
      canvas.toBlob(resolve, f.type, f.quality);
    });
    if (!blob) return { url: page.url, ext: 'png', revoke: false };
    return { url: URL.createObjectURL(blob), ext: f.ext, revoke: true };
  }

  /* ── PDF assembly ─────────────────────────────────────────────────────── */

  function bytes(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  function concat(chunks) {
    var total = chunks.reduce(function (n, c) { return n + c.length; }, 0);
    var out = new Uint8Array(total);
    var at = 0;
    chunks.forEach(function (c) { out.set(c, at); at += c.length; });
    return out;
  }

  /* CompressionStream('deflate') emits zlib, which is exactly /FlateDecode. */
  async function deflate(raw) {
    var stream = new Blob([raw]).stream().pipeThrough(new global.CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /* A sheet as PDF image data: lossless RGB where we can deflate, else JPEG. */
  async function encodeSheet(canvas) {
    if (global.CompressionStream) {
      var px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      var rgb = new Uint8Array(canvas.width * canvas.height * 3);
      for (var i = 0, j = 0; i < px.length; i += 4) {
        rgb[j++] = px[i]; rgb[j++] = px[i + 1]; rgb[j++] = px[i + 2];
      }
      return { data: await deflate(rgb), filter: '/FlateDecode', space: '/DeviceRGB' };
    }
    var blob = await new Promise(function (r) { canvas.toBlob(r, 'image/jpeg', 0.92); });
    return {
      data: new Uint8Array(await blob.arrayBuffer()),
      filter: '/DCTDecode',
      space: '/DeviceRGB'
    };
  }

  /* Every sheet in the tray, in tray order, as one PDF. */
  async function trayToPDF(pages, onProgress) {
    if (!pages.length) throw new Error('The tray is empty.');

    var objects = [];                    // objects[n - 1] is object n
    function add(chunk) { objects.push(chunk); return objects.length; }

    var catalog = add(null);             // reserved: 1
    var tree = add(null);                // reserved: 2
    var kids = [];

    for (var i = 0; i < pages.length; i++) {
      if (onProgress) onProgress(i, pages.length);
      var canvas = toCanvas(await loadImage(pages[i].url));
      var img = await encodeSheet(canvas);
      var w = canvas.width, h = canvas.height;
      var wpt = (w * PT).toFixed(2), hpt = (h * PT).toFixed(2);

      var imgNo = add(concat([
        bytes('<< /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h +
              ' /ColorSpace ' + img.space + ' /BitsPerComponent 8 /Filter ' + img.filter +
              ' /Length ' + img.data.length + ' >>\nstream\n'),
        img.data,
        bytes('\nendstream')
      ]));

      var draw = 'q\n' + wpt + ' 0 0 ' + hpt + ' 0 0 cm\n/Im0 Do\nQ\n';
      var contentNo = add(bytes('<< /Length ' + draw.length + ' >>\nstream\n' + draw + 'endstream'));

      kids.push(add(bytes(
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + wpt + ' ' + hpt + ']' +
        ' /Resources << /XObject << /Im0 ' + imgNo + ' 0 R >> >>' +
        ' /Contents ' + contentNo + ' 0 R >>'
      )));
    }

    objects[catalog - 1] = bytes('<< /Type /Catalog /Pages ' + tree + ' 0 R >>');
    objects[tree - 1] = bytes(
      '<< /Type /Pages /Count ' + kids.length + ' /Kids [' +
      kids.map(function (n) { return n + ' 0 R'; }).join(' ') + '] >>'
    );

    /* Serialise, remembering where each object starts for the xref table. */
    var out = [bytes('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
    var at = out[0].length;
    var offsets = [];

    objects.forEach(function (body, k) {
      var head = bytes((k + 1) + ' 0 obj\n');
      var tail = bytes('\nendobj\n');
      offsets.push(at);
      out.push(head, body, tail);
      at += head.length + body.length + tail.length;
    });

    var xref = 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
    offsets.forEach(function (off) {
      xref += ('0000000000' + off).slice(-10) + ' 00000 n \n';
    });
    xref += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root ' + catalog + ' 0 R >>\n' +
            'startxref\n' + at + '\n%%EOF\n';
    out.push(bytes(xref));

    return new Blob([concat(out)], { type: 'application/pdf' });
  }

  /* ── handing a file to the user ───────────────────────────────────────── */

  function download(url, filename) {
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  global.WP = global.WP || {};
  global.WP.save = {
    formats: formats,
    pageAs: pageAs,
    trayToPDF: trayToPDF,
    download: download
  };
})(window);
