#!/usr/bin/env python3
"""
Suikoden IV Save Editor — cross-platform local web app (stdlib only).

Run:  python3 s4editor.py ["Base ISO/Suikoden IV (USA).iso"]
Then open the printed http://127.0.0.1:PORT URL in any browser.

Nothing is uploaded — the server runs on your machine and only touches the ISO or
memory-card file you point it at.

SCOPE: This is the honest, verified subset — nothing is written unless the layout was
confirmed against real saves.
  * Save editing is WRITE-ENABLED: each recruited character's HP, eight stats, three rune
    slots and seven equipment slots, plus the hero/ship names. The gamedata checksum was
    reverse-engineered (CRC32 + byte-reversed MD5 over the body), so edited saves load
    normally; memcard ECC is refreshed and a backup is made before the first write.
  * The ISO initial-stats table hasn't been located inside FILEDATA yet, so new-game
    stat editing is not exposed. The ISO tab offers identity, the file map, and a hex
    explorer to support locating it.
Reference data (113 characters, 519 items, 42 runes, full record layout) is browsable.
See Suikoden4_offsets.md for the full reverse-engineering notes.
"""
import json, os, sys, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import s4patch as P
import s4save as SV

ISO_PATH = None
_scan_root = os.getcwd()
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".s4editor.json")


def load_config():
    try:
        with open(CONFIG_PATH) as f:
            return json.load(f)
    except Exception:
        return {}

def save_config(**kw):
    cfg = load_config(); cfg.update(kw)
    try:
        with open(CONFIG_PATH, "w") as f:
            json.dump(cfg, f, indent=2)
    except Exception:
        pass


def pick_file_dialog(kind="card"):
    """Native OS file-open dialog on the server machine (runs locally)."""
    is_card = kind == "card"
    title = "Select a memory card or save file" if is_card else "Select a Suikoden IV ISO"
    # memory-card images + individual exported saves
    CARD_EXTS = (".ps2", ".mcd", ".mc2", ".bin", ".cbs", ".sps", ".psu", ".max", ".psv")
    def _guard(path):
        if is_card and path and not path.lower().endswith(CARD_EXTS):
            return {"error": "not a memory card or supported save file"}
        return {"path": path}
    try:
        if sys.platform == "darwin":
            import subprocess
            oftype = ('{"ps2","mcd","mc2","bin","cbs","sps","psu","max","psv"}'
                      if is_card else '{"iso"}')
            scr = (f'set f to choose file with prompt "{title}" of type {oftype}\n'
                   f'POSIX path of f')
            r = subprocess.run(["osascript", "-e", scr], capture_output=True, text=True)
            if r.returncode != 0:
                return {"cancelled": True}
            return _guard(r.stdout.strip())
        else:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk(); root.withdraw()
            exts = [("PS2 saves", "*.ps2 *.mcd *.mc2 *.bin *.cbs *.sps *.psu *.max *.psv")] \
                   if is_card else [("PS2 ISO", "*.iso")]
            path = filedialog.askopenfilename(title=title, filetypes=exts)
            root.destroy()
            return _guard(path) if path else {"cancelled": True}
    except Exception as e:
        return {"error": str(e)}


def scan_isos(root):
    out = []
    for dp, _, files in os.walk(root):
        if dp.count(os.sep) - root.count(os.sep) > 4:
            continue
        for fn in files:
            if fn.lower().endswith(".iso"):
                full = os.path.join(dp, fn)
                try:
                    out.append({"path": full, "name": fn,
                                "gb": round(os.path.getsize(full) / 1e9, 2)})
                except OSError:
                    pass
    return out


