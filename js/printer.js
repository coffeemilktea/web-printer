/* ==========================================================================
   printer.js — the machine itself.

   Owns the stage DOM: the LCD, the status LEDs, the sheet that grows out of
   the slot, the print head that tracks the freshly printed edge, the toner
   cartridge, and the motor noise. Hand it a job from render.js and it prints.
   ========================================================================== */

(function (global) {
  'use strict';

  var SPEED  = { draft: 1500, normal: 800,  high: 420 };  // page-pixels per second
  var SWEEPS = { draft: 7,    normal: 5,    high: 3.4 };  // head sweeps per second
  var reduceMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ── motor / feed noise ───────────────────────────────────────────────── */

  function Sound() {
    this.enabled = false;
    this.ctx = null;
  }

  Sound.prototype._init = function () {
    if (this.ctx) return true;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return false;
    this.ctx = new AC();

    /* One second of noise, looped — the basis for every printer sound. */
    var len = this.ctx.sampleRate;
    var buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    var data = buf.getChannelData(0);
    var last = 0;
    for (var i = 0; i < len; i++) {
      var white = Math.random() * 2 - 1;
      last = (last + 0.04 * white) / 1.04;          // brown-ish, less hissy
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
    this.motorGain.gain.setTargetAtTime(on ? 0.055 : 0, t, 0.05);
  };

  /* Track the carriage: filter frequency follows the head across the page. */
  Sound.prototype.sweep = function (pos) {
    if (!this.enabled || !this.ctx) return;
    this.filter.frequency.setTargetAtTime(520 + pos * 900, this.ctx.currentTime, 0.03);
  };

  /* A roller clunk when a sheet is grabbed or released. */
  Sound.prototype.clunk = function (pitch) {
    if (!this.enabled || !this._init()) return;
    this.resume();
    var t = this.ctx.currentTime;
    var g = this.ctx.createGain();
    var f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = pitch || 260;
    var s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.connect(f).connect(g).connect(this.ctx.destination);
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    s.start(t);
    s.stop(t + 0.25);
  };

  /* ── the printer ──────────────────────────────────────────────────────── */

  function Printer(dom) {
    this.dom = dom;
    this.sound = new Sound();
    this.toner = 100;
    this.busy = false;
    this.cancelled = false;
    this._waiting = null;
    this.onpage = null;      // (canvas, {index, total, copy}) => void
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

  /* ── one sheet ────────────────────────────────────────────────────────── */

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

  Printer.prototype._feed = function (canvas, job, opts, label) {
    var self = this;
    var g = job.geom;
    var sheet = this.dom.sheet;
    var head = this.dom.head;

    /* Mount the page behind the slot at on-screen scale. */
    var prev = sheet.querySelector('canvas');
    if (prev) prev.remove();
    sheet.insertBefore(canvas, sheet.firstChild);

    var sheetW = sheet.getBoundingClientRect().width || 270;
    var scale = sheetW / g.w;
    var fullH = g.h * scale;
    sheet.style.height = '0px';
    head.classList.add('is-on');

    var speed = SPEED[opts.quality] || SPEED.normal;
    var sweeps = SWEEPS[opts.quality] || SWEEPS.normal;
    var travel = Math.max(0, sheetW + 26 - 30);

    this.sound.clunk(240);

    return new Promise(function (resolve) {
      function finish(ok) {
        self._abortFeed = null;
        head.classList.remove('is-on');
        resolve(ok);
      }
      self._abortFeed = function () { finish(false); };

      if (reduceMotion) {                      // no animation: place the sheet, move on
        sheet.style.height = fullH + 'px';
        self.progress(1);
        setTimeout(function () { finish(true); }, 120);
        return;
      }

      var last = performance.now();
      var revealed = 0;
      var clock = 0;

      (function frame(now) {
        if (self.cancelled || !self._abortFeed) {
          finish(false);
          return;
        }
        /* Clamped delta rather than elapsed wall time, so a tab that was in
           the background comes back to a paused sheet, not a finished one. */
        var dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
        last = now;
        clock += dt;
        revealed = Math.min(g.h, revealed + dt * speed);

        var y = revealed * scale;
        sheet.style.height = y.toFixed(1) + 'px';

        var pos = 0.5 - 0.5 * Math.cos(clock * sweeps * Math.PI * 2);
        head.style.transform = 'translate(-50%, ' + (y - 7).toFixed(1) + 'px)';
        head.firstElementChild.style.transform = 'translateX(' + (pos * travel).toFixed(1) + 'px)';
        self.sound.sweep(pos);

        var done = revealed / g.h;
        self.progress(done);
        self.lcd('PRINTING', label + ' · ' + Math.round(done * 100) + '%');

        if (revealed >= g.h) {
          finish(true);
        } else {
          requestAnimationFrame(frame);
        }
      })(last);
    });
  };

  /* Drop the finished sheet into the output tray. */
  Printer.prototype._eject = function () {
    var sheet = this.dom.sheet;
    var self = this;
    this.sound.clunk(150);

    if (reduceMotion || typeof sheet.animate !== 'function') {
      sheet.style.height = '0px';
      var still = sheet.querySelector('canvas');
      if (still) still.remove();
      return Promise.resolve();
    }

    var anim = sheet.animate([
      { transform: 'translateX(-50%) translateY(0) rotate(0deg)', opacity: 1 },
      { transform: 'translateX(-50%) translateY(60px) rotate(1.6deg)', opacity: 0 }
    ], { duration: 380, easing: 'cubic-bezier(.4,0,.85,.4)' });

    return anim.finished.catch(function () {}).then(function () {
      sheet.style.height = '0px';
      var c = sheet.querySelector('canvas');
      if (c) c.remove();
      return sleep(90);
    });
  };

  Printer.prototype._retract = function () {
    var sheet = this.dom.sheet;
    sheet.style.height = '0px';
    var c = sheet.querySelector('canvas');
    if (c) c.remove();
    this.dom.head.classList.remove('is-on');
  };

  /* ── the job ──────────────────────────────────────────────────────────── */

  Printer.prototype.print = async function (job, opts) {
    if (this.busy) return;
    this.busy = true;
    this.cancelled = false;

    var total = job.pages.length * opts.copies;
    var printed = 0;
    this.dom.printer.classList.add('is-busy');
    this.dom.ledData.classList.add('is-on');
    if (this.onstate) this.onstate('printing');
    this.say('Printing ' + total + ' page' + (total === 1 ? '' : 's') + '…');
    this.sound.resume();

    for (var copy = 0; copy < opts.copies && !this.cancelled; copy++) {
      for (var i = 0; i < job.pages.length && !this.cancelled; i++) {

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

        var label = 'page ' + (i + 1) + '/' + job.pages.length +
                    (opts.copies > 1 ? ' · copy ' + (copy + 1) : '');

        this.lcd('PRINTING', label + ' · 0%');
        var made = this._compose(job, i, opts);

        this.sound.motor(true);
        var finished = await this._feed(made.canvas, job, opts, label);
        this.sound.motor(false);

        if (!finished) break;

        this.toner = Math.max(0, this.toner - Math.max(0.6, made.coverage * 22));
        this._paintToner();

        var out = made.canvas;
        await this._eject();

        printed++;
        if (this.onpage) this.onpage(out, { index: i, total: job.pages.length, copy: copy, n: printed });
        if (printed < total && !this.cancelled) await sleep(160);
      }
    }

    this.sound.motor(false);
    this._retract();
    this.dom.printer.classList.remove('is-busy');
    this.dom.ledData.classList.remove('is-on');
    this.busy = false;
    this.progress(0);

    if (this.cancelled) {
      this.lcd('JOB CANCELLED', printed + ' of ' + total + ' pages printed');
      this.say('Job cancelled after ' + printed + ' page' + (printed === 1 ? '' : 's') + '.');
    } else {
      this.lcd('READY', printed + ' page' + (printed === 1 ? '' : 's') + ' printed');
      this.say(printed + ' page' + (printed === 1 ? '' : 's') + ' in the output tray.');
    }
    if (this.onstate) this.onstate('idle');
    return printed;
  };

  global.WP = global.WP || {};
  global.WP.Printer = Printer;
})(window);
