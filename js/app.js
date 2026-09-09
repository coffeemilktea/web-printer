/* ==========================================================================
   app.js — wiring: pick a file, spool it, drive the printer, collect output.
   ========================================================================== */

(function (global) {
  'use strict';

  var R = global.WP.render;
  var S = global.WP.save;
  var $ = function (id) { return document.getElementById(id); };

  var dom = {
    drop: $('drop'), file: $('file'),
    docinfo: $('docinfo'), docName: $('doc-name'), docKind: $('doc-kind'),
    docSize: $('doc-size'), docPages: $('doc-pages'), docNote: $('doc-note'),
    btnClear: $('btn-clear'), btnSample: $('btn-sample'),
    paper: $('paper'), orient: $('orient'), scale: $('scale'), margin: $('margin'),
    nup: $('nup'), range: $('range'), colormode: $('colormode'), quality: $('quality'),
    copies: $('copies'), collate: $('collate'), reverse: $('reverse'), sound: $('sound'),
    btnPrint: $('btn-print'), btnCancel: $('btn-cancel'), btnToner: $('btn-toner'),
    printer: $('printer'), head: $('head'), sheet: $('sheet'), out: $('out'),
    stack: $('stack'), stage: document.querySelector('.stage'), status: $('status'),
    lcd: document.querySelector('.lcd'), lcd1: $('lcd-1'), lcd2: $('lcd-2'), lcdFill: $('lcd-fill'),
    ledData: $('led-data'), ledError: $('led-error'),
    tonerFill: $('toner-fill'), tonerPct: $('toner-pct'), tonerBar: document.querySelector('.toner__bar'),
    trayCount: $('tray-count'), btnEmpty: $('btn-empty'), btnPdf: $('btn-pdf'),
    viewer: $('viewer'), viewerImg: $('viewer-img'), viewerTitle: $('viewer-title'),
    viewerPrev: $('viewer-prev'), viewerNext: $('viewer-next'),
    viewerFormat: $('viewer-format'), viewerDownload: $('viewer-download'),
    viewerClose: $('viewer-close')
  };

  var printer = new global.WP.Printer(dom);
  var currentFile = null;
  var job = null;
  var spoolToken = 0;

  /* ── settings ─────────────────────────────────────────────────────────── */

  function options() {
    var scale = dom.scale.value === 'fit' ? 'fit' : parseFloat(dom.scale.value);
    return {
      paper: dom.paper.value,
      landscape: dom.orient.value === 'landscape',
      scale: scale,
      margin: dom.margin.value,
      nup: parseInt(dom.nup.value, 10) || 1,
      range: dom.range.value,
      colormode: dom.colormode.value,
      quality: dom.quality.value,
      copies: Math.max(1, Math.min(5, parseInt(dom.copies.value, 10) || 1)),
      collate: dom.collate.checked,
      reverse: dom.reverse.checked
    };
  }

  /* Options that change how the document is laid out, and so need a respool. */
  var LAYOUT = ['paper', 'orient', 'scale', 'margin', 'nup', 'range'];

  /* ── loading a document ───────────────────────────────────────────────── */

  async function load(file) {
    if (!file) return;
    currentFile = file;
    await spool();
  }

  async function spool() {
    if (!currentFile) return;
    var token = ++spoolToken;

    dom.docinfo.hidden = false;
    dom.docName.textContent = currentFile.name || 'pasted content';
    dom.docKind.textContent = '…';
    dom.docSize.textContent = R.formatBytes(currentFile.size);
    dom.docPages.textContent = '…';
    dom.docNote.hidden = true;
    dom.btnPrint.disabled = true;
    printer.lcd('SPOOLING', 'reading document…');
    printer.say('Spooling ' + (currentFile.name || 'document') + '…');

    try {
      var built = await R.buildJob(currentFile, options());
      if (token !== spoolToken) return;                 // a newer file won the race
      job = built;

      fitTray(job.geom);
      dom.docKind.textContent = job.kind;
      dom.docPages.textContent = describeSheets(job);
      dom.docNote.hidden = !job.note;
      dom.docNote.textContent = job.note || '';
      dom.btnPrint.disabled = printer.busy || !job.pages.length;
      printer.lcd('READY', job.name + ' · ' + job.pages.length + 'p · ' + job.geom.label);
      printer.say(job.pages.length
        ? 'Ready to print ' + job.pages.length + ' sheet' + (job.pages.length === 1 ? '' : 's') + '.'
        : 'Nothing to print.');
    } catch (err) {
      if (token !== spoolToken) return;
      job = null;
      dom.docKind.textContent = '—';
      dom.docPages.textContent = '—';
      dom.docNote.hidden = false;
      dom.docNote.textContent = err.message || 'That file could not be read.';
      dom.btnPrint.disabled = true;
      printer.lcd('ERROR', 'document rejected', true);
      printer.say(err.message || 'That file could not be read.');
    }
  }

  /* The tray extends to fit whatever paper is loaded, like a real one. */
  function fitTray(geom) {
    var w = dom.sheet.getBoundingClientRect().width;
    if (!w) return;
    dom.stage.style.setProperty('--sheet-h', Math.ceil(w * geom.h / geom.w) + 'px');
  }

  /* "3 sheets" on its own, or "3 sheets · 6 of 8 pages" once the range or
     n-up settings mean sheets and pages are no longer the same thing. */
  function describeSheets(job) {
    var sheets = job.pages.length;
    if (!sheets) return 'nothing to print';
    var text = sheets + (sheets === 1 ? ' sheet' : ' sheets');
    if (job.selected !== job.logical || job.selected !== sheets) {
      text += ' · ' + job.selected + ' of ' + job.logical + ' pages';
    }
    return text;
  }

  function clearDoc() {
    spoolToken++;
    currentFile = null;
    job = null;
    dom.file.value = '';
    dom.docinfo.hidden = true;
    dom.btnPrint.disabled = true;
    printer.lcd('READY', 'no document loaded');
    printer.say('Printer idle.');
  }

  /* ── file pickers ─────────────────────────────────────────────────────── */

  dom.drop.addEventListener('click', function () { dom.file.click(); });
  dom.drop.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dom.file.click(); }
  });
  dom.file.addEventListener('change', function () { load(dom.file.files[0]); });

  ['dragenter', 'dragover'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
      e.preventDefault();
      dom.drop.classList.add('is-over');
    });
  });
  ['dragleave', 'dragend'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      if (e.relatedTarget === null || type === 'dragend') dom.drop.classList.remove('is-over');
    });
  });
  document.addEventListener('drop', function (e) {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    dom.drop.classList.remove('is-over');
    load(e.dataTransfer.files[0]);
  });

  global.addEventListener('resize', function () { if (job) fitTray(job.geom); });

  document.addEventListener('paste', function (e) {
    if (!e.clipboardData) return;
    var target = e.target;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (e.clipboardData.files && e.clipboardData.files.length) {
      load(e.clipboardData.files[0]);
      return;
    }
    var text = e.clipboardData.getData('text/plain');
    if (text && text.trim()) {
      load(new File([text], 'pasted.txt', { type: 'text/plain' }));
    }
  });

  dom.btnClear.addEventListener('click', clearDoc);

  /* Re-paginate whenever a layout setting moves. */
  LAYOUT.forEach(function (key) {
    var el = dom[key === 'orient' ? 'orient' : key];
    el.addEventListener('change', function () { if (currentFile) spool(); });
  });

  /* ── the sample document ──────────────────────────────────────────────── */

  var SAMPLE = [
    '                        WEB-PRINTER',
    '            a printer that lives in your browser',
    '',
    '================================================================',
    '',
    'ABOUT THIS PAGE',
    '',
    'You are looking at a sheet of paper that does not exist. It was',
    'laid out in a canvas element, rasterised at 100 pixels per inch,',
    'and fed through a printer drawn entirely in CSS. No bytes left',
    'your machine to make it.',
    '',
    'WHAT IT PRINTS',
    '',
    '  Text and code .... paginated in a monospace face, wrapped to',
    '                     the width of the sheet, with a running',
    '                     header and a page number in the footer.',
    '',
    '  Images ........... fitted to the printable area, or printed at',
    '                     any scale you ask for. Small images are',
    '                     drawn without smoothing, so pixel art stays',
    '                     sharp.',
    '',
    '  Word ............. .docx keeps its headings, bold and italic,',
    '                     lists and tables. The older .doc keeps its',
    '                     text and paragraphs.',
    '',
    '  PDF .............. rasterised page by page.',
    '',
    '  Everything else .. dumped as hexadecimal, sixteen bytes to a',
    '                     line, with the printable ASCII alongside.',
    '',
    'THINGS TO TRY',
    '',
    '  1. Set the colour to black and white, dithered, and print an',
    '     image. The Bayer matrix does the work a real laser printer',
    '     would.',
    '',
    '  2. Put four pages on a sheet, or ask for pages 2-4 only.',
    '',
    '  3. Turn on printer sounds and set the quality to High. The',
    '     motor noise is filtered noise whose centre frequency tracks',
    '     the print head across the page; the ticks between passes',
    '     are the rollers advancing the paper one band.',
    '',
    '  4. Print until the toner runs out. The last few sheets fade,',
    '     then streak, then the job stops until you fit a new',
    '     cartridge -- exactly like the one down the hall.',
    '',
    '  5. Take a sheet off the top of the tray to read it full size,',
    '     save it as PNG, JPEG or WebP, or turn the whole tray into',
    '     a PDF.',
    '',
    '================================================================',
    '',
    'HOW THE INK GETS ONTO THE PAGE',
    '',
    'Each sheet is painted once, in full, onto an off-screen canvas',
    'the true size of the paper -- 850 by 1100 pixels for US Letter,',
    'which is 8.5 by 11 inches at 100 pixels to the inch. That canvas',
    'is never shown to you.',
    '',
    'What you watch instead is a second, blank canvas. The paper',
    'steps forward by one band, the carriage sweeps across it, and',
    'ink is copied from the finished page into the blank one only',
    'across the strip the head has already passed over. Then the',
    'paper steps again, and the carriage comes back the other way.',
    'A band that is dark on the left and still white on the right is',
    'a pass caught halfway through.',
    '',
    'Higher quality settings lay down thinner bands and take longer,',
    'which is the same trade a real printer makes.',
    '',
    'The frame clock advances by clamped deltas rather than by',
    'elapsed wall time, so leaving this tab and coming back finds a',
    'sheet that paused politely instead of one that finished without',
    'you.',
    '',
    '================================================================',
    '',
    'Drop a file of your own on the panel to the left to print it.',
    ''
  ].join('\n');

  dom.btnSample.addEventListener('click', function () {
    load(new File([SAMPLE], 'sample.txt', { type: 'text/plain' }));
  });

  /* ── printing ─────────────────────────────────────────────────────────── */

  dom.sound.addEventListener('change', function () {
    printer.sound.enabled = dom.sound.checked;
    if (dom.sound.checked) printer.sound.resume();
    else printer.sound.motor(false);
  });

  dom.btnPrint.addEventListener('click', async function () {
    if (!job || printer.busy) return;
    var opts = options();
    /* Colour and quality are read per page, but pagination is baked in. */
    var want = R.geometry(opts.paper, opts.landscape, opts.margin, opts.scale);
    if (job.geom.w !== want.w || job.geom.h !== want.h || job.geom.margin !== want.margin) await spool();
    if (!job || !job.pages.length) return;
    await printer.print(job, opts);
  });

  dom.btnCancel.addEventListener('click', function () { printer.cancel(); });
  dom.btnToner.addEventListener('click', function () { printer.replaceCartridge(); });

  printer.onstate = function (state) {
    var running = state !== 'idle';
    dom.btnPrint.hidden = running;
    dom.btnCancel.hidden = !running;
    dom.btnPrint.disabled = !job || running;
  };

  /* ── output tray ──────────────────────────────────────────────────────── */

  printer.onpage = function (page) {
    page.el.addEventListener('click', function () {
      openViewer(printer.pages.indexOf(page));
    });
  };

  printer.ontray = function () {
    var n = printer.pages.length;
    dom.trayCount.textContent = n ? n + (n === 1 ? ' sheet' : ' sheets') : 'tray empty';
    dom.btnEmpty.hidden = n === 0;
    dom.btnPdf.hidden = n === 0;
  };

  dom.btnEmpty.addEventListener('click', function () { printer.emptyTray(); });

  dom.btnPdf.addEventListener('click', async function () {
    if (!printer.pages.length || dom.btnPdf.disabled) return;
    var label = dom.btnPdf.textContent;
    dom.btnPdf.disabled = true;
    try {
      var blob = await S.trayToPDF(printer.pages, function (i, n) {
        dom.btnPdf.textContent = 'Building PDF… ' + (i + 1) + '/' + n;
      });
      var url = URL.createObjectURL(blob);
      S.download(url, stem() + '.pdf');
      setTimeout(function () { URL.revokeObjectURL(url); }, 8000);
      printer.say(printer.pages.length + ' sheets saved as a PDF.');
    } catch (err) {
      printer.say(err.message || 'That PDF could not be built.');
    }
    dom.btnPdf.textContent = label;
    dom.btnPdf.disabled = false;
  });

  /* A filename that looks like it came from the document, not from a counter. */
  function stem() {
    var name = (job && job.name) || 'web-printer';
    return name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'web-printer';
  }

  /* ── page viewer ──────────────────────────────────────────────────────── */

  var viewing = -1;

  function openViewer(index) {
    var page = printer.pages[index];
    if (!page) return;
    viewing = index;
    dom.viewerImg.src = page.url;
    dom.viewerTitle.textContent = 'Sheet ' + page.n + ' of ' + printer.pages.length;
    dom.viewerPrev.disabled = index <= 0;
    dom.viewerNext.disabled = index >= printer.pages.length - 1;
    if (!dom.viewer.open) {
      if (typeof dom.viewer.showModal === 'function') dom.viewer.showModal();
      else dom.viewer.setAttribute('open', '');
    }
  }

  function step(by) {
    var next = viewing + by;
    if (next >= 0 && next < printer.pages.length) openViewer(next);
  }

  S.formats().forEach(function (f) {
    var opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.label;
    dom.viewerFormat.appendChild(opt);
  });

  dom.viewerDownload.addEventListener('click', async function () {
    var page = printer.pages[viewing];
    if (!page) return;
    dom.viewerDownload.disabled = true;
    try {
      var out = await S.pageAs(page, dom.viewerFormat.value);
      S.download(out.url, stem() + '-sheet-' + page.n + '.' + out.ext);
      if (out.revoke) setTimeout(function () { URL.revokeObjectURL(out.url); }, 8000);
    } catch (err) {
      printer.say(err.message || 'That page could not be saved.');
    }
    dom.viewerDownload.disabled = false;
  });

  dom.viewerPrev.addEventListener('click', function () { step(-1); });
  dom.viewerNext.addEventListener('click', function () { step(1); });
  dom.viewerClose.addEventListener('click', function () { dom.viewer.close(); });
  dom.viewer.addEventListener('click', function (e) {
    if (e.target === dom.viewer) dom.viewer.close();   // click the backdrop
  });
  dom.viewer.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  });

  /* ── boot ─────────────────────────────────────────────────────────────── */

  printer.lcd('READY', 'no document loaded');
  printer.onstate('idle');
  printer.ontray();

  /* The live machine, for anyone who wants to poke at it from the console:
     WP.printer.toner = 3, WP.printer.print(job, opts), and so on. */
  global.WP.printer = printer;
})(window);
