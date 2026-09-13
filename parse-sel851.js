

// ══════════════════════════════════════════════════════════════════════
// SEL-851 (.evzip) — BINARY COMTRADE + .hdr SUPPORT
// ══════════════════════════════════════════════════════════════════════
// The SEL-851 does not write CEV. It is configured with SEL Grid Configurator, not
// AcSELerator QuickSet, and its event export is an .evzip archive holding three files:
//
//   .cfg   IEEE C37.111-2013 configuration — channel list, scaling, sample rate, timestamps
//   .dat   BINARY32 sample data — fixed-length records, little-endian
//   .hdr   SEL event summary plus the COMPLETE relay settings, as plain key,"value" text
//
// This matters for the diagnosis the tool is built to make. The .hdr carries the trip
// equation (Trip_01.Init), every element pickup and delay, and the CT/VT ratios. So an 851
// event is self-describing in the same way a CEV is, even though the file layout is not.
// That is why this format gets a full trip-reasonableness path (analyze-sel851.js) and the
// Eaton Form 6 path does not — Form 6's settings.txt has unresolved curve and group
// ambiguities, while the 851 header states its settings without them.
//
// Two traps this parser handles explicitly, both confirmed on real 851 exports:
//  1. The .dat is BINARY, not ASCII. Decoding it as text destroys it. The ZIP reader must
//     hand back raw bytes for this entry.
//  2. The .cfg timestamps are DD/MM/YYYY (the C37.111 standard order), while the relay's own
//     Time.DateFormat setting may say MDY. These disagree. The .hdr Event_Date is written in
//     the relay's configured order; cross-checking the two resolves the .cfg order for real
//     rather than guessing from whichever field happens to exceed 12.

// ── Detect an 851 bundle among unzipped archive entries ──
// Returns { cfg, dat, hdr } entries, or null if this archive is not an 851 COMTRADE bundle.
function findSel851Bundle(entries) {
  const byExt = ext => entries.filter(e => new RegExp(`\\.${ext}$`, 'i').test(e.name));
  const cfgs = byExt('cfg');
  if (!cfgs.length) return null;

  const bundles = [];
  for (const cfg of cfgs) {
    const stem = cfg.name.replace(/\.cfg$/i, '');
    const dat = entries.find(e => e.name.replace(/\.dat$/i, '') === stem && /\.dat$/i.test(e.name));
    const hdr = entries.find(e => e.name.replace(/\.hdr$/i, '') === stem && /\.hdr$/i.test(e.name));
    if (!dat) continue;
    // An SEL-851 .cfg names the device on its first line. Eaton Form 6 bundles reach this tool
    // as loose .cfg/.dat/.txt files rather than inside an .evzip, but check the marker anyway so
    // the two COMTRADE paths can never claim each other's files.
    const firstLine = (entryText(cfg).split(/\r?\n/)[0] || '');
    const looksSel = /SEL-?8\d\d|SEL-/i.test(firstLine) || !!hdr;
    if (!looksSel) continue;
    bundles.push({ cfg, dat, hdr: hdr || null });
  }
  return bundles.length ? bundles : null;
}

