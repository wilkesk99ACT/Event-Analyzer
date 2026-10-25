// ══════════════════════════════════════════════════════════════════════
// SITE NOTES LINK — past trips at this site, and new trips sent back
// ══════════════════════════════════════════════════════════════════════
// Site Notes (site-notes.html + sites.json, in the "Site Notes" folder on SharePoint that every
// operator syncs through OneDrive) keeps a trip history for each site. This reads that history
// for the site the loaded event came from, and sends an event that is not in it yet back to
// Site Notes.
//
// Access: the operator picks the Site Notes folder once. The browser keeps the folder handle in
// this page's IndexedDB. On later visits Edge and Chrome either allow it straight away (when
// "Allow on every visit" was chosen) or ask with one "Allow" click; no file window again.
//
// Sending: this page never writes sites.json. Site Notes keeps the whole file open and saves it
// on a timer, so a second writer would lose one side's changes. A new trip goes into the
// Imports folder as a standard CEV inbox file (the format the Fiix CEV fetcher writes), with
// the event file itself in it. Site Notes picks analyzer inbox files up on its own while it is
// open, reads the event with its own copy of this analyzer, records the trip, saves, and
// deletes the inbox file. Its usual rules apply there too: duplicates, 18 months, 30 trips.
//
// What is sent, without asking: a trip event at a site that was matched with confidence, that
// is not in the site's history yet, and that is new enough for Site Notes to keep. An event
// already in the history but recorded before Site Notes kept measured values is sent again so
// those values get filled in.

const SN_DB_NAME = 'event-analyzer-site-notes';
const SN_INBOX_TYPE = 'site-notes-cev-inbox';
const SN_KEEP_MONTHS = 18;   // keep in step with TRIP_KEEP_MONTHS in Site Notes
const SN_KEEP_MAX = 30;      // keep in step with TRIP_KEEP_MAX in Site Notes
const SN_FIIX_WO_URL = 'https://actps.macmms.com/?wo=';

const SN = {
  supported: typeof window.showDirectoryPicker === 'function',
  dir: null,          // FileSystemDirectoryHandle of the Site Notes folder
  perm: null,         // 'granted' | 'prompt' | 'denied'
  doc: null,          // sites.json as last read
  docStamp: null,     // its lastModified, to read it again only when it changed
  sent: {},           // trip key -> { t, site, file }: what this browser has sent
  picks: {},          // relay key -> site id: sites chosen by hand
  results: [],        // per ALL_EVENTS index: { match, decision }
  busy: false,
  error: null,
  ready: null,        // promise: IndexedDB read on page load
};

