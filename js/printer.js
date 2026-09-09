/* ==========================================================================
   printer.js — the machine itself.

   Printing is modelled the way an inkjet actually works: the paper steps
   forward by one band, the carriage sweeps across laying ink into that band,
   the paper steps again. Ink is copied from a fully rendered off-screen page
   into the visible sheet only as the head passes over it, so what you watch
   is the page being written, not a page being revealed.
   ========================================================================== */

(function (global) {
  'use strict';

  /* Per quality: band height in page pixels, and how long a sweep and a paper
     step take. Higher quality lays finer bands and takes longer, as it should. */
  var BAND = {
    draft:  { h: 96, sweep: 48, feed: 26 },
    normal: { h: 56, sweep: 64, feed: 30 },
    high:   { h: 34, sweep: 88, feed: 34 }
  };

  var STACK_MAX = 30;         // sheets kept in the tray's DOM
  var FAN_MAX = 168;          // how far down the tray the pile is allowed to fan
  var FAN_STEP = 13;          // the step it prefers when there is room
  var reduceMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* A finished page becomes a PNG blob: one image instead of a 3.7 MB canvas
     per sheet, and the same URL serves the tray, the viewer and the download. */
  function pageURL(canvas) {
    return new Promise(function (resolve) {
      if (!canvas.toBlob) { resolve(canvas.toDataURL('image/png')); return; }
      canvas.toBlob(function (blob) {
        resolve(blob ? URL.createObjectURL(blob) : canvas.toDataURL('image/png'));
      }, 'image/png');
    });
  }

  /* ── motor, rollers, carriage ─────────────────────────────────────────── */

  function Sound() {
    this.enabled = false;
    this.ctx = null;
  }

  Sound.prototype._init = function () {
    if (this.ctx) return true;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return false;
    this.ctx = new AC();

    /* A second of brown-ish noise, looped — the basis for every sound here. */
    var len = this.ctx.sampleRate;
    var buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    var data = buf.getChannelData(0);
    var last = 0;
    for (var i = 0; i < len; i++) {
      var white = Math.random() * 2 - 1;
      last = (last + 0.04 * white) / 1.04;
      data[i] = last * 3.2;
    }
    this.noise = buf;

    this.motorGain = this.ctx.createGain();
    this.motorGain.gain.value = 0;
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'bandpass';
    this.filter.frequency.value = 700;
    this.filter.Q.value = 5;
    this.filter.connect(this.motorGain).connect(this.ctx.destination);

    this.src = this.ctx.createBufferSource();
    this.src.buffer = buf;
    this.src.loop = true;
    this.src.connect(this.filter);
    this.src.start();
    return true;
  };

  Sound.prototype.resume = function () {
    if (this.enabled && this._init() && this.ctx.state === 'suspended') this.ctx.resume();
  };

  Sound.prototype.motor = function (on) {
    if (!this.enabled || !this._init()) return;
    this.resume();
    var t = this.ctx.currentTime;
    this.motorGain.gain.cancelScheduledValues(t);
    this.motorGain.gain.setTargetAtTime(on ? 0.055 : 0, t, 0.02);
  };

  /* The carriage: filter frequency follows the head across the page. */
  Sound.prototype.sweep = function (pos) {
    if (!this.enabled || !this.ctx) return;
    this.filter.frequency.setTargetAtTime(520 + pos * 900, this.ctx.currentTime, 0.03);
  };

  /* Rollers: a low clunk for a sheet, a short tick for one paper step. */
  Sound.prototype.knock = function (pitch, level, decay) {
    if (!this.enabled || !this._init()) return;
    this.resume();
    var t = this.ctx.currentTime;
    var g = this.ctx.createGain();
    var f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = pitch;
    var s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.connect(f).connect(g).connect(this.ctx.destination);
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    s.start(t);
    s.stop(t + decay + 0.02);
  };

  Sound.prototype.clunk = function (pitch) { this.knock(pitch || 260, 0.16, 0.22); };
  Sound.prototype.step  = function ()      { this.knock(1500, 0.035, 0.05); };

  /* ── the printer ──────────────────────────────────────────────────────── */

  function Printer(dom) {
    this.dom = dom;
    this.sound = new Sound();
    this.toner = 100;
    this.busy = false;
    this.cancelled = false;
    this.pages = [];         // {url, n, id, el}
    this._ids = 0;
    this._waiting = null;
    this._abortFeed = null;
    this.onpage = null;      // (page) => void — a sheet landed in the tray
    this.ontray = null;      // () => void — tray contents changed
    this.onstate = null;     // (state) => void
    this._paintToner();
  }

  /* ── panel ────────────────────────────────────────────────────────────── */

  Printer.prototype.lcd = function (line1, line2, error) {
    this.dom.lcd1.textContent = line1;
    if (line2 != null) this.dom.lcd2.textContent = line2;
    this.dom.lcd.classList.toggle('is-error', !!error);
    this.dom.ledError.classList.toggle('is-on', !!error);
  };

  Printer.prototype.progress = function (fraction) {
    this.dom.lcdFill.style.width = Math.max(0, Math.min(1, fraction)) * 100 + '%';
  };

  Printer.prototype.say = function (text) { this.dom.status.textContent = text; };

  Printer.prototype._paintToner = function () {
    var pct = Math.max(0, Math.round(this.toner));
    this.dom.tonerFill.style.width = pct + '%';
    this.dom.tonerPct.textContent = pct + '%';
    this.dom.tonerBar.classList.toggle('is-low', pct <= 20 && pct > 0);
    this.dom.tonerBar.classList.toggle('is-out', pct === 0);
    if (this.dom.ledToner) this.dom.ledToner.classList.toggle('is-on', pct <= 20);
  };

  Printer.prototype.replaceCartridge = function () {
    this.toner = 100;
    this._paintToner();
    if (this._waiting) { var go = this._waiting; this._waiting = null; go(); }
    else if (!this.busy) { this.lcd('READY', 'fresh cartridge installed'); this.say('New cartridge installed.'); }
  };

  Printer.prototype.cancel = function () {
    if (!this.busy) return;
    this.cancelled = true;
    this.sound.motor(false);
    /* Stop the sheet now rather than on the next animation frame — a
       backgrounded tab gets no frames, and cancel should never feel stuck. */
    if (this._abortFeed) this._abortFeed();
    if (this._waiting) { var go = this._waiting; this._waiting = null; go(); }
  };

  /* ── composing one sheet ──────────────────────────────────────────────── */

  Printer.prototype._compose = function (job, index, opts) {
    var g = job.geom;
    var canvas = document.createElement('canvas');
    canvas.width = g.w;
    canvas.height = g.h;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, g.w, g.h);
    job.pages[index](ctx);

    var coverage = global.WP.render.applyColorMode(canvas, opts.colormode);
    global.WP.render.fadeForToner(canvas, this.toner);
    return { canvas: canvas, coverage: coverage };
  };

  /* ── running a sheet through: step, sweep, step, sweep ────────────────── */

  Printer.prototype._run = function (full, job, opts, label) {
    var self = this;
    var g = job.geom;
    var sheet = this.dom.sheet;
    var head = this.dom.head;

    /* The visible sheet starts blank. Ink arrives only where the head has been. */
    var paper = document.createElement('canvas');
    paper.width = g.w;
    paper.height = g.h;
    var ink = paper.getContext('2d');
    ink.fillStyle = '#ffffff';
    ink.fillRect(0, 0, g.w, g.h);

    var old = sheet.querySelector('canvas');
    if (old) old.remove();
    sheet.insertBefore(paper, sheet.firstChild);

    var sheetW = sheet.getBoundingClientRect().width || 270;
    var scale = sheetW / g.w;
    sheet.style.height = '0px';
    head.classList.add('is-on');

    var band = BAND[opts.quality] || BAND.normal;
    var bands = Math.ceil(g.h / band.h);
    var travel = Math.max(0, sheetW + 26 - 30);

    /* Lay ink between two carriage positions on the band starting at `top`. */
    function lay(x0, x1, top, height) {
      var a = Math.max(0, Math.min(x0, x1) - 1);
      var b = Math.min(g.w, Math.max(x0, x1) + 1);
      if (b > a) ink.drawImage(full, a, top, b - a, height, a, top, b - a, height);
    }

    this.sound.clunk(240);

    return new Promise(function (resolve) {
      function finish(ok) {
        self._abortFeed = null;
        head.classList.remove('is-on');
        self.sound.motor(false);
        resolve(ok);
      }
      self._abortFeed = function () { finish(false); };

      if (reduceMotion) {                    // no animation: print the sheet outright
        ink.drawImage(full, 0, 0);
        sheet.style.height = (g.h * scale) + 'px';
        self.progress(1);
        setTimeout(function () { finish(true); }, 140);
        return;
      }

      var i = 0;                             // which band
      var phase = 'step';                    // 'step' (paper advances) | 'sweep' (ink)
      var t = 0;                             // ms into this phase
      var dir = 1;                           // carriage direction, alternating
      var lastX = 0;
      var last = performance.now();

      (function frame(now) {
        if (self.cancelled || !self._abortFeed) { finish(false); return; }

        /* Clamped delta rather than elapsed wall time, so a tab that was in
           the background comes back to a paused sheet, not a finished one. */
        var dt = Math.min(100, Math.max(0, now - last));
        last = now;
        t += dt;

        var top = i * band.h;
        var bottom = Math.min(g.h, top + band.h);
        var height = bottom - top;
        var fed;

        if (phase === 'step') {
          var p = Math.min(1, t / band.feed);
          fed = top + height * p;            // the band rolls out past the print line
          if (p >= 1) {
            phase = 'sweep';
            t = 0;
            lastX = dir > 0 ? 0 : g.w;
            self.sound.motor(true);
          }
        } else {
          var q = Math.min(1, t / band.sweep);
          fed = bottom;
          var x = dir > 0 ? q * g.w : (1 - q) * g.w;
          lay(lastX, x, top, height);
          lastX = x;
          self.sound.sweep(x / g.w);
          if (q >= 1) {
            lay(0, g.w, top, height);        // no rounding gaps at the edges
            self.sound.motor(false);
            self.sound.step();
            i++;
            dir = -dir;
            phase = 'step';
            t = 0;
          }
        }

        sheet.style.height = (fed * scale).toFixed(1) + 'px';

        /* The carriage rides the band it is printing. */
        var headY = Math.max(0, (fed - height / 2) * scale) - 5;
        var carriage = phase === 'sweep' ? lastX / g.w : (dir > 0 ? 0 : 1);
        head.style.transform = 'translate(-50%, ' + headY.toFixed(1) + 'px)';
        head.firstElementChild.style.transform = 'translateX(' + (carriage * travel).toFixed(1) + 'px)';

        var done = fed / g.h;
        self.progress(done);
        self.lcd('PRINTING', label + ' · ' + Math.round(done * 100) + '%');

        if (i >= bands) finish(true);
        else requestAnimationFrame(frame);
      })(last);
    });
  };

  /* Pull the sheet out of the mechanism and drop it on the pile. */
  Printer.prototype._toTray = async function (canvas) {
    var url = await pageURL(canvas);
    this._clearSheet();
    this.sound.clunk(150);
    return this._stack(url);
  };

  Printer.prototype._clearSheet = function () {
    var sheet = this.dom.sheet;
    sheet.style.height = '0px';
    var c = sheet.querySelector('canvas');
    if (c) c.remove();
    this.dom.head.classList.remove('is-on');
  };

  /* Each sheet is stepped further down the tray than the one beneath it, so
     the whole job stays visible. The step shrinks as the pile grows, and the
     tray extends to hold however far it fans. */
  Printer.prototype._fan = function () {
    var sheets = this.dom.stack.children;
    var step = sheets.length > 1
      ? Math.min(FAN_STEP, FAN_MAX / (sheets.length - 1))
      : FAN_STEP;

    this.dom.stack.style.setProperty('--step', step.toFixed(2) + 'px');
    for (var i = 0; i < sheets.length; i++) sheets[i].style.setProperty('--i', i);

    var reach = Math.max(0, (sheets.length - 1) * step);
    this.dom.stage.style.setProperty('--cascade', Math.round(reach) + 'px');
  };

  /* A sheet settling into the tray: paper never lands square, so neither
     does this. */
  Printer.prototype._stack = function (url) {
    var n = this.pages.length + 1;
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'sheetout';
    el.setAttribute('aria-label', 'Printed page ' + n + ' — open it');

    var img = new Image();
    img.src = url;
    img.alt = '';
    el.appendChild(img);

    el.style.setProperty('--dx', (Math.random() * 7 - 3.5).toFixed(1) + 'px');
    el.style.setProperty('--dy', (Math.random() * 3).toFixed(1) + 'px');
    el.style.setProperty('--rot', (Math.random() * 1.6 - 0.8).toFixed(2) + 'deg');

    this.dom.stack.appendChild(el);
    while (this.dom.stack.children.length > STACK_MAX) {
      this.dom.stack.removeChild(this.dom.stack.firstChild);
    }
    this._fan();

    /* Start it a little high and let the transition drop it onto the pile. */
    if (!reduceMotion) {
      el.classList.add('is-landing');
      var settle = function () { el.classList.remove('is-landing'); };
      requestAnimationFrame(settle);
      setTimeout(settle, 250);
    }

    var page = { url: url, n: n, id: 'p' + (++this._ids), el: el };
    this.pages.push(page);
    if (this.ontray) this.ontray();
    return page;
  };

  /* The desk can put the pages in any order it likes; the pile in the tray,
     the numbering and everything downstream follow it. */
  Printer.prototype.reorder = function (order) {
    var byId = {};
    this.pages.forEach(function (p) { byId[p.id] = p; });

    var next = [];
    order.forEach(function (id) { if (byId[id]) { next.push(byId[id]); delete byId[id]; } });
    this.pages.forEach(function (p) { if (byId[p.id]) next.push(p); });

    this.pages = next;
    var stack = this.dom.stack;
    this.pages.forEach(function (page, i) {
      page.n = i + 1;
      page.el.setAttribute('aria-label', 'Printed page ' + page.n + ' — open it');
      stack.appendChild(page.el);
    });
    this._fan();
    if (this.ontray) this.ontray();
  };

  Printer.prototype.emptyTray = function () {
    this.pages.forEach(function (p) {
      if (p.url.slice(0, 5) === 'blob:') URL.revokeObjectURL(p.url);
    });
    this.pages = [];
    this.dom.stack.textContent = '';
    this._fan();
    if (this.ontray) this.ontray();
  };

  /* ── the job ──────────────────────────────────────────────────────────── */

  /* Copies, collation and reverse order all just decide the order sheets come
     out, so flatten them into one queue before anything spins up. */
  function buildQueue(job, opts) {
    var order = job.pages.map(function (_, i) { return i; });
    if (opts.reverse) order.reverse();

    var queue = [];
    if (opts.collate === false) {
      order.forEach(function (i) {
        for (var c = 0; c < opts.copies; c++) queue.push({ index: i, copy: c });
      });
    } else {
      for (var c = 0; c < opts.copies; c++) {
        order.forEach(function (i) { queue.push({ index: i, copy: c }); });
      }
    }
    return queue;
  }

  Printer.prototype.print = async function (job, opts) {
    if (this.busy || !job.pages.length) return 0;
    this.busy = true;
    this.cancelled = false;

    var queue = buildQueue(job, opts);
    var total = queue.length;
    var printed = 0;
    this.dom.printer.classList.add('is-busy');
    this.dom.ledData.classList.add('is-busy');
    if (this.dom.ledDrum) this.dom.ledDrum.classList.add('is-on');
    if (this.onstate) this.onstate('printing');
    this.say('Printing ' + total + ' sheet' + (total === 1 ? '' : 's') + '…');
    this.sound.resume();

    for (var q = 0; q < queue.length && !this.cancelled; q++) {

      /* Out of toner? Stop and wait for a new cartridge. */
      if (this.toner <= 0) {
        this.sound.motor(false);
        this.lcd('REPLACE CARTRIDGE', 'job paused — toner empty', true);
        this.say('Out of toner. Replace the cartridge to finish the job.');
        if (this.onstate) this.onstate('blocked');
        var self = this;
        await new Promise(function (go) { self._waiting = go; });
        if (this.cancelled) break;
        this.lcd('PRINTING', 'resuming');
        if (this.onstate) this.onstate('printing');
      }

      var item = queue[q];
      var label = 'sheet ' + (q + 1) + '/' + total +
                  (opts.copies > 1 ? ' · copy ' + (item.copy + 1) : '');

      this.lcd('PRINTING', label + ' · 0%');
      var made = this._compose(job, item.index, opts);
      var finished = await this._run(made.canvas, job, opts, label);
      if (!finished) break;

      this.toner = Math.max(0, this.toner - Math.max(0.6, made.coverage * 22));
      this._paintToner();

      var page = await this._toTray(made.canvas);
      printed++;
      if (this.onpage) this.onpage(page);
      if (printed < total && !this.cancelled) await sleep(150);
    }

    this.sound.motor(false);
    this._clearSheet();
    this.dom.printer.classList.remove('is-busy');
    this.dom.ledData.classList.remove('is-busy');
    if (this.dom.ledDrum) this.dom.ledDrum.classList.remove('is-on');
    this.busy = false;
    this.progress(0);

    if (this.cancelled) {
      this.lcd('JOB CANCELLED', printed + ' of ' + total + ' sheets printed');
      this.say('Job cancelled after ' + printed + ' sheet' + (printed === 1 ? '' : 's') + '.');
    } else {
      this.lcd('READY', printed + ' sheet' + (printed === 1 ? '' : 's') + ' printed');
      this.say(printed + ' sheet' + (printed === 1 ? '' : 's') + ' in the output tray.');
    }
    if (this.onstate) this.onstate('idle');
    return printed;
  };

  global.WP = global.WP || {};
  global.WP.Printer = Printer;
})(window);
