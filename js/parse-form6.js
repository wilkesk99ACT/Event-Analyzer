

// ════════════════════════════════════════════════════════════════════════════
// APP CONTROLLER
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// MULTI-FILE APP CONTROLLER
// ════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════
// EATON FORM 6 (ProView) — COMTRADE + settings.txt SUPPORT
// ══════════════════════════════════════════════════════════════════════
// Unlike SEL's self-contained CEV (waveforms + settings in one file), a Form 6 event is a
// bundle of THREE files: a standard IEEE COMTRADE ASCII pair (.cfg + .dat) holding the
// oscillography, plus a plain tab-delimited settings.txt holding the protection settings —
// confirmed paired to this specific event (ProView itself refuses to open the .evt without a
// matching settings.txt), not a generic "whenever exported" settings dump. The .evt itself is
// a proprietary binary blob this tool cannot read beyond one plain-text summary line, and isn't
// needed here — the COMTRADE+settings.txt pair is the analyzable record.
//
// NOTE ON SCOPE: this is a first pass. Two things are deliberately NOT implemented pending
// more information:
//  1. Inverse-time operate-time math for TCC curves — the numeric "Curve" index in settings.txt
//     (e.g. TCC1GCurve=5) references a named Eaton/Cooper curve family, but no verified
//     curve-number-to-formula table was available, so only pickup/measured/asserted is shown,
//     no time-to-trip estimate.
//  2. Active setting-group detection — settings.txt values are comma-separated per group
//     (Normal, Alt1-5), and which one was active at event time isn't derivable from the wired
//     COMTRADE digital channels in the files seen so far. Group 0 (Normal) is used by default
//     and this assumption is surfaced in the UI rather than silently applied.

// ── COMTRADE .cfg parser (IEEE C37.111 ASCII, 1991/1999 revisions) ──
function parseComtradeCfg(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length);
  let li = 0;
  const next = () => lines[li++] || '';

  const headerParts = next().split(',');
  const stationName = (headerParts[0] || '').trim();
  const revYear = parseInt(headerParts[2]) || 1991;

  const countParts = next().split(',');
  const totalCh = parseInt(countParts[0]) || 0;
  const numAnalog = parseInt((countParts[1] || '0A').replace(/A/i, '')) || 0;
  const numDigital = parseInt((countParts[2] || '0D').replace(/D/i, '')) || 0;

  const deriveChKey = (chId, fallback) => {
    const segs = chId.split(':').map(s => s.trim());
    const meaningful = segs.filter(s => s && !/\(/.test(s) && !/^(unf|flt)$/i.test(s));
    return ((meaningful.join('_') || chId || fallback)).replace(/[^A-Za-z0-9_]/g, '_');
  };

  const usedKeys = new Set();
  const uniqueKey = k => {
    if (!usedKeys.has(k)) { usedKeys.add(k); return k; }
    let n = 2;
    while (usedKeys.has(`${k}_${n}`)) n++;
    usedKeys.add(`${k}_${n}`);
    return `${k}_${n}`;
  };

  const analogChannels = [];
  for (let i = 0; i < numAnalog; i++) {
    const f = next().split(',');
    const chId = (f[1] || `A${i + 1}`).trim();
    analogChannels.push({
      index: parseInt(f[0]) || (i + 1),
      chId,
      key: uniqueKey(deriveChKey(chId, `A${i + 1}`)),
      phase: (f[2] || '').trim(),
      unit: (f[4] || '').trim(),
      a: parseFloat(f[5]) || 1,
      b: parseFloat(f[6]) || 0,
      min: parseFloat(f[8]),
      max: parseFloat(f[9]),
    });
  }

  const digitalChannels = [];
  for (let i = 0; i < numDigital; i++) {
    const f = next().split(',');
    const chId = (f[1] || `D${i + 1}`).trim();
    digitalChannels.push({
      index: parseInt(f[0]) || (i + 1),
      chId,
      key: uniqueKey(deriveChKey(chId, `D${i + 1}`)),
      normalState: parseInt(f[4]) || 0,
    });
  }

  const lineFreq = parseFloat(next()) || 60;
  const nrates = parseInt(next()) || 1;
  const rates = [];
  for (let i = 0; i < nrates; i++) {
    const f = next().split(',');
    rates.push({ sampFreq: parseFloat(f[0]) || 0, endSample: parseInt(f[1]) || 0 });
  }
  const parseCTDate = (s) => {
    // "MM/DD/YYYY,HH:MM:SS.ffffff"
    const [datePart, timePart] = (s || '').split(',');
    const [mo, da, yr] = (datePart || '').split('/').map(Number);
    const [hh, mm, ssRaw] = (timePart || '').split(':');
    const ss = parseFloat(ssRaw) || 0;
    return { month: mo || 1, day: da || 1, year: yr || 2000, hour: parseInt(hh) || 0, min: parseInt(mm) || 0, sec: Math.floor(ss), msec: Math.round((ss - Math.floor(ss)) * 1000) };
  };
  const startTime = parseCTDate(next());
  const triggerTime = parseCTDate(next());
  const fileType = (next() || 'ASCII').toUpperCase();

  return { stationName, revYear, numAnalog, numDigital, analogChannels, digitalChannels, lineFreq, rates, startTime, triggerTime, fileType };
}

