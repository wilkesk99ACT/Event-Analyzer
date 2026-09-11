// SEL .CEV file parser: digital/analog records, hex bit decoding, analog basis calibration.

function parseCEV(text, fileName) {
  const lines = text.replace(/\r/g, '').split('\n');
  const R = {
    fid: '', device: '', timestamp: {}, eventInfo: {},
    analogChannels: [], analogData: [], digitalLabels: [],
    settings: {}, svSettings: [], voltageElements: {},
    freqElements: {}, overcurrentElements: {},
    tripEquation: '', tripEquationName: '', tripEquationX: '', faultEquation: '', recloseEquation: '', dtlEquation: '', erEquation: '', erEquationName: '',
    digitalTransitions: [], raw: text, fileName: fileName || '',
    format: 'unknown', // will be 'sel651r' or 'sel751' or 'generic'
  };

  // ── Detect format by examining header lines ──
  // SEL-651R: Line 1 = "FID","xxxx"  Line 2 = "FID=SEL-651R..."
  // SEL-751: Line 1 = "FID","CEV_VER","PART_NUM","SER_NUM","xxxx"  (has CEV_VER)
  const line0 = lines[0]?.replace(/"/g, '') || '';
  const line1 = lines[1]?.replace(/"/g, '') || '';

  let headerOffset = 0; // how many extra header lines before timestamp
  let dataHeaderLine = 6; // which line has analog+digital column headers
  let dataStartLine = 7;  // which line data begins

  if (line0.includes('CEV_VER') || line1.includes('CEV_VER') || line1.includes('751')) {
    // SEL-751 format: has extra header fields, timestamp at line 3 (0-indexed: 2), event summary at line 5 (0-indexed: 5)
    R.format = 'sel751';
    R.fid = lines[0]?.replace(/"/g, '').split(',')[0] || '';
    R.device = lines[1]?.replace(/"/g, '').split(',')[0] || '';
  } else {
    R.format = 'sel651r';
    R.fid = line0.split(',')[0] || '';
    R.device = line1.split(',')[0] || '';
  }

  // ── Find timestamp line (MONTH,DAY,YEAR...) ──
  let tsLineIdx = -1;
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    if (/^"?MONTH"?/i.test(lines[i])) { tsLineIdx = i; break; }
  }
  if (tsLineIdx >= 0 && tsLineIdx + 1 < lines.length) {
    const p = lines[tsLineIdx + 1].replace(/"/g, '').split(',');
    R.timestamp = { month:+p[0], day:+p[1], year:+p[2], hour:+p[3], min:+p[4], sec:+p[5], msec:+p[6] };
  }

  // ── Find event summary line (REF_NUM or REC_NUM...) ──
  let evtHeaderIdx = -1;
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    if (/REF_NUM|REC_NUM/i.test(lines[i])) { evtHeaderIdx = i; break; }
  }
  if (evtHeaderIdx >= 0 && evtHeaderIdx + 1 < lines.length) {
    const hdr = lines[evtHeaderIdx].replace(/"/g, '').split(',').map(h => h.trim());
    const vals = lines[evtHeaderIdx + 1].replace(/"/g, '').split(',').map(v => v.trim());
    const get = (key) => { const idx = hdr.indexOf(key); return idx >= 0 ? vals[idx] : null; };

    R.eventInfo = {
      refNum: get('REF_NUM') || get('REC_NUM') || '',
      freq: parseFloat(get('FREQ')) || 60,
      samPerCycA: parseInt(get('SAM/CYC_A')) || 32,
      samPerCycD: parseInt(get('SAM/CYC_D')) || 4,
      numCycles: parseInt(get('NUM_OF_CYC')) || 30,
      eventType: get('EVENT') || '',
      location: get('LOCATION') || '',
      shot: get('SHOT') || '',
      targets: get('TARGETS') || '',
      // The relay's OWN reported fault-current magnitudes for this record (primary amps, RMS).
      // Captured because they are the single most authoritative in-file reference for
      // calibrating what basis and scaling the analog columns actually use — see
      // calibrateAnalogBasis(), which compares these against what we compute from the samples.
      faultCurrents: ['IA', 'IB', 'IC', 'IG', '3I2'].reduce((o, k) => {
        const v = parseFloat(get(k));
        if (Number.isFinite(v)) o[k] = Math.abs(v);
        return o;
      }, {}),
    };

    // SEL-751 has CT/PT ratios in the event summary
    if (R.format === 'sel751') {
      R.settings.CTR = parseFloat(get('CTR_IA')) || null;
      R.settings.PTRY = parseFloat(get('PTR_VA')) || null;
      R.settings.PTRZ = R.settings.PTRY;
      R.settings.primaryValues = get('PRIM_VAL') === 'YES';
    }
  }

  // ── Find data header line (IA, IB, IC... or IA(A), IB(A)...) ──
  let dataHdrIdx = -1;
  for (let i = (evtHeaderIdx || 0) + 1; i < Math.min(15, lines.length); i++) {
    if (/^"?IA/i.test(lines[i])) { dataHdrIdx = i; break; }
  }

  // ── Parse analog channel names and digital labels ──
  if (dataHdrIdx >= 0) {
    const raw = lines[dataHdrIdx].replace(/"/g, '');
    const parts = raw.split(',');
    R.analogChannels = [];
    // Raw, POSITION-PRESERVING name→column-index map (unlike R.analogChannels below, which
    // drops "*" placeholder columns for display purposes). Some formats (e.g. SEL-751) place
    // several "*" placeholder columns between the last named channel and FREQ — filtering
    // those out before computing indices silently shifted every subsequent lookup (FREQ ended
    // up reading one of the placeholder columns instead, always 0, regardless of the real
    // frequency recorded later in the row).
    R.analogColIndex = {};
    for (let j = 0; j < parts.length; j++) {
      const name = parts[j].trim();
      const clean = name.replace(/\(.*\)/, '').trim().toUpperCase();
      if (clean && clean !== '*' && !(clean in R.analogColIndex)) R.analogColIndex[clean] = j;
    }
    let digitalPartIdx = -1;
    // Find where TRIG column is — digital labels follow
    for (let j = 0; j < parts.length; j++) {
      if (parts[j].trim() === 'TRIG') { digitalPartIdx = j + 1; break; }
    }
    // Analog channels are everything before FREQ
    for (let j = 0; j < parts.length; j++) {
      const name = parts[j].trim();
      if (name === 'FREQ') { R.analogChannels.push(name); break; }
      if (name && name !== '*' && name !== 'TRIG') R.analogChannels.push(name);
    }
    // Digital labels
    if (digitalPartIdx >= 0 && digitalPartIdx < parts.length) {
      for (let j = digitalPartIdx; j < parts.length; j++) {
        const chunk = parts[j].trim();
        if (chunk.length > 20 && chunk.includes(' ')) {
          R.digitalLabels = chunk.split(/\s+/);
          break;
        }
      }
    }
    // Fallback: find any part with protection element names
    if (!R.digitalLabels.length) {
      for (const p of parts) {
        if (p.includes('50A1') || p.includes('50P1') || p.includes('ORED50')) {
          R.digitalLabels = p.trim().split(/\s+/);
          break;
        }
      }
    }
    dataStartLine = dataHdrIdx + 1;
  }

  // ── Parse analog data + digital hex words ──
  const hexRe = /([0-9A-Fa-f]{40,})/;
  let triggerIdx = -1;
  const hexSamples = [];

  // Determine analog column mapping based on format
  const chanNames = R.analogChannels.map(c => c.replace(/\(.*\)/, '').trim().toUpperCase());

  for (let i = dataStartLine; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!/^[-\d]/.test(line)) break;

    const parts = line.split(',');
    if (parts.length < 5) break;

    // Map columns dynamically based on channel names, using the RAW header position map
    // (R.analogColIndex) rather than the filtered display list — see the comment where
    // analogColIndex is built for why that distinction matters.
    const getCol = (name) => {
      const idx = R.analogColIndex ? R.analogColIndex[name] : chanNames.indexOf(name);
      return (idx != null && idx >= 0 && idx < parts.length) ? parseFloat(parts[idx]) || 0 : 0;
    };

    const row = {
      IA: getCol('IA'), IB: getCol('IB'), IC: getCol('IC'),
      IN: getCol('IN'), IG: getCol('IG'),
      VAY: getCol('VA') || getCol('VAY'), VBY: getCol('VB') || getCol('VBY'),
      VCY: getCol('VC') || getCol('VCY'),
      VAZ: getCol('VAZ'), VBZ: getCol('VBZ'), VCZ: getCol('VCZ'),
      FREQ: getCol('FREQ'),
    };

    // Find trigger marker and hex word
    for (let j = 0; j < parts.length; j++) {
      const clean = parts[j].replace(/"/g, '').trim();
      if (clean === '*') triggerIdx = R.analogData.length;
      const m = hexRe.exec(clean);
      if (m && m[1].length > 40) {
        hexSamples.push({ sampleIdx: R.analogData.length, hex: m[1], lineNum: i + 1 });
      }
    }
    R.analogData.push(row);
  }
  R.triggerSampleIndex = triggerIdx;

  // ── Decode digital transitions ──
  function hexToBits(h) {
    let b = '';
    for (const c of h) b += parseInt(c, 16).toString(2).padStart(4, '0');
    return b;
  }

  if (hexSamples.length > 1) {
    let prevBits = hexToBits(hexSamples[0].hex);
    for (let i = 1; i < hexSamples.length; i++) {
      const currBits = hexToBits(hexSamples[i].hex);
      if (hexSamples[i].hex !== hexSamples[i - 1].hex) {
        const changes = [];
        for (let b = 0; b < Math.min(prevBits.length, currBits.length, R.digitalLabels.length); b++) {
          if (prevBits[b] !== currBits[b] && R.digitalLabels[b] !== '*') {
            changes.push({
              label: R.digitalLabels[b],
              asserted: currBits[b] === '1',
              bitIdx: b,
            });
          }
        }
        if (changes.length) {
          // Compute time: each digital sample = samPerCycD samples/cycle = 4 at 60Hz
          // digital sample interval = 1/(freq * samPerCycD) seconds
          const freq = R.eventInfo.freq || 60;
          const digitalRate = R.eventInfo.samPerCycD || 4;
          const intervalMs = 1000 / (freq * digitalRate);
          // Time relative to first digital sample
          const timeMs = i * intervalMs;
          // Time relative to trigger
          // Find which digital sample index is closest to trigger analog index
          const trigDigital = hexSamples.findIndex(h => h.sampleIdx >= triggerIdx);
          const relTimeMs = (i - (trigDigital >= 0 ? trigDigital : 0)) * intervalMs;

          R.digitalTransitions.push({
            digitalSampleIdx: i,
            analogSampleIdx: hexSamples[i].sampleIdx,
            lineNum: hexSamples[i].lineNum,
            timeMs,
            relTimeMs,
            changes,
          });
        }
      }
      prevBits = currBits;
    }
  }

  // Also capture the initial state
  if (hexSamples.length > 0) {
    const initBits = hexToBits(hexSamples[0].hex);
    R.initialDigitalState = [];
    for (let b = 0; b < Math.min(initBits.length, R.digitalLabels.length); b++) {
      if (initBits[b] === '1' && R.digitalLabels[b] !== '*') {
        R.initialDigitalState.push(R.digitalLabels[b]);
      }
    }
  }

  // ── Parse settings section ──
  // Try "Group 1" first (651R), then "Group Settings" (751), then "Global Settings"
  let settingsStart = text.indexOf('Group 1');
  if (settingsStart < 0) settingsStart = text.indexOf('Group Settings');
  if (settingsStart < 0) settingsStart = text.indexOf('Global Settings');
  if (settingsStart < 0) settingsStart = text.indexOf('Logic Settings');
  if (settingsStart < 0) {
    // No settings section found — try to parse TR/SV directly from anywhere in file
    settingsStart = 0;
  }
  const S = text.substring(settingsStart);
  R.settingsText = S;

  const m = (re) => { const x = S.match(re); return x ? x[1] : null; };
  const mf = (re) => { const v = m(re); return v ? parseFloat(v) : null; };

  // CT/PT ratios — use values from event summary if already set (SEL-751), otherwise parse from settings
  if (!R.settings.CTR) R.settings.CTR = mf(/CTR\s*:=\s*([\d.]+)/);
  // Parse PT ratios without requiring a word-boundary before the setting name. Using \b here
  // prevented matches when the parameter name was immediately preceded by a non-word character
  // (e.g. parentheses). Removing \b allows matching PTRY, PTR and PTRZ in typical settings lines
  // like "PTRY := 40.00".
  if (!R.settings.PTRY) R.settings.PTRY = mf(/PTRY\s*:=\s*([\d.]+)/) || mf(/PTR\s*:=\s*([\d.]+)/);
  if (!R.settings.PTRZ) R.settings.PTRZ = mf(/PTRZ\s*:=\s*([\d.]+)/) || R.settings.PTRY;
  if (!R.settings.VNOM) R.settings.VNOM = mf(/VNOM\s*:=\s*([\d.]+)/);
  R.settings.RID = m(/RID\s*:=([^\r\n]+)/);
  R.settings.TID = m(/TID\s*:=([^\r\n]+)/);

  R.settings.VYRCF = [mf(/V1YRCF\s*:=\s*([\d.]+)/)||1, mf(/V2YRCF\s*:=\s*([\d.]+)/)||1, mf(/V3YRCF\s*:=\s*([\d.]+)/)||1];
  R.settings.VZRCF = [mf(/V1ZRCF\s*:=\s*([\d.]+)/)||1, mf(/V2ZRCF\s*:=\s*([\d.]+)/)||1, mf(/V3ZRCF\s*:=\s*([\d.]+)/)||1];

  // ── Trip/Fault/Reclose equations — handle multiple naming conventions ──
  //
  // Robust equation matcher. An SEL setting name is a *standalone token*: it sits at the
  // left edge of its column, preceded by either the start of a line or whitespace, and is
  // never part of a longer identifier. The previous approach used /TR\s*:=/ which happily
  // matched the "TR" *inside* "CTR := 40", grabbing the CT-ratio line instead of the real
  // trip equation. It could equally have latched onto PTR, BFTR, REMTRIP, ULTRIP, 50ITRC,
  // RSTTRGT, etc. — any setting name containing the letters we searched for.
  //
  // matchEquation() tries a list of candidate names in priority order and, for each, requires
  // a proper left boundary: (?:^|[^A-Z0-9_]) means "start of line, or a character that is not
  // part of an identifier". The trailing \s*:= gives an implicit right boundary, so "TRIP"
  // will not match "TRIPLED :=" (after "TRIP" comes "LED", not ":=") nor "TRIP3P :=".
  // The `m` flag lets ^ anchor to any line start, and matching is done against the whole
  // settings section so a name appearing as a 2nd/3rd column on a shared line is still found.
  //
  // IMPORTANT: the trip equation is NOT always named "TR". Different relays / site templates
  // use TR3P, TRIP3P, TRIP, or TR. We try the most specific names first so that, when several
  // are present, the canonical three-phase trip wins over a bare/legacy alias.
  const matchEquation = (names) => {
    for (const name of names) {
      // Escape any regex-special chars in the name (e.g. digits are fine, but be safe).
      const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(?:^|[^A-Z0-9_])' + safe + '\\s*:=([^\\r\\n]+)', 'm');
      const x = S.match(re);
      if (x) return { name, value: x[1].trim() };
    }
    return null;
  };

  // Primary trip equation. Order matters: specific 3-phase names before the bare "TR".
  const trHit = matchEquation(['TR3P', 'TRIP3P', 'TRIP', 'TR']);
  R.tripEquation = trHit ? trHit.value : '';
  R.tripEquationName = trHit ? trHit.name : '';

  // TR3X / TRIP3X is the "unconditional trip" / "trip on external" path.
  const trxHit = matchEquation(['TR3X', 'TRIP3X', 'TRX']);
  R.tripEquationX = trxHit ? trxHit.value : '';

  // FAULT can legitimately appear outside the group-settings slice, so search full text —
  // but still require a standalone-token boundary to avoid partial matches.
  const faultHit = (() => {
    const x = text.match(/(?:^|[^A-Z0-9_])FAULT\s*:=([^\r\n]+)/m);
    return x ? x[1].trim() : '';
  })();
  R.faultEquation = faultHit;

  const riHit = matchEquation(['79RI3P', '79RI']);
  R.recloseEquation = riHit ? riHit.value : '';

  const dtHit = matchEquation(['79DTL3P', '79DTL']);
  R.dtlEquation = dtHit ? dtHit.value : '';

  // ER (Event Report trigger) — a SELOGIC equation distinct from TR/TR3P. Engineers program
  // this to capture diagnostic snapshots (e.g. a protection element pickup) WITHOUT tripping
  // the breaker — e.g. "ER := R_TRIG 51G1 OR R_TRIG 50P1". When a record's EVENT field reads
  // something other than TRIP (commonly "ER"), this equation — not TR — explains why the
  // relay generated the report at all.
  const erHit = matchEquation(['ER3P', 'ER']);
  R.erEquation = erHit ? erHit.value : '';
  R.erEquationName = erHit ? erHit.name : '';

  // OC elements — built generically across every instantaneous/def-time family (50P/50G/50Q/50N,
  // levels 1-4) and every inverse-time family (51P, 51G1, 51G2, 51Q, 51N1, 51N2) rather than
  // hardcoding just the ones enabled on one particular site. A site with ground/neg-seq/neutral
  // overcurrent enabled (E50Q, E50N, E51G2, E51Q, E51N1, E51N2 = 1) now gets pickup coverage too;
  // families left OFF/disabled on a given file simply yield null pickups and are skipped later.
  R.overcurrentElements = {
    E50P: m(/E50P\s*:=\s*(\S+)/) || 'N', E50G: m(/E50G\s*:=\s*(\S+)/) || 'N',
    E50Q: m(/E50Q\s*:=\s*(\S+)/) || 'N', E50N: m(/E50N\s*:=\s*(\S+)/) || 'N',
    E51P: m(/E51P\s*:=\s*(\S+)/) || 'N', E51G1: m(/E51G1\s*:=\s*(\S+)/) || 'N',
    E51G2: m(/E51G2\s*:=\s*(\S+)/) || 'N', E51Q: m(/E51Q\s*:=\s*(\S+)/) || 'N',
    E51N1: m(/E51N1\s*:=\s*(\S+)/) || 'N', E51N2: m(/E51N2\s*:=\s*(\S+)/) || 'N',
  };
  ['50P', '50G', '50Q', '50N'].forEach(fam => {
    for (let lvl = 1; lvl <= 4; lvl++) {
      R.overcurrentElements[`${fam}${lvl}P`] = mf(new RegExp(`${fam}${lvl}P\\s*:=\\s*([\\d.]+)`));
      R.overcurrentElements[`${fam}${lvl}D`] = mf(new RegExp(`${fam}${lvl}D\\s*:=\\s*([\\d.]+)`));
      // TORQUE CONTROL. An overcurrent element with its torque-control equation de-asserted
      // does not operate no matter how far over pickup the current goes — so a table that
      // compares magnitude against pickup alone can report "asserted" for an element the relay
      // has deliberately disabled. Real example in the wild: 50G1TC/51G1TC := LT01 with LT01
      // never asserting for the whole record, so the relay's own 51G1 bit stayed low the entire
      // fault while raw magnitude sat at 3x pickup.
      R.overcurrentElements[`${fam}${lvl}TC`] = m(new RegExp(`${fam}${lvl}TC\\s*:=\\s*(.+)`));
    }
  });
  ['51P', '51G1', '51G2', '51Q', '51N1', '51N2'].forEach(fam => {
    R.overcurrentElements[`${fam}JP`] = mf(new RegExp(`${fam}JP\\s*:=\\s*([\\d.]+)`));
    R.overcurrentElements[`${fam}JC`] = m(new RegExp(`${fam}JC\\s*:=\\s*(\\S+)`));
    R.overcurrentElements[`${fam}JTD`] = mf(new RegExp(`${fam}JTD\\s*:=\\s*([\\d.]+)`));
    R.overcurrentElements[`${fam}TC`] = m(new RegExp(`${fam}TC\\s*:=\\s*(.+)`));
  });

  // Voltage element pickups — Y and Z terminal, phase levels 1-4, phase-to-phase, and the
  // sequence family (zero/neg/pos-seq overvoltage: 59#N1/N2, 59#Q1, 59#V1).
  const vPairs = [];
  ['Y', 'Z'].forEach(t => {
    for (let lvl = 1; lvl <= 4; lvl++) vPairs.push(`27${t}P${lvl}P`, `59${t}P${lvl}P`);
    vPairs.push(`27${t}PP1P`, `59${t}PP1P`, `59${t}N1P`, `59${t}N2P`, `59${t}Q1P`, `59${t}V1P`);
  });
  vPairs.forEach(k => {
    const re = new RegExp(k.replace(/([()])/g,'\\$1') + '\\s*:=\\s*([\\d.]+|OFF)');
    const vm = S.match(re);
    R.voltageElements[k] = vm && vm[1] !== 'OFF' ? parseFloat(vm[1]) : null;
  });

  // Frequency elements
  for (let i = 1; i <= 6; i++) {
    R.freqElements[`81D${i}P`] = mf(new RegExp(`81D${i}P\\s*:=\\s*([\\d.]+)`));
    R.freqElements[`81D${i}E`] = mf(new RegExp(`81D${i}E\\s*:=\\s*([\\d.]+)`));
  }

  // SV equations
  const svRe = /SV(\d{2})PU\s*:=\s*([\d.]+)\s+SV\d{2}DO\s*:=\s*([\d.]+)\s*\n\s*SV\d{2}\s*:=([^\n]+)/g;
  let svM;
  while ((svM = svRe.exec(S)) !== null) {
    const eq = svM[4].trim();
    if (eq === 'NA') continue;
    R.svSettings.push({
      num: parseInt(svM[1]),
      label: `SV${svM[1].padStart(2, '0')}`,
      pickupDelay: parseFloat(svM[2]),
      dropoutDelay: parseFloat(svM[3]),
      equation: eq,
    });
  }

  // ── Store debug info ──
  R._debug = {
    hexSampleCount: hexSamples.length,
    hexBitLength: hexSamples.length > 0 ? hexSamples[0].hex.length * 4 : 0,
    allHexIdentical: hexSamples.length > 1 && new Set(hexSamples.map(h => h.hex)).size === 1,
    dataStartLine,
    dataHdrIdx: dataHdrIdx ?? -1,
    analogRowCount: R.analogData.length,
    digitalLabelCount: R.digitalLabels.length,
    transitionCount: R.digitalTransitions.length,
    settingsStart: settingsStart,
  };

  calibrateAnalogBasis(R);

  return R;
}

// ════════════════════════════════════════════════════════════════════════════
// ANALOG BASIS CALIBRATION
// ════════════════════════════════════════════════════════════════════════════
// TWO independent conventions govern how a CEV's analog columns relate to the relay's
// pickup settings. Getting either one wrong silently corrupts every pickup comparison in
// the Protection tab — and neither is reliably stated anywhere in the file's own headers:
//
//  1. PRIMARY vs SECONDARY.  SEL pickup settings (50P1P, 50G1P, 51PJP, VNOM, …) are ALWAYS
//     expressed in CT/PT SECONDARY terms. The exported analog channels may be secondary OR
//     primary. A SEL-651R recloser exports PRIMARY amps with a bare "IA" header that says
//     nothing about it. Comparing a primary-amp channel straight against a secondary-amp
//     pickup overstates every element by the CT ratio — for CTR=100 that is a factor of 100,
//     which is exactly how a 13 A-secondary (1300 A primary) 50P1 comes to read "asserted,
//     7.96x pickup" on a fault that never exceeded ~350 A primary and that the relay's own
//     50P1 bit correctly never asserted for.
//
//  2. RMS-SCALED vs TRUE-INSTANTANEOUS SAMPLES.  A *filtered* CEV ("Report Type: CEV,
//     Filtered") carries the relay's digital-filter output scaled so the sinusoid's
//     AMPLITUDE equals the RMS phasor magnitude — that is why SynchroWAVe's ".Mag" traces
//     for such a file peak at the same numbers the event summary quotes as fault currents.
//     Taking a conventional RMS of those samples divides by an extra sqrt(2) and understates
//     every magnitude by ~29%. An unfiltered/raw report needs no such correction, so this
//     can NOT be hardcoded — it has to be measured per file.
//
// Both are therefore calibrated against references the relay itself produced and put in
// this very file:
//   * the event-summary fault currents (IA/IB/IC/IG) — the relay's own magnitudes, primary
//     amps RMS, for this exact record;
//   * VNOM x PTR — nominal primary phase voltage — against the measured pre-fault voltage.
// The measured ratio is SNAPPED to the nearest physically meaningful candidate rather than
// used raw, because a one-cycle sliding window smears a short or decaying fault peak by a
// few percent (observed ratios of 1.42-1.55 all mean sqrt(2), not "1.48"). If a file offers
// no usable reference, the scale stays 1.0 — identical to the previous behaviour — and the
// uncertainty is surfaced in the UI rather than hidden.

// Whether this file's analog channels are primary-referred. Single shared definition so the
// protection table, the consistency checks and the calibration can never disagree: an
// explicit PRIM_VAL flag wins where present (SEL-751 style), otherwise the "(kV)" voltage
// unit label is the fallback tell for formats that expose no flag at all (SEL-651R).
function analogDataIsPrimary(P) {
  if (P?.settings?.primaryValues !== undefined && P?.settings?.primaryValues !== null) return P.settings.primaryValues;
  return detectChannelUnit(P, ['VA', 'VAY', 'VB', 'VBY'], '').toUpperCase() === 'KV';
}

// Snap an observed ratio to the nearest candidate in log space, but refuse to snap at all if
// nothing is within ~25% — a wild ratio means the reference isn't what we assumed it was, and
// falling back to "uncalibrated" is safer than confidently applying a fabricated scale.
function snapToCandidate(ratio, candidates) {
  let best = null, bestErr = Infinity;
  for (const c of candidates) {
    const err = Math.abs(Math.log(ratio / c.v));
    if (err < bestErr) { bestErr = err; best = c; }
  }
  return (best && bestErr <= Math.log(1.25)) ? best : null;
}

function medianOf(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function calibrateAnalogBasis(R) {
  // magScale multiplies every computed RMS/phasor magnitude to turn it into the true RMS
  // phasor magnitude in the channel's own units. 1.0 = no correction (raw instantaneous data).
  R.magScale = 1;
  R.basisCalibration = { magScale: 1, source: 'none', confidence: 'uncalibrated', detail:
    'No in-file reference (event-summary fault currents or VNOM x PTR) was available to calibrate magnitude scaling; magnitudes are shown as a conventional RMS of the samples.' };

  const data = R.analogData || [];
  if (!data.length) return;
  const N = R.eventInfo?.samPerCycA || 32;
  const CTR = R.settings?.CTR || 1;
  const PTR = R.settings?.PTRY || 1;
  const isPrimary = analogDataIsPrimary(R);
  const voltIsKV = detectChannelUnit(R, ['VA', 'VAY', 'VB', 'VBY'], '').toUpperCase() === 'KV';

  const peakMag = (key) => {
    const s = data.map(r => r[key] || 0);
    if (!s.some(v => Math.abs(v) > 1e-9)) return null;
    const m = computeRmsMagnitude(s, N);
    const p = Math.max(...m);
    return p > 0 ? p : null;
  };

  // ── Reference 1: the relay's own fault currents ──────────────────────────────
  // hdr[ch] is primary amps RMS; obs is what we compute from the samples, so
  // obs * (isPrimary ? 1 : CTR) is our primary-amp estimate and the leftover ratio is
  // purely the magnitude-scaling question.
  const hdr = R.eventInfo?.faultCurrents || {};
  const basisFactor = isPrimary ? 1 : CTR;
  const iRatios = [];
  for (const ch of ['IA', 'IB', 'IC', 'IG']) {
    const ref = hdr[ch], obs = peakMag(ch);
    if (ref > 0 && obs > 0) iRatios.push(ref / (obs * basisFactor));
  }

  // ── Reference 2: nominal voltage ─────────────────────────────────────────────
  // VNOM is secondary volts; VNOM * PTR is nominal primary volts. Compared against the
  // MEDIAN phase-voltage magnitude (robust: voltage sits at nominal for most of a record
  // even when it sags briefly during the fault).
  let vRatio = null;
  if (R.settings?.VNOM > 0) {
    const vRefChannelUnits = isPrimary ? (R.settings.VNOM * PTR) / (voltIsKV ? 1000 : 1) : R.settings.VNOM;
    const meds = [];
    for (const ch of ['VAY', 'VBY', 'VCY', 'VA', 'VB', 'VC']) {
      const s = data.map(r => r[ch] || 0);
      if (!s.some(v => Math.abs(v) > 1e-9)) continue;
      const m = medianOf(computeRmsMagnitude(s, N));
      if (m > 0) meds.push(m);
    }
    const obsV = medianOf(meds);
    if (obsV > 0 && vRefChannelUnits > 0) vRatio = vRefChannelUnits / obsV;
  }

  const CANDIDATES = [
    { v: 1, scale: 1, name: 'instantaneous samples (no correction)' },
    { v: Math.SQRT2, scale: Math.SQRT2, name: 'RMS-scaled filtered data (x sqrt(2))' },
  ];

  const iHit = iRatios.length ? snapToCandidate(medianOf(iRatios), CANDIDATES) : null;
  const vHit = vRatio ? snapToCandidate(vRatio, CANDIDATES) : null;

  const chosen = iHit || vHit;
  if (!chosen) return;

  const agree = iHit && vHit && iHit.scale === vHit.scale;
  R.magScale = chosen.scale;
  R.basisCalibration = {
    magScale: chosen.scale,
    isPrimary,
    source: iHit && vHit ? 'event-summary fault currents + VNOM x PTR' : iHit ? 'event-summary fault currents' : 'VNOM x PTR',
    confidence: agree ? 'high (two independent references agree)'
              : (iHit && vHit) ? 'low (references disagree — current reference used)'
              : 'medium (single reference)',
    observedCurrentRatio: iRatios.length ? +medianOf(iRatios).toFixed(3) : null,
    observedVoltageRatio: vRatio ? +vRatio.toFixed(3) : null,
    detail: `Analog channels read as ${isPrimary ? 'PRIMARY' : 'SECONDARY'}-referred; magnitudes ${chosen.scale === 1 ? 'need no scaling correction' : 'scaled by sqrt(2)'} (${chosen.name}).`,
  };
}


// ════════════════════════════════════════════════════════════════════════════
// ANALYSIS ENGINE
// ════════════════════════════════════════════════════════════════════════════

function calcU1Time(multiple, td) {
  if (multiple <= 1) return Infinity;
  return td * (0.0226 + 0.0104 / (Math.pow(multiple, 0.02) - 1));
}

// `scale` is the per-file magnitude calibration from calibrateAnalogBasis() (P.magScale):
// 1.0 for true instantaneous samples, sqrt(2) for RMS-scaled filtered data. Defaulting it to
// 1 keeps every uncalibrated/other-format caller behaving exactly as before.
function computeRMS(arr, key, scale = 1) {
  if (!arr.length) return 0;
  return scale * Math.sqrt(arr.reduce((s, r) => s + r[key] * r[key], 0) / arr.length);
}

