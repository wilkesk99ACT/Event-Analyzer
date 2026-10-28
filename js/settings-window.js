// ════════════════════════════════════════════════════════════════════════════
// RELAY SETTINGS WINDOW
// ════════════════════════════════════════════════════════════════════════════
// A CEV carries the relay's complete settings after the "SETTINGS" marker, the same block
// SynchroWAVe Event shows in its settings view. This opens them in a separate window laid out
// the way SynchroWAVe and QuickSet do: setting classes (Group 1, Logic 1, Global, Report …) in a
// tree on the left, each class's headings and settings in a grid on the right, plus the text
// exactly as the relay wrote it. A separate window, not a modal, so it can sit beside the charts
// or on a second monitor while the event is read. Popup blocked → the same page in an overlay.
//
// The text is read from P.raw, not P.settingsText, so a SEL-351's legacy "NAME = value" settings
// show as the relay wrote them rather than as normalizeLegacySelogic() rewrote them.

let SETTINGS_WIN = null;

// The settings block as written: from the line after "SETTINGS","xxxx" to the closing
// `","xxxx"` checksum. Falls back to the parser's slice when the marker is missing.
function extractCevSettingsText(P) {
  const raw = String(P?.raw || '');
  const at = raw.indexOf('"SETTINGS"');
  if (at < 0) return String(P?.settingsText || '').trim();
  let s = raw.substring(at).replace(/\r/g, '');
  s = s.substring(s.indexOf('\n') + 1);          // drop the "SETTINGS","02E1" line
  s = s.replace(/^"/, '');                         // opening quote of the settings field
  const end = s.search(/"\s*,\s*"[0-9A-Fa-f]{4}"\s*(\n|$)/);
  if (end >= 0) s = s.substring(0, end);
  return s.replace(/^\n+|\s+$/g, '');
}

// Setting classes are the top level of the tree. The relay writes a class name and then a
// generic title for it ("Group 1" / "Group Settings", "SELogic group 1" / "Logic Settings");
// the generic one is folded into the specific one that came just before it.
const SETTINGS_CLASS_HEADERS = [
  [/^Group\s+(\d+)$/i, m => `Group ${m[1]}`],
  [/^SELogic\s+group\s+(\d+)$/i, m => `Logic ${m[1]}`],
  [/^Group Settings:?$/i, () => 'Group'],
  [/^Logic Settings:?$/i, () => 'Logic'],
  [/^Global Settings:?$/i, () => 'Global'],
  [/^Report Settings:?$/i, () => 'Report'],
  [/^Port\s+(\w+)(?:\s+Settings)?:?$/i, m => `Port ${m[1]}`],
  [/^Front Panel Settings:?$/i, () => 'Front Panel'],
  [/^Breaker Monitor Settings:?$/i, () => 'Breaker Monitor'],
  [/^Notes Settings:?$/i, () => 'Notes'],
  [/^DNP3? Map Settings.*$/i, () => 'DNP Map'],
];
const SETTING_LINE_RE = /[A-Za-z0-9_]\s*:?=(?!=)/;
const SETTING_ITEM_RE = /([A-Za-z0-9_]+)\s*:?=(?!=)(.*?)(?=\s+[A-Za-z0-9_]+\s*:?=(?!=)|$)/g;

function parseCevSettingsClasses(text) {
  const classes = [];
  let cls = null, sec = null, last = null;
  const newClass = (name) => { cls = { name, sections: [] }; classes.push(cls); sec = null; last = null; };
  const ensureSection = () => {
    if (!cls) newClass('Settings');
    if (!sec) { sec = { name: 'General', settings: [] }; cls.sections.push(sec); }
  };
  const classHasSettings = () => cls && cls.sections.some(s => s.settings.length);

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) { last = null; continue; }

    const header = SETTINGS_CLASS_HEADERS.find(([re]) => re.test(trimmed));
    if (header) {
      const name = header[1](trimmed.match(header[0]));
      const generic = name === 'Group' || name === 'Logic';
      if (!(generic && cls && !classHasSettings())) newClass(name);
      continue;
    }

    if (SETTING_LINE_RE.test(trimmed) && /^[A-Za-z0-9_]+\s*:?=/.test(trimmed)) {
      ensureSection();
      for (const m of trimmed.matchAll(SETTING_ITEM_RE)) {
        let value = m[2].trim(), comment = '';
        const hash = value.indexOf('#');
        if (hash >= 0) { comment = value.substring(hash + 1).trim(); value = value.substring(0, hash).trim(); }
        last = { name: m[1], value, comment };
        sec.settings.push(last);
      }
      continue;
    }

    // A wrapped list (SER trigger lists) or an indented legacy continuation belongs to the
    // setting above it; anything else is a heading. The relay drops the comma at a list wrap.
    if (last && (/^\s/.test(line) || !/\s/.test(trimmed))) {
      const list = /^[^\s,]+(,[^\s,]+)*,?$/.test(last.value) && /,/.test(last.value + trimmed);
      last.value += (/,$/.test(last.value) ? '' : list ? ',' : ' ') + trimmed;
      continue;
    }
    if (!cls) newClass('Settings');
    sec = { name: trimmed.replace(/:$/, ''), settings: [] };
    cls.sections.push(sec);
    last = null;
  }

  for (const c of classes) c.sections = c.sections.filter(s => s.settings.length);
  return classes.filter(c => c.sections.length);
}