// ── COMTRADE .dat parser (ASCII revision only — this is what ProView's COMTRADE block emits) ──
function parseComtradeDat(text, cfg) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const f = line.split(',');
    // Trailing/garbage lines (seen in real ProView exports, e.g. a stray control character)
    // won't have enough fields for every declared channel — skip rather than half-parse.
    if (f.length < 2 + cfg.numAnalog + cfg.numDigital) continue;
    const n = parseInt(f[0]);
    if (!Number.isFinite(n)) continue;
    const row = { n };
    cfg.analogChannels.forEach((ch, i) => {
      const raw = parseFloat(f[2 + i]) || 0;
      row[ch.key] = raw * ch.a + ch.b;
    });
    const digBits = {};
    cfg.digitalChannels.forEach((ch, i) => {
      digBits[ch.key] = parseInt(f[2 + cfg.numAnalog + i]) || 0;
    });
    row._digital = digBits;
    rows.push(row);
  }
  return rows;
}

// ── settings.txt parser — tab-delimited Name<TAB>Value(s)<TAB>Description, one setting per
// line, values comma-separated across up to 6 setting groups (Normal + Alt1-5). ──
function parseForm6Settings(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const name = parts[0].trim();
    const values = parts[1].split(',').map(v => v.trim());
    const description = (parts[2] || '').trim();
    out[name] = { values, valuesNum: values.map(v => parseFloat(v)), description };
  }
  return out;
}

// ── Assemble one Form6 event bundle (cfg + dat + optional settings.txt) into a P-like object.
// P.format = 'form6' is the flag renderBanner/renderTabs/renderContent branch on to route to
// the Form6-specific rendering path instead of the SEL one. ──
function parseForm6Bundle(cfgText, datText, settingsText, summaryText, fileName) {
  const cfg = parseComtradeCfg(cfgText);
  const rows = parseComtradeDat(datText, cfg);
  const settings = settingsText ? parseForm6Settings(settingsText) : null;

  const sampFreq = cfg.rates[0]?.sampFreq || (rows.length * cfg.lineFreq / 1); // fallback, rarely needed
  const samplesPerCycle = sampFreq > 0 ? Math.round(sampFreq / cfg.lineFreq) : 16;
  const msPerSample = sampFreq > 0 ? 1000 / sampFreq : 1000 / (cfg.lineFreq * 16);

  const startMs = getTimestampMs({ year: cfg.startTime.year, month: cfg.startTime.month, day: cfg.startTime.day, hour: cfg.startTime.hour, min: cfg.startTime.min, sec: cfg.startTime.sec, msec: cfg.startTime.msec });
  const trigMs = getTimestampMs({ year: cfg.triggerTime.year, month: cfg.triggerTime.month, day: cfg.triggerTime.day, hour: cfg.triggerTime.hour, min: cfg.triggerTime.min, sec: cfg.triggerTime.sec, msec: cfg.triggerTime.msec });
  const triggerSampleIndex = Math.max(0, Math.round((trigMs - startMs) / msPerSample));

  // Fault summary — the one reliably-extractable line from the paired .evt/.txt export, e.g.
  // "BC Fault, 999.9mi, 5.5 cyc, IA=4.2, IB=65.9, IC=49.6 (Amps pri)". Purely informational.
  let faultSummary = (summaryText || '').trim();

  return {
    format: 'form6',
    fileName,
    device: cfg.stationName || 'Form6-TS',
    timestamp: cfg.triggerTime,
    eventInfo: {
      freq: cfg.lineFreq,
      samPerCycA: samplesPerCycle,
      eventType: faultSummary ? (faultSummary.split(',')[0] || 'Event').trim() : 'Event',
      refNum: fileName,
    },
    cfg,
    analogData: rows,
    triggerSampleIndex,
    msPerSample,
    settings,
    faultSummary,
    _debug: { analogRowCount: rows.length, analogChCount: cfg.numAnalog, digitalChCount: cfg.numDigital, samplesPerCycle },
  };
}