// ── .hdr parser ──
// Flat `Key,"Value"` lines grouped under `[Section]` headings. Every setting is returned in one
// flat map keyed by its dotted name (Trip_01.Init, 27PP_02.PUVal, …), because that is how the
// settings refer to each other and how the relay word bits are named. Section membership is
// kept alongside it for the Settings tab only.
function parseSel851Hdr(text) {
  const out = { values: {}, sections: {}, order: [] };
  if (!text) return out;
  let section = 'Header';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { section = sec[1].trim(); continue; }
    const m = line.match(/^([^,]+),(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let val = m[2].trim();
    // Values are normally quoted. Strip one surrounding pair; leave inner quotes alone.
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out.values[key] = val;
    (out.sections[section] = out.sections[section] || []).push(key);
    out.order.push(key);
  }
  return out;
}

// ── .cfg parser (C37.111-1999/2013, binary or ASCII data file) ──
function parseSel851Cfg(text, hdrValues) {
  const lines = text.split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.length);
  let li = 0;
  const next = () => lines[li++] || '';

  const head = next().split(',');
  const stationName = (head[0] || '').trim();
  const recDevId = (head[1] || '').trim();
  const revYear = parseInt(head[2]) || 1999;

  const counts = next().split(',');
  const numAnalog = parseInt((counts[1] || '0A').replace(/A/i, '')) || 0;
  const numDigital = parseInt((counts[2] || '0D').replace(/D/i, '')) || 0;

  // Channel names arrive as dotted identifiers (IA.Raw_Pri, 27PP_02.TmOut). Keep the original
  // name for display and derive a JS-safe key for the sample-row objects.
  const safeKey = s => s.replace(/[^A-Za-z0-9_]/g, '_');
  const analogChannels = [];
  for (let i = 0; i < numAnalog; i++) {
    const f = next().split(',');
    const chId = (f[1] || `A${i + 1}`).trim();
    analogChannels.push({
      index: parseInt(f[0]) || (i + 1),
      chId,
      key: safeKey(chId),
      phase: (f[2] || '').trim(),
      unit: (f[4] || '').trim(),
      a: parseFloat(f[5]) || 1,
      b: parseFloat(f[6]) || 0,
      primary: parseFloat(f[10]),
      secondary: parseFloat(f[11]),
      ps: (f[12] || 'P').trim().toUpperCase(),
    });
  }

  const digitalChannels = [];
  for (let i = 0; i < numDigital; i++) {
    const f = next().split(',');
    const chId = (f[1] || `D${i + 1}`).trim();
    digitalChannels.push({
      index: parseInt(f[0]) || (i + 1),
      chId,
      key: safeKey(chId),
      // The 851 declares its full relay-word space and names the unwired positions UNUSEDnnn.
      // About 560 of 608 channels in a stock scheme are this. They carry no information and
      // must be hidden, or every bit list in the UI becomes unreadable.
      unused: /^UNUSED\d*$/i.test(chId),
      normalState: parseInt(f[4]) || 0,
    });
  }

  const lineFreq = parseFloat(next()) || 60;
  const nrates = parseInt(next()) || 1;
  const rates = [];
  for (let i = 0; i < Math.max(1, nrates); i++) {
    const f = next().split(',');
    rates.push({ sampFreq: parseFloat(f[0]) || 0, endSample: parseInt(f[1]) || 0 });
  }

  const startRaw = next();
  const triggerRaw = next();
  const fileType = (next() || 'ASCII').trim().toUpperCase();
  const timeMult = parseFloat(next()) || 1;

  const dateOrder = resolveSel851DateOrder(startRaw, triggerRaw, hdrValues);
  const startTime = parseSel851CfgTime(startRaw, dateOrder);
  const triggerTime = parseSel851CfgTime(triggerRaw, dateOrder);

  return {
    stationName, recDevId, revYear, numAnalog, numDigital,
    analogChannels, digitalChannels, lineFreq, rates,
    startTime, triggerTime, fileType, timeMult, dateOrder,
  };
}

// Decide whether the .cfg date fields read DD/MM/YYYY or MM/DD/YYYY.
// Order of evidence, strongest first:
//   1. The .hdr Event_Date, read in the order the relay's own Time.DateFormat setting declares,
//      matched against the .cfg trigger date. This is a direct cross-check, not an inference.
//   2. A field above 12, which can only be a day.
//   3. The C37.111 default, DD/MM/YYYY.
function resolveSel851DateOrder(startRaw, triggerRaw, hdrValues) {
  const fields = s => ((s || '').split(',')[0] || '').split('/').map(n => parseInt(n));

  const H = hdrValues || {};
  const hdrDate = H['Event_Date'];
  if (hdrDate) {
    const hf = hdrDate.split('/').map(n => parseInt(n));
    if (hf.length === 3 && hf.every(Number.isFinite)) {
      const fmt = (H['Time.DateFormat'] || 'MDY').toUpperCase();
      const hMonth = fmt.startsWith('D') ? hf[1] : hf[0];
      const hDay = fmt.startsWith('D') ? hf[0] : hf[1];
      const tf = fields(triggerRaw);
      if (tf.length === 3 && tf.every(Number.isFinite)) {
        if (tf[0] === hDay && tf[1] === hMonth) return 'DMY';
        if (tf[0] === hMonth && tf[1] === hDay) return 'MDY';
      }
    }
  }
  for (const raw of [startRaw, triggerRaw]) {
    const f = fields(raw);
    if (f.length === 3) {
      if (f[0] > 12) return 'DMY';
      if (f[1] > 12) return 'MDY';
    }
  }
  return 'DMY';
}

