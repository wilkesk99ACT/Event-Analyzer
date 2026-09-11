// File input handling: reading files, ZIP bundle extraction, multi-event list management.

let ALL_EVENTS = []; // Array of { parsed, analysis, fileName }
let CURRENT_IDX = 0;

function getTimestampMs(ts) {
  return new Date(ts.year, ts.month - 1, ts.day, ts.hour, ts.min, ts.sec, ts.msec).getTime();
}

function formatTimestamp(ts) {
  return `${ts.month}/${ts.day}/${ts.year} ${String(ts.hour).padStart(2,'0')}:${String(ts.min).padStart(2,'0')}:${String(ts.sec).padStart(2,'0')}.${ts.msec}`;
}

// ══════════════════════════════════════════════════════════════════════
// .evzip / .zip SUPPORT — read a zip archive of .CEV files with zero external
// dependencies, using only browser-native APIs. SEL's Event Manager and similar tools
// often bundle a multi-shot event (e.g. a recloser sequence, or several relays'
// records of the same fault) into a single .evzip, which is just a standard ZIP
// containing plain .CEV files. Rather than pull in a JS zip library — an extra
// dependency for a single-file distributable tool, and a possible corporate-proxy
// headache since it'd need to load from a CDN — this parses the ZIP central
// directory by hand and inflates entries with the browser's built-in
// DecompressionStream, so the tool stays a single self-contained HTML file.
// ══════════════════════════════════════════════════════════════════════

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

async function unzipEntries(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);

  // Locate the End Of Central Directory record (signature 0x06054b50). It sits at the
  // very end of the file, but may be preceded by a variable-length comment field, so
  // scan backward from the end rather than assuming a fixed offset.
  let eocdOffset = -1;
  const scanFloor = Math.max(0, bytes.length - 65557); // max comment length (64K) + EOCD record size
  for (let i = bytes.length - 22; i >= scanFloor; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Not a valid ZIP archive (no End Of Central Directory record found)');

  const entryCount = view.getUint16(eocdOffset + 10, true);
  let cdOffset = view.getUint32(eocdOffset + 16, true);

  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(cdOffset, true) !== 0x02014b50) throw new Error('Malformed ZIP central directory');
    const method = view.getUint16(cdOffset + 10, true);
    const compSize = view.getUint32(cdOffset + 20, true);
    const nameLen = view.getUint16(cdOffset + 28, true);
    const extraLen = view.getUint16(cdOffset + 30, true);
    const commentLen = view.getUint16(cdOffset + 32, true);
    const localHeaderOffset = view.getUint32(cdOffset + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.slice(cdOffset + 46, cdOffset + 46 + nameLen));
    entries.push({ name, method, compSize, localHeaderOffset });
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }

  const out = [];
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue; // directory entry, skip
    const lh = entry.localHeaderOffset;
    if (view.getUint32(lh, true) !== 0x04034b50) throw new Error(`Malformed local file header for ${entry.name}`);
    const lhNameLen = view.getUint16(lh + 26, true);
    const lhExtraLen = view.getUint16(lh + 28, true);
    const dataStart = lh + 30 + lhNameLen + lhExtraLen;
    const compData = bytes.slice(dataStart, dataStart + entry.compSize);

    let outBytes;
    if (entry.method === 0) {
      outBytes = compData; // stored — no compression
    } else if (entry.method === 8) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('This browser cannot inflate ZIP entries (needs the DecompressionStream API — try a recent Chrome, Edge, or Firefox).');
      }
      const stream = new Blob([compData]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      outBytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else {
      throw new Error(`Unsupported ZIP compression method (${entry.method}) for ${entry.name}`);
    }
    out.push({ name: entry.name, text: new TextDecoder('utf-8').decode(outBytes) });
  }
  return out;
}

// ── Form6 bundle helpers: classify .txt files (settings vs one-line fault summary vs
// unrecognized) and pick the best-matching settings.txt for a given .cfg/.dat pair when
// several bundles are dropped at once (matched by date + hour token in the filename, since
// ProView names settings.txt truncated to the hour rather than matching the .cfg/.dat exactly). ──
function classifyForm6Txt(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length);
  const tabLines = lines.filter(l => l.includes('\t')).length;
  if (tabLines > 10) return 'settings';
  if (lines.length <= 3 && /fault/i.test(text)) return 'summary';
  return 'unknown';
}
function pickBestMatch(cfgName, candidates) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const m = cfgName.match(/(\d{4}-\d{2}-\d{2})[_ ](\d{2})/);
  if (m) {
    const [, date, hour] = m;
    const exact = candidates.find(c => c.name.includes(date) && c.name.includes(`_${hour}_`));
    if (exact) return exact;
  }
  return candidates[0];
}