// ── Analysis: pickup-vs-measured for the settings.txt protection functions recognized so far.
// No operate-time math (curve table unresolved — see note above); Normal (group 0) setting
// values are used, flagged explicitly since active-group detection isn't available yet. ──
function analyzeForm6(P) {
  const A = { protectionStatus: [], digitalTimeline: [], faultSummary: P.faultSummary, groupAssumption: 'Normal (group 0) — active profile not detected from this file; verify against the device if in doubt.' };
  const rows = P.analogData;
  if (!rows.length) return A;

  const cyc = P.eventInfo.samPerCycA || 16;
  const get = key => rows.map(r => r[key] ?? 0);
  const has = key => P.cfg.analogChannels.some(c => c.key === key);

  const rmsIA = has('IA') ? computeRmsMagnitude(get('IA'), cyc) : [];
  const rmsIB = has('IB') ? computeRmsMagnitude(get('IB'), cyc) : [];
  const rmsIC = has('IC') ? computeRmsMagnitude(get('IC'), cyc) : [];
  const maxPhaseISeries = rmsIA.map((v, i) => Math.max(v, rmsIB[i] || 0, rmsIC[i] || 0));
  const negSeqISeries = (has('IA') && has('IB') && has('IC'))
    ? computeNegSeqMagnitude(get('IA'), get('IB'), get('IC'), cyc) : [];
  // Form 6's 4th current channel (IX) is the dedicated ground/residual sensor on recloser CT
  // schemes that have one — distinct from the phase currents, the way SEL's IG is distinct from
  // IA/IB/IC. Ground-type elements (CLPUG, SEF) should compare against this, not phase current.
  const groundISeries = has('IX') ? computeRmsMagnitude(get('IX'), cyc) : [];

  // Representative instant: end of record (post-fault, well past any DFT/RMS warm-up window) —
  // same rationale as the SEL side's defaultProtIdx, and refreshed the same way if/when cursor
  // support is added for this format.
  const idx = Math.max(0, rows.length - 1);
  const maxPhaseI = maxPhaseISeries[idx] || 0;
  const negSeqI = negSeqISeries[idx] || 0;
  const groundI = groundISeries.length ? (groundISeries[idx] || 0) : null;

  A.protectionStatus = [];
  A.unresolvedElements = [];
  const S = P.settings;
  if (S) {
    const addRow = (settingPrefix, label, measured, unitLabel, measuredNote) => {
      const pu = S[`${settingPrefix}MinTrip`];
      if (!pu) return;
      const pickup = pu.valuesNum[0];
      if (!Number.isFinite(pickup)) return;
      const blockKey = Object.keys(S).find(k => k.toLowerCase() === `${settingPrefix.toLowerCase()}block`);
      const blocked = blockKey ? S[blockKey].valuesNum[0] === 1 : false;
      A.protectionStatus.push({
        element: settingPrefix, type: label,
        pickup: `${pickup} ${unitLabel}`,
        measured: `${measured.toFixed(2)} ${unitLabel}${measuredNote ? ` (${measuredNote})` : ''}`,
        asserted: !blocked && measured >= pickup,
        blocked,
        curveNote: S[`${settingPrefix}Curve`] ? `Curve idx ${S[`${settingPrefix}Curve`].values[0]} (formula not decoded — no operate-time estimate)` : null,
      });
    };
    addRow('CLPUP', 'Cold-Load Pickup (Phase)', maxPhaseI, 'A pri');
    if (groundI != null) addRow('CLPUG', 'Cold-Load Pickup (Ground)', groundI, 'A pri', 'IX channel');
    else addRow('CLPUG', 'Cold-Load Pickup (Ground)', maxPhaseI, 'A pri', 'best-effort — no IX/ground channel found, phase current shown instead');
    addRow('CLPUQ', 'Cold-Load Pickup (Neg-Seq)', negSeqI, 'A pri');
    if (S['SEFMinTrip']) {
      const pickup = S['SEFMinTrip'].valuesNum[0];
      const blocked = S['SEFBlock'] ? S['SEFBlock'].valuesNum[0] === 1 : false;
      const sefMeasured = groundI != null ? groundI : maxPhaseI;
      A.protectionStatus.push({
        element: 'SEF', type: 'Sensitive Earth Fault',
        pickup: `${pickup} A pri`,
        measured: `${sefMeasured.toFixed(2)} A pri (${groundI != null ? 'IX channel' : 'best-effort — no IX/ground channel found, phase current shown instead'})`,
        asserted: !blocked && sefMeasured >= pickup, blocked,
      });
    }
    if (S['NegSeqOCAlarm']) {
      const pickup = S['NegSeqOCAlarm'].valuesNum[0];
      A.protectionStatus.push({
        element: 'NegSeqOCAlarm', type: 'Neg-Seq OC Alarm',
        pickup: `${pickup} A pri (3I2)`, measured: `${negSeqI.toFixed(2)} A pri (3I2)`,
        asserted: negSeqI >= pickup, blocked: false,
      });
    }

    // Main phase/ground/neg-seq time-overcurrent — TCC1 (fast) and TCC2 (delayed) are two
    // different CURVE SHAPES, not independent thresholds; Eaton's documented stock scheme shares
    // one minimum-trip value between them, named e.g. "TCCPMinTrip" (no "1"/"2"). Check for that
    // stock name first…
    const stockFam = { P: { key: 'TCCPMinTrip', label: 'Phase', measured: maxPhaseI, unit: 'A pri' },
                       G: { key: 'TCCGMinTrip', label: 'Ground', measured: groundI != null ? groundI : maxPhaseI, unit: 'A pri' },
                       Q: { key: 'TCCQMinTrip', label: 'Neg-Seq', measured: negSeqI, unit: 'A pri' } };
    Object.entries(stockFam).forEach(([suffix, cfg]) => {
      const pu = S[cfg.key];
      if (!pu) return;
      const pickup = pu.valuesNum[0];
      if (!Number.isFinite(pickup)) return;
      A.protectionStatus.push({
        element: `TCC${suffix}`, type: `${cfg.label} Time OC (TCC1 fast / TCC2 delayed — shared pickup)`,
        pickup: `${pickup} ${cfg.unit}`, measured: `${cfg.measured.toFixed(2)} ${cfg.unit}`,
        asserted: cfg.measured >= pickup, blocked: false,
      });
    });
    // …and only if that's also absent, flag TCC1x/TCC2x as unresolved rather than guessing. This
    // export has Curve/Mult/Add/HCT/MRTA settings for these but no pickup under either the
    // per-curve (TCC1PMinTrip) or stock shared (TCCPMinTrip) naming — on this platform (a
    // programmable function-block scheme, not a fixed-element relay) that most likely means the
    // pickup was wired as a hardwired constant inside the compiled scheme rather than exposed as
    // an adjustable setting, which no settings export — this or any other — would ever show.
    ['TCC1P', 'TCC1G', 'TCC1Q', 'TCC2P', 'TCC2G', 'TCC2Q'].forEach(fam => {
      const stockKey = `TCC${fam.slice(-1)}MinTrip`;
      if (S[`${fam}Curve`] && !S[`${fam}MinTrip`] && !S[stockKey]) A.unresolvedElements.push(fam);
    });
  }

  return A;
}