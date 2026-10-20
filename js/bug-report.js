// ══════════════════════════════════════════════════════════════════════
// REPORT A BUG
// ══════════════════════════════════════════════════════════════════════
// The tool is a static page with no server, so it can't upload anything itself. Instead the
// report is packaged as a .zip (the exact files the user loaded + a plain-text summary of what
// the tool concluded) and downloaded, then a pre-filled email is opened for the user to attach
// it to. Browsers don't allow mailto: links to carry attachments, hence the two steps.

// Where bug-report emails go. Leave blank to let the reporter fill in the To: line.
const BUG_REPORT_EMAIL = '';

function openBugReport() {
  let el = document.getElementById('bugModal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'bugModal';
    el.className = 'help-overlay';
    el.onclick = e => { if (e.target === el) closeBugReport(); };
    document.body.appendChild(el);
  }
  const haveFiles = LOADED_FILES.length > 0;
  el.innerHTML = `<div class="help-modal" style="max-width:560px;">
    <div class="help-modal-header">
      <span>🐞 Report a bug</span>
      <button class="btn" onclick="closeBugReport()">Close</button>
    </div>
    <div class="help-modal-body">
      <label class="bug-label" for="bugWhat">What looks wrong?</label>
      <textarea id="bugWhat" class="bug-input" rows="4" placeholder="e.g. Headline says 51G1T, but the relay targets showed 50P1."></textarea>
      <label class="bug-label" for="bugExpected">What did you expect? <span style="color:var(--text-muted);font-weight:400;">(optional)</span></label>
      <textarea id="bugExpected" class="bug-input" rows="2"></textarea>
      ${haveFiles ? `<label style="display:flex;gap:8px;align-items:center;margin-top:12px;cursor:pointer;">
        <input type="checkbox" id="bugIncludeFiles" checked>
        <span>Include the loaded file${LOADED_FILES.length === 1 ? '' : 's'} (${LOADED_FILES.map(f => bugEsc(f.name)).join(', ')})</span>
      </label>` : ''}
      <p style="margin:14px 0 0;font-size:12px;color:var(--text-muted);">
        Downloads a .zip and opens an email. <b>Attach the .zip to the email</b> before sending.
      </p>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
        <button class="btn" onclick="closeBugReport()">Cancel</button>
        <button class="btn btn-bug" id="bugSubmit" onclick="submitBugReport()">Download &amp; open email</button>
      </div>
    </div>
  </div>`;
  el.style.display = 'flex';
  setTimeout(() => document.getElementById('bugWhat')?.focus(), 0);
}

function closeBugReport() {
  const el = document.getElementById('bugModal');
  if (el) el.style.display = 'none';
}

async function submitBugReport() {
  const what = document.getElementById('bugWhat').value.trim();
  const expected = document.getElementById('bugExpected').value.trim();
  if (!what) { document.getElementById('bugWhat').focus(); return; }
  const includeFiles = !!document.getElementById('bugIncludeFiles')?.checked;
  const btn = document.getElementById('bugSubmit');
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    const now = new Date();
    const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const zipName = `EventAnalyzer-bug-${stamp}.zip`;
    const entries = [{ name: 'report.txt', bytes: new TextEncoder().encode(buildBugReportText(what, expected, now, includeFiles)) }];
    if (includeFiles) {
      for (const f of LOADED_FILES) {
        entries.push({ name: 'files/' + f.name, bytes: new Uint8Array(await readFileAsArrayBuffer(f)) });
      }
    }
    downloadBlob(buildStoredZip(entries), zipName);

    const cur = ALL_EVENTS[CURRENT_IDX];
    const subjectTarget = cur ? (cur.parsed?.device || cur.fileName) : (LOADED_FILES[0]?.name || 'load failure');
    const body = [
      `What looks wrong:\n${what.slice(0, 1200)}`,
      expected ? `Expected:\n${expected.slice(0, 600)}` : '',
      `>>> Please attach ${zipName} (just downloaded) before sending. <<<`,
    ].filter(Boolean).join('\n\n');
    window.location.href = `mailto:${encodeURIComponent(BUG_REPORT_EMAIL)}`
      + `?subject=${encodeURIComponent('Event Analyzer bug: ' + String(subjectTarget).slice(0, 80))}`
      + `&body=${encodeURIComponent(body)}`;
    closeBugReport();
  } catch (err) {
    console.error('Bug report failed:', err);
    alert('Could not build the bug report: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Download & open email';
  }
}

