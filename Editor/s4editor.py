#!/usr/bin/env python3
"""
Suikoden IV ISO & Save editor — cross-platform local web app (stdlib only).

Run:  python3 s4editor.py ["Base ISO/Suikoden IV (USA).iso"]
Then open the printed http://127.0.0.1:PORT URL in any browser.

Nothing is uploaded — the server runs on your machine and only touches the ISO or
memory-card file you point it at.

SCOPE (v1): This is the honest, verified subset. What is NOT yet write-enabled is
labeled read-only in the UI, because the underlying data isn't cracked yet:
  * Save editing is READ-ONLY: the gamedata checksum (a 20-byte digest at 0x0C) is an
    unsolved save-load gate; writing a modified save could brick the load. See
    Suikoden4_offsets.md.
  * The ISO initial-stats table hasn't been located inside FILEDATA yet, so new-game
    stat editing is not exposed. The ISO tab offers identity, the file map, and a hex
    explorer to support locating it.
Reference data (113 characters, 519 items, 42 runes, full record layout) is browsable.
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
    title = "Select a PS2 memory card" if is_card else "Select a Suikoden IV ISO"
    CARD_EXTS = (".ps2", ".mcd", ".mc2", ".bin")
    def _guard(path):
        if is_card and path and not path.lower().endswith(CARD_EXTS):
            return {"error": "not a PS2 memory-card file (.ps2/.mcd/.mc2/.bin)"}
        return {"path": path}
    try:
        if sys.platform == "darwin":
            import subprocess
            oftype = ('{"ps2","mcd","mc2","bin"}' if is_card else '{"iso"}')
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
            exts = [("PS2 memory card", "*.ps2 *.mcd *.mc2 *.bin")] if is_card \
                   else [("PS2 ISO", "*.iso")]
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
                roots = [_scan_root, os.path.expanduser("~"), cfg.get("lastCardRoot", "")]
                return self._send(200, {"cards": SV.scan_memcards([r for r in roots if r])})
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
                return self._send(200, {"ok": True, "saves": SV.read_all_s4_saves(path)})
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
<title>Suikoden IV ISO &amp; Save Editor</title>
<style>
:root{--bg:#0f1116;--panel:#181b22;--panel2:#1f232c;--fg:#e6e9ef;--mut:#98a2b3;
 --acc:#5b8cff;--line:#2a2f3a;--warn:#f0b429;--ok:#38b26b;--bad:#e5484d;}
[data-theme=light]{--bg:#f4f6fb;--panel:#fff;--panel2:#eef1f7;--fg:#1a1d24;
 --mut:#5a6474;--acc:#2f6df0;--line:#dde2ec;--warn:#a05a00;--ok:#188a4e;--bad:#c62a2f;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
 font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:12px 18px;background:var(--panel);
 border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
h1{font-size:16px;margin:0;font-weight:650}.sp{flex:1}
button,input,select{font:inherit;color:var(--fg)}
button{background:var(--panel2);border:1px solid var(--line);border-radius:8px;
 padding:7px 12px;cursor:pointer}button:hover{border-color:var(--acc)}
button.pri{background:var(--acc);border-color:var(--acc);color:#fff}
.tabs{display:flex;gap:4px;padding:10px 18px 0}
.tab{padding:8px 14px;border:1px solid var(--line);border-bottom:none;border-radius:8px 8px 0 0;
 background:var(--panel2);cursor:pointer;color:var(--mut)}
.tab.on{background:var(--panel);color:var(--fg);font-weight:600}
main{padding:18px;max-width:1100px;margin:0 auto}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
.mut{color:var(--mut)}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.badge{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--line)}
.badge.ro{color:var(--warn);border-color:var(--warn)}
.badge.ok{color:var(--ok);border-color:var(--ok)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}
th{color:var(--mut);font-weight:600;position:sticky;top:52px;background:var(--panel)}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
input[type=text],input[type=search]{background:var(--panel2);border:1px solid var(--line);
 border-radius:8px;padding:7px 10px}
.scroll{max-height:60vh;overflow:auto;border:1px solid var(--line);border-radius:8px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:800px){.grid2{grid-template-columns:1fr}}
.hexline{display:grid;grid-template-columns:90px 1fr 150px;gap:12px;font-family:ui-monospace,monospace;font-size:12px;padding:1px 8px}
.note{background:var(--panel2);border-left:3px solid var(--warn);padding:8px 12px;border-radius:0 8px 8px 0;margin:8px 0}
</style></head><body>
<header>
  <h1>Suikoden IV <span class="mut">ISO &amp; Save Editor</span></h1>
  <span id="meta" class="mut mono"></span>
  <span class="sp"></span>
  <button onclick="toggleTheme()">◐ Theme</button>
</header>
<div class="tabs">
  <div class="tab on" data-t="iso" onclick="tab('iso')">ISO</div>
  <div class="tab" data-t="save" onclick="tab('save')">Saves</div>
  <div class="tab" data-t="ref" onclick="tab('ref')">Reference</div>
</div>
<main>
  <section id="t-iso"></section>
  <section id="t-save" hidden></section>
  <section id="t-ref" hidden></section>
</main>
<script>
const $=(s,e=document)=>e.querySelector(s);
const api=(u,b)=>fetch(u,b?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}:undefined).then(r=>r.json());
function toggleTheme(){const d=document.documentElement;const n=d.getAttribute('data-theme')==='light'?'':'light';
 n?d.setAttribute('data-theme',n):d.removeAttribute('data-theme');localStorage.s4theme=n;}
if(localStorage.s4theme)document.documentElement.setAttribute('data-theme',localStorage.s4theme);
function tab(t){for(const el of document.querySelectorAll('.tab'))el.classList.toggle('on',el.dataset.t===t);
 for(const s of ['iso','save','ref'])$('#t-'+s).hidden=(s!==t);
 if(t==='ref'&&!refLoaded)loadRef();if(t==='save'&&!saveInit)initSave();}
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

let meta={};
async function boot(){meta=await api('/api/meta');
 $('#meta').textContent=meta.loaded?('ISO: '+meta.iso):'no ISO loaded';
 renderIso();}
async function renderIso(){
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
async function hexfind(){$('#findout').textContent='searching…';
 const r=await api('/api/iso-find',{hex:$('#hfind').value});
 $('#findout').textContent=r.error?r.error:(r.hits.length+' hit(s): '+r.hits.join('  '));}

// ---- Saves
let saveInit=false;
async function initSave(){saveInit=true;const s=$('#t-save');
 s.innerHTML=`<div class="card"><div class="row"><b>PS2 memory card</b>
   <span class="badge ro">read-only</span><span class="sp"></span>
   <button class="pri" onclick="pickCard()">Choose card…</button>
   <button onclick="scanCards()">Scan for cards</button></div>
   <div class="note">Save editing is read-only: the gamedata checksum (20-byte digest at 0x0C) is an unsolved save-load gate. Writing could break the save. Viewing is safe.</div>
   <div id="cardlist" class="mut"></div>
   <div id="saveout"></div></div>`;}
async function pickCard(){const r=await api('/api/pick',{kind:'card'});if(r.path)readSave(r.path);}
async function scanCards(){$('#cardlist').textContent='scanning…';const r=await api('/api/cards');
 if(!r.cards||!r.cards.length){$('#cardlist').textContent='no PS2 cards found nearby.';return;}
 $('#cardlist').innerHTML='<div class="row" style="margin:8px 0">'+r.cards.map(c=>
   `<button onclick="readSave('${esc(c.path)}')">${esc(c.name)} ${c.hasS4?'<span class=\"badge ok\">S4</span>':''} <span class="mut">${c.mb}MB</span></button>`).join('')+'</div>';}
async function readSave(path){$('#saveout').innerHTML='<p class="mut">reading…</p>';
 const r=await api('/api/read-save',{path});
 if(r.error)return $('#saveout').innerHTML='<p style="color:var(--bad)">'+esc(r.error)+'</p>';
 if(!r.saves.length)return $('#saveout').innerHTML='<p class="mut">no Suikoden IV saves on this card.</p>';
 $('#saveout').innerHTML=r.saves.map(sv=>`<div class="card"><div class="row"><b>${esc(sv.label)}</b>
   <span class="mono mut">${esc(sv.folder)}</span><span class="sp"></span>
   <span class="mono mut">${esc(sv.meta&&sv.meta.title||'')}</span></div>
   <table><tbody>
   <tr><td class="mut">Version</td><td class="mono">${sv.version}</td></tr>
   <tr><td class="mut">Checksum digest</td><td class="mono">${esc(sv.digest)}</td></tr>
   ${sv.names.map(n=>`<tr><td class="mut">${esc(n.label)}</td><td class="mono">${esc(n.value)}</td></tr>`).join('')}
   </tbody></table></div>`).join('');}

// ---- Reference
let refLoaded=false,refData=null;
async function loadRef(){refLoaded=true;refData=await api('/api/reference');
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