function parseSel851CfgTime(s, dateOrder) {
  const [datePart, timePart] = (s || '').split(',');
  const d = (datePart || '').split('/').map(Number);
  const day = dateOrder === 'DMY' ? d[0] : d[1];
  const month = dateOrder === 'DMY' ? d[1] : d[0];
  const year = d[2];
  const [hh, mm, ssRaw] = (timePart || '').split(':');
  const ss = parseFloat(ssRaw) || 0;
  return {
    year: year || 2000, month: month || 1, day: day || 1,
    hour: parseInt(hh) || 0, min: parseInt(mm) || 0,
    sec: Math.floor(ss), msec: Math.round((ss - Math.floor(ss)) * 1000),
  };
}

// ── .dat parser ──
// BINARY32 record layout, little-endian throughout:
//   uint32  sample number
//   uint32  timestamp, in microseconds x timeMult
//   int32   x numAnalog
//   uint16  x ceil(numDigital / 16)      digital channel i = bit (i mod 16) of word (i div 16)
// BINARY uses int16 analogs and FLOAT32 uses float32; both are accepted for completeness.
// Analog engineering value = raw * a + b, using the multiplier and offset from the .cfg.
function parseSel851Dat(bytes, cfg) {
  const type = cfg.fileType;
  const analogBytes = type === 'BINARY' ? 2 : 4;
  const isFloat = type === 'FLOAT32';
  const isSigned16 = type === 'BINARY';
  const digWords = Math.ceil(cfg.numDigital / 16);
  const recLen = 8 + analogBytes * cfg.numAnalog + 2 * digWords;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nRec = Math.floor(bytes.byteLength / recLen);
  if (nRec === 0) {
    throw new Error(`.dat is too small for the channel count declared in the .cfg (expected ${recLen} bytes per sample, file holds ${bytes.byteLength})`);
  }

  // Keep only channels that carry information. See the `unused` note above.
  const usedDigitals = cfg.digitalChannels.filter(c => !c.unused);
  const digitalLabels = usedDigitals.map(c => c.chId);
  const digitalSeries = {};
  digitalLabels.forEach(l => { digitalSeries[l] = new Uint8Array(nRec); });

  const rows = new Array(nRec);
  for (let k = 0; k < nRec; k++) {
    const base = k * recLen;
    const row = { n: view.getUint32(base, true), t: view.getUint32(base + 4, true) * cfg.timeMult };
    let off = base + 8;
    for (let i = 0; i < cfg.numAnalog; i++) {
      const ch = cfg.analogChannels[i];
      let raw;
      if (isFloat) raw = view.getFloat32(off, true);
      else if (isSigned16) raw = view.getInt16(off, true);
      else raw = view.getInt32(off, true);
      row[ch.key] = raw * ch.a + ch.b;
      off += analogBytes;
    }
    const words = new Array(digWords);
    for (let w = 0; w < digWords; w++) { words[w] = view.getUint16(off, true); off += 2; }
    const dig = {};
    for (const ch of usedDigitals) {
      const i = ch.index - 1;
      const v = (words[i >> 4] >> (i & 15)) & 1;
      dig[ch.chId] = v;
      digitalSeries[ch.chId][k] = v;
    }
    row._digital = dig;
    rows[k] = row;
  }
  return { rows, digitalLabels, digitalSeries };
}

// Build the same transition structure the CEV path produces, so shared helpers such as
// bitStateAtAnalogIdx() work against an 851 record without a second code path.
function buildSel851Transitions(digitalLabels, digitalSeries, nRec, msPerSample) {
  const initialDigitalState = digitalLabels.filter(l => digitalSeries[l][0] === 1);
  const transitions = [];
  for (let k = 1; k < nRec; k++) {
    const changes = [];
    for (const l of digitalLabels) {
      const s = digitalSeries[l];
      if (s[k] !== s[k - 1]) changes.push({ label: l, state: s[k] === 1 });
    }
    if (changes.length) transitions.push({ analogSampleIdx: k, timeMs: k * msPerSample, changes });
  }
  return { initialDigitalState, digitalTransitions: transitions };
}

