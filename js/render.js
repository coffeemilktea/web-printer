/* ==========================================================================
   render.js — turns an uploaded file into an array of drawable pages.

   A "page" is just a function (ctx) => void that paints one sheet onto a
   2D canvas of geom.w × geom.h pixels. Everything downstream (the printer
   animation, the output tray, PNG export) only ever deals with that.
   ========================================================================== */

(function (global) {
  'use strict';

  var MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace';

  /* Sheet sizes at 100 px per inch. */
  var PAPER = {
    letter: { w: 850, h: 1100, label: 'Letter' },
    a4:     { w: 827, h: 1169, label: 'A4' },
    legal:  { w: 850, h: 1400, label: 'Legal' },
    a5:     { w: 583, h: 827,  label: 'A5' }
  };

  /* Guard rails so a huge file can't lock up the tab. */
  var LIMITS = {
    file:        30 * 1024 * 1024,
    textPages:   200,
    binaryBytes: 64 * 1024,
    binaryPages: 40,
    pdfPages:    60
  };

  /* pdf.js is only fetched when a PDF is actually dropped in. The font and
     cmap directories have to come from the same package, or pdf.js quietly
     waits forever on a standard font it can't fetch. */
  var PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/';
  var PDF_TIMEOUT = 30000;

  /* ── geometry ─────────────────────────────────────────────────────────── */

  function geometry(paperKey, landscape) {
    var p = PAPER[paperKey] || PAPER.letter;
    return {
      w: landscape ? p.h : p.w,
      h: landscape ? p.w : p.h,
      margin: 58,
      fontPx: 13,
      lineH: 17,
      label: p.label + (landscape ? ' landscape' : '')
    };
  }

  /* ── small helpers ────────────────────────────────────────────────────── */

  function readAs(file, how) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('Could not read the file.')); };
      fr[how](file);
    });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  /* Only counts time while the tab is actually visible: rendering is driven by
     requestAnimationFrame, which stops in a background tab, and a user who
     switches away mid-spool should not come back to a timeout. */
  function withTimeout(promise, ms, label) {
    var timer, spent = 0, step = 250;
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        timer = setInterval(function () {
          if (document.visibilityState !== 'visible') return;
          spent += step;
          if (spent >= ms) reject(new Error(label + ' timed out.'));
        }, step);
      })
    ]).finally(function () { clearInterval(timer); });
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Not a decodable image.')); };
      img.src = url;
    });
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    var u = ['KB', 'MB', 'GB'], i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
  }

  /* Does this buffer look like text? NUL bytes or a pile of control
     characters in the first few KB mean "print it as a hex dump". */
  function looksBinary(buf) {
    var view = new Uint8Array(buf, 0, Math.min(buf.byteLength, 4096));
    var odd = 0;
    for (var i = 0; i < view.length; i++) {
      var b = view[i];
      if (b === 0) return true;
      if (b < 9 || (b > 13 && b < 32)) odd++;
    }
    return view.length > 0 && odd / view.length > 0.08;
  }

  /* ── page chrome (header / footer drawn in the margins) ───────────────── */

  function drawChrome(ctx, g, info, index, total) {
    ctx.save();
    ctx.fillStyle = '#9a978d';
    ctx.font = '11px ' + MONO;
    ctx.textBaseline = 'alphabetic';

    ctx.textAlign = 'left';
    ctx.fillText(clip(ctx, info.name, g.w - g.margin * 2 - 150), g.margin, g.margin - 20);
    ctx.textAlign = 'right';
    ctx.fillText(info.stamp, g.w - g.margin, g.margin - 20);

    ctx.fillStyle = '#d3d0c8';
    ctx.fillRect(g.margin, g.margin - 13, g.w - g.margin * 2, 1);
    ctx.fillRect(g.margin, g.h - g.margin + 12, g.w - g.margin * 2, 1);

    ctx.fillStyle = '#9a978d';
    ctx.textAlign = 'center';
    ctx.fillText('Page ' + (index + 1) + ' of ' + total, g.w / 2, g.h - g.margin + 30);
    ctx.restore();
  }

  function clip(ctx, str, maxW) {
    if (ctx.measureText(str).width <= maxW) return str;
    while (str.length > 4 && ctx.measureText(str + '…').width > maxW) str = str.slice(0, -1);
    return str + '…';
  }

  /* ── text → lines → pages ─────────────────────────────────────────────── */

  var scratch = document.createElement('canvas').getContext('2d');

  function textMetrics(g) {
    scratch.font = g.fontPx + 'px ' + MONO;
    var cw = scratch.measureText('M').width || g.fontPx * 0.6;
    return {
      charW: cw,
      cols: Math.max(24, Math.floor((g.w - g.margin * 2) / cw)),
      rows: Math.max(8, Math.floor((g.h - g.margin * 2) / g.lineH))
    };
  }

  function wrap(text, cols) {
    var out = [];
    var src = String(text).replace(/\r\n?/g, '\n').split('\n');
    for (var i = 0; i < src.length; i++) {
      var s = src[i].replace(/\t/g, '    ');
      while (s.length > cols) {
        var br = s.lastIndexOf(' ', cols);
        if (br <= cols * 0.4) br = cols;           // no sensible break — hard wrap
        out.push(s.slice(0, br));
        s = s.slice(br).replace(/^ +/, '');
      }
      out.push(s);
    }
    return out;
  }

  function textPages(lines, g, info, cap) {
    var m = textMetrics(g);
    var chunks = [];
    for (var i = 0; i < lines.length && chunks.length < cap; i += m.rows) {
      chunks.push(lines.slice(i, i + m.rows));
    }
    if (!chunks.length) chunks.push(['(empty document)']);

    var total = chunks.length;
    return chunks.map(function (chunk, index) {
      return function (ctx) {
        drawChrome(ctx, g, info, index, total);
        ctx.fillStyle = '#1b1b1b';
        ctx.font = g.fontPx + 'px ' + MONO;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        for (var r = 0; r < chunk.length; r++) {
          ctx.fillText(chunk[r], g.margin, g.margin + r * g.lineH);
        }
      };
    });
  }

  /* ── hex dump ─────────────────────────────────────────────────────────── */

  function hexLines(buf) {
    var bytes = new Uint8Array(buf, 0, Math.min(buf.byteLength, LIMITS.binaryBytes));
    var lines = [];
    for (var o = 0; o < bytes.length; o += 16) {
      var hex = '', ascii = '';
      for (var i = 0; i < 16; i++) {
        if (o + i < bytes.length) {
          var b = bytes[o + i];
          hex += (b < 16 ? '0' : '') + b.toString(16) + ' ';
          ascii += (b >= 32 && b < 127) ? String.fromCharCode(b) : '.';
        } else {
          hex += '   ';
        }
        if (i === 7) hex += ' ';
      }
      lines.push(('0000000' + o.toString(16)).slice(-8) + '  ' + hex + ' |' + ascii + '|');
    }
    return lines;
  }

  /* ── image page ───────────────────────────────────────────────────────── */

  function imagePage(img, g, info, caption) {
    return function (ctx) {
      drawChrome(ctx, g, info, 0, 1);
      var boxW = g.w - g.margin * 2;
      var boxH = g.h - g.margin * 2 - 26;
      var s = Math.min(boxW / img.naturalWidth, boxH / img.naturalHeight);
      var w = img.naturalWidth * s, h = img.naturalHeight * s;
      var x = (g.w - w) / 2, y = g.margin + (boxH - h) / 2;

      if (s > 2) ctx.imageSmoothingEnabled = false;   // keep pixel art crisp
      ctx.drawImage(img, x, y, w, h);
      ctx.imageSmoothingEnabled = true;

      ctx.fillStyle = '#9a978d';
      ctx.font = '11px ' + MONO;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(caption, g.w / 2, g.margin + boxH + 18);
      ctx.textAlign = 'left';
    };
  }

  /* ── PDF (pdf.js, fetched lazily; falls back to a hex dump) ───────────── */

  async function pdfPages(buf, g, info) {
    if (!global.pdfjsLib) {
      await loadScript(PDFJS_BASE + 'build/pdf.min.js');
      global.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'build/pdf.worker.min.js';
    }
    var doc = await global.pdfjsLib.getDocument({
      data: new Uint8Array(buf),
      cMapUrl: PDFJS_BASE + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: PDFJS_BASE + 'standard_fonts/'
    }).promise;
    var count = Math.min(doc.numPages, LIMITS.pdfPages);
    var pages = [];

    for (var n = 1; n <= count; n++) {
      /* Rasterise up front so printing never stalls waiting on pdf.js. */
      var page = await doc.getPage(n);
      var vp1 = page.getViewport({ scale: 1 });
      var scale = Math.min((g.w - g.margin) / vp1.width, (g.h - g.margin) / vp1.height) * 1.6;
      var vp = page.getViewport({ scale: scale });
      var off = document.createElement('canvas');
      off.width = Math.max(1, Math.round(vp.width));
      off.height = Math.max(1, Math.round(vp.height));
      await page.render({ canvasContext: off.getContext('2d'), viewport: vp }).promise;
      pages.push(off);
    }

    return pages.map(function (bmp, index) {
      return function (ctx) {
        drawChrome(ctx, g, info, index, count);
        var boxW = g.w - g.margin * 2, boxH = g.h - g.margin * 2;
        var s = Math.min(boxW / bmp.width, boxH / bmp.height);
        var w = bmp.width * s, h = bmp.height * s;
        ctx.drawImage(bmp, (g.w - w) / 2, g.margin + (boxH - h) / 2, w, h);
      };
    });
  }

  /* ── the job builder ──────────────────────────────────────────────────── */

  async function buildJob(file, opts) {
    if (file.size > LIMITS.file) {
      throw new Error('That file is ' + formatBytes(file.size) + '. The limit is ' + formatBytes(LIMITS.file) + '.');
    }

    var g = geometry(opts.paper, opts.landscape);
    var info = {
      name: file.name || 'untitled',
      stamp: new Date().toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
      })
    };
    var job = { name: info.name, size: file.size, geom: g, note: '', kind: '', pages: [] };

    var ext = (info.name.split('.').pop() || '').toLowerCase();
    var isPdf = file.type === 'application/pdf' || ext === 'pdf';
    var isImg = /^image\//.test(file.type) || /^(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/.test(ext);

    /* Images ------------------------------------------------------------- */
    if (isImg) {
      try {
        var url = await readAs(file, 'readAsDataURL');
        var img = await loadImage(url);
        job.kind = 'Image';
        job.pages = [imagePage(img, g, info, img.naturalWidth + ' × ' + img.naturalHeight + ' px · ' + formatBytes(file.size))];
        return job;
      } catch (e) {
        job.note = 'That image could not be decoded, so it was printed as a hex dump.';
      }
    }

    /* PDF ---------------------------------------------------------------- */
    var buf = await readAs(file, 'readAsArrayBuffer');

    if (isPdf) {
      try {
        job.pages = await withTimeout(pdfPages(buf, g, info), PDF_TIMEOUT, 'PDF rendering');
        job.kind = 'PDF';
        if (job.pages.length === LIMITS.pdfPages) job.note = 'Only the first ' + LIMITS.pdfPages + ' pages were spooled.';
        return job;
      } catch (e) {
        job.note = e && e.name === 'PasswordException'
          ? 'That PDF is password-protected, so it printed as a hex dump.'
          : 'This PDF could not be rendered (pdf.js needs a network connection), so it printed as a hex dump.';
      }
    }

    /* Binary → hex dump --------------------------------------------------- */
    if (job.note || looksBinary(buf)) {
      var hl = hexLines(buf);
      job.kind = job.kind || 'Binary';
      job.pages = textPages(hl, g, info, LIMITS.binaryPages);
      if (!job.note && buf.byteLength > LIMITS.binaryBytes) {
        job.note = 'Binary file — the first ' + formatBytes(LIMITS.binaryBytes) + ' were dumped as hex.';
      } else if (!job.note) {
        job.note = 'Not a text file, so it printed as a hex dump.';
      }
      return job;
    }

    /* Text ---------------------------------------------------------------- */
    var text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    var m = textMetrics(g);
    var lines = wrap(text, m.cols);
    job.kind = 'Text';
    job.pages = textPages(lines, g, info, LIMITS.textPages);
    if (Math.ceil(lines.length / m.rows) > LIMITS.textPages) {
      job.note = 'Long document — printing stops at ' + LIMITS.textPages + ' pages.';
    }
    return job;
  }

  /* ── colour modes, applied to a finished page ─────────────────────────── */

  var BAYER8 = [
    [ 0, 32,  8, 40,  2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44,  4, 36, 14, 46,  6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [ 3, 35, 11, 43,  1, 33,  9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47,  7, 39, 13, 45,  5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21]
  ];

  /* Returns ink coverage 0..1 (used to drain the toner cartridge). */
  function applyColorMode(canvas, mode) {
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    var img = ctx.getImageData(0, 0, w, h);
    var d = img.data;
    var dark = 0, samples = 0;

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        var lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

        if (mode === 'gray') {
          d[i] = d[i + 1] = d[i + 2] = lum;
        } else if (mode === 'dither') {
          var t = (BAYER8[y & 7][x & 7] + 0.5) * 4;   // 0..255
          var v = lum < t ? 0 : 255;
          d[i] = d[i + 1] = d[i + 2] = v;
          lum = v;
        }

        dark += (255 - lum) / 255;
        samples++;
      }
    }

    ctx.putImageData(img, 0, 0);
    return samples ? dark / samples : 0;
  }

  /* Low toner: wash the page out and add a couple of drum streaks. */
  function fadeForToner(canvas, toner) {
    if (toner >= 18) return;
    var ctx = canvas.getContext('2d');
    var amount = Math.min(0.72, (18 - toner) / 22);
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,' + amount.toFixed(3) + ')';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (toner < 9) {
      for (var s = 0; s < 3; s++) {
        var x = (0.17 + s * 0.31) * canvas.width;
        ctx.fillStyle = 'rgba(255,255,255,.55)';
        ctx.fillRect(x, 0, 5 + s * 3, canvas.height);
      }
    }
    ctx.restore();
  }

  global.WP = global.WP || {};
  global.WP.render = {
    PAPER: PAPER,
    LIMITS: LIMITS,
    MONO: MONO,
    geometry: geometry,
    buildJob: buildJob,
    applyColorMode: applyColorMode,
    fadeForToner: fadeForToner,
    formatBytes: formatBytes,
    textPages: textPages,
    wrap: wrap,
    textMetrics: textMetrics
  };
})(window);
