/**
 * ESC/POS command builder.
 *
 * Thermal printers speak a byte protocol, not a document format. This is a
 * small, dependency-free encoder for the subset a receipt needs — the
 * alternatives all pull in native bindings that would need rebuilding per
 * platform, which is a poor trade for about eighty lines of byte pushing.
 *
 * Commands are from the Epson ESC/POS reference, which every 58mm/80mm printer
 * on the market implements.
 */

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export type Alignment = 'left' | 'centre' | 'right';

const ALIGNMENT_CODE: Record<Alignment, number> = { left: 0, centre: 1, right: 2 };

/**
 * Accumulates ESC/POS bytes.
 *
 * Chainable, because a receipt reads far better as a sequence of intentions
 * than as a series of Buffer.concat calls.
 */
export class EscPosBuilder {
  private readonly chunks: Buffer[] = [];

  /** `ESC @` — reset to a known state. Always the first thing sent. */
  initialise(): this {
    return this.raw([ESC, 0x40]);
  }

  /**
   * `ESC t n` — selects the character code page.
   *
   * Note this only affects the printer's built-in bitmap fonts, which cover
   * Latin and a handful of European sets. That is all this system needs:
   * printed documents are English by design (Punjabi is voice input only), so
   * the Indic scripts no code page carries never have to be printed.
   */
  codePage(page: number): this {
    return this.raw([ESC, 0x74, page & 0xff]);
  }

  /** `ESC a n` */
  align(alignment: Alignment): this {
    return this.raw([ESC, 0x61, ALIGNMENT_CODE[alignment]]);
  }

  /** `ESC E n` */
  bold(on: boolean): this {
    return this.raw([ESC, 0x45, on ? 1 : 0]);
  }

  /** `ESC - n` */
  underline(on: boolean): this {
    return this.raw([ESC, 0x2d, on ? 1 : 0]);
  }

  /**
   * `GS ! n` — character size. Width and height each 1–8x.
   *
   * The nibbles are packed: high nibble is width, low nibble is height, each
   * as (multiplier − 1).
   */
  size(width: 1 | 2 | 3 | 4, height: 1 | 2 | 3 | 4): this {
    return this.raw([GS, 0x21, ((width - 1) << 4) | (height - 1)]);
  }

  /** Back to single width and height. */
  normalSize(): this {
    return this.size(1, 1);
  }

  /**
   * Writes text and a line feed.
   *
   * Encoded latin1 rather than utf8: the printer interprets each byte through
   * its code page, so a multi-byte UTF-8 sequence would print as mojibake.
   * Receipts are English, so anything outside latin1 is a stray paste rather
   * than real content — replaced with `?` so it is visible, not mangled.
   */
  line(text = ''): this {
    return this.text(text).feed();
  }

  text(text: string): this {
    const safe = text.replace(/[^\x00-\xff]/g, '?');
    this.chunks.push(Buffer.from(safe, 'latin1'));
    return this;
  }

  feed(lines = 1): this {
    return this.raw(new Array<number>(Math.max(1, lines)).fill(LF));
  }

  /**
   * `GS V m n` — partial cut after feeding the paper clear of the head.
   *
   * Without the feed the cut lands mid-receipt, because the print head sits
   * some millimetres above the blade.
   */
  cut(feedBefore = 4): this {
    return this.feed(feedBefore).raw([GS, 0x56, 66, 0]);
  }

  /** `ESC p m t1 t2` — fires the cash drawer kick-out on pin 2. */
  openCashDrawer(): this {
    return this.raw([ESC, 0x70, 0x00, 0x19, 0xfa]);
  }

  raw(bytes: number[] | Buffer): this {
    this.chunks.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    return this;
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Printable characters per line, by paper width. */
export const CHARS_PER_LINE: Record<string, number> = {
  MM_58: 32,
  MM_80: 48,
};

export const charsPerLine = (paperWidth: string, override?: number | null): number =>
  override && override > 0 ? override : (CHARS_PER_LINE[paperWidth] ?? 48);