function hasRelaySettings(P) {
  return !!P && P.format !== 'form6' && P.format !== 'sel851' && !!extractCevSettingsText(P);
}

function updateSettingsButton() {
  const btn = document.getElementById('settingsBtn');
  if (btn) btn.style.display = hasRelaySettings(PARSED) ? '' : 'none';
  // An open window follows the event selector.
  if (SETTINGS_WIN && !SETTINGS_WIN.closed) writeSettingsWindow(SETTINGS_WIN);
  const frame = document.getElementById('settingsFrame');
  if (frame && document.getElementById('settingsOverlay')?.style.display !== 'none') frame.srcdoc = buildSettingsWindowHTML(PARSED);
}

function openRelaySettings() {
  if (!hasRelaySettings(PARSED)) return;
  if (SETTINGS_WIN && !SETTINGS_WIN.closed) { writeSettingsWindow(SETTINGS_WIN); SETTINGS_WIN.focus(); return; }
  const w = Math.min(1200, screen.availWidth - 40), h = Math.min(820, screen.availHeight - 60);
  SETTINGS_WIN = window.open('', 'cevRelaySettings', `width=${w},height=${h},resizable=yes,scrollbars=yes`);
  if (SETTINGS_WIN) { writeSettingsWindow(SETTINGS_WIN); SETTINGS_WIN.focus(); return; }
  showSettingsOverlay(true);
}

function writeSettingsWindow(w) {
  w.document.open();
  w.document.write(buildSettingsWindowHTML(PARSED));
  w.document.close();
}

// Fallback when the browser blocks the popup: the same page in an iframe overlay.
function showSettingsOverlay(show) {
  let ov = document.getElementById('settingsOverlay');
  if (!ov && show) {
    ov = document.createElement('div');
    ov.id = 'settingsOverlay';
    ov.className = 'help-overlay';
    ov.onclick = (e) => { if (e.target === ov) showSettingsOverlay(false); };
    ov.innerHTML = `<div class="help-modal" style="width:min(97vw,1300px);max-width:none;height:90vh;max-height:none;">
      <div class="help-modal-header"><span>Relay Settings</span>
        <span style="font-size:11px;color:var(--text-muted);font-weight:400;">Allow pop-ups for this page to open it in its own window.</span>
        <button class="btn" onclick="showSettingsOverlay(false)">Close</button></div>
      <iframe id="settingsFrame" style="flex:1 1 auto;border:0;width:100%;background:#fff;border-radius:0 0 10px 10px;"></iframe>
    </div>`;
    document.body.appendChild(ov);
  }
  if (!ov) return;
  if (show) document.getElementById('settingsFrame').srcdoc = buildSettingsWindowHTML(PARSED);
  ov.style.display = show ? 'flex' : 'none';
}

