/* ==========================================================================
   richtext.js — laying formatted blocks onto sheets of paper.

   Takes the block list office.js produces and does what a word processor
   does: measure runs, wrap them into lines, stack the lines into columns,
   break tables across rows, and hand back one painter per sheet.
   ========================================================================== */

(function (global) {
  'use strict';

  var BODY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif';

  /* Point sizes Word uses when a document doesn't say otherwise. */
  var SIZES = { p: 15.3, li: 15.3, h1: 30, h2: 21, h3: 17 };
  var GAP   = { p: 0.5,  li: 0.22, h1: 0.5, h2: 0.55, h3: 0.5 };   // space after, in ems
  var LEAD  = 1.34;                                                 // line height multiplier

  var scratch = document.createElement('canvas').getContext('2d');

  function fontOf(seg) {
    return (seg.italic ? 'italic ' : '') + (seg.bold ? '600 ' : '') +
           seg.size.toFixed(1) + 'px ' + BODY;
  }

  function measure(seg) {
    scratch.font = fontOf(seg);
    return scratch.measureText(seg.text).width;
  }

  /* ── one paragraph → lines ────────────────────────────────────────────── */

  /* Runs are split into words that remember their own styling, then packed
     greedily. A word too wide for the column is broken mid-word. */
  function wrapBlock(block, width, g) {
    var base = (SIZES[block.kind] || SIZES.p) * (g.fit ? 1 : g.scale);
    var heading = block.kind.charAt(0) === 'h';
    var tokens = [];

    (block.runs || []).forEach(function (run) {
      if (run.br) { tokens.push({ br: true }); return; }
      var size = run.size ? run.size * (g.fit ? 1 : g.scale) : base;
      var style = {
        bold: run.bold || heading,
        italic: run.italic,
        underline: run.underline,
        size: size
      };
      String(run.text).split(/(\t|\s+)/).forEach(function (piece) {
        if (!piece) return;
        if (piece === '\t') tokens.push(Object.assign({ text: '', tab: true }, style));
        else if (/^\s+$/.test(piece)) tokens.push(Object.assign({ text: ' ', space: true }, style));
        else tokens.push(Object.assign({ text: piece }, style));
      });
    });

    var lines = [];
    var line = { segments: [], width: 0, height: base * LEAD };
    var lineH = base * LEAD;

    function push() {
      while (line.segments.length && line.segments[line.segments.length - 1].space) {
        line.width -= line.segments.pop().w;
      }
      lines.push(line);
      line = { segments: [], width: 0, height: lineH };
    }

    var TAB = 48;

    tokens.forEach(function (token) {
      if (token.br) { push(); return; }

      /* A tab advances to the next stop, measured from where the line is. */
      if (token.tab) {
        var target = Math.floor(line.width / TAB) * TAB + TAB;
        var advance = Math.max(6, target - line.width);
        if (line.width + advance > width) { push(); return; }
        line.segments.push(Object.assign({}, token, { w: advance }));
        line.width += advance;
        return;
      }

      var w = measure(token);

      if (token.space && !line.segments.length) return;      // no leading spaces
      if (line.width + w > width && !token.space && line.segments.length) push();

      /* A single word wider than the column has to be split. */
      while (w > width && !token.space) {
        var cut = token.text.length;
        while (cut > 1) {
          var head = Object.assign({}, token, { text: token.text.slice(0, cut) });
          if (measure(head) <= width) break;
          cut--;
        }
        var head2 = Object.assign({}, token, { text: token.text.slice(0, cut) });
        var hw = measure(head2);
        line.segments.push(Object.assign(head2, { w: hw }));
        line.width += hw;
        push();
        token = Object.assign({}, token, { text: token.text.slice(cut) });
        w = measure(token);
        if (!token.text) return;
      }

      line.segments.push(Object.assign({}, token, { w: w }));
      line.width += w;
      line.height = Math.max(line.height, token.size * LEAD);
    });
    push();

    if (!lines.length) lines.push({ segments: [], width: 0, height: base * LEAD });
    return { lines: lines, base: base, after: base * (GAP[block.kind] || 0.5) };
  }

  /* ── blocks → a flat list of things that occupy vertical space ────────── */

  function flowBlocks(blocks, contentW, g, depth) {
    var items = [];

    blocks.forEach(function (block) {
      if (block.kind === 'table') {
        items.push(tableItem(block, contentW, g, depth || 0));
        items.push({ kind: 'gap', height: 10 });
        return;
      }

      var indent = block.indent || 0;
      var marker = block.marker;
      var laid = wrapBlock(block, Math.max(40, contentW - indent), g);

      laid.lines.forEach(function (line, i) {
        items.push({
          kind: 'line',
          line: line,
          indent: indent,
          align: block.align,
          height: line.height,
          marker: i === 0 ? marker : null,
          markerSize: laid.base,
          rule: block.kind === 'h1' && i === laid.lines.length - 1
        });
      });
      items.push({ kind: 'gap', height: laid.after });
    });

    return items;
  }

  /* A table becomes one item per row, so long tables split across sheets. */
  function tableItem(block, contentW, g, depth) {
    var cols = block.rows.reduce(function (n, r) { return Math.max(n, r.length); }, 1);
    var pad = 7;
    var widths = [];

    var declared = (block.widths || []).filter(function (w) { return w > 0; });
    var total = declared.reduce(function (a, b) { return a + b; }, 0);
    for (var c = 0; c < cols; c++) {
      widths.push(declared.length === cols && total > 0
        ? (declared[c] / total) * contentW
        : contentW / cols);
    }

    var rows = block.rows.map(function (row) {
      var cells = row.map(function (cell, c) {
        var inner = flowBlocks(cell.blocks, widths[c] - pad * 2, g, depth + 1);
        while (inner.length && inner[inner.length - 1].kind === 'gap') inner.pop();
        var h = inner.reduce(function (n, it) { return n + it.height; }, 0);
        return { items: inner, height: h };
      });
      var height = cells.reduce(function (n, cell) { return Math.max(n, cell.height); }, 0) + pad * 2;
      return { cells: cells, height: height };
    });

    return { kind: 'table', rows: rows, widths: widths, pad: pad, height: 0, table: true };
  }

  /* ── painting ─────────────────────────────────────────────────────────── */

  function paintLine(ctx, item, x0, contentW, y) {
    var line = item.line;
    var x = x0 + item.indent;
    var room = contentW - item.indent;

    if (item.align === 'center') x += (room - line.width) / 2;
    else if (item.align === 'right') x += room - line.width;

    if (item.marker) {
      scratch.font = item.markerSize.toFixed(1) + 'px ' + BODY;
      ctx.font = scratch.font;
      ctx.fillStyle = '#1b1b1b';
      ctx.fillText(item.marker, x - Math.min(item.indent, 22), y + line.height * 0.78);
    }

    line.segments.forEach(function (seg) {
      ctx.font = fontOf(seg);
      ctx.fillStyle = '#1b1b1b';
      var baseline = y + line.height * 0.78;
      ctx.fillText(seg.text, x, baseline);
      if (seg.underline) {
        ctx.fillRect(x, baseline + 2.5, seg.w, Math.max(1, seg.size / 15));
      }
      x += seg.w;
    });

    if (item.rule) {
      ctx.fillStyle = '#c9c6bd';
      ctx.fillRect(x0, y + line.height + 3, contentW, 1);
    }
  }

  function paintRow(ctx, row, widths, pad, x0, y) {
    var x = x0;
    row.cells.forEach(function (cell, c) {
      var top = y + pad;
      cell.items.forEach(function (item) {
        if (item.kind === 'line') paintLine(ctx, item, x + pad, widths[c] - pad * 2, top);
        else if (item.table) top += 0;
        top += item.height;
      });
      ctx.strokeStyle = '#b9b6ad';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, widths[c], row.height);
      x += widths[c];
    });
  }

  /* ── pagination ───────────────────────────────────────────────────────── */

  function paginate(blocks, g) {
    var x0 = g.margin;
    var contentW = g.w - g.margin * 2;
    var top = g.margin;
    var bottom = g.h - g.margin;
    var items = flowBlocks(blocks, contentW, g, 0);

    var pages = [];
    var current = [];
    var y = top;

    function flush() {
      if (current.length) pages.push(current);
      current = [];
      y = top;
    }

    items.forEach(function (item) {
      if (item.kind === 'table') {
        item.rows.forEach(function (row) {
          if (y + row.height > bottom && current.length) flush();
          current.push({ paint: paintRow.bind(null, null), row: row, table: item, y: y });
          y += row.height;
        });
        return;
      }
      if (item.kind === 'gap') {
        if (current.length) y += item.height;
        return;
      }
      if (y + item.height > bottom && current.length) flush();
      current.push({ item: item, y: y });
      y += item.height;
    });
    flush();

    if (!pages.length) pages.push([]);

    return pages.map(function (page) {
      return function (ctx) {
        page.forEach(function (entry) {
          if (entry.row) paintRow(ctx, entry.row, entry.table.widths, entry.table.pad, x0, entry.y);
          else paintLine(ctx, entry.item, x0, contentW, entry.y);
        });
      };
    });
  }

  global.WP = global.WP || {};
  global.WP.richtext = { paginate: paginate };
})(window);
