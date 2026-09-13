
// ════════════════════════════════════════════════════════════════════════════
// CEV PARSER
// ════════════════════════════════════════════════════════════════════════════

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
    const line1Parts = lines[1]?.replace(/"/g, '').split(',') || [];
    R.device = line1Parts[0] || '';
    // SER_NUM (4th field on the FID line) identifies the physical relay. Used to reconcile
    // the VNOM L-L/L-N convention across multiple events from the same device — see
    // reconcileVnomAcrossEvents() — since that convention is fixed by the relay's PT wiring
    // and cannot differ between two records from the same unit with the same CTR/PTR/VNOM.
    R.serialNumber = line1Parts[3] || '';
  } else {
    R.format = 'sel651r';
    R.fid = line0.split(',')[0] || '';
    R.device = line1.split(',')[0] || '';
    R.serialNumber = '';
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
    // SEL-751 event-summary headers put a unit suffix on every measurement column — "IA(A)",
    // "IG(A)", "VA(V)" — while other formats use the bare name. Matching only the bare name
    // silently returned null for all of them, which left calibrateAnalogBasis() with no
    // fault-current reference at all and no way to notice the file was mis-scaled.
    const findIdx = (key) => {
      const direct = hdr.indexOf(key);
      if (direct >= 0) return direct;
      return hdr.findIndex(h => h.replace(/\s*\([^)]*\)\s*$/, '').trim() === key);
    };
    const get = (key) => { const idx = findIdx(key); return idx >= 0 ? vals[idx] : null; };

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
  // The Event Report trigger equation. Every record in a CEV set exists because ONE of this
  // equation's terms asserted, and on a device whose ER list includes supervision bits
  // (SV10T, 52A3P, …) that term is frequently NOT a trip — which is exactly the case that
  // makes a reader ask "why is there an event here at all?". Anchored on a non-word char so
  // it cannot match the tail of LDAR/SER/PRE.
  R.settings.EReq = m(/(?:^|[^A-Z0-9_])ER\s*:=([^\r\n]+)/m);

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

  // Full ANSI 79 scheme — the two equations above are what the trip-cause tracer needs; the
  // Reclosing tab needs the whole picture (shot count, open intervals, reset timers, and
  // every supervision equation), so it's parsed once here and hung off the parsed record.
  R.reclose = parseRecloseScheme(S, text);

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

  // SEL-751 names its inverse-time elements by LEVEL — 51P1P / 51P1C / 51P1TD — where the
  // SEL-651R this parser was first built against uses the "J curve" form, 51PJP / 51PJC /
  // 51PJTD. Same element, different convention, and looking only for the J form meant every
  // SEL-751 file produced an EMPTY inverse-time table: on 35KV CLEARSKY record 10722, a
  // phase-to-ground fault, both 51P1 (7.50 A sec) and 51G1 (1.00 A sec) were configured and
  // neither appeared anywhere in the Protection tab. Filled in under the same J-form keys the
  // row builder already reads, and only where the J form didn't already match, so 651R files
  // are untouched.
  ['51P1', '51P2', '51G1', '51G2', '51N1', '51N2', '51Q'].forEach(fam => {
    if (R.overcurrentElements[`${fam}JP`] != null) return;
    const jp = mf(new RegExp(`(?:^|[^A-Z0-9])${fam}P\\s*:=\\s*([\\d.]+)`, 'm'));
    if (jp == null) return;
    R.overcurrentElements[`${fam}JP`] = jp;
    R.overcurrentElements[`${fam}JC`] = m(new RegExp(`(?:^|[^A-Z0-9])${fam}C\\s*:=\\s*(\\S+)`, 'm'));
    R.overcurrentElements[`${fam}JTD`] = mf(new RegExp(`(?:^|[^A-Z0-9])${fam}TD\\s*:=\\s*([\\d.]+)`, 'm'));
    if (!R.overcurrentElements[`${fam}TC`]) R.overcurrentElements[`${fam}TC`] = m(new RegExp(`(?:^|[^A-Z0-9])${fam}TC\\s*:=\\s*(.+)`, 'm'));
  });

  // Voltage element pickups — Y and Z terminal, phase levels 1-4, phase-to-phase, and the
  // sequence family (zero/neg/pos-seq overvoltage: 59#N1/N2, 59#Q1, 59#V1).
  const vPairs = [];
  ['Y', 'Z'].forEach(t => {
    for (let lvl = 1; lvl <= 4; lvl++) vPairs.push(`27${t}P${lvl}P`, `59${t}P${lvl}P`);
    vPairs.push(`27${t}PP1P`, `59${t}PP1P`, `59${t}N1P`, `59${t}N2P`, `59${t}Q1P`, `59${t}V1P`);
  });
  // SEL-751 voltage elements carry NO Y/Z terminal letter (27P1P, 59P1P, 27PP1P) and name the
  // residual/zero-sequence overvoltage element 59G — where the 651R uses 59YN. Neither form was
  // recognised, so the whole voltage table came out empty on every SEL-751 file. That is the
  // direct cause of "59G1 asserted but nothing listed for it" on record 10722.
  //
  // The left-boundary guard is what keeps the two conventions apart: without it the bare key
  // "59P1P" would happily match inside a 651R's "59YP1P" and cross-wire the two namings.
  for (let lvl = 1; lvl <= 4; lvl++) vPairs.push(`27P${lvl}P`, `59P${lvl}P`);
  vPairs.push('27PP1P', '27PP2P', '59PP1P', '59PP2P', '59G1P', '59G2P', '59Q1P', '59Q2P', '59V1P');
  vPairs.forEach(k => {
    const re = new RegExp('(?:^|[^A-Z0-9])' + k.replace(/([()])/g,'\\$1') + '\\s*:=\\s*([\\d.]+|OFF)', 'm');
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
function snapToCandidate(ratio, candidates, tol = 1.25) {
  let best = null, bestErr = Infinity;
  for (const c of candidates) {
    const err = Math.abs(Math.log(ratio / c.v));
    if (err < bestErr) { bestErr = err; best = c; }
  }
  return (best && bestErr <= Math.log(tol)) ? best : null;
}

function medianOf(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ── Calibration reference 3: the relay's own element bits ────────────────────
// The strongest reference in the file, and the one that was sitting unused. Every voltage
// element bit the record carries (27YA1, 59YB3, …) is the relay's own verdict on whether a
// measured phase was above or below a pickup this file also states. Recompute that decision
// from the samples under a candidate magnitude scale and compare: the scale that reproduces
// the relay's bits is the right one, and a scale that contradicts them is provably wrong no
// matter how plausible the ratio arithmetic looked.
//
// This is worth having even when another reference already answered, because the failure mode
// it catches is silent — a wrong scale produces a perfectly reasonable-looking voltage that
// happens to disagree with the relay by sqrt(2). On STATION A 19565 the tool reported the bus
// at 77% of nominal (an undervoltage) while the record's own 59Y*3 overvoltage bits were
// asserted throughout. Nothing else in the analysis noticed.
//
// Samples within 2% of a pickup are skipped: element hysteresis and the relay's own filtering
// make the boolean genuinely ambiguous right at the threshold, and scoring those would add
// noise in exactly the region where the comparison is least informative.
function elementBitCrossCheck(R, scale) {
  const data = R.analogData || [];
  const labels = R.digitalLabels || [];
  if (!data.length || !labels.length) return null;
  const N = R.eventInfo?.samPerCycA || 32;
  const isPrimary = analogDataIsPrimary(R);
  const voltIsKV = detectChannelUnit(R, ['VA', 'VAY', 'VB', 'VBY'], '').toUpperCase() === 'KV';
  const TERMS = {
    Y: { A: 'VAY', B: 'VBY', C: 'VCY', ptr: R.settings?.PTRY || 1 },
    Z: { A: 'VAZ', B: 'VBZ', C: 'VCZ', ptr: R.settings?.PTRZ || R.settings?.PTRY || 1 },
  };
  const toSec = (raw, ptr) => {
    const primaryKV = isPrimary ? (voltIsKV ? raw : raw / 1000) : (raw * ptr) / 1000;
    return primaryKV * 1000 / ptr;
  };
  const series = {};
  for (const T of Object.keys(TERMS)) {
    for (const ph of ['A', 'B', 'C']) {
      const s = data.map(r => r[TERMS[T][ph]] || 0);
      series[T + ph] = s.some(v => Math.abs(v) > 1e-9) ? computeRmsMagnitude(s, N, scale) : null;
    }
  }
  const step = Math.max(N, Math.floor(data.length / 12));
  const pts = [];
  for (let i = N; i < data.length; i += step) pts.push(i);
  if (!pts.length) return null;

  let agree = 0, total = 0;
  for (const T of Object.keys(TERMS)) {
    for (let lvl = 1; lvl <= 4; lvl++) {
      for (const kind of ['27', '59']) {
        const pickup = getSettingNum(R, [`${kind}${T}P${lvl}P`]);
        if (pickup == null || !(pickup > 0)) continue;
        for (const ph of ['A', 'B', 'C']) {
          const bit = `${kind}${T}${ph}${lvl}`;
          if (!labels.includes(bit)) continue;
          const sr = series[T + ph];
          if (!sr) continue;
          for (const i of pts) {
            const secV = toSec(sr[i] || 0, TERMS[T].ptr);
            if (Math.abs(secV - pickup) < pickup * 0.02) continue;
            const expect = kind === '27' ? secV < pickup : secV > pickup;
            const actual = bitStateAtAnalogIdx(R, bit, i).state;
            total++;
            if (expect === actual) agree++;
          }
        }
      }
    }
  }
  return total ? { agree, total, rate: agree / total } : null;
}

function calibrateAnalogBasis(R) {
  // magScale multiplies every computed RMS/phasor magnitude to turn it into the true RMS
  // phasor magnitude in the channel's own units. 1.0 = no correction (raw instantaneous data).
  R.magScale = 1;
  R.basisCalibration = { magScale: 1, source: 'none', confidence: 'uncalibrated', detail:
    'No in-file reference (event-summary fault currents or VNOM x PTR) was available to calibrate magnitude scaling; magnitudes are shown as a conventional RMS of the samples.' };
  // Whether this file's VNOM setting is nominal phase-to-PHASE or phase-to-NEUTRAL secondary
  // voltage (see the V_CANDIDATES note below) — null until/unless the voltage reference below
  // resolves it. Set here (not just alongside R.magScale) so it still defaults sanely on any
  // early return in this function, and consulted anywhere VNOM x PTR is used to state an
  // expected PRIMARY voltage (e.g. the top-bar "Expected V(L-N) primary" figure).
  R.vnomIsPhaseToPhase = null;

  const data = R.analogData || [];
  if (!data.length) return;
  const N = R.eventInfo?.samPerCycA || 32;
  const CTR = R.settings?.CTR || 1;
  const PTR = R.settings?.PTRY || 1;
  const isPrimary = analogDataIsPrimary(R);
  const voltIsKV = detectChannelUnit(R, ['VA', 'VAY', 'VB', 'VBY'], '').toUpperCase() === 'KV';

  // The relay's event-summary fault currents are all sampled at ONE instant — the fault — not
  // at each channel's individual maximum. Comparing each channel against its own peak over the
  // whole record therefore compares two different moments: on SEL-751 record 10824 that made
  // IA read 244 A (its own late peak) against a summary value of 126.6 A, a spurious 0.52
  // ratio that dragged the median away from the truth. Locating the common instant first —
  // the sample where phase current is greatest — makes all four channels agree to 0.3%.
  const magSeries = {};
  const seriesFor = (key) => {
    if (!(key in magSeries)) {
      const arr = data.map(r => r[key] || 0);
      magSeries[key] = arr.some(v => Math.abs(v) > 1e-9) ? computeRmsMagnitude(arr, N) : null;
    }
    return magSeries[key];
  };
  let faultIdx = 0, faultPeak = -1;
  for (let i = 0; i < data.length; i++) {
    let m = 0;
    for (const ch of ['IA', 'IB', 'IC']) { const sr = seriesFor(ch); if (sr && sr[i] > m) m = sr[i]; }
    if (m > faultPeak) { faultPeak = m; faultIdx = i; }
  }
  const peakMag = (key) => {
    const sr = seriesFor(key);
    if (!sr) return null;
    const v = sr[faultIdx];
    return v > 0 ? v : null;
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
    // Median over the PRE-FAULT window only. Taking it over the whole record silently assumes
    // voltage sits near nominal for most of the file, which is false for any record that keeps
    // capturing after the breaker opens. On SEL-751 record 10824 the bus is dead for more than
    // half the capture, so the whole-record median was exactly 0 — the reference evaluated to
    // zero, vRatio came out null, and the file fell through to "uncalibrated" with no warning.
    // Two corrections to the window, both learned from records where the trigger sits at the
    // very start of the capture:
    //
    //   * The sliding-RMS needs a full cycle of history behind it, so the first N samples of
    //     the series are a filter ramp, not a measurement. Including them drags the median low.
    //   * `pfEnd = triggerSampleIndex` is only a pre-fault window if the trigger is actually
    //     some distance in. On a record triggered at sample 15 of 960, "slice(0, 15)" is 15
    //     ramp samples and nothing else — on STATION A 19565 that produced a reference 6% low,
    //     which is enough to miss the sqrt(2) candidate's 10% window entirely and drop the whole
    //     file to "uncalibrated" with magScale 1. Every voltage in the file then read 1/sqrt(2)
    //     of its true value: 77% of nominal for a bus the relay's own 108% element was picked
    //     up on. A too-short pre-fault window is no window at all — use the whole record, which
    //     is the correct reference precisely in this case (breaker already open, source-side
    //     voltage steady from end to end).
    const trigIdx = R.triggerSampleIndex;
    const lo = Math.min(N, Math.max(0, data.length - 1));
    const hi = (trigIdx != null && trigIdx >= lo + N) ? trigIdx : data.length;
    const meds = [];
    for (const ch of ['VAY', 'VBY', 'VCY', 'VA', 'VB', 'VC']) {
      const s = data.map(r => r[ch] || 0);
      if (!s.some(v => Math.abs(v) > 1e-9)) continue;
      const win = computeRmsMagnitude(s, N).slice(lo, hi).filter(v => v > 0);
      if (win.length < Math.max(4, N / 2)) continue;
      // The whole-record fallback above assumes voltage sits near nominal for MOST of the
      // record, which breaks the other way on a short capture that trips early and stays open
      // for the remainder: e.g. a trigger at sample 2 of 720 leaves ~715 samples in this window,
      // of which only the first ~20-30 are actually energized before the bus decays to ~0 for
      // the rest — 90%+ of the window is post-trip dead bus. A plain median over that window is
      // itself ~0, not "nominal", producing a nonsense vRatio (seen as high as 3800x on a real
      // CASH SOLAR "59 Trip" file) that should have snapped to a sane candidate. Restricting to
      // samples within 10% of THIS channel's own peak within the window isolates the settled
      // energized level (whichever portion of the window that is) from a decayed/dead tail or
      // lead, without assuming which end of the window is which. A looser threshold (tried at
      // 50%) still pulls in a wide swath of the post-trip RC-decay ramp — which decays at a
      // different rate on each phase — so the three per-channel medians disagreed by up to 40%;
      // tight to the peak (~90%+) is what actually converges all three channels on the same
      // settled value.
      const chMax = Math.max(...win);
      const dominant = win.filter(v => v >= chMax * 0.9);
      const m = medianOf(dominant.length ? dominant : win);
      if (m > 0) meds.push(m);
    }
    const obsV = medianOf(meds);
    if (obsV > 0 && vRefChannelUnits > 0) vRatio = vRefChannelUnits / obsV;
  }

  const CANDIDATES = [
    { v: 1, scale: 1, name: 'instantaneous samples (no correction)' },
    { v: Math.SQRT2, scale: Math.SQRT2, name: 'RMS-scaled filtered data (x sqrt(2))' },
  ];

  // The VOLTAGE reference carries a second ambiguity the current reference does not: VNOM may
  // be the nominal phase-to-PHASE secondary voltage while the channels are phase-to-neutral, or
  // vice versa, which puts a stray sqrt(3) in the ratio. On SEL-751 record 10824 VNOM = 120 is
  // phase-to-phase (measured 487 V primary L-L / PTR 4 = 122 V secondary) while VA/VB/VC are
  // phase-to-neutral at 281 V primary, giving an observed ratio of 1.707.
  //
  // That number is the whole reason this needs separate handling: sqrt(2) = 1.414 and
  // sqrt(3) = 1.732 are only 22% apart, so the 25% snap window used for currents cannot tell
  // them apart — 1.707 snapped to sqrt(2) and applied a 41% magnitude error to any file where
  // the voltage reference was the only one available. Enumerating the sqrt(3) variants
  // explicitly and tightening the window to 10% separates them cleanly (1.414 x 1.10 = 1.56
  // vs 1.732 / 1.10 = 1.57, no overlap) and makes the connection convention an explicit,
  // reported conclusion rather than a silent assumption.
  const V_CANDIDATES = [
    { v: 1, scale: 1, name: 'instantaneous samples, VNOM phase-to-neutral' },
    { v: Math.SQRT2, scale: Math.SQRT2, name: 'RMS-scaled filtered data, VNOM phase-to-neutral' },
    { v: Math.sqrt(3), scale: 1, name: 'instantaneous samples, VNOM phase-to-phase' },
    { v: Math.SQRT2 * Math.sqrt(3), scale: Math.SQRT2, name: 'RMS-scaled filtered data, VNOM phase-to-phase' },
  ];

  const iHit = iRatios.length ? snapToCandidate(medianOf(iRatios), CANDIDATES) : null;
  const vHit = vRatio ? snapToCandidate(vRatio, V_CANDIDATES, 1.10) : null;
  // Record the VNOM L-L/L-N determination independently of which reference ends up chosen for
  // magScale below (e.g. a file with clean event-summary fault currents will let iHit win the
  // magScale decision even though vHit — computed from actual VA/VB/VC samples vs VNOM x PTR —
  // is exactly what tells us whether VNOM is phase-to-phase or phase-to-neutral in this file).
  if (vHit) R.vnomIsPhaseToPhase = /phase-to-phase/.test(vHit.name);

  // Score both candidate scales against the record's own voltage element bits.
  const bitScores = CANDIDATES.map(c => ({ cand: c, score: elementBitCrossCheck(R, c.scale) }))
    .filter(x => x.score && x.score.total >= 6);
  const bestBit = bitScores.length ? bitScores.slice().sort((a, b) => b.score.rate - a.score.rate)[0] : null;
  const worstBit = bitScores.length > 1 ? bitScores.slice().sort((a, b) => a.score.rate - b.score.rate)[0] : null;
  // "Decisive" means one candidate reproduces the relay's own decisions and the other clearly
  // does not. Anything less and the bits are not separating the candidates — a record where
  // every phase sits far from every pickup scores 100% either way and says nothing.
  const bitDecisive = !!(bestBit && worstBit && bestBit.score.rate >= 0.9 && bestBit.score.rate - worstBit.score.rate >= 0.3);

  let chosen = iHit || vHit;
  let recovered = false;
  if (!chosen && bitDecisive) { chosen = bestBit.cand; recovered = true; }
  if (!chosen) return;

  // A ratio-derived scale that contradicts the relay's own bits is wrong. Say so loudly, and
  // prefer the bits — they are the relay's published answer, not an inference from a nominal.
  let overridden = false;
  if (!recovered && bitDecisive && bestBit.cand.scale !== chosen.scale) {
    chosen = bestBit.cand;
    overridden = true;
  }

  const agree = iHit && vHit && iHit.scale === vHit.scale;
  const bitNote = bestBit
    ? ` Cross-checked against ${bestBit.score.total} voltage-element bit comparisons in this record: x${bestBit.cand.scale === 1 ? '1' : 'sqrt(2)'} reproduces ${(bestBit.score.rate * 100).toFixed(0)}% of the relay's own pickup decisions${worstBit && worstBit !== bestBit ? `, versus ${(worstBit.score.rate * 100).toFixed(0)}% for x${worstBit.cand.scale === 1 ? '1' : 'sqrt(2)'}` : ''}.`
    : '';
  R.magScale = chosen.scale;
  R.basisCalibration = {
    magScale: chosen.scale,
    isPrimary,
    source: recovered ? 'relay voltage-element bits'
      : overridden ? 'relay voltage-element bits (overrode ratio reference)'
        : (iHit && vHit ? 'event-summary fault currents + VNOM x PTR' : iHit ? 'event-summary fault currents' : 'VNOM x PTR'),
    confidence: overridden ? 'medium (ratio reference contradicted the relay’s own element bits — bits used)'
      : recovered ? 'medium (recovered from the relay’s own element bits)'
        : agree ? 'high (two independent references agree)'
          : (iHit && vHit) ? 'low (references disagree — current reference used)'
            : (bitDecisive && bestBit.cand.scale === chosen.scale) ? 'high (ratio reference confirmed by the relay’s own element bits)'
              : 'medium (single reference)',
    observedCurrentRatio: iRatios.length ? +medianOf(iRatios).toFixed(3) : null,
    observedVoltageRatio: vRatio ? +vRatio.toFixed(3) : null,
    elementBitAgreement: bestBit ? { scale: bestBit.cand.scale, rate: +bestBit.score.rate.toFixed(3), samples: bestBit.score.total } : null,
    detail: `Analog channels read as ${isPrimary ? 'PRIMARY' : 'SECONDARY'}-referred; magnitudes ${chosen.scale === 1 ? 'need no scaling correction' : 'scaled by sqrt(2)'} (${chosen.name}).${bitNote}`,
  };
}

// The VNOM L-L/L-N convention (see calibrateAnalogBasis' V_CANDIDATES block) is fixed by how
// a relay's PTs are wired — it is a property of the physical device + settings, not of any one
// event. calibrateAnalogBasis() resolves it per-file from that file's own pre-fault voltage
// samples, which fails when a record's pre-fault window happens to be mostly dead bus with
// only a still-rising energization tail (seen on a real PV SEL-751 pair, events 11097/11098:
// 11097's pre-fault window sat settled at ~13.4 kV the whole way through and resolved cleanly;
// 11098, captured ~2m15s later, was de-energized for all but the last few samples before its
// trigger, so the "restrict to top 10% of window peak" logic caught only the mid-ramp tail and
// produced a ratio that snapped to neither candidate). When multiple events from the SAME
// device (matched by serial number, falling back to device string, + identical CTR/PTR/VNOM)
// are loaded together, borrow a confidently-resolved determination for any sibling whose own
// window came back null, rather than leaving it an unexplained "*". Does not touch magScale —
// only the VNOM L-L/L-N flag, which is what the top-bar "Expected V(L-N) primary" figure uses.
function reconcileVnomAcrossEvents(results) {
  const keyFor = (p) => [p.serialNumber || p.device || '', p.settings?.CTR, p.settings?.PTRY, p.settings?.VNOM].join('|');
  const byKey = {};
  for (const r of results) {
    if (!r.parsed || r.parsed.format === 'form6' || r.parsed.format === 'sel851') continue;
    if (r.parsed.vnomIsPhaseToPhase === undefined) continue; // no VNOM-based figure applies to this file at all
    const k = keyFor(r.parsed);
    (byKey[k] = byKey[k] || []).push(r);
  }
  for (const k in byKey) {
    const group = byKey[k];
    if (group.length < 2) continue;
    const resolved = group.find(r => r.parsed.vnomIsPhaseToPhase != null);
    if (!resolved) continue;
    for (const r of group) {
      if (r.parsed.vnomIsPhaseToPhase == null) {
        r.parsed.vnomIsPhaseToPhase = resolved.parsed.vnomIsPhaseToPhase;
        r.parsed.vnomInferredFromSibling = resolved.parsed.eventInfo?.refNum || resolved.parsed.fileName || 'a sibling event';
        if (r.parsed.basisCalibration) {
          r.parsed.basisCalibration.confidence = `medium (VNOM convention inferred from sibling event ${r.parsed.vnomInferredFromSibling} on the same relay — this file's own pre-fault window did not resolve it)`;
        }
      }
    }
  }
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
function computeRMS(arr, key, scale = 1, samplesPerCycle = null) {
  if (!arr.length) return 0;
  // On filtered quarter-cycle data a mean-of-squares returns |X|/sqrt(2) for the same reason
  // the point-by-point sliding RMS did (see isFilteredQuarterCycle), so the sqrt(2) has to go
  // back in. There is no exact pairwise substitute here because this is a window AVERAGE by
  // design — but over a window where the magnitude is roughly steady, which is exactly what the
  // pre-fault and fault summary windows are, the correction is exact.
  const filt = isFilteredQuarterCycle(samplesPerCycle) ? Math.SQRT2 : 1;
  return scale * filt * Math.sqrt(arr.reduce((s, r) => s + r[key] * r[key], 0) / arr.length);
}