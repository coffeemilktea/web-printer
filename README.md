# web-printer

A printer that lives in your browser. Drop in a file and watch a virtual
machine actually print it: the paper steps forward one band at a time, the
carriage sweeps across laying ink into each band, the toner runs low, and the
finished sheets pile up in the output tray.

**Live:** https://coffeemilktea.github.io/web-printer/

Everything is client-side. Your file is read with `FileReader`, laid out on a
`<canvas>`, and never uploaded anywhere.

## What it prints

| Input | Result |
|---|---|
| Text, code, Markdown, CSV, JSON, logs | Paginated monospace with a running header and page numbers |
| PNG, JPEG, GIF, WebP, SVG, BMP | Fitted to the sheet or printed at any scale, captioned with its pixel size |
| PDF | Rasterised page by page (via pdf.js, loaded on demand) |
| Anything else | Hex dump — 16 bytes per line with the ASCII gutter |

Paste works too: <kbd>⌘V</kbd> anywhere on the page prints the clipboard.

## Print options

Everything a real print dialog offers, and each setting genuinely changes the
paper that comes out:

- **Paper size** — Letter, A4, Legal, A5, portrait or landscape. Laid out at
  100 px/inch, so a Letter sheet really is an 850 × 1100 canvas.
- **Scale** — fit to page, or 50–200% of actual size. Text is set larger or
  smaller and repaginates; images and PDF pages scale and clip at the margins.
- **Margins** — normal, narrow, wide or none, which changes how much fits on
  a sheet.
- **Pages per sheet** — 1, 2 or 4 up, tiled with each page keeping its own
  header and footer.
- **Page range** — `All`, or a list like `1-3, 7`.
- **Colour** — colour, black & white, or black & white through an 8 × 8 Bayer
  dither.
- **Quality** — draft, normal or high. Higher quality lays down thinner bands
  and takes longer, the same trade a real printer makes.
- **Copies**, with **collate** and **reverse order**.
- **Sounds** — a looping brown-noise buffer through a bandpass filter whose
  centre frequency tracks the print head, plus roller ticks between passes.

The toner cartridge drains in proportion to how much ink each sheet actually
uses. Below 18% sheets wash out, below 9% they streak, and at zero the job
pauses until you fit a new cartridge.

## Getting paper back off the screen

Sheets land in the tray as PNG blobs, so a page costs a few tens of kilobytes
rather than a 3.7 MB canvas.

- Click the top sheet to read any of them full size and step through the stack.
- Save a single sheet as **PNG, JPEG or WebP** (unsupported formats are hidden
  rather than silently falling back).
- Save the whole tray as a **PDF** — written by hand, one image XObject per
  sheet, deflated losslessly with `CompressionStream` where the browser has it
  and JPEG-compressed where it doesn't.

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
index.html      markup for the print dialog, the printer, and the tray
styles.css      the whole machine — printer and tray are CSS boxes and gradients
js/render.js    file → sheets. A page is a function (ctx) => void that paints
                one sheet; pagination, scale, margins, n-up, ranges, hex
                dumps, images, PDF, colour modes
js/printer.js   the machine: LCD, LEDs, the band-by-band print run, the tray
                stack, the toner cartridge, the motor noise
js/save.js      PNG/JPEG/WebP re-encoding and the PDF writer
js/app.js       wiring: file pickers, settings, the tray, the page viewer
```

The animation is the part worth reading. Each sheet is painted once, in full,
to an off-screen canvas you never see. The visible sheet starts blank; on every
frame the paper either steps forward by one band, or the carriage sweeps and
ink is copied from the finished page into the blank one **only across the strip
the head has already crossed**. Catch a frame mid-pass and the band is dark on
one side and still white on the other.

## Licence

MIT