// ── Assemble one 851 event ──
function parseSel851Bundle(cfgText, datBytes, hdrText, fileName) {
  const hdr = parseSel851Hdr(hdrText);
  const H = hdr.values;
  const cfg = parseSel851Cfg(cfgText, H);
  const { rows, digitalLabels, digitalSeries } = parseSel851Dat(datBytes, cfg);

  const sampFreq = cfg.rates[0]?.sampFreq || 0;
  const msPerSample = sampFreq > 0 ? 1000 / sampFreq : 1000 / (cfg.lineFreq * 16);
  // Sample rate is not always a whole multiple of line frequency — 2000 Hz on a 60 Hz system
  // gives 33.33 samples per cycle. Round for the DFT window; the resulting leakage is well
  // below the accuracy this tool claims anywhere.
  const samplesPerCycle = sampFreq > 0 ? Math.max(4, Math.round(sampFreq / cfg.lineFreq)) : 16;

  const startMs = getTimestampMs(cfg.startTime);
  const trigMs = getTimestampMs(cfg.triggerTime);
  const triggerSampleIndex = Math.max(0, Math.min(rows.length - 1, Math.round((trigMs - startMs) / msPerSample)));

  const { initialDigitalState, digitalTransitions } =
    buildSel851Transitions(digitalLabels, digitalSeries, rows.length, msPerSample);

  // Resolve the analog channels this tool reasons about, by name. The 851 writes both raw
  // sampled waveforms (VA.Raw_Pri) and relay-computed magnitude/angle pairs (VA.MagPri,
  // VA.Ang). Only the raw waveforms can be re-derived independently, so those are what every
  // measured quantity in the analysis is built from. The relay's own magnitudes are kept for
  // cross-checking, never as the primary source.
  const hasKey = k => cfg.analogChannels.some(c => c.key === k);
  const pick = (...names) => names.find(hasKey) || null;
  const chan = {
    va: pick('VA_Raw_Pri', 'VA'), vb: pick('VB_Raw_Pri', 'VB'), vc: pick('VC_Raw_Pri', 'VC'),
    ia: pick('IA_Raw_Pri', 'IA'), ib: pick('IB_Raw_Pri', 'IB'), ic: pick('IC_Raw_Pri', 'IC'),
    iN: pick('IN_Raw_Pri', 'IN'), iGnd: pick('IGnd_Raw_Pri', 'IGnd'),
    freq: pick('Freq_Mag'), freqTrk: pick('FreqTrk_Mag'),
  };

  const num = k => { const v = parseFloat(H[k]); return Number.isFinite(v) ? v : null; };

  return {
    format: 'sel851',
    fileName,
    device: H['Dev.Id'] || cfg.stationName || 'SEL-851',
    deviceLocation: H['Dev.Loc'] || '',
    companyName: H['Dev.CoName'] || '',
    fid: H['FID'] || cfg.recDevId || '',
    serialNumber: H['Serial_Number'] || '',
    partNumber: H['Part_Number'] || '',
    timestamp: cfg.triggerTime,
    eventInfo: {
      freq: cfg.lineFreq,
      samPerCycA: samplesPerCycle,
      eventType: H['Event'] || 'Event',
      refNum: H['Event_Number'] || fileName,
      timeSource: H['Time_Source'] || '',
      targets: H['Targets'] || '',
    },
    cfg,
    hdr,
    settings: H,
    ratios: {
      CTP: num('CTP.Rat'), CTPsec: num('CTP.NomSec'),
      CTN: num('CTN.Rat'), CTNsec: num('CTN.NomSec'),
      PTP: num('VTP.Rat'), vtConn: H['VTP.Conn'] || '',
      VNomKv: num('Sys.VNom'), FNom: num('Sys.FNom') || cfg.lineFreq,
    },
    chan,
    analogData: rows,
    digitalLabels,
    digitalSeries,
    digitalTransitions,
    initialDigitalState,
    triggerSampleIndex,
    msPerSample,
    tripEquationName: 'Trip_01.Init',
    tripEquation: H['Trip_01.Init'] || null,
    _debug: {
      sampleCount: rows.length,
      analogChCount: cfg.numAnalog,
      digitalChDeclared: cfg.numDigital,
      digitalChNamed: digitalLabels.length,
      samplesPerCycle,
      fileType: cfg.fileType,
      dateOrder: cfg.dateOrder,
      hdrPresent: !!hdrText,
    },
  };
}