# --------------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def _send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        p = self.path.split("?")[0]
        try:
            if p in ("/", "/index.html"):
                return self._send(200, INDEX_HTML.encode(), "text/html; charset=utf-8")
            if p == "/api/meta":
                return self._send(200, {
                    "iso": os.path.basename(ISO_PATH) if ISO_PATH else None,
                    "loaded": bool(ISO_PATH),
                    "lastIso": load_config().get("lastIso"),
                    "serial": P.GAME_SERIAL,
                    "counts": {"characters": len(P.CHAR_OFFSETS),
                               "items": len(P.ITEM_NAMES), "runes": len(P.RUNE_NAMES)},
                })
            if p == "/api/isos":
                return self._send(200, {"root": _scan_root, "isos": scan_isos(_scan_root)})
            if p == "/api/iso-info":
                if not ISO_PATH:
                    return self._send(200, {"loaded": False})
                info = P.identify(ISO_PATH)
                info["loaded"] = True
                info["files"] = [{"name": n, "lba": lba, "offset": lba * P.SECTOR,
                                  "size": sz} for n, (lba, sz) in P.ISO_FILES.items()]
                return self._send(200, info)
            if p == "/api/reference":
                return self._send(200, {
                    "characters": P.character_list(),
                    "items": [{"id": k, "name": v} for k, v in sorted(P.ITEM_NAMES.items())],
                    "runes": [{"id": k, "name": v} for k, v in sorted(P.RUNE_NAMES.items())],
                    "statFields": P.STAT_FIELDS, "equipFields": P.EQUIP_FIELDS,
                    "stride": P.CHAR_STRIDE,
                })
            if p == "/api/cards":
                cfg = load_config()
                here = os.path.dirname(os.path.abspath(__file__))
                # Bounded root set (like the S3 editor) — never walk all of $HOME, which
                # hangs on large trees. Search the project dir, its parent, any nearby
                # Saves folders, and wherever the last card was opened.
                roots = {_scan_root,
                         os.path.abspath(os.path.join(_scan_root, "..")),
                         os.path.abspath(os.path.join(_scan_root, "Saves")),
                         os.path.abspath(os.path.join(here, "..")),
                         os.path.abspath(os.path.join(here, "..", "Saves")),
                         cfg.get("lastCardRoot", "")}
                scan = SV.scan_saves(sorted(r for r in roots if r))
                return self._send(200, {"lastCard": cfg.get("lastCard"),
                                        "cards": scan["memcards"], "files": scan["files"]})
            return self._send(404, {"error": "not found"})
        except Exception as e:
            return self._send(500, {"error": str(e)})

    def do_POST(self):
        global ISO_PATH
        try:
            b = self._body()
            if self.path == "/api/pick":
                return self._send(200, pick_file_dialog(b.get("kind", "card")))
            if self.path == "/api/open-iso":
                path = b.get("path", "")
                if not path or not os.path.isfile(path):
                    return self._send(200, {"error": "file not found"})
                ISO_PATH = path
                save_config(lastIso=path)
                return self._send(200, {"ok": True, "iso": os.path.basename(path)})
            if self.path == "/api/read-save":
                path = b.get("path", "")
                if not path or not os.path.isfile(path):
                    return self._send(200, {"error": "file not found"})
                save_config(lastCardRoot=os.path.dirname(path))
                # rune ids as INTEGERS so they match the integer rune values in each
                # character record (the JSON keys are hex strings like "0B").
                runes = sorted(({"id": int(k, 16), "name": v}
                                for k, v in P.RUNE_NAMES.items()), key=lambda r: r["id"])
                items = sorted(({"id": k, "name": v}
                                for k, v in SV.ITEM_NAMES.items()), key=lambda r: r["id"])
                saves = SV.read_all_s4_saves(path)
                if isinstance(saves, dict) and saves.get("error"):
                    return self._send(200, {"error": saves["error"]})
                return self._send(200, {"ok": True, "path": path, "runes": runes,
                                        "items": items, "equipSlots": SV.EQUIP_SLOTS,
                                        "saves": saves})
            if self.path == "/api/save-write":
                path = b.get("path", "")
                folder = b.get("folder", "")
                if not path or not os.path.isfile(path):
                    return self._send(200, {"error": "card file not found"})
                # char_edits keys arrive as strings from JSON; coerce to int
                ce = {int(k): v for k, v in (b.get("charEdits") or {}).items()}
                res = SV.write_save_edits(path, folder, char_edits=ce,
                                          name_edits=b.get("nameEdits") or {},
                                          make_backup=b.get("backup", True))
                if res.get("ok"):
                    res["saves"] = SV.read_all_s4_saves(path)
                return self._send(200, res)
            if self.path == "/api/iso-dump":
                if not ISO_PATH:
                    return self._send(200, {"error": "no ISO loaded"})
                off = int(b.get("off", 0)); ln = min(int(b.get("len", 256)), 4096)
                data = P.read_at(ISO_PATH, off, ln)
                rows = []
                for o in range(0, len(data), 16):
                    row = data[o:o+16]
                    rows.append({"off": off + o,
                                 "hex": " ".join(f"{x:02X}" for x in row),
                                 "ascii": "".join(chr(x) if 32 <= x < 127 else "." for x in row)})
                return self._send(200, {"ok": True, "rows": rows})
            if self.path == "/api/iso-find":
                if not ISO_PATH:
                    return self._send(200, {"error": "no ISO loaded"})
                try:
                    needle = bytes.fromhex(b.get("hex", "").replace(" ", ""))
                except ValueError:
                    return self._send(200, {"error": "invalid hex"})
                if not needle:
                    return self._send(200, {"error": "empty pattern"})
                hits = P.find_bytes(ISO_PATH, needle, int(b.get("start", 0)),
                                    int(b.get("end", 0)))
                return self._send(200, {"ok": True, "hits": [hex(h) for h in hits]})
            return self._send(404, {"error": "not found"})
        except Exception as e:
            return self._send(500, {"error": str(e)})


