import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { charsPerLine, CHARS_PER_LINE, EscPosBuilder } from './escpos.js';

const bytes = (buffer: Buffer) => [...buffer];

describe('EscPosBuilder', () => {
  it('initialise emits ESC @', () => {
    assert.deepEqual(bytes(new EscPosBuilder().initialise().build()), [0x1b, 0x40]);
  });

  it('align emits ESC a n with the right code per alignment', () => {
    assert.deepEqual(bytes(new EscPosBuilder().align('left').build()), [0x1b, 0x61, 0]);
    assert.deepEqual(bytes(new EscPosBuilder().align('centre').build()), [0x1b, 0x61, 1]);
    assert.deepEqual(bytes(new EscPosBuilder().align('right').build()), [0x1b, 0x61, 2]);
  });

  it('bold and underline emit their on/off pairs', () => {
    assert.deepEqual(bytes(new EscPosBuilder().bold(true).bold(false).build()), [
      0x1b, 0x45, 1, 0x1b, 0x45, 0,
    ]);
    assert.deepEqual(bytes(new EscPosBuilder().underline(true).build()), [0x1b, 0x2d, 1]);
  });

  it('packs size into nibbles as (multiplier - 1)', () => {
    // 2x wide, 3x tall -> high nibble 1, low nibble 2 -> 0x12
    assert.deepEqual(bytes(new EscPosBuilder().size(2, 3).build()), [0x1d, 0x21, 0x12]);
    assert.deepEqual(bytes(new EscPosBuilder().normalSize().build()), [0x1d, 0x21, 0x00]);
    assert.deepEqual(bytes(new EscPosBuilder().size(4, 4).build()), [0x1d, 0x21, 0x33]);
  });

  it('line appends a single LF', () => {
    assert.deepEqual(bytes(new EscPosBuilder().line('Hi').build()), [0x48, 0x69, 0x0a]);
  });

  it('encodes text as latin1, not utf8', () => {
    // é is one byte in latin1 (0xe9) and two in utf8 — the printer decodes each
    // byte through its code page, so utf8 would print mojibake.
    assert.deepEqual(bytes(new EscPosBuilder().text('é').build()), [0xe9]);
  });

  it('replaces characters no code page can render', () => {
    // Receipts are English, so this is the backstop for a stray paste — an
    // Indic character and the rupee sign both fall outside latin1.
    assert.deepEqual(bytes(new EscPosBuilder().text('ਪ₹').build()), [0x3f, 0x3f]);
  });

  it('feeds at least one line even when asked for zero', () => {
    assert.deepEqual(bytes(new EscPosBuilder().feed(0).build()), [0x0a]);
    assert.deepEqual(bytes(new EscPosBuilder().feed(3).build()), [0x0a, 0x0a, 0x0a]);
  });

  it('feeds the paper clear of the head before cutting', () => {
    // Without the leading feeds the blade lands mid-receipt.
    assert.deepEqual(bytes(new EscPosBuilder().cut(2).build()), [0x0a, 0x0a, 0x1d, 0x56, 66, 0]);
  });

  it('kicks the cash drawer on pin 2', () => {
    assert.deepEqual(bytes(new EscPosBuilder().openCashDrawer().build()), [
      0x1b, 0x70, 0x00, 0x19, 0xfa,
    ]);
  });

  it('chains in order', () => {
    const buffer = new EscPosBuilder().initialise().align('centre').text('A').build();
    assert.deepEqual(bytes(buffer), [0x1b, 0x40, 0x1b, 0x61, 1, 0x41]);
  });

  it('accepts a raw Buffer as well as an array', () => {
    assert.deepEqual(bytes(new EscPosBuilder().raw(Buffer.from([1, 2])).build()), [1, 2]);
  });
});

describe('charsPerLine', () => {
  it('knows the two roll widths', () => {
    assert.equal(CHARS_PER_LINE.MM_58, 32);
    assert.equal(charsPerLine('MM_58'), 32);
    assert.equal(charsPerLine('MM_80'), 48);
  });

  it('prefers an explicit override', () => {
    assert.equal(charsPerLine('MM_58', 42), 42);
  });

  it('ignores a nonsense override', () => {
    assert.equal(charsPerLine('MM_58', 0), 32);
    assert.equal(charsPerLine('MM_58', null), 32);
  });

  it('falls back to 48 for a width it does not know', () => {
    assert.equal(charsPerLine('A4'), 48);
  });
});