function processFiles(files) {
  const fileArray = Array.from(files);
  const results = [];
  const errors = [];

  const finish = () => {
    if (results.length === 0) {
      document.getElementById('errorMsg').textContent = 'Failed to parse file(s): ' + errors.join('; ');
      document.getElementById('errorMsg').style.display = 'block';
      return;
    }
    // Sort by timestamp chronologically
    results.sort((a, b) => getTimestampMs(a.parsed.timestamp) - getTimestampMs(b.parsed.timestamp));

    // Analyze each event with context from the previous event
    for (let i = 0; i < results.length; i++) {
      const prevEvt = i > 0 ? results[i - 1] : null;
      results[i].analysis = results[i].parsed.format === 'form6'
        ? analyzeForm6(results[i].parsed)
        : analyzeCEV(results[i].parsed, prevEvt);
    }

    ALL_EVENTS = results;
    CURRENT_IDX = 0;

    document.getElementById('upload-screen').style.display = 'none';
    document.getElementById('analysis-screen').style.display = 'block';
    document.getElementById('errorMsg').style.display = 'none';

    renderEventSelector();
    selectEvent(0);

    if (errors.length) console.warn('Some files had errors:', errors);
  };

  const cfgFiles = fileArray.filter(f => /\.cfg$/i.test(f.name));
  const otherFiles = fileArray.filter(f => !/\.cfg$/i.test(f.name));

  Promise.all([
    // ── Form6 COMTRADE bundles: one per .cfg, paired with its exact-name .dat and the
    // best-matching settings.txt/summary.txt among whatever .txt files were dropped alongside.
    // .evt files dropped in the same batch are intentionally ignored — everything needed is in
    // the COMTRADE pair + settings.txt (see the .evt discussion this tool's chat history covers).
    ...cfgFiles.map(async cfgFile => {
      try {
        const stem = cfgFile.name.replace(/\.cfg$/i, '');
        const datFile = fileArray.find(f => f.name.replace(/\.dat$/i, '') === stem && /\.dat$/i.test(f.name));
        if (!datFile) { errors.push(`${cfgFile.name}: no matching .dat file found`); return; }
        const cfgText = await readFileAsText(cfgFile);
        const datText = await readFileAsText(datFile);
        const txtFiles = fileArray.filter(f => /\.txt$/i.test(f.name));
        const txtWithContent = await Promise.all(txtFiles.map(async f => ({ name: f.name, text: await readFileAsText(f) })));
        const settingsCandidates = txtWithContent.filter(t => classifyForm6Txt(t.text) === 'settings');
        const summaryCandidates = txtWithContent.filter(t => classifyForm6Txt(t.text) === 'summary');
        const settingsMatch = pickBestMatch(cfgFile.name, settingsCandidates);
        // Fault summary .txt shares the exact same basename as the .cfg/.dat (unlike settings.txt)
        const summaryMatch = summaryCandidates.find(t => t.name.replace(/\.txt$/i, '') === stem) || pickBestMatch(cfgFile.name, summaryCandidates);
        const parsed = parseForm6Bundle(cfgText, datText, settingsMatch?.text, summaryMatch?.text, cfgFile.name);
        results.push({ parsed, fileName: cfgFile.name });
      } catch (err) {
        errors.push(`${cfgFile.name}: ${err.message}`);
        console.error(`Error processing Form6 bundle for ${cfgFile.name}:`, err);
      }
    }),
    // ── Existing SEL CEV / .evzip handling — unchanged, applied to everything that isn't a
    // .cfg/.dat/.txt already consumed above as part of a Form6 bundle. ──
    ...otherFiles.filter(f => !/\.(dat|txt)$/i.test(f.name) || cfgFiles.length === 0).map(async file => {
    const isArchive = /\.(evzip|zip)$/i.test(file.name);
    try {
      if (isArchive) {
        // .evzip is SEL's bundle format: a plain ZIP containing one or more .CEV files
        // (e.g. all shots of a recloser sequence, or multiple relays' records of one
        // fault). Unzip it and feed each contained event file through the same parser,
        // exactly as if the user had dropped each .CEV individually.
        const buf = await readFileAsArrayBuffer(file);
        const entries = await unzipEntries(buf);
        const cevEntries = entries.filter(e => /\.(cev|txt)$/i.test(e.name));
        if (cevEntries.length === 0) {
          errors.push(`${file.name}: archive contained no .CEV files`);
          return;
        }
        for (const entry of cevEntries) {
          try {
            const parsed = parseCEV(entry.text, entry.name);
            results.push({ parsed, fileName: entry.name });
          } catch (err) {
            errors.push(`${file.name} → ${entry.name}: ${err.message}`);
          }
        }
      } else if (/\.evt$/i.test(file.name)) {
        // Proprietary Eaton binary — nothing usable beyond the plain-text fault-summary line,
        // and that's only recoverable if a matching .cfg/.dat/.txt bundle covers this event
        // instead. Skip silently rather than failing the whole batch.
        return;
      } else {
        const text = await readFileAsText(file);
        const parsed = parseCEV(text, file.name);
        results.push({ parsed, fileName: file.name });
      }
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
      console.error(`Error processing ${file.name}:`, err);
    }
    }),
  ]).then(finish);
}

