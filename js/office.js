/* ==========================================================================
   office.js — reading Word files without a library.

   .docx is a ZIP of XML, so this contains a small ZIP reader (central
   directory + raw inflate) and a WordprocessingML walker that keeps
   headings, bold/italic/underline, alignment, indents, lists and tables.

   .doc is the older OLE compound file. This walks the FAT, finds the
   WordDocument and table streams, reads the piece table out of the FIB's
   CLX and reassembles the text. Character formatting in that format lives
   in binary style tables that are not worth the weight, so .doc comes
   through as text with its paragraph structure intact.

   Both produce the same block list, which richtext.js lays out.
   ========================================================================== */

(function (global) {
  'use strict';

  var W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  var FFLATE = 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js';
  var TWIPS = 100 / 1440;              // twentieths of a point → page pixels
  var HALFPT = 100 / 144;              // half-points → page pixels

  /* ── raw inflate, natively where possible ─────────────────────────────── */

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(s);
    });
  }

  async function inflateRaw(bytes) {
    if (global.DecompressionStream) {
      var stream = new Blob([bytes]).stream().pipeThrough(new global.DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    if (!global.fflate) await loadScript(FFLATE);
    return global.fflate.inflateSync(bytes);
  }

  /* ── ZIP ──────────────────────────────────────────────────────────────── */

  /* Reads only the members asked for; a .docx carries a lot we never touch. */
  async function unzip(buf, wanted) {
    var view = new DataView(buf);
    var bytes = new Uint8Array(buf);
    var end = -1;

    for (var i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error('Not a zip archive.');

    var count = view.getUint16(end + 10, true);
    var at = view.getUint32(end + 16, true);
    var out = {};

    for (var n = 0; n < count; n++) {
      if (view.getUint32(at, true) !== 0x02014b50) break;
      var method = view.getUint16(at + 10, true);
      var compressed = view.getUint32(at + 20, true);
      var nameLen = view.getUint16(at + 28, true);
      var extraLen = view.getUint16(at + 30, true);
      var commentLen = view.getUint16(at + 32, true);
      var local = view.getUint32(at + 42, true);
      var name = new TextDecoder('utf-8').decode(bytes.subarray(at + 46, at + 46 + nameLen));

      if (wanted.indexOf(name) > -1) {
        var lnLen = view.getUint16(local + 26, true);
        var leLen = view.getUint16(local + 28, true);
        var start = local + 30 + lnLen + leLen;
        var raw = bytes.subarray(start, start + compressed);
        out[name] = method === 0 ? raw : await inflateRaw(raw);
      }
      at += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  /* ── WordprocessingML ─────────────────────────────────────────────────── */

  function kids(node, name) {
    var out = [];
    if (!node) return out;                 // a paragraph need not carry any pPr
    for (var c = node.firstElementChild; c; c = c.nextElementSibling) {
      if (c.localName === name && c.namespaceURI === W) out.push(c);
    }
    return out;
  }

  function kid(node, name) { return kids(node, name)[0] || null; }

  function attr(node, name) {
    if (!node) return null;
    return node.getAttributeNS(W, name) || node.getAttribute('w:' + name) || node.getAttribute(name);
  }

  /* <w:b/> means on; <w:b w:val="0"/> means off. */
  function flag(parent, name) {
    var el = kid(parent, name);
    if (!el) return false;
    var v = attr(el, 'val');
    return v !== '0' && v !== 'false' && v !== 'none';
  }

  function headingLevel(pPr) {
    if (!pPr) return 0;
    var style = attr(kid(pPr, 'pStyle'), 'val') || '';
    if (/^title$/i.test(style)) return 1;
    if (/^subtitle$/i.test(style)) return 3;
    var m = style.match(/^heading\s*(\d)/i);
    if (m) return Math.min(3, parseInt(m[1], 10) + (/^heading/i.test(style) ? 0 : 0));
    var outline = attr(kid(pPr, 'outlineLvl'), 'val');
    if (outline != null) return Math.min(3, parseInt(outline, 10) + 1);
    return 0;
  }

  /* numbering.xml: numId → the format of each level, so bullets stay bullets
     and numbered lists actually count. */
  function readNumbering(doc) {
    var map = {};
    if (!doc) return map;
    var abstracts = {};
    var all = doc.getElementsByTagNameNS(W, 'abstractNum');
    for (var a = 0; a < all.length; a++) {
      var id = attr(all[a], 'abstractNumId');
      var levels = {};
      var lvls = all[a].getElementsByTagNameNS(W, 'lvl');
      for (var l = 0; l < lvls.length; l++) {
        levels[attr(lvls[l], 'ilvl')] = {
          fmt: attr(kid(lvls[l], 'numFmt'), 'val') || 'bullet',
          text: attr(kid(lvls[l], 'lvlText'), 'val') || ''
        };
      }
      abstracts[id] = levels;
    }
    var nums = doc.getElementsByTagNameNS(W, 'num');
    for (var n = 0; n < nums.length; n++) {
      var ref = attr(kid(nums[n], 'abstractNumId'), 'val');
      map[attr(nums[n], 'numId')] = abstracts[ref] || {};
    }
    return map;
  }

  function runsOf(container, inherited) {
    var out = [];
    for (var c = container.firstElementChild; c; c = c.nextElementSibling) {
      if (c.namespaceURI !== W) continue;

      if (c.localName === 'hyperlink' || c.localName === 'smartTag' || c.localName === 'sdtContent') {
        out = out.concat(runsOf(c, inherited));
        continue;
      }
      /* Word puts breaks inside runs, but they turn up loose often enough. */
      if (c.localName === 'br') {
        out.push({ br: attr(c, 'type') === 'page' ? 'page' : 'line' });
        continue;
      }
      if (c.localName !== 'r') continue;

      var rPr = kid(c, 'rPr');
      var style = {
        bold: rPr ? flag(rPr, 'b') : false,
        italic: rPr ? flag(rPr, 'i') : false,
        underline: rPr ? !!kid(rPr, 'u') && attr(kid(rPr, 'u'), 'val') !== 'none' : false,
        size: rPr && attr(kid(rPr, 'sz'), 'val') ? parseInt(attr(kid(rPr, 'sz'), 'val'), 10) * HALFPT : null
      };

      for (var t = c.firstElementChild; t; t = t.nextElementSibling) {
        if (t.namespaceURI !== W) continue;
        if (t.localName === 't') {
          out.push(Object.assign({ text: t.textContent || '' }, style));
        } else if (t.localName === 'tab') {
          out.push(Object.assign({ text: '\t' }, style));
        } else if (t.localName === 'br') {
          out.push({ br: attr(t, 'type') === 'page' ? 'page' : 'line' });
        } else if (t.localName === 'noBreakHyphen') {
          out.push(Object.assign({ text: '-' }, style));
        }
      }
    }
    return out;
  }

  function paragraph(p, numbering, counters) {
    var pPr = kid(p, 'pPr');
    var block = {
      kind: 'p',
      align: attr(kid(pPr, 'jc'), 'val') || 'left',
      indent: 0,
      runs: runsOf(p)
    };

    var level = headingLevel(pPr);
    if (level) block.kind = 'h' + level;

    var ind = kid(pPr, 'ind');
    if (ind) {
      var left = parseInt(attr(ind, 'left') || attr(ind, 'start') || '0', 10);
      if (left) block.indent = left * TWIPS;
    }

    var numPr = kid(pPr, 'numPr');
    if (numPr) {
      var numId = attr(kid(numPr, 'numId'), 'val');
      var ilvl = attr(kid(numPr, 'ilvl'), 'val') || '0';
      var def = (numbering[numId] || {})[ilvl] || { fmt: 'bullet' };
      block.kind = 'li';
      block.level = parseInt(ilvl, 10) || 0;
      block.indent = block.indent || (block.level + 1) * 26;

      if (def.fmt === 'bullet' || !def.fmt) {
        block.marker = block.level % 2 ? '◦' : '•';
      } else {
        var key = numId + ':' + ilvl;
        counters[key] = (counters[key] || 0) + 1;
        block.marker = ordinal(counters[key], def.fmt) + '.';
      }
    }
    return block;
  }

  function ordinal(n, fmt) {
    if (fmt === 'lowerLetter') return String.fromCharCode(96 + ((n - 1) % 26) + 1);
    if (fmt === 'upperLetter') return String.fromCharCode(64 + ((n - 1) % 26) + 1);
    if (fmt === 'lowerRoman' || fmt === 'upperRoman') {
      var map = [[10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
      var out = '', left = n;
      map.forEach(function (pair) { while (left >= pair[0]) { out += pair[1]; left -= pair[0]; } });
      return fmt === 'upperRoman' ? out.toUpperCase() : out;
    }
    return String(n);
  }

  function table(tbl, numbering, counters) {
    var widths = [];
    var grid = kid(tbl, 'tblGrid');
    if (grid) {
      kids(grid, 'gridCol').forEach(function (col) {
        widths.push(parseInt(attr(col, 'w') || '0', 10) * TWIPS);
      });
    }

    var rows = kids(tbl, 'tr').map(function (tr) {
      return kids(tr, 'tc').map(function (tc) {
        return { blocks: bodyBlocks(tc, numbering, counters) };
      });
    });

    return { kind: 'table', rows: rows, widths: widths };
  }

  function bodyBlocks(node, numbering, counters) {
    var out = [];
    for (var c = node.firstElementChild; c; c = c.nextElementSibling) {
      if (c.namespaceURI !== W) continue;
      if (c.localName === 'p') out.push(paragraph(c, numbering, counters));
      else if (c.localName === 'tbl') out.push(table(c, numbering, counters));
      else if (c.localName === 'sdt') {
        var content = kid(c, 'sdtContent');
        if (content) out = out.concat(bodyBlocks(content, numbering, counters));
      }
    }
    return out;
  }

  async function readDocx(buf) {
    var parts = await unzip(buf, ['word/document.xml', 'word/numbering.xml']);
    if (!parts['word/document.xml']) throw new Error('No Word document inside that archive.');

    var parser = new DOMParser();
    var text = new TextDecoder('utf-8').decode(parts['word/document.xml']);
    var doc = parser.parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('That document.xml is malformed.');

    var numbering = parts['word/numbering.xml']
      ? readNumbering(parser.parseFromString(new TextDecoder('utf-8').decode(parts['word/numbering.xml']), 'application/xml'))
      : {};

    var body = doc.getElementsByTagNameNS(W, 'body')[0];
    if (!body) throw new Error('That document has no body.');

    return { blocks: bodyBlocks(body, numbering, {}), kind: 'Word document' };
  }

  /* ── the OLE compound file behind .doc ────────────────────────────────── */

  function readOLE(buf) {
    var view = new DataView(buf);
    var bytes = new Uint8Array(buf);
    if (view.getUint32(0, true) !== 0xe011cfd0 || view.getUint32(4, true) !== 0xe11ab1a1) {
      throw new Error('Not an OLE compound file.');
    }

    var SEC = 1 << view.getUint16(0x1e, true);
    var MINI = 1 << view.getUint16(0x20, true);
    var fatCount = view.getUint32(0x2c, true);
    var dirStart = view.getUint32(0x30, true);
    var cutoff = view.getUint32(0x38, true) || 4096;
    var miniStart = view.getUint32(0x3c, true);
    var difatStart = view.getUint32(0x44, true);
    var difatCount = view.getUint32(0x48, true);

    var off = function (sector) { return 512 + sector * SEC; };

    /* DIFAT: 109 entries in the header, the rest chained through sectors. */
    var difat = [];
    for (var i = 0; i < 109 && difat.length < fatCount; i++) difat.push(view.getUint32(0x4c + i * 4, true));
    var next = difatStart;
    for (var d = 0; d < difatCount && next < 0xfffffffa; d++) {
      var base = off(next);
      for (var k = 0; k < SEC / 4 - 1 && difat.length < fatCount; k++) {
        difat.push(view.getUint32(base + k * 4, true));
      }
      next = view.getUint32(base + SEC - 4, true);
    }

    var fat = [];
    difat.forEach(function (sector) {
      if (sector >= 0xfffffffa) return;
      var at = off(sector);
      for (var j = 0; j < SEC / 4; j++) fat.push(view.getUint32(at + j * 4, true));
    });

    function chain(start, table) {
      var out = [], s = start, guard = 0;
      while (s < 0xfffffffa && guard++ < 100000) {
        out.push(s);
        s = table[s];
        if (s == null) break;
      }
      return out;
    }

    function readSectors(start, size) {
      var parts = chain(start, fat);
      var out = new Uint8Array(parts.length * SEC);
      parts.forEach(function (s, n) { out.set(bytes.subarray(off(s), off(s) + SEC), n * SEC); });
      return out.subarray(0, size);
    }

    /* Directory entries: 128 bytes each. */
    var entries = [];
    chain(dirStart, fat).forEach(function (sector) {
      var at = off(sector);
      for (var e = 0; e + 128 <= SEC; e += 128) {
        var p = at + e;
        var nameLen = view.getUint16(p + 0x40, true);
        if (nameLen < 2) continue;
        var name = '';
        for (var c = 0; c < nameLen - 2; c += 2) name += String.fromCharCode(view.getUint16(p + c, true));
        entries.push({
          name: name,
          type: bytes[p + 0x42],
          start: view.getUint32(p + 0x74, true),
          size: view.getUint32(p + 0x78, true)
        });
      }
    });

    var root = entries.filter(function (e) { return e.type === 5; })[0];
    var miniFat = [];
    if (miniStart < 0xfffffffa) {
      chain(miniStart, fat).forEach(function (sector) {
        var at = off(sector);
        for (var j = 0; j < SEC / 4; j++) miniFat.push(view.getUint32(at + j * 4, true));
      });
    }
    var miniStream = root ? readSectors(root.start, root.size) : new Uint8Array(0);

    function stream(name) {
      var e = entries.filter(function (x) { return x.name === name && x.type === 2; })[0];
      if (!e) return null;
      if (e.size >= cutoff) return readSectors(e.start, e.size);
      var parts = chain(e.start, miniFat);
      var out = new Uint8Array(parts.length * MINI);
      parts.forEach(function (s, n) { out.set(miniStream.subarray(s * MINI, s * MINI + MINI), n * MINI); });
      return out.subarray(0, e.size);
    }

    return { stream: stream, names: entries.map(function (e) { return e.name; }) };
  }

  var CP1252 = {
    128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡', 136: 'ˆ',
    137: '‰', 138: 'Š', 139: '‹', 140: 'Œ', 142: 'Ž', 145: '‘', 146: '’', 147: '“',
    148: '”', 149: '•', 150: '–', 151: '—', 152: '˜', 153: '™', 154: 'š', 155: '›',
    156: 'œ', 158: 'ž', 159: 'Ÿ'
  };

  function decode1252(slice) {
    var out = '';
    for (var i = 0; i < slice.length; i++) {
      var b = slice[i];
      out += b >= 128 && b < 160 ? (CP1252[b] || '') : String.fromCharCode(b);
    }
    return out;
  }

  function readDoc(buf) {
    var ole = readOLE(buf);
    var wd = ole.stream('WordDocument');
    if (!wd) throw new Error('No Word document in that file.');

    var fib = new DataView(wd.buffer, wd.byteOffset, wd.byteLength);
    if (fib.getUint16(0, true) !== 0xa5ec) throw new Error('That is not a Word 97-2003 document.');

    var flags = fib.getUint16(0x0a, true);
    var tableName = (flags & 0x0200) ? '1Table' : '0Table';
    var tbl = ole.stream(tableName) || ole.stream(tableName === '1Table' ? '0Table' : '1Table');
    if (!tbl) throw new Error('That document is missing its table stream.');

    var fcClx = fib.getUint32(0x01a2, true);
    var lcbClx = fib.getUint32(0x01a6, true);
    var clx = tbl.subarray(fcClx, fcClx + lcbClx);
    var clxView = new DataView(clx.buffer, clx.byteOffset, clx.byteLength);

    /* Step past any property runs to the piece table. */
    var at = 0, pieces = null;
    while (at < clx.length) {
      if (clx[at] === 1) {
        at += 3 + clxView.getUint16(at + 1, true);
      } else if (clx[at] === 2) {
        var lcb = clxView.getUint32(at + 1, true);
        pieces = { start: at + 5, length: lcb };
        break;
      } else break;
    }
    if (!pieces) throw new Error('That document has no piece table.');

    var count = Math.floor((pieces.length - 4) / 12);
    var cps = [];
    for (var c = 0; c <= count; c++) cps.push(clxView.getUint32(pieces.start + c * 4, true));

    var text = '';
    for (var p = 0; p < count; p++) {
      var fc = clxView.getUint32(pieces.start + (count + 1) * 4 + p * 8 + 2, true);
      var compressed = !!(fc & 0x40000000);
      var pos = compressed ? (fc & 0x3fffffff) >> 1 : (fc & 0x3fffffff);
      var chars = cps[p + 1] - cps[p];
      if (compressed) {
        text += decode1252(wd.subarray(pos, pos + chars));
      } else {
        var slice = wd.subarray(pos, pos + chars * 2);
        var dv = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
        for (var u = 0; u + 1 < slice.length; u += 2) text += String.fromCharCode(dv.getUint16(u, true));
      }
    }

    return { blocks: docText(text), kind: 'Word 97–2003' };
  }

  /* Word's control characters, turned back into paragraphs. */
  function docText(raw) {
    var out = [];
    var buffer = '';
    var skipField = false;

    function flush() {
      var line = buffer.replace(/\s+$/, '');
      out.push({ kind: 'p', align: 'left', indent: 0, runs: line ? [{ text: line }] : [] });
      buffer = '';
    }

    for (var i = 0; i < raw.length; i++) {
      var ch = raw.charCodeAt(i);
      if (ch === 0x13) { skipField = true; continue; }     // field instructions
      if (ch === 0x14) { skipField = false; continue; }
      if (ch === 0x15) { skipField = false; continue; }
      if (skipField) continue;

      if (ch === 0x0d || ch === 0x07 || ch === 0x0c) { flush(); continue; }
      if (ch === 0x0b) { flush(); continue; }              // line break
      if (ch === 0x09) { buffer += '    '; continue; }
      if (ch < 0x20 || ch === 0xfffe || ch === 0xffff) continue;
      buffer += raw[i];
    }
    if (buffer.trim()) flush();

    /* Trim the run of empty paragraphs Word leaves at the end. */
    while (out.length && !out[out.length - 1].runs.length) out.pop();
    return out;
  }

  /* ── entry point ──────────────────────────────────────────────────────── */

  function looksLike(buf) {
    var b = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
    if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7)) return 'zip';
    if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'ole';
    return '';
  }

  async function read(buf) {
    var shape = looksLike(buf);
    if (shape === 'zip') return await readDocx(buf);
    if (shape === 'ole') return readDoc(buf);
    throw new Error('That is not a Word document.');
  }

  global.WP = global.WP || {};
  global.WP.office = { read: read, looksLike: looksLike, unzip: unzip };
})(window);
