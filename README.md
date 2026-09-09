# web-printer

A printer that lives in your browser. Drop in a file and watch a virtual
machine physically print it — the sheet slides out of the slot, the carriage
sweeps across each freshly printed line, the toner runs low, and the finished
pages stack up in the output tray.

**Live:** https://coffeemilktea.github.io/web-printer/

Everything is client-side. Your file is read with `FileReader`, laid out on a
`<canvas>`, and never uploaded anywhere.

## What it prints

| Input | Result |
|---|---|
| Text, code, Markdown, CSV, JSON, logs | Paginated monospace with a running header and page numbers |
| PNG, JPEG, GIF, WebP, SVG, BMP | Scaled to fit the sheet, centred, captioned with its pixel size |
| PDF | Rasterised page by page (via pdf.js, loaded on demand) |
| Anything else | Hex dump — 16 bytes per line with the ASCII gutter |

Paste works too: <kbd>⌘V</kbd> anywhere on the page prints the clipboard.

## Settings

- **Paper** — Letter, A4, Legal, A5, portrait or landscape. Everything is laid
  out at 100 px/inch, so a Letter sheet is a real 850 × 1100 canvas.
- **Colour** — full colour, greyscale (Rec. 709 luma), or 1-bit ordered dither
  through an 8 × 8 Bayer matrix.
- **Quality** — draft, normal, or high; sets the feed rate and how fast the
  carriage sweeps.
- **Copies** — 1 to 5.
- **Sounds** — a looping brown-noise buffer through a bandpass filter whose
  centre frequency tracks the print head, plus roller clunks between sheets.

The toner cartridge drains in proportion to how much ink each page actually
uses. Below 18% pages wash out, below 9% they streak, and at zero the job
pauses until you fit a new cartridge.

Click any sheet in the output tray to read it full size or save it as a PNG.

## Running it locally

No build step, no dependencies, no package manager:

```bash
git clone https://github.com/coffeemilktea/web-printer.git
cd web-printer
python3 -m http.server 8000
```

Then open <http://localhost:8000>. Opening `index.html` straight off disk
works too, though some browsers restrict `file://` pages.

## How it fits together

```
index.html      markup for the panel, the printer, and the output tray
styles.css      the whole machine — the printer is CSS boxes and gradients
js/render.js    file → pages. A page is a function (ctx) => void that paints
                one sheet; pagination, hex dumps, images, PDF, colour modes
js/printer.js   the machine: LCD, LEDs, the sheet growing out of the slot,
                the print head, the toner cartridge, the motor noise
js/app.js       wiring: file pickers, settings, the output tray, the viewer
```

The trick that makes the animation simple: each page is drawn once, in full,
to an off-screen canvas. The sheet element is `overflow: hidden` with its
height driven by a `requestAnimationFrame` loop, so "printing" is just the
sheet growing downward out of the slot while the head tracks its bottom edge.

## Licence

MIT
