/* ==========================================================================
   app.js — wiring: pick a file, spool it, drive the printer, collect output.
   ========================================================================== */

(function (global) {
  'use strict';

  var R = global.WP.render;
  var $ = function (id) { return document.getElementById(id); };

  var dom = {
    drop: $('drop'), file: $('file'),
    docinfo: $('docinfo'), docName: $('doc-name'), docKind: $('doc-kind'),
    docSize: $('doc-size'), docPages: $('doc-pages'), docNote: $('doc-note'),
    btnClear: $('btn-clear'), btnSample: $('btn-sample'),
    paper: $('paper'), orient: $('orient'), colormode: $('colormode'),
    quality: $('quality'), copies: $('copies'), sound: $('sound'),
    btnPrint: $('btn-print'), btnCancel: $('btn-cancel'), btnToner: $('btn-toner'),
    printer: $('printer'), head: $('head'), sheet: $('sheet'), out: $('out'), status: $('status'),
    lcd: document.querySelector('.lcd'), lcd1: $('lcd-1'), lcd2: $('lcd-2'), lcdFill: $('lcd-fill'),
    ledData: $('led-data'), ledError: $('led-error'),
    tonerFill: $('toner-fill'), tonerPct: $('toner-pct'), tonerBar: document.querySelector('.toner__bar'),
    trayStack: $('tray-stack'), trayEmpty: $('tray-empty'), trayCount: $('tray-count'), btnEmpty: $('btn-empty'),
    viewer: $('viewer'), viewerBody: $('viewer-body'), viewerTitle: $('viewer-title'),
    viewerDownload: $('viewer-download'), viewerClose: $('viewer-close')
  };

  var printer = new global.WP.Printer(dom);
  var currentFile = null;
  var job = null;
  var spoolToken = 0;
  var printed = 0;

  /* ── settings ─────────────────────────────────────────────────────────── */

  function options() {
    return {
      paper: dom.paper.value,
      landscape: dom.orient.value === 'landscape',
      colormode: dom.colormode.value,
      quality: dom.quality.value,
      copies: Math.max(1, Math.min(5, parseInt(dom.copies.value, 10) || 1))
    };
  }

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

      fitLandingArea(job.geom);
      dom.docKind.textContent = job.kind;
      dom.docPages.textContent = job.pages.length + (job.pages.length === 1 ? ' page' : ' pages');
      dom.docNote.hidden = !job.note;
      dom.docNote.textContent = job.note || '';
      dom.btnPrint.disabled = printer.busy;
      printer.lcd('READY', job.name + ' · ' + job.pages.length + 'p · ' + job.geom.label);
      printer.say('Ready to print ' + job.pages.length + ' page' + (job.pages.length === 1 ? '' : 's') + '.');
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

  /* Reserve exactly one sheet's worth of room below the slot. */
  function fitLandingArea(geom) {
    var w = dom.sheet.getBoundingClientRect().width;
    if (!w) return;
    dom.out.style.minHeight = Math.ceil(w * geom.h / geom.w) + 'px';
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

  global.addEventListener('resize', function () { if (job) fitLandingArea(job.geom); });

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

  /* Re-paginate when the sheet geometry changes. */
  [dom.paper, dom.orient].forEach(function (el) {
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
    '  Images ........... scaled to fit the printable area, centred,',
    '                     and captioned with their pixel dimensions.',
    '                     Small images are drawn without smoothing,',
    '                     so pixel art stays sharp.',
    '',
    '  PDF .............. rasterised page by page.',
    '',
    '  Everything else .. dumped as hexadecimal, sixteen bytes to a',
    '                     line, with the printable ASCII alongside.',
    '',
    'THINGS TO TRY',
    '',
    '  1. Switch the colour mode to 1-bit dither and print an image.',
    '     The Bayer matrix does the work a real laser printer would.',
    '',
    '  2. Set the quality to High and watch the carriage sweep.',
    '',
    '  3. Turn on printer sounds. The motor noise is filtered noise',
    '     whose centre frequency tracks the print head across the',
    '     page; the clunks are the rollers grabbing each sheet.',
    '',
    '  4. Print until the toner runs out. The last few pages fade,',
    '     then streak, then the job stops until you fit a new',
    '     cartridge -- exactly like the one down the hall.',
    '',
    '  5. Click any sheet in the output tray to read it full size',
    '     or save it as a PNG.',
    '',
    '================================================================',
    '',
    'HOW THE SHEET GETS ONTO THE SCREEN',
    '',
    'Each page is painted once, in full, onto an off-screen canvas the',
    'true size of the sheet -- 850 by 1100 pixels for US Letter, which',
    'is 8.5 by 11 inches at 100 pixels to the inch.',
    '',
    'The sheet you can see is that canvas inside a box with its',
    'overflow hidden. Printing is nothing more than a loop on',
    'requestAnimationFrame growing the height of that box, which is why',
    'the page appears from the top down, in reading order, at whatever',
    'rate the quality setting asks for. The carriage above the paper is',
    'a rectangle parked on the bottom edge of whatever has emerged so',
    'far, sliding side to side on a cosine.',
    '',
    'The frame clock advances by clamped deltas rather than by elapsed',
    'wall time, so leaving this tab and coming back finds a sheet that',
    'paused politely instead of one that finished without you.',
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
    var want = R.geometry(opts.paper, opts.landscape);
    if (job.geom.w !== want.w || job.geom.h !== want.h) await spool();
    if (!job) return;
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

  printer.onpage = function (canvas, meta) {
    printed++;
    dom.trayEmpty.hidden = true;
    dom.btnEmpty.hidden = false;

    var thumb = document.createElement('canvas');
    var tw = 200;
    thumb.width = tw;
    thumb.height = Math.round(tw * canvas.height / canvas.width);
    var tctx = thumb.getContext('2d');
    tctx.fillStyle = '#fff';
    tctx.fillRect(0, 0, thumb.width, thumb.height);
    tctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pageout';
    btn.title = 'View page ' + printed;
    btn.setAttribute('aria-label', 'View printed page ' + printed);
    btn.appendChild(thumb);

    var no = document.createElement('span');
    no.className = 'pageout__no';
    no.textContent = printed;
    btn.appendChild(no);

    btn._full = canvas;
    btn._label = 'page ' + printed;
    btn.addEventListener('click', function () { openViewer(btn._full, btn._label, printed); });

    dom.trayStack.appendChild(btn);
    dom.trayStack.scrollLeft = dom.trayStack.scrollWidth;
    dom.trayCount.textContent = printed + (printed === 1 ? ' page' : ' pages');

    if (!('animate' in btn)) return;
    btn.animate([
      { transform: 'translateY(-26px) rotate(-4deg)', opacity: 0 },
      { transform: 'none', opacity: 1 }
    ], { duration: 260, easing: 'cubic-bezier(.2,.8,.3,1)' });
  };

  dom.btnEmpty.addEventListener('click', function () {
    Array.prototype.slice.call(dom.trayStack.querySelectorAll('.pageout')).forEach(function (el) { el.remove(); });
    printed = 0;
    dom.trayEmpty.hidden = false;
    dom.btnEmpty.hidden = true;
    dom.trayCount.textContent = 'empty';
  });

  /* ── page viewer ──────────────────────────────────────────────────────── */

  var viewing = null;

  function openViewer(canvas, label, n) {
    viewing = { canvas: canvas, n: n };
    dom.viewerTitle.textContent = label;
    dom.viewerBody.innerHTML = '';
    var copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d').drawImage(canvas, 0, 0);
    dom.viewerBody.appendChild(copy);
    if (typeof dom.viewer.showModal === 'function') dom.viewer.showModal();
    else dom.viewer.setAttribute('open', '');
  }

  dom.viewerClose.addEventListener('click', function () { dom.viewer.close(); });
  dom.viewer.addEventListener('click', function (e) {
    if (e.target === dom.viewer) dom.viewer.close();   // click the backdrop
  });

  dom.viewerDownload.addEventListener('click', function () {
    if (!viewing) return;
    viewing.canvas.toBlob(function (blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'web-printer-page-' + viewing.n + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }, 'image/png');
  });

  /* ── boot ─────────────────────────────────────────────────────────────── */

  printer.lcd('READY', 'no document loaded');
  printer.onstate('idle');

  /* The live machine, for anyone who wants to poke at it from the console:
     WP.printer.toner = 3, WP.printer.print(job, opts), and so on. */
  global.WP.printer = printer;
})(window);