INDEX_HTML = r"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Suikoden IV Save Editor</title>
<style>
:root{
 /* Ocean / naval theme — deep-sea navy, teal foam, brass */
 --bg:#0a141e;--panel:#0f2233;--panel2:#143247;--fg:#e8f1f7;--mut:#8fb0c4;
 --acc:#2ec5c8;--acc2:#f2c14e;--line:#1d4258;--warn:#f2c14e;--ok:#3fd08a;--bad:#ff6b6b;
 --sea1:#0a141e;--sea2:#0d2033;--foam:rgba(120,224,200,.08);}
[data-theme=light]{--bg:#eaf4f7;--panel:#ffffff;--panel2:#e2eef3;--fg:#0d2233;
 --mut:#4a6b7d;--acc:#0e8f96;--acc2:#c78a1a;--line:#c5dbe4;--warn:#a05a00;--ok:#188a4e;--bad:#c62a2f;
 --sea1:#dcecf2;--sea2:#eaf4f7;--foam:rgba(14,143,150,.06);}
*{box-sizing:border-box}
body{margin:0;color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
 background:linear-gradient(180deg,var(--sea2) 0%,var(--sea1) 60%);background-attachment:fixed;min-height:100vh}
/* subtle animated foam/wave sheen behind everything */
body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;opacity:.5;
 background:radial-gradient(1200px 400px at 80% -10%,var(--foam),transparent 70%),
            radial-gradient(900px 300px at 10% 110%,var(--foam),transparent 70%)}
header{display:flex;align-items:center;gap:12px;padding:12px 18px;position:sticky;top:0;z-index:5;
 background:linear-gradient(180deg,var(--panel),var(--sea2));border-bottom:2px solid var(--acc);
 box-shadow:0 2px 12px rgba(0,0,0,.25);overflow:hidden}
/* animated wave crest along the header bottom */
header::after{content:"";position:absolute;left:0;right:0;bottom:0;height:6px;
 background:repeating-linear-gradient(90deg,var(--acc) 0 8px,transparent 8px 16px);opacity:.35;
 -webkit-mask:linear-gradient(90deg,transparent,#000,transparent);mask:linear-gradient(90deg,transparent,#000,transparent)}
h1{font-size:16px;margin:0;font-weight:650;letter-spacing:.02em}
h1::before{content:"⚓ ";color:var(--acc2)}
.sp{flex:1}
button,input,select{font:inherit;color:var(--fg)}
button{background:var(--panel2);border:1px solid var(--line);border-radius:8px;
 padding:7px 12px;cursor:pointer}button:hover{border-color:var(--acc)}
button.pri{background:var(--acc);border-color:var(--acc);color:#fff}
.tabs{display:flex;gap:4px;padding:10px 18px 0}
.tab{padding:8px 16px;border:1px solid var(--line);border-bottom:none;border-radius:10px 10px 0 0;
 background:var(--panel2);cursor:pointer;color:var(--mut)}
.tab.on{background:var(--panel);color:var(--acc);font-weight:600;box-shadow:0 -2px 0 var(--acc) inset}
main{padding:18px;max-width:1100px;margin:0 auto}
.card{background:linear-gradient(180deg,var(--panel),var(--sea2));border:1px solid var(--line);
 border-radius:12px;padding:16px;margin-bottom:16px;box-shadow:0 1px 10px rgba(0,0,0,.18)}
.mut{color:var(--mut)}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.badge{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--line)}
.badge.ro{color:var(--warn);border-color:var(--warn)}
.badge.ok{color:var(--ok);border-color:var(--ok);background:rgba(63,208,138,.08)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
th{color:var(--mut);font-weight:600;position:sticky;top:52px;background:var(--panel)}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
input[type=text],input[type=search],input[type=number],select{background:var(--panel2);
 color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:7px 10px}
input[type=number]{width:100%;padding:5px 6px;text-align:right}
select{width:100%;padding:5px 8px;cursor:pointer}
select option{background:var(--panel2);color:var(--fg)}
input:focus,select:focus{outline:none;border-color:var(--acc)}
.scroll{max-height:60vh;overflow:auto;border:1px solid var(--line);border-radius:8px}
.scroll th{top:0}
/* per-character editor blocks (S3-editor style) */
.subtabs{display:flex;gap:6px;margin-bottom:10px}
.subtabs button{background:transparent;color:var(--mut);border:1px solid var(--line);
 border-radius:8px;padding:6px 12px;cursor:pointer}
.subtabs button.on{background:var(--acc);color:#fff;border-color:var(--acc);font-weight:600}
/* save block header bar — like a ship's nameplate */
.appfoot{margin:26px 0 12px;text-align:center;color:var(--mut);font-size:12px}
.appfoot a{color:var(--acc);text-decoration:none}
.appfoot a:hover{text-decoration:underline}
.savecard{padding-top:0}
.savebar{cursor:pointer}
.caret{display:inline-block;transition:transform .15s;color:var(--acc);font-size:13px}
.savecard:not(.collapsed) .caret{transform:rotate(90deg)}
.savecard.collapsed .savebody{display:none}
.savecard.collapsed .savebar{margin-bottom:-16px;border-radius:12px}
.savebar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:-16px -16px 12px;
 padding:11px 16px;background:linear-gradient(90deg,var(--panel2),var(--panel));
 border-bottom:1px solid var(--acc);position:sticky;top:47px;z-index:4;
 box-shadow:0 4px 14px rgba(0,0,0,.28)}
.savebar b{font-size:15px;color:var(--acc)}
.rgn{font-size:11px;font-weight:700;letter-spacing:.5px;padding:2px 7px;border-radius:999px;
 background:var(--acc2);color:#1a2a33;vertical-align:middle}
.recsel{margin-left:auto;font-size:11px;padding:2px 6px;max-width:170px}
.charcard.unrec .recsel{background:#3a2b2b;color:#e79a9a;border-color:#6b4a4a}
.charcard.unrec{opacity:.72}
.charcard.unrec .charhead>span:first-child{color:var(--mut)}
.nametbl{width:auto}.nametbl td{border:0;padding:3px 10px 3px 0}
.charcard{border:1px solid var(--line);border-radius:10px;padding:12px 14px;
 background:var(--panel2);margin:0 0 12px;position:relative}
.charcard::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;
 background:linear-gradient(180deg,var(--acc),var(--acc2));border-radius:10px 0 0 10px;opacity:.7}
.charhead{font-weight:600;font-size:15px;color:var(--acc2);margin-bottom:8px;
 display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.charhead .lvl{color:var(--mut);font-weight:400;font-size:12px}
.tablewrap{overflow-x:auto}
.savetbl{width:auto;min-width:100%;border-collapse:collapse}
.savetbl th{position:static;background:none;text-align:center;font-size:11px;
 text-transform:uppercase;letter-spacing:.03em;padding:2px 6px;border:0}
.savetbl td{padding:2px 6px;border:0}
.savetbl input[type=number]{width:62px;text-align:center}
.seclabel{color:var(--acc2);font-size:12px;font-weight:600;margin:12px 2px 4px}
.grid{display:grid;gap:6px 10px}
.grid.g3{grid-template-columns:repeat(3,minmax(0,1fr))}
.grid.g4{grid-template-columns:repeat(4,minmax(0,1fr))}
@media(max-width:720px){.grid.g4,.grid.g3{grid-template-columns:repeat(2,1fr)}}
.fld{display:flex;flex-direction:column;gap:3px}
.fld label{font-size:11px;color:var(--mut)}
.chars{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px;margin-top:10px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:800px){.grid2{grid-template-columns:1fr}}
.hexline{display:grid;grid-template-columns:90px 1fr 150px;gap:12px;font-family:ui-monospace,monospace;font-size:12px;padding:1px 8px}
.note{background:var(--panel2);border-left:3px solid var(--warn);padding:8px 12px;border-radius:0 8px 8px 0;margin:8px 0}
/* loading UX — a spinning ship's helm */
.loading{display:flex;align-items:center;gap:10px;color:var(--mut);padding:10px 2px}
.helm{width:20px;height:20px;flex:none;border-radius:50%;border:2px solid var(--line);
 border-top-color:var(--acc);border-right-color:var(--acc);animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
button.busy{position:relative;color:transparent!important;pointer-events:none}
button.busy::after{content:"";position:absolute;left:50%;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;
 border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}
/* skeleton shimmer for card placeholders */
.skel{border:1px solid var(--line);border-radius:10px;height:120px;background:
 linear-gradient(100deg,var(--panel2) 30%,var(--foam) 50%,var(--panel2) 70%);
 background-size:200% 100%;animation:wave 1.3s ease-in-out infinite}
@keyframes wave{to{background-position:-200% 0}}
.skelgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px;margin-top:10px}
@media(prefers-reduced-motion:reduce){.helm,.skel,button.busy::after{animation:none}}
</style></head><body>
<header>
  <h1>Suikoden IV <span class="mut">Save Editor</span></h1>
  <span id="meta" class="mut mono"></span>
  <span class="sp"></span>
  <button onclick="toggleTheme()">◐ Theme</button>
</header>
<div class="tabs">
  <div class="tab on" data-t="save" onclick="tab('save')">Save Editor</div>
  <div class="tab" data-t="ref" onclick="tab('ref')">Reference</div>
  <div class="tab" data-t="iso" onclick="tab('iso')">ISO Tools</div>
</div>
<main>
  <section id="t-save"></section>
  <section id="t-ref" hidden></section>
  <section id="t-iso" hidden></section>
</main>
<footer class="appfoot">Made by <b>Sparda</b> · <a href="https://github.com/TheSparda/Suikoden-4-Save-Editor" target="_blank" rel="noopener">github.com/TheSparda/Suikoden-4-Save-Editor</a></footer>
<script>
const $=(s,e=document)=>e.querySelector(s);
const api=(u,b)=>fetch(u,b?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}:undefined).then(r=>r.json());
// loading UX helpers
const spinner=(msg)=>`<div class="loading"><span class="helm"></span><span>${esc(msg||'loading…')}</span></div>`;
const skelCards=(n=3)=>`<div class="skelgrid">${'<div class="skel"></div>'.repeat(n)}</div>`;
async function withBusy(btn,fn){ if(btn)btn.classList.add('busy'); try{ return await fn(); } finally{ if(btn)btn.classList.remove('busy'); } }
function toggleTheme(){const d=document.documentElement;const n=d.getAttribute('data-theme')==='light'?'':'light';
 n?d.setAttribute('data-theme',n):d.removeAttribute('data-theme');localStorage.s4theme=n;}
if(localStorage.s4theme)document.documentElement.setAttribute('data-theme',localStorage.s4theme);
function tab(t){for(const el of document.querySelectorAll('.tab'))el.classList.toggle('on',el.dataset.t===t);
 for(const s of ['iso','save','ref'])$('#t-'+s).hidden=(s!==t);
 if(t==='ref'&&!refLoaded)loadRef();if(t==='save'&&!saveInit)initSave();if(t==='iso'&&!isoInit){isoInit=true;renderIso();}}
let isoInit=false;
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

let meta={};
async function boot(){meta=await api('/api/meta');
 $('#meta').textContent=meta.loaded?('ISO: '+meta.iso):'';
 initSave();}   // Save Editor is the default tab
async function renderIso(){
 $('#t-iso').innerHTML='<div class="card">'+spinner('reading ISO…')+'</div>';
 const info=await api('/api/iso-info');
 const s=$('#t-iso');
 if(!info.loaded){
   s.innerHTML=`<div class="card"><b>No ISO loaded.</b>
    <p class="mut">Open your <code>Suikoden IV (USA).iso</code>. Nothing is uploaded — it's read on this machine only.</p>
    <div class="row"><button class="pri" onclick="pickIso()">Choose ISO…</button>
    <span class="mut">last: <code>${esc(meta.lastIso||'—')}</code></span>
    ${meta.lastIso?`<button onclick="openIso('${esc(meta.lastIso)}')">Reopen last</button>`:''}</div></div>`;
   return;}
 const okb=info.match?'<span class="badge ok">verified USA · '+esc(info.serial)+'</span>':'<span class="badge ro">serial mismatch</span>';
 s.innerHTML=`<div class="card"><div class="row"><b>${esc(info.path.split('/').pop())}</b>${okb}
   <span class="sp"></span><button onclick="pickIso()">Change…</button></div>
   <pre class="mono mut" style="white-space:pre-wrap">${esc(info.system_cnf)}</pre></div>
  <div class="card"><b>File map</b> <span class="mut">(raw offset = LBA × 2048)</span>
   <table><thead><tr><th>File</th><th>LBA</th><th>Offset</th><th>Size</th></tr></thead><tbody>
   ${info.files.map(f=>`<tr><td class="mono">${esc(f.name)}</td><td class="mono">${f.lba}</td>
     <td class="mono">0x${f.offset.toString(16).toUpperCase()}</td>
     <td class="mono">${f.size.toLocaleString()}</td></tr>`).join('')}</tbody></table></div>
  <div class="card"><b>Hex explorer</b>
   <div class="note">New-game character stats live packed in <code>FILEDATA.*</code> — location not yet confirmed. Use this to help locate tables. Read-only.</div>
   <div class="row"><label>offset <input type="text" id="hoff" value="0x0" size="12" class="mono"></label>
    <label>len <input type="text" id="hlen" value="256" size="6" class="mono"></label>
    <button onclick="hexdump()">Dump</button>
    <span class="sp"></span>
    <label>find hex <input type="text" id="hfind" placeholder="20 00 22 00" class="mono" size="18"></label>
    <button onclick="hexfind()">Search</button></div>
   <div id="hexout" class="scroll mono" style="margin-top:10px"></div>
   <div id="findout" class="mut mono" style="margin-top:6px"></div></div>`;
}
async function pickIso(){const r=await api('/api/pick',{kind:'iso'});if(r.path)openIso(r.path);}
async function openIso(path){const r=await api('/api/open-iso',{path});if(r.error)return alert(r.error);
 meta.iso=r.iso;meta.loaded=true;$('#meta').textContent='ISO: '+r.iso;renderIso();}
async function hexdump(){const off=parseInt($('#hoff').value,16||10)||0;
 const r=await api('/api/iso-dump',{off:parseInt($('#hoff').value),len:parseInt($('#hlen').value)});
 if(r.error)return $('#hexout').textContent=r.error;
 $('#hexout').innerHTML=r.rows.map(x=>`<div class="hexline"><span class="mut">${x.off.toString(16).toUpperCase().padStart(8,'0')}</span><span>${x.hex}</span><span>${esc(x.ascii)}</span></div>`).join('');}
async function hexfind(){$('#findout').innerHTML=spinner('searching the ISO…');
 const r=await api('/api/iso-find',{hex:$('#hfind').value});
 $('#findout').textContent=r.error?r.error:(r.hits.length+' hit(s): '+r.hits.join('  '));}

// ---- Saves (editable — checksum solved: CRC32 + reversed MD5 over 0x20..0x20+0xE240)
let saveInit=false, cardPath=null;
async function initSave(){saveInit=true;const s=$('#t-save');
 s.innerHTML=`<div class="card">
   <div class="row"><b>PS2 memory card</b><span class="sp"></span>
     <button class="pri" onclick="pickCard()">Choose file…</button>
     <button onclick="scanCards()">Scan nearby</button></div>
   <div class="note">Edit character stats, HP, runes, equipment and names on an existing save. Writes recompute the save checksum and refresh the card's ECC so it loads normally; a <code>.bak</code> of the whole card is made before the first write.</div>
   <div id="cardlist" class="mut" style="margin-top:6px"></div>
   </div>
   <div id="saveout"></div>`;
 scanCards();}   // auto-scan so the card list is ready on open
async function pickCard(){const r=await api('/api/pick',{kind:'card'});if(r.path)readSave(r.path);}
async function scanCards(){$('#cardlist').innerHTML=spinner('scanning for saves…');const r=await api('/api/cards');
 const cards=r.cards||[], files=r.files||[];
 if(!cards.length && !files.length){$('#cardlist').innerHTML='<span class="mut">no PS2 cards or save files found nearby — use “Choose file…”.</span>';return;}
 const pdir=p=>{const s=String(p).split(/[\\\\/]/);return s.length>1?s[s.length-2]:'';};
 const cardBtn=c=>`<button title="${esc(c.path)}" onclick="readSave('${esc(c.path)}',this)">${esc(c.name)} ${c.hasS4?'<span class=\"badge ok\">S4</span>':''} <span class="mut">${c.mb}MB</span></button>`;
 const fileBtn=c=>`<button title="${esc(c.path)}" onclick="readSave('${esc(c.path)}',this)">${esc(c.name)} <span class="rgn" style="background:var(--acc)">${esc((c.format||'').toUpperCase())}</span>${c.writable?'':' <span class="badge ro">read-only</span>'}${pdir(c.path)?` <span class="mut">· ${esc(pdir(c.path))}/</span>`:''}</button>`;
 let h='';
 if(cards.length) h+='<div class="mut" style="margin:6px 0 2px">Memory cards</div><div class="row" style="margin:2px 0 8px">'+cards.map(cardBtn).join('')+'</div>';
 if(files.length) h+='<div class="mut" style="margin:6px 0 2px">Individual save files</div><div class="row" style="margin:2px 0 8px">'+files.map(fileBtn).join('')+'</div>';
 $('#cardlist').innerHTML=h;}
let RUNE_LIST=[];   // [{id:int,name}] for rune dropdowns, built on read
let ITEM_LIST=[];   // [{id:int,name}] for equipment dropdowns
let ITEM_OPTS='';   // prebuilt <option> string (519 items) reused per slot
let EQUIP_SLOTS=[]; // [[key,offset],...] slot order from the server
function renderSaves(saves){
 const many=saves.length>1;   // collapse each save when there are several to choose from
 $('#saveout').innerHTML=saves.map(sv=>{
  const cksum=sv.checksumValid?'<span class="badge ok">checksum ok</span>':'<span class="badge ro">checksum off</span>';
  const nameRows=sv.names.map(n=>`<tr><td class="mut">${esc(n.label)}</td>
    <td><input type="text" class="mono" data-name="${esc(n.folder)}|${esc(n.key)}" value="${esc(n.value)}" maxlength="${n.max}" size="18"></td></tr>`).join('');
  const GEAR_LABELS={head:'Head',body:'Body',hands:'Hands',feet:'Feet',acc1:'Accessory 1',acc2:'Accessory 2',acc3:'Accessory 3'};
  const STATS=['STR','SKL','MAG','EVA','PDF','MDF','SPD','LUK'];
  const charCard=(c)=>{
    const st=c.stats, cid=esc(sv.folder)+'|'+c.rosterIndex;
    const cell=(f,v,mx)=>`<input type="number" min="0" max="${mx}" value="${v}" data-ch="${cid}|${f}">`;
    const statTable=`<div class="tablewrap"><table class="savetbl"><thead><tr>`+
      `<th>Max HP</th>${STATS.map(k=>`<th>${k}</th>`).join('')}</tr></thead><tbody><tr>`+
      `<td>${cell('maxHP',c.maxHP,9999)}</td>`+
      STATS.map(k=>`<td>${cell('stat:'+k,st[k],999)}</td>`).join('')+`</tr></tbody></table></div>`;
    const rune=(slot,label)=>{
      const cur=c.runes[slot];
      const opts=RUNE_LIST.map(r=>`<option value="${r.id}"${r.id===cur?' selected':''}>${esc(r.name)}</option>`).join('');
      return `<div class="fld"><label>${label}</label><select data-ch="${cid}|rune:${slot}">${opts}</select></div>`;};
    const gear=(key,label)=>{
      const cur=(c.equip||{})[key]||0;
      const opts=ITEM_OPTS.replace(`value="${cur}">`,`value="${cur}" selected>`);
      return `<div class="fld"><label>${label}</label><select data-ch="${cid}|equip:${key}">${opts}</select></div>`;};
    // Real recruitment flag from the save (0x164 + idx*0x78):
    // 0=Not Recruited, 1=In Your Company, 10=Recruited, 11=In Party, 15=Permanently In Party
    const REC_STATES=[[0,'Not Recruited'],[1,'In Your Company'],[10,'Recruited'],[11,'In Party'],[15,'Permanently In Party']];
    const rcur=(c.recruited===undefined)?null:c.recruited;
    const unrec=rcur!==null && rcur===0;
    const recSel=rcur===null?'':`<select class="recsel" data-ch="${cid}|recruited" onclick="event.stopPropagation()" title="Recruitment status — this is the flag the game itself checks">${
      REC_STATES.map(([v,l])=>`<option value="${v}"${v===rcur?' selected':''}>${l}</option>`).join('')
    }${REC_STATES.some(([v])=>v===rcur)?'':`<option value="${rcur}" selected>? (${rcur})</option>`}</select>`;
    return `<div class="charcard${unrec?' unrec':''}" data-name="${esc(c.name.toLowerCase())}" data-ri="${c.rosterIndex}" data-data="${c.hasData?1:0}">
      <div class="charhead"><span>${esc(c.name)}</span><span class="lvl">#${c.rosterIndex}</span>${recSel}</div>
      ${statTable}
      <div class="seclabel">Runes</div>
      <div class="grid g3">${rune(0,'Rune 1')}${rune(1,'Rune 2')}${rune(2,'Rune 3')}</div>
      <div class="seclabel">Equipment</div>
      <div class="grid g4">${EQUIP_SLOTS.map(([k])=>gear(k,GEAR_LABELS[k]||k)).join('')}</div>
    </div>`;};
  const chars=(sv.characters||[]).map(charCard).join('');
  const f=esc(sv.folder);
  const nrec=(sv.characters||[]).filter(c=>(c.recruited||0)>=10).length;
  return `<div class="card savecard${many?' collapsed':''}">
    <div class="savebar" onclick="toggleSave('${f}',event)" title="click to expand / collapse">
      <span class="caret">▸</span>
      <b>${esc(sv.label)}</b>${sv.region?` <span class="rgn">${esc(sv.region)}</span>`:''} ${cksum}
      <span class="mono mut">${esc(sv.meta&&sv.meta.title||'')}</span>
      <span class="mut" style="font-size:12px">${nrec} recruited</span>
      ${sv.container&&sv.container!=='memcard'?`<span class="rgn" style="background:var(--acc)">${esc(sv.container.toUpperCase())}</span>`:''}
      <span class="sp"></span>
      ${sv.writable===false
        ? `<span class="badge ro" title="${esc(sv.note||'read-only container')}">read-only</span>`
        : `<label class="mut" title="write a .bak first" onclick="event.stopPropagation()"><input type="checkbox" class="bak" checked> backup</label>
           <button class="pri" onclick="event.stopPropagation();writeSave('${f}',this)">Write ${esc(sv.label)}</button>`}
    </div>
    <div class="savebody">
    <div class="seclabel">Names</div>
    <table class="nametbl"><tbody>${nameRows}</tbody></table>
    <div class="seclabel" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">Characters
      <input type="search" placeholder="filter by name or #…" oninput="filterChars('${f}',this.value)" style="width:200px;font-weight:400">
      <label class="mut" style="font-weight:400"><input type="checkbox" onchange="withdataChars('${f}',this.checked)"> only non-default</label>
    </div>
    <div id="chars-${f}" class="chars">${chars}</div></div></div>`;}).join('');
 applyCharFilters();}
// expand / collapse one save card (ignore clicks on the write button / backup toggle)
function toggleSave(folder,ev){
 const card=document.querySelector(`#chars-${CSS.escape(folder)}`)?.closest('.savecard');
 if(card) card.classList.toggle('collapsed');}
// filter state per folder
const CHARFILT={};
function filterChars(folder,q){(CHARFILT[folder]=CHARFILT[folder]||{}).q=q.toLowerCase();applyCharFilters();}
function withdataChars(folder,on){(CHARFILT[folder]=CHARFILT[folder]||{}).data=on;applyCharFilters();}
function applyCharFilters(){
 document.querySelectorAll('.chars').forEach(box=>{
   const folder=box.id.slice('chars-'.length);
   const st=CHARFILT[folder]||{}; const q=st.q||''; const dataOnly=!!st.data;
   box.querySelectorAll('.charcard').forEach(card=>{
     const okQ=!q||card.dataset.name.includes(q)||card.dataset.ri===q;
     const okD=!dataOnly||card.dataset.data==='1';
     card.style.display=(okQ&&okD)?'':'none';});});}
async function readSave(path,btn){
 $('#saveout').innerHTML=spinner('reading memory card…')+skelCards(3);
 const r=await withBusy(btn,()=>api('/api/read-save',{path}));
 if(r.error)return $('#saveout').innerHTML='<p style="color:var(--bad)">'+esc(r.error)+'</p>';
 if(!r.saves.length)return $('#saveout').innerHTML='<p class="mut">no Suikoden IV saves on this card.</p>';
 RUNE_LIST=r.runes||[];
 ITEM_LIST=r.items||[]; EQUIP_SLOTS=r.equipSlots||[];
 ITEM_OPTS=ITEM_LIST.map(x=>`<option value="${x.id}">${esc(x.name)}</option>`).join('');
 cardPath=r.path;renderSaves(r.saves);}
async function writeSave(folder,btn){
 if(!cardPath)return;
 const charEdits={}, nameEdits={};
 for(const el of document.querySelectorAll(`[data-ch^="${folder}|"]`)){
   const [,ridx,field]=el.dataset.ch.split('|');
   charEdits[ridx]=charEdits[ridx]||{};
   if(field.startsWith('stat:')){charEdits[ridx].stats=charEdits[ridx].stats||{};charEdits[ridx].stats[field.slice(5)]=+el.value;}
   else if(field.startsWith('rune:')){charEdits[ridx].runes=charEdits[ridx].runes||{};charEdits[ridx].runes[field.slice(5)]=+el.value;}
   else if(field.startsWith('equip:')){charEdits[ridx].equip=charEdits[ridx].equip||{};charEdits[ridx].equip[field.slice(6)]=+el.value;}
   else charEdits[ridx][field]=+el.value;}
 for(const el of document.querySelectorAll(`[data-name^="${folder}|"]`)){
   const key=el.dataset.name.split('|')[1];nameEdits[key]=el.value;}
 const bakEl=document.querySelector(`#chars-${CSS.escape(folder)}`)?.closest('.savecard')?.querySelector('.bak');
 const backup=bakEl?bakEl.checked:true;
 const r=await withBusy(btn,()=>api('/api/save-write',{path:cardPath,folder,charEdits,nameEdits,backup}));
 if(r.error)return alert('Write failed: '+r.error);
 alert(`Wrote ${folder}: ${r.changed} field(s) changed. Checksum recomputed — save will load normally.`);
 if(r.saves)renderSaves(r.saves);}

// ---- Reference
let refLoaded=false,refData=null;
async function loadRef(){refLoaded=true;
 $('#t-ref').innerHTML='<div class="card">'+spinner('loading reference data…')+'</div>';
 refData=await api('/api/reference');
 const s=$('#t-ref');
 s.innerHTML=`<div class="card"><div class="row">
   <b>Reference</b><span class="mut">${refData.characters.length} characters · ${refData.items.length} items · ${refData.runes.length} runes</span>
   <span class="sp"></span><input type="search" id="rq" placeholder="filter…" oninput="renderRef()"></div>
   <div class="row" style="margin-top:8px">
    <select id="rkind" onchange="renderRef()">
     <option value="characters">Characters</option><option value="items">Items</option>
     <option value="runes">Runes</option><option value="layout">Record layout</option></select></div>
   <div id="reftbl" class="scroll" style="margin-top:10px"></div></div>`;
 renderRef();}
function renderRef(){const kind=$('#rkind').value,q=($('#rq').value||'').toLowerCase();
 let html='';
 if(kind==='layout'){
   html=`<table><thead><tr><th>Record</th><th>Offset</th><th>Width</th><th>Field</th></tr></thead><tbody>`
    +refData.statFields.map(f=>`<tr><td>stat</td><td class="mono">+0x${f[0].toString(16).toUpperCase()}</td><td>${f[1]}</td><td>${esc(f[2])}</td></tr>`).join('')
    +refData.equipFields.map(f=>`<tr><td>equip</td><td class="mono">+0x${f[0].toString(16).toUpperCase()}</td><td>${f[1]}</td><td>${esc(f[2])}</td></tr>`).join('')
    +`</tbody></table><p class="mut" style="padding:8px">Stride 0x${refData.stride.toString(16).toUpperCase()} per character (RAM layout from the Cheat Engine table).</p>`;
 }else{
   const rows=refData[kind].filter(x=>!q||JSON.stringify(x).toLowerCase().includes(q));
   const cols=kind==='characters'?['name','index','offset']:['id','name'];
   html=`<table><thead><tr>${cols.map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>`
    +rows.slice(0,600).map(x=>`<tr>${cols.map(c=>`<td class="${c==='id'||c==='offset'||c==='index'?'mono':''}">${esc(c==='offset'?'0x'+x[c].toString(16).toUpperCase():x[c])}</td>`).join('')}</tr>`).join('')
    +`</tbody></table>`+(rows.length>600?`<p class="mut" style="padding:8px">showing 600 of ${rows.length}</p>`:'');
 }
 $('#reftbl').innerHTML=html;}
boot();
</script></body></html>"""


def main():
    global ISO_PATH, _scan_root
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    port = 8749
    for a in sys.argv[1:]:
        if a.startswith("--port="):
            port = int(a.split("=", 1)[1])
    if args:
        cand = args[0]
        if os.path.isfile(cand):
            ISO_PATH = cand
            save_config(lastIso=cand)
        elif os.path.isdir(cand):
            _scan_root = cand
    if not ISO_PATH:
        last = load_config().get("lastIso")
        if last and os.path.isfile(last):
            ISO_PATH = last
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}"
    print(f"Suikoden IV editor → {url}   (Ctrl-C to stop)")
    if ISO_PATH:
        print(f"  ISO: {ISO_PATH}")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
