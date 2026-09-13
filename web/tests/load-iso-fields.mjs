// Load web/iso.js under Node and hand back its real FIELDS table.
//
// iso.js is a browser IIFE that assigns window.ISO on the way out, so it can't be `import`ed.
// Rather than keep a second copy of the offsets in the test tree — which would make the fixture
// prove the copy rather than the code — this runs the real file against the smallest shim that
// satisfies its module scope, and reads the table back off the export.
//
// The shim is deliberately minimal: anything iso.js needs that isn't here should fail loudly,
// because a silent stub is how a test starts passing against a fiction.
import fs from "fs";
import path from "path";
import vm from "vm";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadIsoFields() {
  const S4Core = createRequire(import.meta.url)(path.join(WEB, "s4-core.js"));
  const store = new Map();
  const sandbox = {
    S4Core,
    console,
    ReadableStream, MessageChannel,          // capability probes at module scope
    navigator: { serviceWorker: undefined },  // → CAN_STREAM_SAVE false, which is fine here
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: undefined,
    $: () => null, $$: () => [], esc: (x) => String(x),
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(WEB, "iso.js"), "utf8"), sandbox, { filename: "iso.js" });
  const fields = sandbox.window.ISO && sandbox.window.ISO.FIELDS;
  if (!Array.isArray(fields) || !fields.length) throw new Error("iso.js did not expose FIELDS");
  return fields;
}
