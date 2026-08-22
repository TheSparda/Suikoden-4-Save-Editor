# Web editor tests

Ships **no game data** — fixtures are built from the engine's own constants, so they can't
drift from the code under test. Run everything with:

```bash
cd web/tests
npm test
```

Two layers:

- **`validate.mjs`** — fast, no browser. Checks that `app.js`/`sw.js` parse, the reference
  JSON tables have their expected sizes, the `s4save.py` layout constants are self-consistent
  (body/record/potch/world-map offsets all fit inside the 57952-byte payload), and the app
  shell + PWA are wired (script tag, both mode tabs, manifest `share_target`, service-worker
  share handler + precache). Also asserts `app.js` drives the real engine functions.

- **`save_roundtrip.py`** (wrapped by `save-roundtrip.mjs` for `npm test`) — imports the
  **real** `s4save` module and builds a synthetic 57952-byte S4 payload, then drives
  `read_all_s4_saves` → `write_save_edits` → re-read, asserting every field persists, the
  gamedata checksum (CRC32 + reversed MD5) stays valid, the world-map "fully explored" write
  works, the memory-card ECC helper is correct, and unrecognized files are rejected. The
  `.mjs` wrapper **skips cleanly (exit 0)** if `python3` is absent.