function buildSettingsWindowHTML(P) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const text = extractCevSettingsText(P);
  const data = {
    classes: parseCevSettingsClasses(text),
    text,
    device: String(P.device || '').replace(/^FID=/i, ''),
    rid: P.settings?.RID?.trim() || '',
    tid: P.settings?.TID?.trim() || '',
    event: P.eventInfo?.refNum ?? '',
    file: P.fileName || '',
    when: typeof formatTimestamp === 'function' ? formatTimestamp(P.timestamp) : '',
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const title = ['Settings', data.rid || data.device, data.tid].filter(Boolean).join(' — ');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { font: 12px 'Segoe UI', system-ui, sans-serif; color: #1b1b1b; background: #f3f3f3; display: flex; flex-direction: column; }
  .bar { display: flex; align-items: center; gap: 10px; padding: 6px 10px; background: #fff; border-bottom: 1px solid #c8c8c8; flex-wrap: wrap; }
  .bar .ttl { font-weight: 600; font-size: 13px; }
  .bar .meta { color: #555; }
  .bar .grow { flex: 1; }
  .bar input { width: 240px; padding: 4px 6px; border: 1px solid #a8a8a8; border-radius: 2px; font: inherit; }
  .seg button, .bar > button { font: inherit; padding: 3px 10px; border: 1px solid #a8a8a8; background: #fdfdfd; cursor: pointer; }
  .seg button + button { border-left: 0; }
  .seg button.on { background: #cce4f7; border-color: #2a7ab9; }
  .main { flex: 1; display: flex; min-height: 0; }
  .tree { width: 290px; flex: 0 0 auto; overflow: auto; background: #fff; border-right: 1px solid #c8c8c8; padding: 4px 0; }
  .tree .cls { padding: 3px 8px; cursor: pointer; font-weight: 600; white-space: nowrap; user-select: none; }
  .tree .cls .tw { display: inline-block; width: 12px; color: #666; }
  .tree .sec { padding: 2px 8px 2px 30px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #333; }
  .tree .cls:hover, .tree .sec:hover { background: #e5f1fb; }
  .tree .sel { background: #cce8ff !important; }
  .tree .collapsed + .secs { display: none; }
  .pane { flex: 1; overflow: auto; background: #fff; }
  table { border-collapse: collapse; width: 100%; }
  th { position: sticky; top: 0; z-index: 2; background: #f0f0f0; border-bottom: 1px solid #c8c8c8; border-right: 1px solid #ddd; text-align: left; font-weight: 600; padding: 4px 8px; }
  td { border-bottom: 1px solid #e6e6e6; border-right: 1px solid #eee; padding: 3px 8px; vertical-align: top; }
  td.n { font-family: Consolas, 'Courier New', monospace; width: 110px; white-space: nowrap; color: #00428a; }
  td.v { font-family: Consolas, 'Courier New', monospace; white-space: pre-wrap; word-break: break-word; }
  td.c { color: #2f6b2f; width: 32%; }
  tr.h td { background: #e8eef5; font-weight: 600; color: #1d3a5c; border-top: 1px solid #c3d0de; }
  tr.ch td { background: #d7e1ec; font-weight: 700; color: #102a46; }
  tr.flash td { animation: fl 1.6s ease-out; }
  @keyframes fl { 0% { background: #ffe58a; } 100% { background: transparent; } }
  a.ref { color: inherit; text-decoration: underline dotted #6a8fb8; cursor: pointer; }
  a.ref:hover { color: #0b63c5; }
  mark { background: #fff07a; padding: 0; }
  pre { margin: 0; padding: 10px 14px; font: 12px/1.45 Consolas, 'Courier New', monospace; white-space: pre; }
  .empty { padding: 24px; color: #666; }
  .foot { padding: 3px 10px; border-top: 1px solid #c8c8c8; background: #f0f0f0; color: #555; font-size: 11px; }
</style></head><body>
<div class="bar">
  <span class="ttl">Relay Settings</span>
  <span class="meta" id="meta"></span>
  <span class="grow"></span>
  <input id="q" type="search" placeholder="Find setting, value or comment" autocomplete="off">
  <span class="seg"><button id="vTable" class="on">Settings</button><button id="vText">Text</button></span>
  <button id="copy" title="Copy the settings text as the relay wrote it">Copy text</button>
</div>
<div class="main">
  <div class="tree" id="tree"></div>
  <div class="pane" id="pane"></div>
</div>
<div class="foot" id="foot"></div>
<script>
const D = ${json};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let view = 'table', curClass = 0, query = '';

// Every setting name, so equation terms can link to the setting that defines them.
const where = new Map();
D.classes.forEach((c, ci) => c.sections.forEach((s, si) => s.settings.forEach((st, ti) => {
  if (!where.has(st.name)) where.set(st.name, [ci, si, ti]);
})));
// SV09T → SV09, LT01 → SET01: the bit names an equation uses for a timer output or a latch.
function target(tok) {
  if (where.has(tok)) return tok;
  let m = tok.match(/^(SV\\d+)T$/); if (m && where.has(m[1])) return m[1];
  m = tok.match(/^LT(\\d+)$/); if (m && where.has('SET' + m[1])) return 'SET' + m[1];
  return null;
}
const isEquation = (v) => /\\b(AND|OR|NOT|R_TRIG|F_TRIG)\\b|[()]/.test(v);
function hl(s) {
  const e = esc(s);
  if (!query) return e;
  const re = new RegExp(query.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'), 'gi');
  return e.replace(re, m => '<mark>' + m + '</mark>');
}
function valueHTML(st) {
  if (query || !isEquation(st.value)) return hl(st.value);
  return st.value.split(/([A-Za-z0-9_]+)/).map((part, i) => {
    if (i % 2 === 0) return esc(part);
    const t = target(part);
    return t && t !== st.name ? '<a class="ref" data-go="' + t + '" title="Go to ' + t + '">' + esc(part) + '</a>' : esc(part);
  }).join('');
}
const row = (st) => '<tr data-name="' + esc(st.name) + '"><td class="n">' + hl(st.name) + '</td><td class="v">' + valueHTML(st) +
  '</td><td class="c">' + hl(st.comment) + '</td></tr>';
const head = '<table><thead><tr><th>Setting</th><th>Value</th><th>Comment</th></tr></thead><tbody>';

function renderTree() {
  $('tree').innerHTML = D.classes.map((c, ci) =>
    '<div class="cls' + (ci === curClass && !query ? ' sel' : '') + (ci === curClass || query ? '' : ' collapsed') + '" data-c="' + ci + '"><span class="tw">' +
    (ci === curClass || query ? '▾' : '▸') + '</span>' + esc(c.name) + '</div><div class="secs">' +
    c.sections.map((s, si) => '<div class="sec" data-c="' + ci + '" data-s="' + si + '" title="' + esc(s.name) + '">' + esc(s.name) + '</div>').join('') +
    '</div>').join('');
}

function renderPane() {
  const pane = $('pane');
  if (view === 'text') { pane.innerHTML = '<pre>' + hl(D.text) + '</pre>'; return; }
  if (query) {
    const q = query.toLowerCase();
    let html = head, n = 0;
    D.classes.forEach((c) => {
      let classHtml = '';
      c.sections.forEach((s) => {
        const hits = s.settings.filter(st => (st.name + '\\u0000' + st.value + '\\u0000' + st.comment).toLowerCase().includes(q));
        if (!hits.length) return;
        n += hits.length;
        classHtml += '<tr class="h"><td colspan="3">' + esc(s.name) + '</td></tr>' + hits.map(row).join('');
      });
      if (classHtml) html += '<tr class="ch"><td colspan="3">' + esc(c.name) + '</td></tr>' + classHtml;
    });
    pane.innerHTML = n ? html + '</tbody></table>' : '<div class="empty">No setting matches “' + esc(query) + '”.</div>';
    $('foot').textContent = n + ' matching setting' + (n === 1 ? '' : 's');
    return;
  }
  const c = D.classes[curClass];
  if (!c) { pane.innerHTML = '<div class="empty">No settings found in this record.</div>'; return; }
  pane.innerHTML = head + c.sections.map((s, si) =>
    '<tr class="h" id="s' + si + '"><td colspan="3">' + esc(s.name) + '</td></tr>' + s.settings.map(row).join('')).join('') + '</tbody></table>';
  const total = c.sections.reduce((a, s) => a + s.settings.length, 0);
  $('foot').textContent = c.name + ' — ' + c.sections.length + ' headings, ' + total + ' settings';
}

function render() { renderTree(); renderPane(); }

function goTo(name) {
  const w = where.get(name);
  if (!w) return;
  query = ''; $('q').value = ''; view = 'table'; setViewButtons();
  curClass = w[0]; render();
  const tr = $('pane').querySelector('tr[data-name="' + CSS.escape(name) + '"]');
  if (tr) { tr.scrollIntoView({ block: 'center' }); tr.classList.remove('flash'); void tr.offsetWidth; tr.classList.add('flash'); }
}
function setViewButtons() { $('vTable').classList.toggle('on', view === 'table'); $('vText').classList.toggle('on', view === 'text'); }

$('tree').addEventListener('click', (e) => {
  const sec = e.target.closest('.sec'), cls = e.target.closest('.cls');
  if (sec) {
    query = ''; $('q').value = ''; view = 'table'; setViewButtons();
    curClass = +sec.dataset.c; render();
    $('tree').querySelector('.sec[data-c="' + sec.dataset.c + '"][data-s="' + sec.dataset.s + '"]').classList.add('sel');
    $('s' + sec.dataset.s)?.scrollIntoView({ block: 'start' });
  } else if (cls) {
    query = ''; $('q').value = '';
    curClass = +cls.dataset.c; render(); $('pane').scrollTop = 0;
  }
});
$('pane').addEventListener('click', (e) => { const a = e.target.closest('a.ref'); if (a) goTo(a.dataset.go); });
$('q').addEventListener('input', () => { query = $('q').value.trim(); render(); });
$('q').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('q').value = ''; query = ''; render(); } });
$('vTable').onclick = () => { view = 'table'; setViewButtons(); renderPane(); };
$('vText').onclick = () => { view = 'text'; setViewButtons(); renderPane(); };
$('copy').onclick = () => {
  const done = () => { $('copy').textContent = 'Copied'; setTimeout(() => $('copy').textContent = 'Copy text', 1200); };
  if (navigator.clipboard) navigator.clipboard.writeText(D.text).then(done, () => {});
};
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); $('q').focus(); $('q').select(); } });

$('meta').textContent = [D.device, D.rid, D.tid, D.event !== '' ? 'Event #' + D.event : '', D.when].filter(Boolean).join('  ·  ');
render();
<\/script></body></html>`;
}