function buildBugReportText(what, expected, now, includeFiles) {
  const strip = s => String(s ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const L = [];
  L.push('EVENT ANALYZER — BUG REPORT', '');
  L.push('What looks wrong:', what, '');
  if (expected) L.push('Expected:', expected, '');
  L.push(`Reported:  ${now.toString()}`);
  L.push(`Page:      ${location.href}`);
  L.push(`Browser:   ${navigator.userAgent}`);
  L.push(`Window:    ${window.innerWidth}x${window.innerHeight}`, '');

  L.push(`Loaded files${includeFiles ? '' : ' (NOT included in this zip)'}:`);
  if (!LOADED_FILES.length) L.push('  (none)');
  LOADED_FILES.forEach(f => L.push(`  ${f.name}  ${f.size} bytes  modified ${new Date(f.lastModified).toISOString()}`));
  if (LOAD_ERRORS.length) { L.push('', 'Load errors:'); LOAD_ERRORS.forEach(e => L.push('  ' + e)); }

  ALL_EVENTS.forEach((ev, i) => {
    const P = ev.parsed || {}, A = ev.analysis || {}, c = A.tripCause;
    L.push('', `── Event ${i + 1} of ${ALL_EVENTS.length}${i === CURRENT_IDX ? '  (being viewed when reported)' : ''} ──`);
    L.push(`File:        ${ev.fileName}`);
    L.push(`Format:      ${P.format || 'cev'}`);
    if (P.device) L.push(`Device:      ${P.device}`);
    if (P.eventInfo) L.push(`Event:       #${P.eventInfo.refNum ?? '?'}  type ${P.eventInfo.eventType ?? '?'}`);
    if (P.timestamp && typeof formatTimestamp === 'function') { try { L.push(`Time:        ${formatTimestamp(P.timestamp)}`); } catch (e) { /* unusual timestamp shape */ } }
    if (c) {
      L.push(`Headline:    ${strip(c.causeText)}`);
      if (c.immediateCause) L.push(`Immediate:   ${c.immediateCause}`);
      if (c.sourceEquationName || P.tripEquationName) L.push(`Equation:    ${c.sourceEquationName || P.tripEquationName}`);
      if (c.causeChain?.length) L.push(`Chain:       ${c.causeChain.map(s => s.label).join(' → ')}`);
      if (c.causeDetail) L.push(`Detail:      ${strip(c.causeDetail)}`);
    } else {
      L.push('Headline:    (no cause resolved)');
    }
    (A.investigationFlags || []).forEach(f => L.push(`Flag [${f.severity || 'info'}]: ${strip(f.title)}`));
    if (A.reclose?.verdict?.headline) L.push(`Reclose:     ${strip(A.reclose.verdict.headline)}`);
  });
  return L.join('\r\n') + '\r\n';
}

function bugEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Minimal ZIP writer — "stored" (uncompressed) entries only, which every unzip tool reads.
// Event files are small, so compression isn't worth a dependency.
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function buildStoredZip(entries) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);          // UTF-8 file names
    local.setUint16(8, 0, true);               // stored
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, e.bytes.length, true);
    local.setUint32(22, e.bytes.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local, name, e.bytes);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, e.bytes.length, true);
    cd.setUint32(24, e.bytes.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd, name);
    offset += 30 + name.length + e.bytes.length;
  }
  const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
