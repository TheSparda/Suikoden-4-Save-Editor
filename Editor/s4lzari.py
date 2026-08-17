#!/usr/bin/env python3
"""
LZARI decoder (Haruhiko Okumura's algorithm), ported to Python 3 from mymc's lzari.py
(Ross Ridge, public domain). Decode-only — enough to read MAX Drive (.max) saves.
"""

HIST_LEN = 4096
MIN_MATCH_LEN = 3
MAX_MATCH_LEN = 60
ARITH_BITS = 15
QUADRANT1 = 1 << ARITH_BITS
QUADRANT2 = QUADRANT1 * 2
QUADRANT3 = QUADRANT1 * 3
QUADRANT4 = QUADRANT1 * 4
MAX_CUM = QUADRANT1 - 1
MAX_CHAR = 256 + MAX_MATCH_LEN - MIN_MATCH_LEN + 1


class _Decoder:
    def __init__(self, src):
        def bits():
            for byte in src:
                for k in range(7, -1, -1):
                    yield (byte >> k) & 1
            while True:                     # the reference impl pads with zeros
                yield 0
        self._bits = bits()
        self.in_iter = lambda: next(self._bits)
        self.high = QUADRANT4
        self.low = 0
        self.sym_cum = list(range(0, MAX_CHAR + 1))
        self.symbol_to_char = [0] + list(range(MAX_CHAR))
        self.sym_freq = [0] + [1] * MAX_CHAR
        self.position_cum = [0] * (HIST_LEN + 1)
        a = 0
        for i in range(HIST_LEN, 0, -1):
            a += 10000 // (200 + i)
            self.position_cum[i - 1] = a
        self.code = 0
        for _ in range(ARITH_BITS + 2):
            self.code += self.code + self.in_iter()

    def _search(self, table, x):
        c, s = 1, len(table) - 1
        while True:
            a = (s + c) // 2
            if table[a] <= x:
                s = a
            else:
                c = a + 1
            if c >= s:
                break
        return c

    def _update_model(self, symbol):
        sym_freq, sym_cum = self.sym_freq, self.sym_cum
        if sym_cum[MAX_CHAR] >= MAX_CUM:
            c = 0
            for i in range(MAX_CHAR, 0, -1):
                sym_cum[MAX_CHAR - i] = c
                a = (sym_freq[i] + 1) // 2
                sym_freq[i] = a
                c += a
            sym_cum[MAX_CHAR] = c
        freq = sym_freq[symbol]
        new_symbol = symbol
        while sym_freq[new_symbol - 1] == freq:
            new_symbol -= 1
        if new_symbol != symbol:
            s2c = self.symbol_to_char
            s2c[new_symbol], s2c[symbol] = s2c[symbol], s2c[new_symbol]
        sym_freq[new_symbol] = freq + 1
        for i in range(MAX_CHAR - new_symbol + 1, MAX_CHAR + 1):
            sym_cum[i] += 1

    def decode_char(self):
        from bisect import bisect_right
        high, low, code = self.high, self.low, self.code
        sym_cum = self.sym_cum
        _range = high - low
        max_cum_freq = sym_cum[MAX_CHAR]
        n = ((code - low + 1) * max_cum_freq - 1) // _range
        i = bisect_right(sym_cum, n, 1)
        high = low + sym_cum[i] * _range // max_cum_freq
        low += sym_cum[i - 1] * _range // max_cum_freq
        symbol = MAX_CHAR + 1 - i
        while True:
            if low < QUADRANT2:
                if low < QUADRANT1 or high > QUADRANT3:
                    if high > QUADRANT2:
                        break
                else:
                    low -= QUADRANT1
                    code -= QUADRANT1
                    high -= QUADRANT1
            else:
                low -= QUADRANT2
                code -= QUADRANT2
                high -= QUADRANT2
            low *= 2
            high *= 2
            code = code * 2 + self.in_iter()
        ret = self.symbol_to_char[symbol]
        self.high, self.low, self.code = high, low, code
        self._update_model(symbol)
        return ret

    def decode_position(self):
        _range = self.high - self.low
        max_cum = self.position_cum[0]
        pos = self._search(self.position_cum,
                           ((self.code - self.low + 1) * max_cum - 1) // _range) - 1
        self.high = self.low + self.position_cum[pos] * _range // max_cum
        self.low += self.position_cum[pos + 1] * _range // max_cum
        while True:
            if self.low < QUADRANT2:
                if self.low < QUADRANT1 or self.high > QUADRANT3:
                    if self.high > QUADRANT2:
                        return pos
                else:
                    self.low -= QUADRANT1
                    self.code -= QUADRANT1
                    self.high -= QUADRANT1
            else:
                self.low -= QUADRANT2
                self.code -= QUADRANT2
                self.high -= QUADRANT2
            self.low *= 2
            self.high *= 2
            self.code = self.in_iter() + self.code * 2


def decode(src, out_length):
    """Decompress LZARI `src` (bytes) to exactly `out_length` bytes."""
    d = _Decoder(src)
    out = bytearray(out_length)
    outpos = 0
    hist_pos = HIST_LEN - MAX_MATCH_LEN
    history = [0x20] * hist_pos + [0] * MAX_MATCH_LEN
    while outpos < out_length:
        char = d.decode_char()
        if char >= 0x100:
            pos = d.decode_position()
            length = char - 0x100 + MIN_MATCH_LEN
            base = (hist_pos - pos - 1) % HIST_LEN
            for off in range(length):
                a = history[(base + off) % HIST_LEN]
                out[outpos] = a
                outpos += 1
                history[hist_pos] = a
                hist_pos = (hist_pos + 1) % HIST_LEN
        else:
            out[outpos] = char
            outpos += 1
            history[hist_pos] = char
            hist_pos = (hist_pos + 1) % HIST_LEN
    return bytes(out)