// ── IndexedDB ──
function snIdb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(SN_DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function snGet(k) {
  try {
    const db = await snIdb();
    return await new Promise(res => {
      const r = db.transaction('kv').objectStore('kv').get(k);
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(undefined);
    });
  } catch (e) { return undefined; }
}
async function snSet(k, v) {
  try {
    const db = await snIdb();
    db.transaction('kv', 'readwrite').objectStore('kv').put(v, k);
  } catch (e) { /* private window, storage off */ }
}

SN.ready = (async () => {
  if (!SN.supported) return;
  SN.dir = (await snGet('dir')) || null;
  SN.sent = (await snGet('sent')) || {};
  SN.picks = (await snGet('picks')) || {};
  if (SN.dir) {
    try { SN.perm = await SN.dir.queryPermission({ mode: 'readwrite' }); }
    catch (e) { SN.perm = 'prompt'; }
  }
})();

// ── Small helpers, written to match Site Notes' own so keys line up ──
const snNorm = v => String(v || '').trim().toUpperCase();
function snEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function snTsText(t) {
  if (!t || !t.year) return '';
  const p = n => String(n).padStart(2, '0');
  return `${t.year}-${p(t.month)}-${p(t.day)} ${p(t.hour)}:${p(t.min)}:${p(t.sec)}.${String(t.msec || 0).padStart(3, '0')}`;
}
function snTsMs(t) {
  if (!t || !t.year) return null;
  const d = new Date(t.year, (t.month || 1) - 1, t.day || 1, t.hour || 0, t.min || 0, t.sec || 0, t.msec || 0);
  return isNaN(d) ? null : d.getTime();
}
function snCutoffMs() {
  const d = new Date();
  d.setMonth(d.getMonth() - SN_KEEP_MONTHS);
  return d.getTime();
}

// The relay identity Site Notes records for an event. An SEL-851 has no TID or RID; Site Notes
// translates Dev.Loc and Dev.Id to them, so the same is done here.
function snEventIds(P) {
  const S = P.settings || {};
  const is851 = P.format === 'sel851';
  const tid = String((is851 ? S['Dev.Loc'] : S.TID) || '').trim();
  const rid = String((is851 ? (S['Dev.Id'] || 'SEL-851') : S.RID) || '').trim();
  return { tid, rid, serial: String(P.serialNumber || '').trim(), at: snTsText(P.timestamp), atMs: snTsMs(P.timestamp) };
}
const snRelayKey = ids => `${snNorm(ids.serial)}|${snNorm(ids.tid)}|${snNorm(ids.rid)}`;
const snTripKey = ids => `${snNorm(ids.tid)}|${ids.at}`;
const snSameTrip = (t, ids) => t.at === ids.at && (!t.tid || !ids.tid || snNorm(t.tid) === snNorm(ids.tid));

// ── Access ──
async function snConnect() {
  try {
    let dir = await window.showDirectoryPicker({ id: 'site-notes', mode: 'readwrite' });
    // Accept the Site Notes folder itself, or the folder above it (ARCC - DG_Tools).
    if (!(await snHasFile(dir, 'sites.json'))) {
      let sub = null;
      try { sub = await dir.getDirectoryHandle('Site Notes'); } catch (e) { /* not there */ }
      if (sub && await snHasFile(sub, 'sites.json')) dir = sub;
      else {
        SN.error = `"${dir.name}" has no sites.json in it. Pick the "Site Notes" folder (the one with site-notes.html and sites.json).`;
        renderSiteNotesBar();
        return;
      }
    }
    SN.dir = dir; SN.perm = 'granted'; SN.error = null; SN.doc = null; SN.docStamp = null;
    await snSet('dir', dir);
    await snProcessAll();
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    SN.error = 'Could not open that folder: ' + (e && e.message);
    renderSiteNotesBar();
  }
}
async function snHasFile(dir, name) {
  try { await dir.getFileHandle(name); return true; } catch (e) { return false; }
}

async function snReconnect() {
  if (!SN.dir) return snConnect();
  try { SN.perm = await SN.dir.requestPermission({ mode: 'readwrite' }); }
  catch (e) { SN.perm = 'prompt'; }
  if (SN.perm === 'granted') { SN.error = null; await snProcessAll(); }
  else renderSiteNotesBar();
}

async function snForget() {
  SN.dir = null; SN.perm = null; SN.doc = null; SN.docStamp = null; SN.results = [];
  await snSet('dir', null);
  renderSiteNotesBar();
}

// ── sites.json ──
async function snLoadDoc() {
  const fh = await SN.dir.getFileHandle('sites.json');
  const f = await fh.getFile();
  if (SN.doc && SN.docStamp === f.lastModified) return SN.doc;
  const doc = JSON.parse(await f.text());
  if (!doc || !Array.isArray(doc.sites)) throw new Error('sites.json has no "sites" list.');
  SN.doc = doc;
  SN.docStamp = f.lastModified;
  return doc;
}

// ── Which site an event is from ──
//   trip      the event is already in a site's trip history
//   picked    the operator chose the site for this relay before
//   serial    one site's saved relay has this serial number
//   tid+rid   one site's saved relay has this TID and RID
//   tid       one site's saved relay has this TID (RID differs): asked before sending
function snMatchSite(doc, ids) {
  const sites = doc.sites;
  for (const s of sites) {
    const t = (s.trips || []).find(x => snSameTrip(x, ids));
    if (t && ids.at) return { site: s, how: 'trip', trip: t };
  }
  const pick = SN.picks[snRelayKey(ids)];
  if (pick) {
    const s = sites.find(x => x.id === pick);
    if (s) return { site: s, how: 'picked' };
  }
  const withRelay = sites.filter(s => s.relay);
  if (ids.serial) {
    const c = withRelay.filter(s => snNorm(s.relay.serial) === snNorm(ids.serial));
    if (c.length === 1) return { site: c[0], how: 'serial' };
  }
  let candidates = [];
  if (ids.tid) {
    const both = withRelay.filter(s => snNorm(s.relay.tid) === snNorm(ids.tid) && snNorm(s.relay.rid) === snNorm(ids.rid));
    if (both.length === 1) return { site: both[0], how: 'tid+rid' };
    const tidOnly = withRelay.filter(s => snNorm(s.relay.tid) === snNorm(ids.tid));
    if (!both.length && tidOnly.length === 1) return { site: tidOnly[0], how: 'tid', confirm: true };
    candidates = both.length ? both : tidOnly;
  }
  return { site: null, candidates };
}

function snIsTrip(P, A) {
  const c = A && A.tripCause;
  if (c) return !c.isEventReport;
  const want = new Set(['TRIP', 'TRIP3P', 'TR', 'TRIPA', 'TRIPB', 'TRIPC']);
  return (P.digitalTransitions || []).some(t => (t.changes || []).some(ch => ch.asserted && want.has(ch.label)));
}

// What to do with one loaded event. Pure: reads SN and the match, writes nothing.
function snDecide(evt, m) {
  const P = evt.parsed, A = evt.analysis;
  if (P.format === 'form6') return { state: 'unsupported' };
  if (!m.site) return { state: m.candidates && m.candidates.length ? 'ambiguous' : 'nomatch' };
  if (m.confirm) return { state: 'confirm' };
  const ids = snEventIds(P);
  const key = snTripKey(ids);
  const existing = (m.site.trips || []).find(t => snSameTrip(t, ids));
  const sent = SN.sent[key];
  if (existing) {
    // Recorded before Site Notes kept measured values: send once more to fill them in.
    const canMeasure = (P.analogData || []).length > 0;
    if (!existing.meas && canMeasure && !(sent && sent.refresh)) return { state: 'send', refresh: true, trip: existing };
    return { state: 'catalogued', trip: existing, measPending: !existing.meas && !!(sent && sent.refresh) };
  }
  if (sent && sent.site === m.site.id) return { state: 'sent', sent };
  if (P.format !== 'sel851' && !snIsTrip(P, A)) return { state: 'notTrip' };
  if (ids.atMs != null && ids.atMs < snCutoffMs()) return { state: 'old' };
  const kept = (m.site.trips || []).filter(t => t.atMs != null);
  if (kept.length >= SN_KEEP_MAX && ids.atMs != null && ids.atMs < Math.min(...kept.map(t => t.atMs))) return { state: 'full' };
  return { state: 'send' };
}

// ── The run: match every loaded event, send what is new ──
async function snProcessAll() {
  if (!SN.dir || SN.perm !== 'granted' || !ALL_EVENTS.length || SN.busy) { renderSiteNotesBar(); return; }
  SN.busy = true; SN.error = null;
  renderSiteNotesBar();
  try {
    const doc = await snLoadDoc();
    SN.results = ALL_EVENTS.map(evt => {
      const ids = snEventIds(evt.parsed);
      const match = snMatchSite(doc, ids);
      return { ids, match, decision: snDecide(evt, match) };
    });
    await snSendPending();
  } catch (e) {
    console.error('Site Notes link', e);
    SN.error = 'Could not read Site Notes: ' + (e && e.message);
  } finally {
    SN.busy = false;
    renderSiteNotesBar();
  }
}

async function snSendPending() {
  const items = [];
  const doneSources = new Set();
  const sentNow = [];
  for (let i = 0; i < ALL_EVENTS.length; i++) {
    const r = SN.results[i];
    if (!r || r.decision.state !== 'send') continue;
    const evt = ALL_EVENTS[i];
    const src = evt.source;
    // One .evzip can hold several events; send the file once.
    if (src && src.group) {
      if (doneSources.has(src.group)) { sentNow.push(i); continue; }
      doneSources.add(src.group);
    }
    const it = await snInboxItem(evt, r.match.site);
    if (!it) { r.decision = { state: 'nosource' }; continue; }
    items.push(it);
    sentNow.push(i);
  }
  if (!items.length) return;
  const name = await snWriteInbox(items);
  const t = new Date().toISOString();
  for (const i of sentNow) {
    const r = SN.results[i];
    SN.sent[snTripKey(r.ids)] = { t, site: r.match.site.id, file: name, refresh: !!r.decision.refresh };
    r.decision = { state: 'sent', sent: SN.sent[snTripKey(r.ids)], justNow: true, refresh: r.decision.refresh };
  }
  // Keep the log small: anything older than Site Notes keeps can go.
  const cut = Date.now() - (SN_KEEP_MONTHS + 1) * 31 * 864e5;
  for (const [k, v] of Object.entries(SN.sent)) if (Date.parse(v.t) < cut) delete SN.sent[k];
  await snSet('sent', SN.sent);
}

// One inbox item in the fetcher's format: the event file itself, read again by Site Notes.
async function snInboxItem(evt, site) {
  const P = evt.parsed;
  const base = { siteId: site.id, siteName: site.name, from: 'Analyzer', added: new Date().toISOString() };
  const src = evt.source;
  if (P.format === 'sel851') {
    let bytes = null, name = evt.fileName;
    if (src && src.kind === 'evzip') { bytes = src.bytes; name = src.name; }
    else if (src && src.kind === 'files') {
      const files = await Promise.all(src.files.map(async f => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
      bytes = snStoredZip(files);
      name = src.name.replace(/\.cfg$/i, '') + '.evzip';
    }
    if (!bytes) return null;
    return Object.assign(base, { kind: 'evzip', fileName: name, gz: await snGzipB64(bytes) });
  }
  const text = (src && src.text) || P.raw;
  if (!text) return null;
  return Object.assign(base, { fileName: evt.fileName, text });
}

async function snWriteInbox(items) {
  const imports = await SN.dir.getDirectoryHandle('Imports', { create: true });
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const name = `cev-inbox-analyzer-${stamp}-${Math.random().toString(36).slice(2, 6)}.json`;
  const doc = { type: SN_INBOX_TYPE, source: 'Event Analyzer', created: d.toISOString(), items };
  const fh = await imports.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(doc));
  await w.close();
  return name;
}

async function snGzipB64(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

// A ZIP with no compression, for an SEL-851 event that was loaded as loose .cfg/.dat/.hdr files.
// Site Notes reads SEL-851 events only as .evzip, so the three files are packed into one.
let SN_CRC_TABLE = null;
function snCrc32(b) {
  if (!SN_CRC_TABLE) {
    SN_CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      SN_CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = SN_CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function snStoredZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = f.bytes, crc = snCrc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const a of all) { out.set(a, o); o += a.length; }
  return out;
}

// ── Choosing the site by hand ──
async function snUsePickedSite(siteId) {
  const r = SN.results[CURRENT_IDX];
  if (!r || !siteId) return;
  // Every loaded event from the same relay goes to the same site.
  SN.picks[snRelayKey(r.ids)] = siteId;
  await snSet('picks', SN.picks);
  await snProcessAll();
}
function snPickFromInput() {
  const inp = document.getElementById('snSiteInput');
  if (!inp || !SN.doc) return;
  const name = inp.value.trim();
  const s = SN.doc.sites.find(x => x.name === name) || SN.doc.sites.find(x => x.name.toLowerCase() === name.toLowerCase());
  if (!s) { inp.setCustomValidity('Pick a site from the list.'); inp.reportValidity(); return; }
  snUsePickedSite(s.id);
}
async function snResend() {
  const r = SN.results[CURRENT_IDX];
  if (!r) return;
  delete SN.sent[snTripKey(r.ids)];
  await snSet('sent', SN.sent);
  await snProcessAll();
}

// ── The bar under the banner ──
function snTripsFor(site) {
  const cut = snCutoffMs();
  return (site.trips || []).filter(t => t.atMs == null || t.atMs >= cut).sort((a, b) => (b.atMs || 0) - (a.atMs || 0));
}
function snCauseGroup(t) {
  const txt = String((t.cause && t.cause.text) || 'Unknown').replace(/\s*\((?:via |Phase |Three-Phase|[A-C]{1,3}\b)[^)]*\)\s*$/, '').trim();
  return txt || 'Unknown';
}

function renderSiteNotesBar() {
  const bar = document.getElementById('siteNotesBar');
  if (!bar) return;
  const btn = (label, fn, cls = '') => `<button class="btn btn-small ${cls}" onclick="${fn}">${label}</button>`;
  let html = '';
  if (!SN.supported) {
    html = `<span class="sn-muted">📒 Site Notes trip history needs Edge or Chrome.</span>`;
  } else if (!SN.dir) {
    html = `<span>📒 <b>Site Notes</b>: see this site's past trips, and record new trips automatically.</span>
      ${btn('Connect the Site Notes folder', 'snConnect()', 'btn-accent')}
      <span class="sn-muted">One time: pick the "Site Notes" folder in your OneDrive.</span>`;
  } else if (SN.perm !== 'granted') {
    html = `<span>📒 <b>Site Notes</b> is connected. The browser needs you to allow it again.</span>
      ${btn('Allow Site Notes', 'snReconnect()', 'btn-accent')}
      <span class="sn-muted">Choose "Allow on every visit" to skip this next time.</span>`;
  } else if (SN.busy) {
    html = `<span>📒 Reading Site Notes…</span>`;
  } else if (SN.error) {
    html = `<span class="sn-error">📒 ${snEsc(SN.error)}</span>${btn('Try again', 'snProcessAll()')}${btn('Pick the folder again', 'snConnect()')}`;
  } else {
    html = snBarForEvent();
  }
  if (SN.error && SN.supported && !SN.dir) html += `<div class="sn-error">${snEsc(SN.error)}</div>`;
  bar.innerHTML = html;
  bar.style.display = 'flex';
  // the trend beside the measured value reads the same match
  if (typeof renderMeasTrend === 'function') renderMeasTrend();
}

function snBarForEvent() {
  const r = SN.results[CURRENT_IDX];
  if (!r) return `<span>📒 Site Notes is connected.</span>`;
  const d = r.decision, m = r.match;
  const parts = [];
  if (m.site) {
    const list = snTripsFor(m.site);
    const last = list[0];
    parts.push(`<span>📒 <b>${snEsc(m.site.name)}</b>${m.how === 'picked' ? ' <span class="sn-muted">(chosen by hand)</span>' : ''}</span>`);
    parts.push(`<span class="sn-muted">${list.length ? `${list.length} trip${list.length === 1 ? '' : 's'} in ${SN_KEEP_MONTHS} months · last ${snEsc(String(last.at || '').slice(0, 10))}: ${snEsc(snCauseGroup(last))}` : `No trips recorded in ${SN_KEEP_MONTHS} months`}</span>`);
    if (list.length) parts.push(`<button class="btn btn-small btn-accent" onclick="openSiteTrips()">Past trips (${list.length})</button>`);
  }
  const status = {
    catalogued: d.measPending
      ? '✓ This event is in the site\'s trip history. Its measured values were sent and are added the next time Site Notes is open.'
      : '✓ This event is in the site\'s trip history.',
    sent: d.justNow
      ? (d.refresh ? '↻ Sent to Site Notes again, to add its measured values.' : '➜ New trip: sent to Site Notes. It is recorded the next time Site Notes is open.')
      : `➜ Sent to Site Notes ${snEsc(String((d.sent && d.sent.t) || '').slice(0, 10))}; not recorded yet. It is recorded the next time Site Notes is open.`,
    notTrip: 'Not a trip (event report only). Nothing to record.',
    old: `Not sent: older than the ${SN_KEEP_MONTHS} months Site Notes keeps.`,
    full: `Not sent: older than the ${SN_KEEP_MAX} newest trips Site Notes keeps for this site.`,
    unsupported: 'Eaton Form 6 events are not recorded in Site Notes.',
    nosource: 'Not sent: the event file is not available to send. Load the .CEV or .evzip again.',
  }[d.state];
  if (status) parts.push(`<span class="sn-status sn-${d.state}">${status}</span>`);
  if (d.state === 'sent' && !d.justNow) parts.push(`<button class="btn btn-small" onclick="snResend()" title="Write the inbox file again, for example when it was deleted before Site Notes read it">Send again</button>`);

  if (d.state === 'confirm') {
    parts.push(`<span class="sn-status">Matched by TID ${snEsc(r.ids.tid)} only (the RID is different). Is this event from ${snEsc(m.site.name)}?</span>`);
    parts.push(`<button class="btn btn-small btn-accent" onclick="snUsePickedSite('${snEsc(m.site.id)}')">Yes, record it there</button>`);
  }
  if (d.state === 'ambiguous' || d.state === 'nomatch' || d.state === 'confirm') {
    const cands = (m.candidates || []).map(s => s.name);
    const relay = [r.ids.tid && `TID ${r.ids.tid}`, r.ids.rid && `RID ${r.ids.rid}`].filter(Boolean).join(', ');
    if (d.state !== 'confirm') {
      parts.push(`<span>📒 ${d.state === 'ambiguous'
        ? `${cands.length} sites have this relay (${snEsc(relay)}). Which one is it?`
        : `No site in Site Notes has this relay${relay ? ` (${snEsc(relay)})` : ''}. Which site is it?`}</span>`);
    }
    const opts = [...cands, ...SN.doc.sites.map(s => s.name).filter(n => !cands.includes(n)).sort()];
    parts.push(`<input id="snSiteInput" class="sn-input" list="snSiteList" placeholder="Type a site name…"
        onkeydown="if(event.key==='Enter') snPickFromInput()" oninput="this.setCustomValidity('')">
      <datalist id="snSiteList">${opts.map(n => `<option value="${snEsc(n)}">`).join('')}</datalist>
      <button class="btn btn-small" onclick="snPickFromInput()">Use this site</button>`);
  } else if (m.site && m.how !== 'trip') {
    parts.push(`<button class="btn btn-small btn-link" onclick="snChangeSite()" title="Use when the event was matched to the wrong site">Wrong site?</button>`);
  }
  return parts.join('');
}

function snChangeSite() {
  const r = SN.results[CURRENT_IDX];
  if (!r) return;
  r.decision = { state: 'nomatch' };
  r.match = { site: null, candidates: [] };
  const bar = document.getElementById('siteNotesBar');
  bar.innerHTML = snBarForEvent();
  const inp = document.getElementById('snSiteInput');
  if (inp) inp.focus();
}

// ── Past trips ──
function snEnsureModal() {
  let el = document.getElementById('siteTripsModal');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'siteTripsModal';
  el.className = 'help-overlay';
  el.style.display = 'none';
  el.onclick = e => { if (e.target === el) closeSiteTrips(); };
  el.innerHTML = `<div class="help-modal" style="width:min(97vw,1300px);max-width:none;">
    <div class="help-modal-header"><span id="siteTripsTitle">Past trips</span><button class="btn" onclick="closeSiteTrips()">Close</button></div>
    <div class="help-modal-body" id="siteTripsBody"></div></div>`;
  document.body.appendChild(el);
  return el;
}
function closeSiteTrips() {
  const el = document.getElementById('siteTripsModal');
  if (el) el.style.display = 'none';
}

// A stand-in for the event Site Notes saved for the site, so bit tooltips and the logic tree
// can read the relay's own settings. Same idea as tripStubParsed in Site Notes.
function snStubParsed(site, t) {
  const r = site.relay;
  const stub = { format: t && t.format, device: t && t.device, settings: {}, digitalLabels: [], digitalTransitions: [],
    initialDigitalState: [], analogData: [], analogChannels: [], analogColIndex: {}, svSettings: [],
    eventInfo: { freq: 60 }, raw: '' };
  if (r && (!t || !t.tid || !r.tid || snNorm(t.tid) === snNorm(r.tid))) {
    Object.assign(stub, r, { analogData: [], raw: r.settingsText || '', eventInfo: Object.assign({ freq: 60 }, r.eventInfo || {}) });
  }
  return stub;
}

function snTreeHTML(site, t) {
  if (!t.tree || typeof buildLogicTreeSection !== 'function') return '';
  const P = snStubParsed(site, t);
  const savedP = PARSED, savedA = ANALYSIS, savedIdx = LLG_VIEW_SAMPLE_IDX;
  PARSED = null; ANALYSIS = null; LLG_VIEW_SAMPLE_IDX = null;   // no timer playback here
  try {
    return buildLogicTreeSection(P, { tripCause: { logicTree: t.tree, finalLabel: t.final || 'TRIP', logicTreeOtherBranchCount: t.treeOther || 0 } });
  } catch (e) {
    console.warn(e);
    return `<div class="sn-error">The logic tree could not be drawn: ${snEsc(e.message)}</div>`;
  } finally {
    PARSED = savedP; ANALYSIS = savedA; LLG_VIEW_SAMPLE_IDX = savedIdx;
  }
}

function openSiteTrips() {
  const r = SN.results[CURRENT_IDX];
  if (!r || !r.match.site) return;
  const site = r.match.site;
  const list = snTripsFor(site);
  const modal = snEnsureModal();
  document.getElementById('siteTripsTitle').textContent = `${site.name} — trips in the last ${SN_KEEP_MONTHS} months`;

  let html = `<p class="sn-muted" style="margin-top:0">From Site Notes, newest first. Times are as the relay stamped them.
    The event open now is marked. Measured values are kept for trips recorded on or after 2026-10-25.</p>`;

  const groups = new Map();
  for (const t of list) { const g = snCauseGroup(t); groups.set(g, (groups.get(g) || 0) + 1); }
  const curCause = ANALYSIS && ANALYSIS.tripCause && ANALYSIS.tripCause.causeText;
  html += `<div class="sn-chips">${[...groups].sort((a, b) => b[1] - a[1]).map(([g, n]) =>
    `<span class="sn-chip${curCause && snCauseGroup({ cause: { text: curCause } }) === g ? ' same' : ''}">${snEsc(g)} × ${n}</span>`).join('')}</div>`;

  // The event open now, measured the same way, for side-by-side reading.
  const curMeas = typeof tripMeasurements === 'function' ? tripMeasurements(PARSED, ANALYSIS) : null;
  if (curMeas && r.decision.state !== 'catalogued') {
    html += `<details class="sn-trip current" open><summary><span class="sn-when">${snEsc(r.ids.at)}</span>
      <span class="sn-what">This event: ${snEsc(curCause || PARSED.eventInfo.eventType || 'Event')}</span></summary>
      <div class="sn-inner">${tripMeasHTML(curMeas, snEsc)}</div></details>`;
  }

  list.forEach((t, i) => {
    const isCur = snSameTrip(t, r.ids);
    const src = t.src || {};
    const steps = [];
    const seen = new Set();
    for (const c of (t.chain || [])) { if (!seen.has(c.label)) { seen.add(c.label); steps.push(c); } }
    const P = snStubParsed(site, t);
    const chain = steps.length ? `<div class="sn-chain">${steps.map(c =>
      `<span class="sn-step" title="${snEsc(c.desc || '')}">${typeof tt === 'function' ? tt(c.label, P) : snEsc(c.label)}${c.delay ? `<small> ${snEsc(c.delay)} cyc</small>` : ''}</span>`).join('<span class="sn-arrow">→</span>')}</div>` : '';
    const rows = [
      ['Cause detail', t.cause && t.cause.detail],
      ['Trip equation', t.cause && t.cause.equation ? t.cause.equation + (t.cause.equationText ? ' := ' + t.cause.equationText : '') : null],
      ['Event', t.ev], ['Targets', t.targets], ['Shot', t.shot],
      ['Relay', [t.tid, t.rid].filter(Boolean).join(' / ')], ['File', t.file],
    ].filter(([, v]) => v != null && v !== '');
    let srcHtml = '';
    if (src.workOrder || src.workOrderId) {
      const label = `WO ${snEsc(src.workOrder || src.workOrderId)}${src.workOrderCreated ? ` (${snEsc(src.workOrderCreated)})` : ''}`;
      srcHtml = src.workOrderId ? `<a href="${SN_FIIX_WO_URL}${encodeURIComponent(src.workOrderId)}" target="_blank" rel="noopener">${label}</a>` : label;
    } else if (src.from === 'Analyzer') srcHtml = `Sent from the Event Analyzer ${snEsc(String(src.added || '').slice(0, 10))}`;
    else if (src.from === 'Relay') srcHtml = 'Pulled from the relay';
    else if (src.from === 'Drop') srcHtml = `Dropped on the site ${snEsc(String(src.added || '').slice(0, 10))}`;
    const meas = t.meas && t.meas.q ? tripMeasHTML(t.meas, snEsc)
      : isCur && curMeas ? `<div class="sn-muted">Measured from the event open now (not in Site Notes yet).</div>${tripMeasHTML(curMeas, snEsc)}`
      : t.meas && t.meas.none ? `<div class="sn-muted">The event file has no analog data that could be measured.</div>`
      : `<div class="sn-muted">No measured values: recorded before Site Notes kept them.</div>`;
    const tree = snTreeHTML(site, t);
    html += `<details class="sn-trip${isCur ? ' current' : ''}"${i === 0 || isCur ? ' open' : ''}>
      <summary><span class="sn-when">${snEsc(t.at || 'date not known')}</span>
        <span class="sn-what">${isCur ? '<b>This event:</b> ' : ''}${snEsc((t.cause && t.cause.text) || 'Trip')}</span>
        <span class="sn-ev">${snEsc([t.ev, t.targets && t.targets !== t.ev ? 'targets ' + t.targets : null].filter(Boolean).join(' · '))}</span></summary>
      <div class="sn-inner">${chain}
        <div class="sn-grid">${rows.map(([k, v]) => `<div><label>${snEsc(k)}</label><div>${snEsc(v)}</div></div>`).join('')}
          ${srcHtml ? `<div><label>Source</label><div>${srcHtml}</div></div>` : ''}</div>
        <h4>Measured values</h4>${meas}
        ${tree ? `<h4>Trip logic path</h4><div class="sn-tree">${tree}</div>` : ''}
      </div></details>`;
  });
  document.getElementById('siteTripsBody').innerHTML = html;
  modal.style.display = 'flex';
}

// ── Hooks called by the rest of the page ──
// After a load: ask for access while the drop or click that loaded the files may still count as
// a user action (it often does not, and then the bar shows an "Allow" button instead).
async function siteNotesOnEventsLoaded() {
  SN.results = [];
  await SN.ready;
  if (SN.dir && SN.perm !== 'granted') {
    try {
      SN.perm = await SN.dir.queryPermission({ mode: 'readwrite' });
      if (SN.perm !== 'granted') SN.perm = await SN.dir.requestPermission({ mode: 'readwrite' });
    } catch (e) { SN.perm = 'prompt'; }
  }
  await snProcessAll();
}
