
function analyzeCEV(P, prevEvent) {
  // prevEvent: optional { parsed, analysis } from the chronologically prior event
  const A = { voltages: {}, currents: {}, protectionStatus: [], voltageStatus: [],
              freqStatus: [], svChain: [], tripPath: [], tripCause: null,
              digitalTimeline: [], };

  const { settings, analogData, overcurrentElements: OC, voltageElements: VE,
          freqElements: FE, svSettings, triggerSampleIndex: trigIdx, digitalTransitions } = P;
  const CTR = settings.CTR || 1;
  const PTRY = settings.PTRY || 1;
  const PTRZ = settings.PTRZ || 1;
  const VNOM = settings.VNOM || 1;
  const freq = P.eventInfo.freq || 60;
  // Per-file magnitude calibration (see calibrateAnalogBasis): turns a conventional RMS of the
  // samples into the true RMS phasor magnitude in the channel's own units.
  const MAGS = P.magScale || 1;
  // Whether the CURRENT channels are primary-referred. Previously only the VOLTAGE path applied
  // this distinction; the current path assumed secondary unconditionally, which is precisely
  // what made primary-amp files (e.g. SEL-651R) read every overcurrent element as CTR times
  // over pickup.
  const iDataIsPrimary = analogDataIsPrimary(P);

  // Pre-fault / fault windows
  const pfEnd = Math.max(0, trigIdx > 0 ? trigIdx : Math.floor(analogData.length * 0.5));
  const pfStart = Math.max(0, pfEnd - 32);
  const preFault = analogData.slice(pfStart, pfEnd);
  const fStart = trigIdx > 0 ? trigIdx : Math.floor(analogData.length * 0.5);
  const fEnd = Math.min(analogData.length, fStart + 64);
  const faultData = analogData.slice(fStart, fEnd);

  // Voltage analysis
  // Raw channel data can be secondary-referred (the common case) or primary-referred, and
  // primary-referred data can itself be expressed in kV or in raw volts depending on the
  // relay/export format — these are two independent conventions that must be detected
  // separately (see the fuller explanation next to this same detection in
  // computeConsistencyCheck). Assuming one fixed convention here previously produced
  // secondaryV/primaryKV values off by orders of magnitude for files that don't match it.
  const isPrimaryDataV = (P.settings.primaryValues !== undefined && P.settings.primaryValues !== null)
    ? P.settings.primaryValues
    : detectChannelUnit(P, ['VA', 'VAY', 'VB', 'VBY'], '').toUpperCase() === 'KV';
  const voltChannelIsKV = detectChannelUnit(P, ['VA', 'VAY', 'VB', 'VBY'], '').toUpperCase() === 'KV';
  // Shared primary<->secondary converter (previously redefined per-terminal inline) — also
  // used below for sequence (3V0/V2/V1) and phase-to-phase magnitudes, which are derived from
  // the same raw channel arrays and need the identical basis conversion.
  const toKvSec = (raw, ptr) => {
    const primaryKV = isPrimaryDataV ? (voltChannelIsKV ? raw : raw / 1000) : (raw * ptr) / 1000;
    const secondaryV = primaryKV * 1000 / ptr;
    return { primaryKV, secondaryV };
  };
  ['yTerminal', 'zTerminal'].forEach(term => {
    const ptr = term === 'yTerminal' ? PTRY : PTRZ;
    const phases = term === 'yTerminal'
      ? { VA: 'VAY', VB: 'VBY', VC: 'VCY' }
      : { VA: 'VAZ', VB: 'VBZ', VC: 'VCZ' };

    A.voltages[term] = {};
    for (const [ph, key] of Object.entries(phases)) {
      const pfRaw = computeRMS(preFault, key, MAGS, P.eventInfo.samPerCycA);
      const fRaw = computeRMS(faultData, key, MAGS, P.eventInfo.samPerCycA);
      const pf = toKvSec(pfRaw, ptr), f = toKvSec(fRaw, ptr);
      A.voltages[term][ph] = {
        preFault: pf,
        fault: f,
        change: pf.primaryKV > 0 ? ((f.primaryKV - pf.primaryKV) / pf.primaryKV * 100) : (f.primaryKV > 0 ? 999 : 0),
      };
    }
  });

  // Per-sample series (current + voltage, including sequence/phase-to-phase) computed once here
  // — NOT reduced to a single fault-window figure — so the Protection tab can show the value at
  // any specific instant (trip instant by default, then live as the measurement cursor moves),
  // in the exact same units the corresponding waveform/relevant-quantity chart plots (a raw
  // series value IS what those charts draw directly, with no unit conversion applied).
  const cyc = P.eventInfo.samPerCycA || 32;

  const rmsIA = computeRmsMagnitude(analogData.map(r => r.IA), cyc, MAGS);
  const rmsIB = computeRmsMagnitude(analogData.map(r => r.IB), cyc, MAGS);
  const rmsIC = computeRmsMagnitude(analogData.map(r => r.IC), cyc, MAGS);
  const seriesMaxPhaseI = rmsIA.map((v, i) => Math.max(v, rmsIB[i], rmsIC[i]));
  const seriesGroundI = computeRmsMagnitude(analogData.map(r => r.IG), cyc, MAGS);
  const seriesNeutralI = computeRmsMagnitude(analogData.map(r => r.IN), cyc, MAGS);
  const seriesNegSeqI = computeNegSeqMagnitude(analogData.map(r => r.IA), analogData.map(r => r.IB), analogData.map(r => r.IC), cyc, MAGS);

  const seriesV = {};
  ['yTerminal', 'zTerminal'].forEach(term => {
    const isY = term === 'yTerminal';
    const chA = isY ? 'VAY' : 'VAZ', chB = isY ? 'VBY' : 'VBZ', chC = isY ? 'VCY' : 'VCZ';
    const sA = analogData.map(r => r[chA]), sB = analogData.map(r => r[chB]), sC = analogData.map(r => r[chC]);
    seriesV[term] = {
      A: computeRmsMagnitude(sA, cyc, MAGS), B: computeRmsMagnitude(sB, cyc, MAGS), C: computeRmsMagnitude(sC, cyc, MAGS),
      zero: computeZeroSeqMagnitude(sA, sB, sC, cyc, MAGS),
      neg: computeNegSeqMagnitude(sA, sB, sC, cyc, MAGS),
      pos: computePosSeqMagnitude(sA, sB, sC, cyc, MAGS),
      ab: computePhaseDiffMagnitude(sA, sB, cyc, MAGS),
      bc: computePhaseDiffMagnitude(sB, sC, cyc, MAGS),
      ca: computePhaseDiffMagnitude(sC, sA, cyc, MAGS),
    };
    // The 651R exposes a separate relay bit per phase (27YA1, 27YB1, 27YC1), so its rows compare
    // one phase each. The 751 exposes ONE bit per level (27P1) that answers for all three, so its
    // rows need the worst phase: the lowest for an undervoltage element, the highest for an
    // overvoltage one. Same for the phase-to-phase trio.
    const v = seriesV[term];
    const worst = (keys, pick) => v[keys[0]].map((_, i) => pick(v[keys[0]][i] || 0, v[keys[1]][i] || 0, v[keys[2]][i] || 0));
    v.minPhase = worst(['A', 'B', 'C'], Math.min);
    v.maxPhase = worst(['A', 'B', 'C'], Math.max);
    v.minPP = worst(['ab', 'bc', 'ca'], Math.min);
    v.maxPP = worst(['ab', 'bc', 'ca'], Math.max);
  });

  // Everything evalOcRowAtIdx/evalVoltRowAtIdx (defined at top level, outside analyzeCEV) need
  // to re-evaluate any row at an arbitrary sample index later — both the initial default-instant
  // pass below and the live cursor-driven refresh use these exact same functions, so they can
  // never drift out of sync with each other.
  A.cursorData = {
    CTR, PTRY, PTRZ, VNOM, freq,
    isPrimaryDataV, voltChannelIsKV, iDataIsPrimary, magScale: MAGS,
    // Kept so evalOcRowAtIdx can resolve torque-control equations against the record's own
    // relay-word bits at whatever instant the cursor sits on.
    P,
    voltUnit: detectChannelUnit(P, ['VA', 'VAY', 'VB', 'VBY'], 'V'),
    current: { maxPhaseI: seriesMaxPhaseI, groundI: seriesGroundI, neutralI: seriesNeutralI, negSeqI: seriesNegSeqI },
    voltage: seriesV,
    length: analogData.length,
  };
  // Default instant shown before any cursor interaction or client-side bootstrap — using fEnd-1
  // (end of the existing fault window, already comfortably past the trigger) rather than fStart
  // directly, since the trigger sample itself can sit earlier than the one-cycle DFT functions
  // (computeZeroSeqMagnitude etc.) need to have real history behind them, which would otherwise
  // show 0 for the sequence/phase-to-phase rows until the client-side bootstrap in selectEvent()
  // re-syncs to the actual trip-transition instant.
  const defaultProtIdx = Math.max(0, fEnd - 1);

  // Current analysis
  A.currents = {};
  for (const ch of ['IA', 'IB', 'IC', 'IG', 'IN']) {
    const pfRMS = computeRMS(preFault, ch, MAGS, P.eventInfo.samPerCycA);
    const fRMS = computeRMS(faultData, ch, MAGS, P.eventInfo.samPerCycA);
    // Same primary/secondary correction as the protection table: when the channel is already
    // primary-referred, the raw figure IS the primary amps and the secondary figure is the one
    // that has to be derived (previously both were computed as if the channel were secondary,
    // reporting a primary value CTR times too large).
    A.currents[ch] = {
      preFault: { secA: iDataIsPrimary ? pfRMS / CTR : pfRMS, priA: iDataIsPrimary ? pfRMS : pfRMS * CTR },
      fault: { secA: iDataIsPrimary ? fRMS / CTR : fRMS, priA: iDataIsPrimary ? fRMS : fRMS * CTR },
      change: pfRMS > 0.001 ? ((fRMS - pfRMS) / pfRMS * 100) : (fRMS > 0.001 ? 999 : 0),
    };
  }

  // Protection element evaluation — row descriptors are stored (A.protectionRows) alongside the
  // rendered default-instant values (A.protectionStatus) so a later cursor move can re-evaluate
  // every row at a new sample index (see evalOcRowAtIdx) without re-running the whole analysis.
  A.protectionRows = [];
  const addOCRow = (el, type, pickup, delay, delayUnit, seriesKey, curve, td, tcExpr, family) => {
    A.protectionRows.push({ el, type, pickup, delay, delayUnit, seriesKey, curve, td, tcExpr, family });
  };

  // Instantaneous / definite-time families — 50P/50G/50Q/50N, levels 1-4. Families/levels with
  // no pickup configured (OFF, or not present in this file's settings) are silently skipped.
  const instLabel = { '50P': 'Phase', '50G': 'Ground', '50Q': 'Neg-Seq', '50N': 'Neutral' };
  const instSeriesKey = { '50P': 'maxPhaseI', '50G': 'groundI', '50Q': 'negSeqI', '50N': 'neutralI' };
  ['50P', '50G', '50Q', '50N'].forEach(fam => {
    for (let lvl = 1; lvl <= 4; lvl++) {
      const p = OC[`${fam}${lvl}P`];
      if (p) addOCRow(`${fam}${lvl}`, `${instLabel[fam]} Inst/Def-Time OC`, p, OC[`${fam}${lvl}D`] || 0, 'cycles', instSeriesKey[fam], null, null, OC[`${fam}${lvl}TC`], '50');
    }
  });

  // Inverse-time families — 51P, 51G1, 51G2, 51Q, 51N1, 51N2.
  const timeLabel = { '51P': 'Phase', '51P1': 'Phase Lvl1', '51P2': 'Phase Lvl2', '51G1': 'Ground Lvl1', '51G2': 'Ground Lvl2', '51Q': 'Neg-Seq', '51N1': 'Neutral Lvl1', '51N2': 'Neutral Lvl2' };
  const timeSeriesKey = { '51P': 'maxPhaseI', '51P1': 'maxPhaseI', '51P2': 'maxPhaseI', '51G1': 'groundI', '51G2': 'groundI', '51Q': 'negSeqI', '51N1': 'neutralI', '51N2': 'neutralI' };
  ['51P', '51P1', '51P2', '51G1', '51G2', '51Q', '51N1', '51N2'].forEach(fam => {
    const p = OC[`${fam}JP`];
    if (p) addOCRow(fam, `${timeLabel[fam]} Time OC (${OC[`${fam}JC`] || 'U1'})`, p, OC[`${fam}JTD`] || 1, 'td', timeSeriesKey[fam], OC[`${fam}JC`] || 'U1', OC[`${fam}JTD`] || 1, OC[`${fam}TC`], '51');
  });

  A.protectionStatus = A.protectionRows.map(row => evalOcRowAtIdx(A, row, defaultProtIdx));

  // Voltage element evaluation — Y and Z terminals, phase levels 1-4, phase-to-phase, and
  // sequence (zero/neg/pos-seq overvoltage). Row descriptors carry a `kind` key into
  // A.cursorData.voltage[term] (phase letter, ab/bc/ca, or zero/neg/pos) so evalVoltRowAtIdx can
  // re-evaluate at any sample index using the same per-sample series built above.
  A.voltageRows = [];
  const addVoltRow = (term, elBase, level, pickup, type, kindByPh) => {
    if (!pickup) return;
    for (const [ph, kind] of Object.entries(kindByPh)) {
      A.voltageRows.push({
        element: `${elBase}${ph}${level}`, type,
        typeLabel: type === 'UV' ? 'Undervoltage' : 'Overvoltage',
        term: term === 'yTerminal' ? 'Y' : 'Z', pickup, kind,
      });
    }
  };

  ['yTerminal', 'zTerminal'].forEach(term => {
    const T = term === 'yTerminal' ? 'Y' : 'Z';
    for (let lvl = 1; lvl <= 4; lvl++) {
      addVoltRow(term, `27${T}`, lvl, VE[`27${T}P${lvl}P`], 'UV', { A: 'A', B: 'B', C: 'C' });
      addVoltRow(term, `59${T}`, lvl, VE[`59${T}P${lvl}P`], 'OV', { A: 'A', B: 'B', C: 'C' });
    }
    // Phase-to-phase (element names match the real relay bits: 27YAB1, 59YAB1, etc.)
    addVoltRow(term, `27${T}`, '1', VE[`27${T}PP1P`], 'UV', { AB: 'ab', BC: 'bc', CA: 'ca' });
    addVoltRow(term, `59${T}`, '1', VE[`59${T}PP1P`], 'OV', { AB: 'ab', BC: 'bc', CA: 'ca' });
    // Sequence elements — always an overvoltage-style comparison (asserts above pickup)
    [
      [`59${T}N1P`, 'zero', `59${T}N1`, 'Zero-Seq OV (3V0)'],
      [`59${T}N2P`, 'zero', `59${T}N2`, 'Zero-Seq OV (3V0) Lvl2'],
      [`59${T}Q1P`, 'neg', `59${T}Q1`, 'Neg-Seq OV (V2)'],
      [`59${T}V1P`, 'pos', `59${T}V1`, 'Pos-Seq OV (V1)'],
    ].forEach(([settingKey, kind, elName, typeLabel]) => {
      const pickup = VE[settingKey];
      if (!pickup) return;
      A.voltageRows.push({ element: elName, type: 'OV', typeLabel, term: T, pickup, kind });
    });
  });

  // SEL-751 rows. Named exactly as the relay's own bits (27P1, 59G1, 59Q1 …) so a row lines up
  // with what the digital word and the flags chart call the same element. Each is skipped unless
  // this file actually configures it, so 651R files add nothing here.
  [
    ['27P1P', 'UV', 'minPhase', '27P1', 'Undervoltage Lvl1 (lowest phase)'],
    ['27P2P', 'UV', 'minPhase', '27P2', 'Undervoltage Lvl2 (lowest phase)'],
    ['27P3P', 'UV', 'minPhase', '27P3', 'Undervoltage Lvl3 (lowest phase)'],
    ['27P4P', 'UV', 'minPhase', '27P4', 'Undervoltage Lvl4 (lowest phase)'],
    ['59P1P', 'OV', 'maxPhase', '59P1', 'Overvoltage Lvl1 (highest phase)'],
    ['59P2P', 'OV', 'maxPhase', '59P2', 'Overvoltage Lvl2 (highest phase)'],
    ['59P3P', 'OV', 'maxPhase', '59P3', 'Overvoltage Lvl3 (highest phase)'],
    ['59P4P', 'OV', 'maxPhase', '59P4', 'Overvoltage Lvl4 (highest phase)'],
    ['27PP1P', 'UV', 'minPP', '27PP1', 'Undervoltage Lvl1 (lowest phase-to-phase)'],
    ['27PP2P', 'UV', 'minPP', '27PP2', 'Undervoltage Lvl2 (lowest phase-to-phase)'],
    ['59PP1P', 'OV', 'maxPP', '59PP1', 'Overvoltage Lvl1 (highest phase-to-phase)'],
    ['59PP2P', 'OV', 'maxPP', '59PP2', 'Overvoltage Lvl2 (highest phase-to-phase)'],
    ['59G1P', 'OV', 'zero', '59G1', 'Residual/Zero-Seq OV (3V0)'],
    ['59G2P', 'OV', 'zero', '59G2', 'Residual/Zero-Seq OV (3V0) Lvl2'],
    ['59Q1P', 'OV', 'neg', '59Q1', 'Neg-Seq OV (V2)'],
    ['59Q2P', 'OV', 'neg', '59Q2', 'Neg-Seq OV (V2) Lvl2'],
    ['59V1P', 'OV', 'pos', '59V1', 'Pos-Seq OV (V1)'],
  ].forEach(([settingKey, type, kind, elName, typeLabel]) => {
    const pickup = VE[settingKey];
    if (!pickup) return;
    A.voltageRows.push({ element: elName, type, typeLabel, term: 'Y', pickup, kind });
  });

  A.voltageStatus = A.voltageRows.map(row => evalVoltRowAtIdx(A, row, defaultProtIdx));

  // Frequency analysis
  const freqSamples = faultData.map(r => r.FREQ).filter(f => f > 0);
  const avgFreq = freqSamples.length ? freqSamples.reduce((a, b) => a + b) / freqSamples.length : 60;
  for (let i = 1; i <= 6; i++) {
    const p = FE[`81D${i}P`];
    if (!p) continue;
    const isUnder = p < 60;
    const asserted = isUnder ? avgFreq <= p : avgFreq >= p;
    A.freqStatus.push({
      element: `81D${i}`, type: isUnder ? 'Underfrequency' : 'Overfrequency',
      pickup: `${p} Hz`, timeDelay: `${FE[`81D${i}E`]} sec`,
      measured: `${avgFreq.toFixed(2)} Hz`, asserted,
    });
  }

  // SV chain — mark which are in the trip equation
  A.svChain = svSettings.map(sv => {
    const tripEqClean = P.tripEquation.split('#')[0];
    const inTrip = tripEqClean.includes(sv.label + 'T') || tripEqClean.includes(sv.label + ' ') || tripEqClean.includes(sv.label + ')') || tripEqClean.endsWith(sv.label);
    // Also check the unconditional trip path (TR3X/TRIP3X), already parsed robustly above
    const trxClean = (P.tripEquationX || '').split('#')[0];
    const inTripX = trxClean ? (trxClean.includes(sv.label + 'T') || trxClean.includes(sv.label + ' ') || trxClean.includes(sv.label + ')') || trxClean.endsWith(sv.label)) : false;
    return { ...sv, inTrip, inTripX };
  });

  // ══════════════════════════════════════════════════════════════════════
  // DYNAMIC TRIP CAUSE ANALYSIS — reads actual SV equations from the file
  // ══════════════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════════════
  // SEL BOOLEAN EQUATION EVALUATOR
  // ══════════════════════════════════════════════════════════════════════
  // The previous resolver flattened an SV equation and followed *every* term it
  // recognized, ignoring the AND/OR/NOT structure entirely. For an equation like
  //   SV27 := SV31T AND SV14T OR 59G2T
  // that meant it would happily walk into SV14T even when SV14T never asserted, and —
  // because its element regex didn't even recognize 59G2T — it missed the branch that
  // actually operated. The result was a confidently wrong "SV27T via SV14T".
  //
  // These helpers parse an equation into an AST honoring SEL operator precedence
  // (NOT > AND > OR, parentheses override) and evaluate it against the set of bits
  // that actually asserted in the event. Evaluation returns the *live leaves*: the
  // operand names that genuinely contributed to a TRUE result. A dead AND branch
  // (SV31T false ⇒ whole conjunction false) contributes nothing, so only 59G2T
  // survives — which is the real cause.
  //
  // Rising/falling-edge operators (R_TRIG, F_TRIG, R_TRIGGER, F_TRIGGER) are treated as
  // transparent: the branch is live iff its operand is asserted. This is a level
  // approximation of an edge, which is the best we can do from the settings alone, and
  // is correct for cause attribution (the operand did assert at some point in the record).

  // Split a top-level OR chain into its independent branches (e.g. "A OR B OR C" → [A,B,C]).
  // A trip equation is very often a long flat disjunction of unrelated conditions; only ONE
  // branch usually matters for a given event, so this lets us isolate and render just that
  // branch's own internal AND/OR/NOT structure without exploding every sibling condition too.
  function splitTopOr(node) {
    if (!node) return [];
    if (node.op === 'OR') return [...splitTopOr(node.l), ...splitTopOr(node.r)];
    return [node];
  }

  function astContainsToken(node, name) {
    if (!node) return false;
    switch (node.op) {
      case 'VAR': return node.name === name;
      case 'NOT': case 'REDGE': case 'FEDGE': return astContainsToken(node.c, name);
      case 'AND': case 'OR': return astContainsToken(node.l, name) || astContainsToken(node.r, name);
      default: return false;
    }
  }

  // Evaluate an AST into a static, already-resolved tree (every node carries its own boolean
  // value at the moment being analyzed) so the UI layer can render it as a branching diagram
  // without needing to re-run any logic — it just walks this plain object. AND nodes always
  // keep both children (an AND's OTHER side is exactly the context that's easy to miss in a
  // flat description — e.g. a supervisory condition like "AND 52A" — so it's never collapsed).
  //
  // Crucially, this does NOT stop at an SV reference (e.g. "SV28T") and treat it as an opaque
  // leaf — it looks up THAT SV's own equation and substitutes its whole (recursively baked)
  // tree in its place, tagged as an 'SVNODE' so the UI can still show the SV's own name as a
  // labeled point in the diagram. The result is ONE continuous tree reaching all the way from
  // the ultimate field/measured leaves through every intermediate SV to the top trip equation,
  // rather than a series of disconnected per-SV cards the reader has to mentally re-link.
  // `visited` guards against a (rare, mis-configured) SV equation that references itself,
  // directly or via a cycle, which would otherwise recurse forever.
  function svEquationInfo(num) {
    const sv = svSettings.find(s => s.num === num);
    if (!sv) return null;
    const eq = sv.equation.split('#')[0].trim();
    if (eq === 'NA' || !eq) return null;
    const comment = sv.equation.includes('#') ? sv.equation.split('#').slice(1).join('#').trim() : '';
    return { label: sv.label, comment, ast: parseEq(tokenizeEq(eq)), equationText: eq, pickupDelay: sv.pickupDelay };
  }

  const recordedDigitalLabels = new Set((P.digitalLabels || []).filter(l => l && l !== '*'));
  function bakeFullLogicTree(node, isAsserted, visited, depth) {
    if (!node || depth > 14) return { op: 'VAR', name: node ? '(too deep)' : '?', value: false };
    switch (node.op) {
      case 'VAR': {
        const svm = node.name.match(/^SV(\d+)(T)?$/);
        if (svm) {
          const num = parseInt(svm[1]);
          const isTimedRef = !!svm[2];
          if (!visited.has(num)) {
            const info = svEquationInfo(num);
            if (info) {
              const nextVisited = new Set(visited); nextVisited.add(num);
              const child = bakeFullLogicTree(info.ast, isAsserted, nextVisited, depth + 1);
              const bareSvNode = { op: 'SVNODE', label: info.label, comment: info.comment, value: !!isAsserted(info.label), child, refName: info.label };
              // When the reference is the TIMED form (SVxxT) and this SV actually has a pickup
              // delay configured, the timer is a real hop of its own — SVxx and SVxxT can read
              // differently for up to that whole delay — so show it as a distinct node rather
              // than silently treating the two as the same point (which hid the timer entirely).
              if (isTimedRef && info.pickupDelay > 0) {
                return { op: 'TIMERNODE', label: info.label + 'T', pickupDelay: info.pickupDelay,
                         value: !!isAsserted(node.name), child: bareSvNode, refName: node.name,
                         // Same measure-don't-assume treatment the element timers get — the gap
                         // observed in this record beats any reading of the setting's units.
                         measuredMs: measuredTimerMs(P, info.label, node.name),
                         settingLabel: info.label + 'PU', settingValue: info.pickupDelay };
              }
              return Object.assign({}, bareSvNode, { value: !!isAsserted(node.name), refName: node.name });
            }
          }
        }
        // Same idea as the SVxx -> SVxxT timer hop above, for a PROTECTION ELEMENT's timed
        // output (27PP1T, 51PT, …). It has no SELogic equation, so the equation walk would stop
        // here and the raw pickup that started the timer — and the delay itself — would never
        // appear on the diagram. Only expand when the input bit is actually recorded in this
        // file, since this tree colours every node by its true/false state and a bit the record
        // never captured would otherwise render as a confident "false".
        const elemInput = timedBitInputLabel(node.name, P);
        if (elemInput && !/^SV\d+$/.test(elemInput) && recordedDigitalLabels.has(elemInput)) {
          const inputNode = { op: 'VAR', name: elemInput, label: elemInput, value: !!isAsserted(elemInput) };
          return { op: 'TIMERNODE', label: node.name, refName: node.name, value: !!isAsserted(node.name),
                   measuredMs: measuredTimerMs(P, elemInput, node.name),
                   settingLabel: node.name.slice(0, -1) + 'D',
                   settingValue: getSettingNum(P, [node.name.slice(0, -1) + 'D']),
                   child: inputNode };
        }
        return { op: 'VAR', name: node.name, value: !!isAsserted(node.name) };
      }
      case 'NOT': {
        const c = bakeFullLogicTree(node.c, isAsserted, visited, depth);
        return { op: 'NOT', value: !c.value, child: c };
      }
      case 'REDGE': case 'FEDGE': {
        const c = bakeFullLogicTree(node.c, isAsserted, visited, depth);
        return { op: node.op, value: c.value, child: c };
      }
      case 'AND': {
        const l = bakeFullLogicTree(node.l, isAsserted, visited, depth), r = bakeFullLogicTree(node.r, isAsserted, visited, depth);
        return { op: 'AND', value: l.value && r.value, children: [l, r] };
      }
      case 'OR': {
        const l = bakeFullLogicTree(node.l, isAsserted, visited, depth), r = bakeFullLogicTree(node.r, isAsserted, visited, depth);
        return { op: 'OR', value: l.value || r.value, children: [l, r] };
      }
      default: return { op: '?', value: false };
    }
  }

  // Drop the branches that DIDN'T actually contribute to the result, rather than showing every
  // alternative regardless of whether it happened. The rule is intentionally dual, not a blanket
  // "hide anything false":
  //   • An OR that came out TRUE only needed ONE side — keep whichever side(s) are true, drop
  //     the false alternatives (they're just conditions that didn't happen).
  //   • An OR that came out FALSE needed EVERY side to be false (that's the only way an OR is
  //     false) — every side is equally part of the explanation, so keep all of them.
  //   • An AND that came out TRUE needed EVERY side true — all of them are the explanation, keep
  //     all (this is why "AND 52A"-type context never disappears).
  //   • An AND that came out FALSE only needed ONE side to fail — keep whichever side(s) are
  //     false (the actual blocker), drop the side(s) that were fine.
  // This is exactly De Morgan's duality (NOT-of-AND-of-false-things is the same shape as an
  // OR-of-true-things), so a NOT wrapping a false AND — e.g. "NOT (IN301 AND IN303 AND IN305)"
  // where all three read false — correctly keeps every one of those false leaves, since THAT
  // false AND is precisely why the NOT came out true.
  function pruneLogicTree(node) {
    if (!node) return node;
    switch (node.op) {
      case 'VAR': return node;
      case 'SVNODE': case 'TIMERNODE': return Object.assign({}, node, { child: pruneLogicTree(node.child) });
      case 'NOT': case 'REDGE': case 'FEDGE':
        return Object.assign({}, node, { child: pruneLogicTree(node.child) });
      case 'AND': case 'OR': {
        const [l, r] = node.children;
        const shouldFilter = (node.op === 'OR' && node.value === true) || (node.op === 'AND' && node.value === false);
        if (!shouldFilter) {
          // OR-false (every side had to fail) or AND-true (every side had to hold) — all
          // children are part of the explanation, keep both.
          return Object.assign({}, node, { children: [pruneLogicTree(l), pruneLogicTree(r)] });
        }
        const wantValue = node.op === 'OR'; // OR-true keeps true side(s); AND-false keeps false side(s)
        let keep = [l, r].filter(c => c.value === wantValue);
        if (!keep.length) keep = [l, r]; // shouldn't happen, but never drop everything
        const pruned = keep.map(pruneLogicTree);
        if (pruned.length === 1) return pruned[0]; // only one side survived — no group left to show
        return Object.assign({}, node, { children: pruned });
      }
      default: return node;
    }
  }

  const EDGE_OPS = new Set(['R_TRIG', 'F_TRIG', 'R_TRIGGER', 'F_TRIGGER']);

  // Pretty-print an AST back to SEL-ish text, for display in explanations (e.g. "blocked by
  // (IN301 AND IN303 AND IN305)").
  function astToStr(node) {
    if (!node) return '';
    switch (node.op) {
      case 'VAR': return node.name;
      case 'NOT': return 'NOT ' + astToStr(node.c);
      case 'REDGE': return 'R_TRIG ' + astToStr(node.c);
      case 'FEDGE': return 'F_TRIG ' + astToStr(node.c);
      case 'AND': return '(' + astToStr(node.l) + ' AND ' + astToStr(node.r) + ')';
      case 'OR': return '(' + astToStr(node.l) + ' OR ' + astToStr(node.r) + ')';
      default: return '?';
    }
  }

  // When a NOT wraps a single variable (e.g. "NOT LT01"), the old evaluator correctly names
  // that variable as the reason the NOT came out true. But when a NOT wraps a COMPOUND
  // expression — e.g. "NOT (IN301 AND IN303 AND IN305)" — it previously reported nothing at
  // all, silently discarding the real explanation. That's not a cosmetic gap: it's exactly the
  // shape SEL engineers use for "not all three poles confirmed open" / "not fully closed"
  // supervisory logic, and a trip that hinges on that condition becoming true (because one of
  // those inputs dropped, or a pole-discordance state resolved) needs the SPECIFIC input(s)
  // named, or the tool just points at whatever positively-asserted latch bit happens to sit
  // alongside it in an AND (e.g. "LT01") — technically part of the equation, but not the thing
  // that actually changed. findFalseCause recurses into a false sub-expression and collects
  // every leaf that contributed to it being false, so that de-assertion gets attributed to
  // real, named points instead of disappearing.
  function findFalseCause(node, isAsserted) {
    if (!node) return new Set();
    switch (node.op) {
      case 'VAR': return isAsserted(node.name) ? new Set() : new Set([node.name]);
      case 'NOT': return new Set(); // double-negation nesting is rare; don't guess
      case 'REDGE': case 'FEDGE': return findFalseCause(node.c, isAsserted);
      case 'AND': {
        // AND is false because at least one side is false — collect from both sides (either
        // may be the culprit; showing both is more honest than guessing which one "wins").
        const l = findFalseCause(node.l, isAsserted);
        const r = findFalseCause(node.r, isAsserted);
        return new Set([...l, ...r]);
      }
      case 'OR': {
        // OR is false only if BOTH sides are false — both genuinely contribute.
        const l = findFalseCause(node.l, isAsserted);
        const r = findFalseCause(node.r, isAsserted);
        return new Set([...l, ...r]);
      }
      default: return new Set();
    }
  }

  // Given a top-level equation AST and a specific leaf name somewhere inside it, find the
  // nearest enclosing AND whose OTHER side is false — i.e. the supervisory condition that's
  // currently blocking that leaf from mattering. Returns a display string of that blocking
  // sub-expression, or null if the leaf isn't gated (or its sibling is true).
  function findBlockingSibling(ast, targetLeaf, isAsserted) {
    function containsLeaf(node) {
      if (!node) return false;
      switch (node.op) {
        case 'VAR': return node.name === targetLeaf;
        case 'NOT': case 'REDGE': case 'FEDGE': return containsLeaf(node.c);
        case 'AND': case 'OR': return containsLeaf(node.l) || containsLeaf(node.r);
        default: return false;
      }
    }
    function walk(node) {
      if (!node) return null;
      if (node.op === 'AND') {
        const inL = containsLeaf(node.l), inR = containsLeaf(node.r);
        if (inL && !inR) {
          if (!evalAst(node.r, isAsserted).value) return astToStr(node.r);
          return walk(node.l);
        }
        if (inR && !inL) {
          if (!evalAst(node.l, isAsserted).value) return astToStr(node.l);
          return walk(node.r);
        }
        if (inL && inR) return walk(node.l) || walk(node.r);
        return null;
      }
      if (node.op === 'OR') return walk(node.l) || walk(node.r);
      if (node.op === 'NOT' || node.op === 'REDGE' || node.op === 'FEDGE') return walk(node.c);
      return null;
    }
    return walk(ast);
  }

  function tokenizeEq(eq) {
    eq = eq.split('#')[0].trim();
    const tokens = [];
    // Order matters: keywords before the generic identifier pattern.
    const re = /\(|\)|\bAND\b|\bOR\b|\bNOT\b|\bR_TRIGGER\b|\bF_TRIGGER\b|\bR_TRIG\b|\bF_TRIG\b|[A-Za-z0-9_]+/g;
    let m;
    while ((m = re.exec(eq)) !== null) tokens.push(m[0]);
    return tokens;
  }

  function parseEq(tokens) {
    let i = 0;
    const peek = () => tokens[i];
    const next = () => tokens[i++];
    function parseExpr() {
      let node = parseTerm();
      while (peek() === 'OR') { next(); node = { op: 'OR', l: node, r: parseTerm() }; }
      return node;
    }
    function parseTerm() {
      let node = parseFactor();
      while (peek() === 'AND') { next(); node = { op: 'AND', l: node, r: parseFactor() }; }
      return node;
    }
    function parseFactor() {
      const t = peek();
      if (t === undefined) return { op: 'VAR', name: '__EMPTY__' };
      if (t === 'NOT') { next(); return { op: 'NOT', c: parseFactor() }; }
      if (EDGE_OPS.has(t)) {
        next();
        const isFalling = (t === 'F_TRIG' || t === 'F_TRIGGER');
        return { op: isFalling ? 'FEDGE' : 'REDGE', c: parseFactor() };
      }
      if (t === '(') { next(); const e = parseExpr(); if (peek() === ')') next(); return e; }
      next(); return { op: 'VAR', name: t };
    }
    return parseExpr();
  }

  // Evaluate an AST. isAsserted(name)->bool. Returns { value, live:Set<string> }.
  // `live` = the operand leaves that positively contributed to a TRUE result.
  function evalAst(ast, isAsserted) {
    function ev(node) {
      switch (node.op) {
        case 'VAR': {
          const v = !!isAsserted(node.name);
          return { value: v, live: v ? new Set([node.name]) : new Set(), neg: new Set() };
        }
        case 'NOT': {
          const c = ev(node.c);
          const value = !c.value;
          // A bare NOT of a single variable (e.g. "NOT PWR_SRC1") names a real, meaningful
          // condition — "PWR_SRC1 is de-asserted" — when it's the thing that made the branch
          // true. We track this separately from `live` (positively-asserted causes) so callers
          // can label it correctly ("power source lost") instead of silently dropping it.
          // A NOT of a COMPOUND expression (e.g. "NOT (IN301 AND IN303 AND IN305)") is just as
          // real a condition, but naming it requires walking in to find which leaf/leaves are
          // false — findFalseCause does that instead of silently returning nothing.
          const neg = value
            ? (node.c.op === 'VAR' ? new Set([node.c.name]) : findFalseCause(node.c, isAsserted))
            : new Set();
          return { value, live: new Set(), neg };
        }
        case 'REDGE': case 'FEDGE': {
          // Single-snapshot evaluation can't distinguish a genuine edge from a level that's
          // simply been steady — this is a pass-through approximation (adequate for the
          // trip-equation backward-scan, which anchors on a known trip instant and isn't
          // vulnerable to the "already true at record start" false positive). Where that
          // distinction actually matters — e.g. the ER equation's forward scan from t=0 — use
          // evalAstEdgeAware() instead, which compares consecutive snapshots properly.
          const c = ev(node.c);
          return { value: c.value, live: c.live, neg: c.neg };
        }
        case 'AND': {
          const l = ev(node.l), r = ev(node.r);
          const value = l.value && r.value;
          return {
            value,
            live: value ? new Set([...l.live, ...r.live]) : new Set(),
            neg: value ? new Set([...l.neg, ...r.neg]) : new Set(),
          };
        }
        case 'OR': {
          const l = ev(node.l), r = ev(node.r);
          const value = l.value || r.value;
          const live = new Set(), neg = new Set();
          if (l.value) { for (const x of l.live) live.add(x); for (const x of l.neg) neg.add(x); }
          if (r.value) { for (const x of r.live) live.add(x); for (const x of r.neg) neg.add(x); }
          return { value, live, neg };
        }
        default: return { value: false, live: new Set(), neg: new Set() };
      }
    }
    return ev(ast);
  }

  // Edge-aware evaluator: unlike evalAst (single snapshot, edges approximated as level
  // pass-through), this correctly resolves REDGE ("just became true") and FEDGE ("just
  // became false") by comparing two consecutive snapshots. This matters whenever an equation
  // relies on the R_TRIG/F_TRIG distinction for its OWN correctness rather than just as a
  // qualifier — e.g. an ER (event-report) equation containing both "R_TRIG 52A3P" (breaker
  // just closed) and "F_TRIG 52A3P" (breaker just opened) on the SAME operand. Under a level
  // approximation, if 52A3P is asserted for the entire record (breaker stays closed
  // throughout), both terms would appear permanently true — masking every other term in the
  // equation. isCurr/isPrev are asserted-checkers for the current and immediately-prior
  // snapshots respectively.
  function evalAstEdgeAware(ast, isCurr, isPrev) {
    // Single-snapshot evaluation of a subtree (used to evaluate an edge node's operand at a
    // specific point in time — deliberately does NOT recurse into further edge-awareness,
    // since we only need the level state of the operand at each of the two snapshots).
    function evalLevel(node, isAsserted) {
      switch (node.op) {
        case 'VAR': {
          const v = !!isAsserted(node.name);
          return { value: v, live: v ? new Set([node.name]) : new Set(), neg: new Set() };
        }
        case 'NOT': {
          const c = evalLevel(node.c, isAsserted);
          const value = !c.value;
          const neg = value
            ? (node.c.op === 'VAR' ? new Set([node.c.name]) : findFalseCause(node.c, isAsserted))
            : new Set();
          return { value, live: new Set(), neg };
        }
        case 'REDGE': case 'FEDGE': return evalLevel(node.c, isAsserted); // nested edge, rare — pass through
        case 'AND': {
          const l = evalLevel(node.l, isAsserted), r = evalLevel(node.r, isAsserted);
          const value = l.value && r.value;
          return { value, live: value ? new Set([...l.live, ...r.live]) : new Set(), neg: value ? new Set([...l.neg, ...r.neg]) : new Set() };
        }
        case 'OR': {
          const l = evalLevel(node.l, isAsserted), r = evalLevel(node.r, isAsserted);
          const value = l.value || r.value;
          const live = new Set(), neg = new Set();
          if (l.value) { for (const x of l.live) live.add(x); for (const x of l.neg) neg.add(x); }
          if (r.value) { for (const x of r.live) live.add(x); for (const x of r.neg) neg.add(x); }
          return { value, live, neg };
        }
        default: return { value: false, live: new Set(), neg: new Set() };
      }
    }

    function ev(node) {
      switch (node.op) {
        case 'VAR': return evalLevel(node, isCurr);
        case 'NOT': {
          const c = ev(node.c);
          const value = !c.value;
          const neg = value
            ? (node.c.op === 'VAR' ? new Set([node.c.name]) : findFalseCause(node.c, isCurr))
            : new Set();
          return { value, live: new Set(), neg };
        }
        case 'REDGE': {
          const currRes = evalLevel(node.c, isCurr);
          const prevRes = evalLevel(node.c, isPrev);
          const value = currRes.value && !prevRes.value; // just became true
          return { value, live: value ? currRes.live : new Set(), neg: value ? currRes.neg : new Set() };
        }
        case 'FEDGE': {
          const currRes = evalLevel(node.c, isCurr);
          const prevRes = evalLevel(node.c, isPrev);
          const value = !currRes.value && prevRes.value; // just became false
          // The "cause" of a falling-edge trigger is the operand that just went away; report
          // it via `neg` (same channel used for NOT-driven causes) so callers still get a
          // concrete element name rather than nothing.
          const neg = value && node.c.op === 'VAR' ? new Set([node.c.name]) : new Set();
          return { value, live: new Set(), neg };
        }
        case 'AND': {
          const l = ev(node.l), r = ev(node.r);
          const value = l.value && r.value;
          return { value, live: value ? new Set([...l.live, ...r.live]) : new Set(), neg: value ? new Set([...l.neg, ...r.neg]) : new Set() };
        }
        case 'OR': {
          const l = ev(node.l), r = ev(node.r);
          const value = l.value || r.value;
          const live = new Set(), neg = new Set();
          if (l.value) { for (const x of l.live) live.add(x); for (const x of l.neg) neg.add(x); }
          if (r.value) { for (const x of r.live) live.add(x); for (const x of r.neg) neg.add(x); }
          return { value, live, neg };
        }
        default: return { value: false, live: new Set(), neg: new Set() };
      }
    }
    return ev(ast);
  }

  // ══════════════════════════════════════════════════════════════════════
  // GENERAL SEL RELAY-WORD MATCHER
  // ══════════════════════════════════════════════════════════════════════
  // The old element regex required a [YZ] terminal designator after 27/59 and omitted
  // whole families (59G/59N/59Q/59V ground & sequence OV, 67 directional, 81R rate-of-change,
  // etc.), so real protection elements like 59G2T fell through invisibly. This matcher
  // recognizes the general shape of an SEL protection relay word so classification can see
  // the actual operating element regardless of family.
  const RELAY_WORD_RE = new RegExp(
    '\\b(' + [
      '27[A-Z]*\\d+[A-Z]*',      // undervoltage (any terminal/seq)
      '59[A-Z]*\\d+[A-Z]*',      // overvoltage (phase, ground 59G, neg-seq 59Q, zero-seq 59N/59V)
      '81[A-Z]*\\d+[A-Z]*',      // frequency (81D) and rate-of-change (81R)
      '50[A-Z]*\\d+[A-Z]*',      // instantaneous OC (phase/ground/neg-seq)
      '51[A-Z]*\\d*[A-Z]*',      // time OC
      '67[A-Z]*\\d+[A-Z]*',      // directional OC
      '78VS[O]?',                // vector shift
      '55[AT]', '3P59', '3P27',
      'SAG[ABC]', 'SW[ABC]', 'LOP', 'TOSLP', 'BTFAIL',
      'PWR_SRC\\d', '3PWR\\d[PT]?',
      'PB\\d+_PUL', 'OC\\d?', 'CC',
      'HALARM', 'SALARM', 'GNDSW', 'VPOLV', 'I2I1',
      'IN\\d+', 'LT\\d+',
    ].join('|') + ')\\b'
  );

  // Helper: recursively resolve what an SV ultimately depends on by walking ONLY the
  // branches that actually evaluated true. `triggered` is the array of asserted bit
  // names (digital transitions + initial state). When present, boolean evaluation
  // decides which leaves/children are live; when absent (structure-only mode) we fall
  // back to following everything so the tool still degrades gracefully.
  function resolveSV(svLabel, depth, triggered) {
    if (depth > 8) return { elements: [], svPath: [], comment: '' };
    const svNum = parseInt(svLabel.replace(/SV|T/g, ''));
    const sv = svSettings.find(s => s.num === svNum);
    if (!sv) return { elements: [], svPath: [], comment: '' };

    const eq = sv.equation.split('#')[0].trim();
    const comment = sv.equation.includes('#') ? sv.equation.split('#').slice(1).join('#').trim() : '';

    const haveTriggered = triggered && Array.isArray(triggered) && triggered.length > 0;
    const tSet = new Set(triggered || []);
    // A leaf name is "asserted" if it, or its timer/instantaneous sibling, is in the set.
    const isAsserted = (name) => {
      if (tSet.has(name)) return true;
      const svm = name.match(/^SV(\d+)(T?)$/);
      if (svm) {
        const base = 'SV' + svm[1].padStart(2, '0');
        return tSet.has(base) || tSet.has(base + 'T');
      }
      return false;
    };

    // Determine the set of leaf names that actually drove this equation true.
    let liveLeaves, negLeaves = [];
    if (haveTriggered) {
      const res = evalAst(parseEq(tokenizeEq(eq)), isAsserted);
      liveLeaves = [...res.live];
      negLeaves = [...res.neg]; // leaves that drove this true via NOT (de-assertion), not assertion
      // If evaluation found nothing live (e.g. this SV asserted in a prior event and its
      // inputs already dropped out, or an unmodeled operator), fall back to every operand
      // so we still surface a plausible cause rather than a blank.
      if (liveLeaves.length === 0 && negLeaves.length === 0) {
        liveLeaves = [...new Set(tokenizeEq(eq).filter(t =>
          !['AND','OR','NOT','(',')'].includes(t) && !EDGE_OPS.has(t)))];
      }
    } else {
      // Structure-only mode: all operands.
      liveLeaves = [...new Set(tokenizeEq(eq).filter(t =>
        !['AND','OR','NOT','(',')'].includes(t) && !EDGE_OPS.has(t)))];
    }

    // Split live leaves into protection elements vs. child SV references.
    const directElements = [];
    const svRefs = [];
    for (const leaf of liveLeaves) {
      const svRef = leaf.match(/^SV\d{2}T?$/);
      if (svRef) { svRefs.push(leaf); continue; }
      if (RELAY_WORD_RE.test(leaf)) directElements.push(leaf);
    }
    // Negated leaves are reported directly (not followed into child SVs) — a de-asserted
    // status/logic bit is the end of the trail, not a protection element with its own chain.
    const directNegElements = negLeaves.filter(leaf => RELAY_WORD_RE.test(leaf) && !/^SV\d{2}T?$/.test(leaf));

    let allElements = [...new Set(directElements)];
    let allNegElements = [...new Set(directNegElements)];
    let allSvPath = [{ label: sv.label, equation: sv.equation, equationText: eq, pickupDelay: sv.pickupDelay, comment, ast: parseEq(tokenizeEq(eq)) }];

    for (const ref of svRefs) {
      const childNum = parseInt(ref.replace(/SV|T/g, ''));
      if (childNum !== svNum) { // avoid self-reference
        const child = resolveSV(ref, depth + 1, triggered);
        allElements = allElements.concat(child.elements);
        allNegElements = allNegElements.concat(child.negElements || []);
        allSvPath = child.svPath.concat(allSvPath);
      }
    }

    return {
      elements: [...new Set(allElements)],
      negElements: [...new Set(allNegElements)],
      svPath: allSvPath,
      comment,
      equationAst: parseEq(tokenizeEq(eq)),
      equationText: eq,
    };
  }

  // Classify a set of resolved elements into a human-readable trip cause
  function classifyCause(elements, svPath, label, allChangedLabels, negElements) {
    negElements = negElements || [];
    // Detect element families. Names may or may not carry a terminal designator (Y/Z),
    // and a trailing pickup/timer suffix (P/T). Ground (59G/zero-seq) and negative-seq
    // (59Q) overvoltage previously slipped through because the tests demanded a [YZ]
    // between the number and the phase/seq letter.
    const hasUV = elements.some(e => /^27/.test(e));
    const hasPhaseOV = elements.some(e => /^59([YZ]?[ABC]|P|PP)\d/.test(e));
    const hasGroundOV = elements.some(e => /^59[YZ]?[GN]\d/.test(e)); // zero-seq / residual OV (59G, 59N)
    const hasNegSeqOV = elements.some(e => /^59[YZ]?Q\d/.test(e));    // negative-seq OV (59Q)
    const hasOV = hasPhaseOV;
    const hasOVseq = hasGroundOV || hasNegSeqOV;
    const hasFreq = elements.some(e => /^81D/.test(e));
    const hasROCOF = elements.some(e => /^81R/.test(e));
    const hasPhaseOC = elements.some(e => /^5[01]P/.test(e) || /^51[ABC]/.test(e) || /^67P/.test(e));
    const hasGroundOC = elements.some(e => /^5[01]G/.test(e) || /^67G/.test(e));
    const hasNegSeqOC = elements.some(e => /^50Q/.test(e) || /^51Q/.test(e) || /^67Q/.test(e));
    const hasSag = elements.some(e => /^SAG|^SW[ABC]/.test(e));
    const hasVectorShift = elements.some(e => e === '78VSO' || e === '78VS');
    const hasOpenPhase = elements.some(e => e === 'I2I1') || elements.some(e => /27[YZ]?[ABC]4|59[YZ]?[ABC]4/.test(e));
    const hasPowerLoss = elements.some(e => e === 'PWR_SRC1' || /^3PWR/.test(e));
    const hasSleep = elements.some(e => e === 'TOSLP');
    const hasBattery = elements.some(e => e === 'BTFAIL');

    // Get the comment from the most relevant SV (the one in the trip equation)
    const topComment = svPath.length ? svPath[svPath.length - 1].comment : '';

    // Use the SV's own comment if available — it's the programmer's description
    if (topComment) {
      // Still classify for color/icon purposes, but use comment as detail
    }

    let causeText = '';
    let causeDetail = '';
    let family = null; // which derived quantity (if any) best explains this trip beyond I/V magnitude

    // Classify based on what elements are actually referenced
    if ((hasPhaseOC || hasGroundOC) && (hasOVseq || hasOV || hasUV)) {
      // BOTH a current element and a voltage element are live in the resolved logic — this
      // is a combined/supervised condition (typically an AND of both quantities), and titling
      // it by only one family misrepresents the logic and invites the exact misreading where
      // someone assumes the visible voltage dip alone was the cause. Name both.
      const iPart = hasPhaseOC && hasGroundOC ? 'Phase + Ground Overcurrent' : hasPhaseOC ? 'Phase Overcurrent' : 'Ground Overcurrent';
      const vPart = hasOVseq ? (hasGroundOV && hasNegSeqOV ? 'Zero + Negative Sequence Overvoltage' : hasGroundOV ? 'Zero-Sequence Overvoltage' : 'Negative-Sequence Overvoltage')
                  : hasOV ? 'Overvoltage' : 'Undervoltage';
      causeText = `Combined Condition Trip (${vPart} + ${iPart})`;
      causeDetail = topComment || `The trip logic required both a ${vPart.toLowerCase()} condition and a ${iPart.toLowerCase()} condition simultaneously via ${label}`;
      if (hasGroundOV || hasNegSeqOV) family = hasGroundOV ? 'zeroSeqV' : 'negSeqV';
    } else if (hasPhaseOC && hasGroundOC) {
      causeText = 'Overcurrent Trip (Phase + Ground)';
      causeDetail = topComment || 'Phase and ground overcurrent elements asserted via ' + label;
      family = 'groundI';
    } else if (hasPhaseOC) {
      causeText = 'Phase Overcurrent Trip';
      causeDetail = topComment || 'Phase overcurrent elements asserted via ' + label;
    } else if (hasGroundOC) {
      causeText = 'Ground Overcurrent Trip';
      causeDetail = topComment || 'Ground overcurrent elements asserted via ' + label;
      family = 'groundI';
    } else if (hasUV && hasOV) {
      causeText = 'Voltage Protection Trip (UV + OV)';
      causeDetail = topComment || 'Both undervoltage and overvoltage conditions detected via ' + label;
    } else if (hasUV && !hasOV && !hasFreq) {
      // Determine phases from digital transitions
      const uvAsserted = allChangedLabels.filter(l => /^27[YZ][ABC]\d$/.test(l));
      const phases = [...new Set(uvAsserted.map(l => l.charAt(3)))].sort();
      const phaseStr = phases.length === 3 ? 'Three-Phase' : phases.length ? 'Phase ' + phases.join(',') : '';
      causeText = `Undervoltage Trip${phaseStr ? ' (' + phaseStr + ')' : ''}`;
      causeDetail = topComment || 'Voltage dropped below undervoltage pickup and sustained through timer delay';
    } else if (hasOV && !hasUV) {
      causeText = 'Overvoltage Trip';
      causeDetail = topComment || 'Voltage exceeded overvoltage pickup threshold via ' + label;
    } else if (hasOVseq && !hasUV && !hasOV) {
      const kind = hasGroundOV && hasNegSeqOV ? 'Zero + Negative Sequence'
                 : hasGroundOV ? 'Zero Sequence / 3V0'
                 : 'Negative Sequence';
      causeText = `Sequence Overvoltage Trip (${kind})`;
      causeDetail = topComment || `${kind} overvoltage detected via ` + label;
      // A phase-magnitude chart can look almost flat during a zero/neg-sequence event —
      // the three phases can all stay near nominal while the sequence component itself
      // spikes. That's exactly the "chart doesn't show it" gap being addressed here.
      family = hasGroundOV && hasNegSeqOV ? 'zeroSeqV+negSeqV' : hasGroundOV ? 'zeroSeqV' : 'negSeqV';
    } else if (hasROCOF && !hasFreq && !hasUV && !hasOV) {
      causeText = 'Rate-of-Change of Frequency Trip (81R)';
      causeDetail = topComment || 'Frequency rate-of-change element operated via ' + label;
      family = 'freq';
    } else if (hasFreq && !hasUV && !hasOV) {
      causeText = 'Frequency Protection Trip';
      causeDetail = topComment || 'Frequency element timer expired via ' + label;
      family = 'freq';
    } else if (hasFreq && (hasUV || hasOV)) {
      causeText = 'Voltage/Frequency Protection Trip';
      causeDetail = topComment || 'Combined voltage and frequency protection via ' + label;
      family = 'freq';
    } else if (hasSag || hasVectorShift) {
      causeText = 'Power Quality Trip (Sag/Swell/Vector Shift)';
      causeDetail = topComment || 'Voltage sag, swell, or vector shift detected via ' + label;
    } else if (hasNegSeqOC) {
      causeText = 'Negative Sequence Overcurrent Trip';
      causeDetail = topComment || 'Negative sequence overcurrent via ' + label;
      family = 'negSeqI';
    } else if (hasOpenPhase) {
      causeText = 'Open Phase Detection Trip';
      causeDetail = topComment || 'Open phase condition detected via ' + label;
      family = 'negSeqI';
    } else if (hasPowerLoss) {
      causeText = 'Loss of AC Power Trip';
      causeDetail = topComment || 'AC power source lost via ' + label;
    } else if (hasSleep) {
      causeText = 'Relay Going to Sleep (TOSLP)';
      causeDetail = topComment || 'Relay entering sleep mode — trip to open breaker before power down';
    } else if (hasBattery) {
      causeText = 'Battery Failure Trip';
      causeDetail = topComment || 'Battery failure detected';
    } else if (topComment) {
      causeText = `Protection Trip (${label})`;
      causeDetail = topComment;
      if (negElements.length) {
        causeDetail += ` (driven in part by de-assertion of ${negElements.join(', ')})`;
      }
    } else {
      causeText = `Trip via ${label}`;
      causeDetail = `Asserted through: ${elements.join(', ') || 'complex logic'}`;
    }

    // ── Non-protection detection ──
    // hasRecognizedProtection checks BOTH the positively-asserted elements and the
    // negated/de-asserted ones (a trip driven by "NOT 51G1P" is still fundamentally a
    // protection-element condition, just phrased as an absence). If nothing on either side
    // matches a real measured electrical quantity, the trip was produced entirely by internal
    // relay logic — latch bits, status/position inputs, pushbuttons, comms bits — not by
    // anything the relay measured on the line. That distinction matters most when the
    // resolved cause is a bare latch/status name (LT01, IN301, 52A/52B and the like): those
    // names mean nothing to most operators, and — worse — the waveform shown alongside them
    // (e.g. suppressed phase voltages on an open breaker) can visually resemble a real
    // protection event and get mislabeled as one (a classic case: someone reads a flat/low
    // three-phase voltage trace next to a "trip" and calls it a three-phase undervoltage trip,
    // when no 27 element ever actually operated).
    const combinedForProtectionCheck = [...elements, ...negElements];
    const hasRecognizedProtection = combinedForProtectionCheck.some(e =>
      /^27/.test(e) || /^59/.test(e) || /^81/.test(e) || /^5[01]/.test(e) || /^67/.test(e) ||
      /^SAG|^SW[ABC]/.test(e) || e === '78VSO' || e === '78VS' || e === 'I2I1' ||
      e === 'PWR_SRC1' || /^3PWR/.test(e) || e === 'TOSLP' || e === 'BTFAIL'
    );
    const isNonProtection = !hasRecognizedProtection;
    if (isNonProtection && !topComment) {
      // Override the generic "Trip via SVxx" wording with a clearer, honest label — this is
      // the single most useful place in the whole tool to say "this isn't a fault" instead of
      // giving a cryptic relay-word name and letting it be misread as one.
      const posPart = elements.length ? `assertion of ${elements.join(', ')}` : '';
      const negPart = negElements.length ? `de-assertion of ${negElements.join(', ')}` : '';
      const parts = [posPart, negPart].filter(Boolean).join(' and ');
      causeText = `Logic/Status-Driven Trip (via ${label})`;
      causeDetail = `No overcurrent, voltage, or frequency protection element is behind this — ${label} resolved entirely to internal status/latch points${parts ? ', via ' + parts : ''}. This is not a measured electrical fault condition; something in the relay's internal logic or a status/position input drove it instead.`;
    }

    if (!family && /3V0|ZERO.?SEQ|NEG.?SEQ|SEQUENCE VOLT/i.test(topComment)) {
      family = /NEG.?SEQ/i.test(topComment) && !/3V0|ZERO.?SEQ/i.test(topComment) ? 'negSeqV' : 'zeroSeqV';
    }

    return { causeText, causeDetail, family, isNonProtection, negElements };
  }

  // Walk the transitions and find what fed into a trip bit (TRIP3P, TRIPA, TRIPB, TRIPC, or TRIP)
  const tripBitNames = ['TRIP3P', 'TRIPA', 'TRIPB', 'TRIPC', 'TRIP'];
  const tripTransition = digitalTransitions.find(t => t.changes.some(c => tripBitNames.includes(c.label) && c.asserted));
  const tripBitUsed = tripTransition ? tripTransition.changes.find(c => tripBitNames.includes(c.label) && c.asserted)?.label : 'TRIP3P';
  const allChangedLabels = digitalTransitions.flatMap(t => t.changes.filter(c => c.asserted).map(c => c.label));

  // ── Reconstruct the actual bit-state timeline ──
  // A CEV's digital section only logs *changes*, not full state at every sample. To evaluate
  // any top-level equation correctly (respecting AND/OR/NOT/edge structure) we need to know
  // the full set of asserted bits at each point in time, not just "did this literal bit name
  // appear in a change list". We replay the transitions in order onto a running Set,
  // snapshotting after each one, seeded from the initial digital state at record start. Built
  // once here (rather than inside the trip-only branch) so both the trip equation (TR/TR3P)
  // and the event-report equation (ER) below can share it.
  const timeline = [new Set(P.initialDigitalState || [])];
  const timelineRunning = new Set(timeline[0]);
  for (const t of digitalTransitions) {
    for (const c of t.changes) { if (c.asserted) timelineRunning.add(c.label); else timelineRunning.delete(c.label); }
    timeline.push(new Set(timelineRunning));
  }

  // Build the combined top-level trip logic (TR/TR3P plus the unconditional TR3X path, if any).
  //
  // CRITICAL: each equation's inline "# comment" must be stripped BEFORE joining, not after.
  // The previous code did `[eqA, eqB].join(' OR ')` and only THEN called `.split('#')[0]`.
  // If eqA itself carries an inline comment (very common — SEL engineers annotate equations
  // constantly), that single split silently discarded everything after the first '#' —
  // including the entire second equation that had been appended after it. In practice this
  // meant TR3X (and any element living only in TR3X, like a 3V0/zero-sequence overvoltage
  // element) could vanish from consideration entirely on any relay where TR3P/TR happened to
  // carry a comment, with no error or warning — the tool just silently failed to find a cause.
  const tripEqCombined = [P.tripEquation, P.tripEquationX || '']
    .map(e => e.split('#')[0].trim())
    .filter(Boolean)
    .join(' OR ');
  const tripAst = tripEqCombined ? parseEq(tokenizeEq(tripEqCombined)) : null;
  // Separate ASTs for TR and TR3X individually (in addition to the combined one above) — needed
  // so that once an immediate cause is resolved, we can report WHICH of the two actually
  // contains/produced it (e.g. "via TR3X" vs "via TR") instead of always crediting the combined
  // equation's name. TR3X is typically the relay's unconditional-trip path and often protects
  // completely different elements than TR/TR3P, so conflating them mis-attributes the cause.
  const tripAstMain = P.tripEquation ? parseEq(tokenizeEq(P.tripEquation.split('#')[0].trim())) : null;
  const tripAstX = P.tripEquationX ? parseEq(tokenizeEq(P.tripEquationX.split('#')[0].trim())) : null;

  // ── Shared classification: turn a resolved immediate-cause term into a human explanation ──
  // Used by BOTH the trip path (TR/TR3P below) and the event-report path (ER further down) so
  // the same element (say, 51G1) is described identically regardless of which equation it was
  // found through. Returns { causeText, causeDetail, causeChain, family }; the caller adds
  // whatever final "command issued" node it needs (TRIP vs ER) on top of causeChain.
  function classifyImmediateCauseTerm(immediateCause, immediateCauseNegated) {
    let causeText = '', causeDetail = '', causeChain = [], family = null;
    let isNonProtection = false, resolvedNegElements = [], resolvedSvPath = [];
    const svMatch = immediateCause.match(/^SV(\d+)T?$/);
    const ocMatch = immediateCause.match(/^(5[01][A-Z]\d*T?)$/);

    if (immediateCauseNegated) {
      causeText = `Loss/De-assertion of ${immediateCause}`;
      causeDetail = `${immediateCause} was NOT asserted (per the logic's NOT ${immediateCause} term), which drove the condition true`;
      causeChain.push({ label: immediateCause, desc: 'Condition de-asserted (drives result via NOT)', delay: 0 });
      isNonProtection = !RELAY_WORD_RE.test(immediateCause) || !/^(27|59|81|5[01]|67)/.test(immediateCause);
      resolvedNegElements = [immediateCause];
    } else if (svMatch) {
      // It's an SV — recursively resolve its equation to find what it really means.
      const triggeredLabels = allChangedLabels.concat(P.initialDigitalState || []);
      const resolved = resolveSV(immediateCause, 0, triggeredLabels);
      const classified = classifyCause(resolved.elements, resolved.svPath, immediateCause, allChangedLabels, resolved.negElements);
      causeText = classified.causeText;
      causeDetail = classified.causeDetail;
      family = classified.family;
      isNonProtection = classified.isNonProtection;
      resolvedNegElements = resolved.negElements || [];
      resolvedSvPath = resolved.svPath || [];

      const leafElements = resolved.elements.filter(e => allChangedLabels.includes(e));
      for (const le of leafElements.slice(0, 3)) {
        causeChain.push({ label: le, desc: 'Protection element asserted', delay: 0 });
      }
      for (const ne of (resolved.negElements || []).slice(0, 3)) {
        causeChain.push({ label: ne, desc: 'Status/logic input de-asserted (NOT condition)', delay: 0 });
      }
      for (const step of resolved.svPath) {
        const delayMs = step.pickupDelay > 0 ? svDelayMs(P, step.pickupDelay, freq).ms.toFixed(0) : 0;
        causeChain.push({
          label: step.label,
          desc: step.comment || step.equation.split('#')[0].trim().substring(0, 60),
          delay: step.pickupDelay,
        });
        if (step.pickupDelay > 0) {
          causeChain.push({ label: step.label + 'T', desc: `Timer: ${step.pickupDelay} cyc (${delayMs}ms)`, delay: 0 });
        }
      }
    } else if (ocMatch || /^(51|50|67)/.test(immediateCause)) {
      const elName = immediateCause.replace('T', '');
      const isPhase = /50P|51P|51A|51B|51C|67P/.test(elName);
      const isGround = /50G|51G|67G/.test(elName);
      const isNegSeq = /50Q|51Q|67Q/.test(elName);
      causeText = isPhase ? `Phase Overcurrent (${elName})`
                : isGround ? `Ground Overcurrent (${elName})`
                : isNegSeq ? `Negative Sequence Overcurrent (${elName})`
                : `Overcurrent (${elName})`;
      causeDetail = `${elName} element asserted directly`;
      causeChain.push({ label: immediateCause, desc: causeText, delay: 0 });
      family = isGround ? 'groundI' : isNegSeq ? 'negSeqI' : null;
    } else if (/^81D\d/.test(immediateCause)) {
      causeText = `Frequency Element (${immediateCause.replace('T','')})`;
      causeDetail = 'Frequency element asserted directly';
      causeChain.push({ label: immediateCause, desc: causeText, delay: 0 });
      family = 'freq';
    } else if (/^59/.test(immediateCause)) {
      const isGroundOV = /^59[YZ]?[GN]\d/.test(immediateCause);
      const isNegSeqOV = /^59[YZ]?Q\d/.test(immediateCause);
      causeText = `Overvoltage (${immediateCause.replace('T','')})`;
      causeDetail = `${immediateCause} asserted directly`;
      causeChain.push({ label: immediateCause, desc: causeText, delay: 0 });
      family = isGroundOV ? 'zeroSeqV' : isNegSeqOV ? 'negSeqV' : null;
    } else if (/^27/.test(immediateCause)) {
      causeText = `Undervoltage (${immediateCause.replace('T','')})`;
      causeDetail = `${immediateCause} asserted directly`;
      causeChain.push({ label: immediateCause, desc: causeText, delay: 0 });
    } else if (immediateCause === 'PB12_PUL') {
      causeText = 'Manual (Pushbutton)';
      causeDetail = 'Initiated via PB12 pushbutton pulse';
      causeChain.push({ label: 'PB12_PUL', desc: 'Pushbutton', delay: 0 });
    } else if (immediateCause === 'OC3') {
      causeText = 'External Contact (OC3)';
      causeDetail = 'Triggered by external overcurrent contact OC3';
      causeChain.push({ label: 'OC3', desc: 'External contact', delay: 0 });
    } else if (immediateCause === 'TOSLP') {
      causeText = 'Relay Going to Sleep';
      causeDetail = 'Relay entering sleep mode';
      causeChain.push({ label: 'TOSLP', desc: 'Sleep mode', delay: 0 });
    } else if (/^3PWR/.test(immediateCause) || /^PWR_SRC/.test(immediateCause)) {
      causeText = 'Loss of AC Power';
      causeDetail = 'AC power source lost';
      causeChain.push({ label: immediateCause, desc: 'Power loss', delay: 0 });
    } else if (immediateCause === 'CLOSE3P' || /^CLOSE/.test(immediateCause)) {
      causeText = 'Breaker Close';
      causeDetail = `${immediateCause} asserted directly`;
      causeChain.push({ label: immediateCause, desc: causeText, delay: 0 });
    } else if (/^52A/.test(immediateCause)) {
      causeText = 'Breaker Status Change (52A)';
      causeDetail = `${immediateCause} changed state`;
      causeChain.push({ label: immediateCause, desc: causeText, delay: 0 });
    } else if (/^RMB\d+[A-Z]?$/.test(immediateCause) || /^TMB\d+[A-Z]?$/.test(immediateCause)) {
      // MIRRORED BITS — SEL's proprietary bidirectional relay-to-relay digital comms over a
      // serial link, NOT a locally-measured protection element. RMBn = "Received" (from an
      // upstream/adjacent device); TMBn = "Transmitted" (to that device). Commonly used to
      // implement communications-assisted/pilot tripping schemes, so a trip that resolves to
      // an RMB bit means an upstream relay told THIS device to trip — the local relay may not
      // have seen an overcurrent/overvoltage condition large enough to trip on its own.
      //
      // RMB points are pure inputs — they're never defined via their own SELOGIC equation, so
      // there's no comment attached directly to them. But the reciprocal TMB definition this
      // same device sends OUT often documents the actual purpose of that comms relationship
      // (e.g. "TMB4A := TRIP3P #DTT FROM PSE OR LOCAL TRIP" explains what an RMB4B trip means,
      // even though the port letter differs) — findMirroredBitComment() looks for that.
      const isReceived = immediateCause.startsWith('RMB');
      causeText = isReceived ? `Communications Signal Received (${immediateCause})` : `Communications Signal Transmitted (${immediateCause})`;
      causeDetail = isReceived
        ? `${immediateCause} is a Received MIRRORED BITS point — a signal received from an upstream or adjacent relay over a serial communications link, not a local measurement. This is characteristic of a coordinated/pilot tripping scheme: another device detected a condition and signaled this relay to trip.`
        : `${immediateCause} is a Transmitted MIRRORED BITS point sent to another relay over a serial communications link.`;
      const mbComments = findMirroredBitComments(P, immediateCause);
      if (mbComments.length === 1) {
        causeDetail += ` A related settings comment on this same numbered channel: "${mbComments[0].source} := ... #${mbComments[0].comment}". Channel numbers are assigned independently per direction, so this is not necessarily the same logical relationship as ${immediateCause}.`;
      } else if (mbComments.length > 1) {
        const list = mbComments.map(c => `"${c.source} := ... #${c.comment}"`).join('; ');
        causeDetail += ` Multiple related settings comments share this channel number (not necessarily the same logical relationship as ${immediateCause}): ${list}.`;
      }
      // Look for a companion term this bit is AND-paired with in the actual equation text
      // (a common security measure in pilot schemes — requiring two independent bits to
      // agree before tripping, so a single noise event or bit error can't cause a false trip).
      const eqSources = [tripEqCombined, P.erEquation || ''].filter(Boolean);
      for (const eqText of eqSources) {
        const pairRe = new RegExp('\\(\\s*([A-Z0-9_]+)\\s+AND\\s+' + immediateCause + '\\s*\\)|\\(\\s*' + immediateCause + '\\s+AND\\s+([A-Z0-9_]+)\\s*\\)');
        const pm = eqText.match(pairRe);
        const companion = pm ? (pm[1] || pm[2]) : null;
        if (companion) {
          causeDetail += ` The trip logic requires this together with ${companion} (both must assert) — a common security measure in pilot schemes.`;
          causeChain.push({ label: companion, desc: 'Paired communications bit (AND condition)', delay: 0 });
          break;
        }
      }
      causeChain.push({ label: immediateCause, desc: causeText, delay: 0 });
    } else {
      causeText = immediateCause;
      causeDetail = `Element ${immediateCause} asserted`;
      causeChain.push({ label: immediateCause, desc: causeText, delay: 0 });
    }

    return { causeText, causeDetail, causeChain, family, isNonProtection, negElements: resolvedNegElements, svPath: resolvedSvPath };
  }

  if (tripTransition) {
    const tripIdx = digitalTransitions.indexOf(tripTransition);

    // Evaluate the real trip logic to find what actually explains the KNOWN, real trip
    // instant (tripTransition — found directly from the recorded TRIP/TR bit itself, not
    // derived from re-evaluating the equation). This ground-truth anchoring matters: a trip
    // equation is very often "branch1 OR branch2 OR ... OR R_TRIG someLatch", and if even ONE
    // branch was already true at record start (e.g. a stale status/logic condition that's sat
    // true the whole time — R_TRIG's level-approximation can't tell that apart from a fresh
    // edge), the reconstructed equation as a WHOLE reads "already true at t=0" and never shows
    // a 0→1 crossing again, even though a genuinely different, later-transitioning branch is
    // what actually explains why the REAL relay tripped right now. Anchoring on the known
    // instant and asking "which live/neg leaf of the equation matches what literally changed
    // in that SAME digital-word transition" sidesteps that entirely — tripTransition.changes
    // is ground truth from the recorded data, immune to the OR-branch conflation above.
    let immediateCause = null;
    let immediateCauseNegated = false;
    let evalFoundAt = null;
    let stateAtTripSnapshot = null;
    if (tripAst) {
      const groundTruthChanged = new Set((tripTransition.changes || []).map(c => c.label));
      const tIdxTimeline = Math.min(tripIdx + 1, timeline.length - 1);
      const stateAtTrip = timeline[tIdxTimeline];
      stateAtTripSnapshot = stateAtTrip;
      const res0 = evalAst(tripAst, name => stateAtTrip.has(name));
      const liveChanged0 = [...res0.live].filter(l => groundTruthChanged.has(l));
      const negChanged0 = [...res0.neg].filter(l => groundTruthChanged.has(l));

      if (liveChanged0.length) { immediateCause = liveChanged0[0]; immediateCauseNegated = false; evalFoundAt = tIdxTimeline; }
      else if (negChanged0.length) { immediateCause = negChanged0[0]; immediateCauseNegated = true; evalFoundAt = tIdxTimeline; }
      else {
        // Nothing in the equation's resolved live/neg set matches what literally changed at
        // the real trip instant (can happen with multi-cycle R_TRIG propagation delays, where
        // the underlying signal's own edge landed one digital-transition record earlier than
        // the TRIP bit it fed). Fall back to the original approach: walk backward through the
        // reconstructed equation looking for its own latest 0→1 crossing.
        const maxIdx = Math.min(tripIdx + 1, timeline.length - 1);
        let prevVal = evalAst(tripAst, name => timeline[0].has(name)).value;
        let bestI = prevVal ? 0 : null; // already true at record start — cross-event fallback
        for (let i = 1; i <= maxIdx; i++) {
          const val = evalAst(tripAst, name => timeline[i].has(name)).value;
          if (val && !prevVal) bestI = i; // keep the LATEST rising edge found
          prevVal = val;
        }
        if (bestI != null) {
          const state = timeline[bestI];
          const res = evalAst(tripAst, name => state.has(name));
          const changedHere = new Set((digitalTransitions[bestI - 1]?.changes || []).map(c => c.label));
          const liveChanged = [...res.live].filter(l => changedHere.has(l));
          const negChanged = [...res.neg].filter(l => changedHere.has(l));
          if (liveChanged.length) { immediateCause = liveChanged[0]; immediateCauseNegated = false; }
          else if (negChanged.length) { immediateCause = negChanged[0]; immediateCauseNegated = true; }
          else if (res.live.size) { immediateCause = [...res.live][0]; immediateCauseNegated = false; }
          else if (res.neg.size) { immediateCause = [...res.neg][0]; immediateCauseNegated = true; }
          evalFoundAt = bestI;
        }
      }

    }

    if (immediateCause) {
      const isCrossEvent = evalFoundAt === 0; // only true at record start = condition predates this record
      // Which of TR / TR3X actually contains the resolved leaf — astContainsToken walks the AST
      // looking for the literal token, independent of NOT/AND/OR structure, so this correctly
      // attributes the cause even when the leaf sits deep inside a nested SV chain reference.
      // Falls back to the combined/main name if neither individual AST can be checked (e.g. one
      // of the two equations is empty) or if — unusually — the leaf appears in both.
      let sourceEquationName = P.tripEquationName || 'TR';
      if (tripAstX && astContainsToken(tripAstX, immediateCause) && !(tripAstMain && astContainsToken(tripAstMain, immediateCause))) {
        sourceEquationName = 'TR3X';
      }
      const sourceEquationText = sourceEquationName === 'TR3X' ? (P.tripEquationX || '') : (P.tripEquation || '');
      const classified = classifyImmediateCauseTerm(immediateCause, immediateCauseNegated);
      let { causeText, causeDetail, causeChain, family, isNonProtection, negElements } = classified;
      // Restore trip-specific phrasing (the shared classifier uses generic wording so it also
      // reads correctly for non-trip ER events; append "Trip" context back on here).
      causeText = causeText.replace(/^(Phase Overcurrent|Ground Overcurrent|Negative Sequence Overcurrent|Overcurrent|Frequency Element|Overvoltage|Undervoltage|Manual|External Contact|Loss of AC Power)(\s*\(|$)/, (m, p1, p2) => {
        const tripWord = p1 === 'Manual' ? 'Manual Trip' : p1 === 'External Contact' ? 'External Trip' : p1 === 'Frequency Element' ? 'Frequency Trip' : p1 === 'Loss of AC Power' ? 'Loss of AC Power Trip' : p1 + ' Trip';
        return tripWord + p2;
      });

      if (isCrossEvent) {
        causeDetail += ' — condition was already present when this event record began';
        if (prevEvent) {
          causeDetail += ` (possibly originating in prior event ${prevEvent.parsed.eventInfo.eventType || prevEvent.parsed.fileName})`;
        }
      }

      // Always add the trip bit at the end
      causeChain.push({ label: tripBitUsed, desc: 'Trip command issued', delay: 0 });

      // Did the resolved leaf(s) that supposedly explain this trip ever actually change state
      // anywhere in this record? The literal bit that changed AT the trip instant (immediateCause
      // itself, e.g. SV28T) always did — that's how it was found. But when that bit resolves
      // (via resolveSV) to a de-asserted status input (e.g. IN301/303/305 inside a NOT clause),
      // those specific field inputs may have been sitting at that same (false) reading for the
      // ENTIRE record, never transitioning at all. That's a meaningful distinction: it means
      // whatever flipped the internal bit did so without a visible field-input change in this
      // window — worth knowing, rather than presenting a resolved name as if it were a fresh,
      // observed cause.
      const neverTransitioned = (negElements || []).filter(ne =>
        !digitalTransitions.some(t => t.changes.some(c => c.label === ne)));

      // ── Branching logic tree ──
      // ONE unified tree from the ultimate leaf conditions all the way to the trip equation —
      // any SV reference encountered is substituted with that SV's own equation (recursively),
      // so an AND's easy-to-miss other side (e.g. "AND 52A") shows up right in context no
      // matter how many SV layers deep it lives, instead of being split across separate cards.
      let logicTree = null, logicTreeOtherBranchCount = 0;
      if (tripAst && stateAtTripSnapshot) {
        const isAssertedAtTrip = name => stateAtTripSnapshot.has(name);
        const branches = splitTopOr(tripAst);
        const winningBranch = branches.find(b => astContainsToken(b, immediateCause)) || branches[0];
        if (winningBranch) {
          logicTree = pruneLogicTree(bakeFullLogicTree(winningBranch, isAssertedAtTrip, new Set(), 0));
          logicTreeOtherBranchCount = Math.max(0, branches.length - 1);
        }
      }

      A.tripCause = {
        causeText, causeDetail, immediateCause, causeChain, tripTransition,
        crossEvent: isCrossEvent, family, isNonProtection, negElements: negElements || [],
        negElementsNeverTransitioned: neverTransitioned,
        logicTree, logicTreeOtherBranchCount, finalLabel: tripBitUsed,
        sourceEquationName, sourceEquationText,
      };
    } else {
      const causeText = 'Trip Detected (cause element not captured in digital data)';
      const causeDetail = `${tripBitUsed} asserted but the specific triggering term could not be resolved from the trip logic against the reconstructed bit-state timeline. The SV Logic and Timeline tabs contain the underlying digital transitions and equation resolution.`;
      const causeChain = [{ label: P.tripEquationName || 'TR', desc: 'Trip equation', delay: 0 }, { label: tripBitUsed, desc: 'Trip', delay: 0 }];
      A.tripCause = { causeText, causeDetail, immediateCause: null, causeChain, tripTransition };
    }
  } else if (P.erEquation) {
    // ── EVENT REPORT (ER) PATH ──
    // No TRIP/TRIP3P bit ever asserted in this record — but many SEL relays are also
    // programmed with a *separate* SELOGIC equation, ER (Event Report trigger), specifically
    // to capture conditions worth recording WITHOUT tripping the breaker (e.g. "ER := R_TRIG
    // 51G1" — show me every ground time-OC pickup, even ones that self-clear). If the file
    // has one, resolve it with exactly the same boolean-timeline machinery as the trip
    // equation, so an ER-triggered event gets a real, specific explanation instead of the
    // generic "trip cause not captured" message (which — for these files — was never a trip
    // to explain in the first place).
    const erEqClean = P.erEquation.split('#')[0].trim();
    const erAst = erEqClean ? parseEq(tokenizeEq(erEqClean)) : null;

    let immediateCause = null;
    let immediateCauseNegated = false;
    let erFoundAt = null;
    if (erAst) {
      // Unlike the trip search (which walks backward from a known trip instant), there's no
      // equivalent anchor point here, so scan forward for the FIRST moment the ER logic
      // becomes true. This equation is built almost entirely from R_TRIG/F_TRIG qualifiers,
      // and — critically — real ER equations often use BOTH on the very same operand (e.g.
      // "R_TRIG 52A3P OR F_TRIG 52A3P" to mean "breaker just closed OR just opened"). A level
      // approximation of edges can't tell those apart: if the breaker stays closed for the
      // entire record, "52A3P" is asserted throughout, and a naive pass-through would make
      // both terms look permanently true from t=0 — drowning out the real triggering term
      // entirely. evalAstEdgeAware compares each pair of consecutive snapshots properly, so a
      // rising-edge term is only true exactly where its operand actually just went from false
      // to true (never at t=0, since there's no prior sample to compare against there).
      for (let i = 1; i < timeline.length; i++) {
        const prevState = timeline[i - 1];
        const currState = timeline[i];
        const res = evalAstEdgeAware(erAst, name => currState.has(name), name => prevState.has(name));
        if (!res.value || (!res.live.size && !res.neg.size)) continue;

        // Prefer whichever leaf the transition at this exact step reports as having changed,
        // over any other leaf that merely happens to co-occur as "live" in the equation.
        const changedHere = new Set((digitalTransitions[i - 1]?.changes || []).map(c => c.label));
        const liveChanged = [...res.live].filter(l => changedHere.has(l));
        const negChanged = [...res.neg].filter(l => changedHere.has(l));

        if (liveChanged.length) { immediateCause = liveChanged[0]; immediateCauseNegated = false; }
        else if (negChanged.length) { immediateCause = negChanged[0]; immediateCauseNegated = true; }
        else if (res.live.size) { immediateCause = [...res.live][0]; immediateCauseNegated = false; }
        else { immediateCause = [...res.neg][0]; immediateCauseNegated = true; }
        erFoundAt = i;
        break;
      }
    }

    if (immediateCause) {
      const classified = classifyImmediateCauseTerm(immediateCause, immediateCauseNegated);
      const { causeChain, family, isNonProtection, negElements } = classified;
      const causeText = classified.causeText;
      const causeDetail = classified.causeDetail
        + ` — this triggered the relay's Event Report (${P.erEquationName || 'ER'}) logic, not a trip. No TRIP/TRIP3P bit asserted anywhere in this record.`;

      causeChain.push({ label: P.erEquationName || 'ER', desc: 'Event report recorded (no trip)', delay: 0 });

      // Fabricate a transition-like object for the chart markers (TRIG/marker alignment
      // elsewhere expects a tripTransition-shaped object with analogSampleIdx/timeMs).
      const erTransitionIdx = Math.max(0, erFoundAt - 1);
      const erTransition = digitalTransitions[erTransitionIdx] || digitalTransitions[0] || null;

      const neverTransitioned = (negElements || []).filter(ne =>
        !digitalTransitions.some(t => t.changes.some(c => c.label === ne)));

      A.tripCause = {
        causeText, causeDetail, immediateCause, causeChain,
        tripTransition: erTransition, family, isEventReport: true,
        isNonProtection, negElements: negElements || [], negElementsNeverTransitioned: neverTransitioned,
      };
    }
    // If the ER equation exists but couldn't be resolved either, leave A.tripCause as null —
    // the banner's existing "Unable to determine" fallback still applies, just as honestly.
  }

  // Build digital timeline with dynamic SV descriptions
  A.digitalTimeline = digitalTransitions.map(t => {
    const asserts = t.changes.filter(c => c.asserted).map(c => c.label);
    const deasserts = t.changes.filter(c => !c.asserted).map(c => c.label);
    const allChanged = [...asserts, ...deasserts];
    let desc = '';

    const hasTrip = asserts.some(l => ['TRIP3P','TRIPA','TRIPB','TRIPC','TRIP'].includes(l));
    const hasClose = asserts.some(l => ['CLOSE','CLOSE3P','CLOSEA','CLOSEB','CLOSEC','CL'].includes(l));
    const bkrClosedNow = ['52A3P', '52A'].some(l => asserts.includes(l)) || deasserts.includes('52B');
    const bkrOpenNow = ['52A3P', '52A'].some(l => deasserts.includes(l)) || asserts.includes('52B');
    // Ground/neutral-residual/negative-sequence protection elements — see the broadened
    // sequence-element regex used elsewhere for the "What is sequence voltage/current?" link;
    // these get their own category since "50G1P picks up" reads very differently from a plain
    // phase overcurrent, and lumping it into "Overcurrent element state change" hid that.
    const seqElRe = /^(50|51|59|67|27|47)[A-Z]*[GNQ]\d?/;
    const seqEls = [...new Set(allChanged.filter(l => seqElRe.test(l)))];
    const hasOC = asserts.some(l => /^5[01][A-Z]/.test(l));
    const hasUV = asserts.some(l => /^27/.test(l));
    const hasOV = asserts.some(l => /^59/.test(l));
    const hasFreq = allChanged.some(l => /^81[DR]/.test(l));
    const hasDir = asserts.some(l => /^(67[PGQ]?\d|F32[QVGP]?|R32[QVGP]?)/.test(l));
    const hasER = asserts.includes('ER');
    const hasComm = allChanged.some(l => ['COMMLOSS','COMMFLT','COMMIDLE','LINKA','LINKFAIL'].includes(l));
    const hasTarget = asserts.some(l => ['TRGTR','RSTTRGT'].includes(l));
    const hasPB = asserts.some(l => /^PB\d+_PUL$/.test(l));
    const hasIN = allChanged.some(l => /^IN\d+$/.test(l));
    const hasOUT = allChanged.some(l => /^OUT\d+$/.test(l));

    // Short, plain-text (no HTML) description of a single bit, used by several branches below
    // and as the final fallback — pulls from the same tooltip data as everywhere else in the
    // tool, so the wording stays consistent whether it's read here or in a popup.
    const plainDesc = (label, asserted) => {
      const el = explainElementBit(label, P, freq);
      if (el) {
        // Some bits only carry a static one-line dictionary entry (e.g. "Fault on Phase A"),
        // for which explainElementBit pads out a generic "the condition just described is
        // currently active" on/off pair rather than real state-specific text. That boilerplate
        // reads fine paired with a visible "short" title in the bit-detail popup, but is
        // meaningless read alone here — prefer the short description itself in that case.
        const stateText = asserted ? el.on : el.off;
        const isGenericPad = /^The condition (just described is currently true\/active on this device\.|described is not currently active\.)$/.test(stateText);
        return (isGenericPad ? el.short : stateText).split('\n')[0];
      }
      const tip = getSVTooltip(label, P);
      return tip ? tip.split('\n')[0] : label;
    };

    if (hasTrip) {
      desc = 'TRIP COMMAND ISSUED';
    } else if (hasClose) {
      desc = asserts.includes('CC') ? 'CLOSE COMMAND ISSUED (remote/SCADA)' : 'CLOSE COMMAND ISSUED';
    } else if (bkrClosedNow || bkrOpenNow) {
      desc = bkrClosedNow ? 'Breaker confirms CLOSED' : 'Breaker confirms OPEN';
    } else if (allChanged.some(l => /^SV\d+T$/.test(l))) {
      // Describe what the SV timer expiration means using the equation. Checked against BOTH
      // asserts and deasserts (not asserts alone) so a blinker's OFF transitions get simplified
      // just as much as its ON ones — otherwise only half of a blinker's noise gets filtered.
      const svtLabels = allChanged.filter(l => /^SV\d+T$/.test(l));
      const descs = svtLabels.map(l => {
        const asserted = asserts.includes(l);
        const num = parseInt(l.replace(/SV|T/g, ''));
        const sv = svSettings.find(s => s.num === num);
        if (!sv) return `${l} ${asserted ? 'timer expired' : 'timer resets'}`;
        const info = describeSVLogic(sv);
        if (info.isBlinker) return `${l}: Blinker`;
        if (info.comment) return `${l} ${asserted ? 'timer expired' : 'timer resets'} (${info.comment.substring(0, 50)})`;
        if (info.referencedName) return `Timer for ${info.referencedName} ${asserted ? 'expired' : 'resets'}`;
        return `${l} ${asserted ? 'timer expired' : 'timer resets'}`;
      });
      desc = descs.join('; ');
    } else if (allChanged.some(l => /^SV\d+$/.test(l))) {
      const svLabels = allChanged.filter(l => /^SV\d+$/.test(l));
      const descs = svLabels.map(l => {
        const asserted = asserts.includes(l);
        const num = parseInt(l.replace('SV', ''));
        const sv = svSettings.find(s => s.num === num);
        if (!sv) return `${l} ${asserted ? 'asserts' : 'de-asserts'}`;
        const info = describeSVLogic(sv);
        if (info.isBlinker) return `${l}: Blinker`;
        if (info.comment) return `${l} ${asserted ? 'starts' : 'clears'} (${info.comment.substring(0, 50)})`;
        if (info.referencedName) return `${info.referencedName} condition ${asserted ? 'starts' : 'clears'}`;
        return `${l} ${asserted ? 'asserts' : 'de-asserts'}`;
      });
      desc = descs.join('; ');
    } else if (seqEls.length) {
      const isAssert = seqEls.some(l => asserts.includes(l));
      desc = `${seqEls.join(', ')} ${isAssert ? 'picks up' : 'resets'} — ground/residual or negative-sequence element`;
    } else if (hasOC) {
      const ocLabels = asserts.filter(l => /^5[01][A-Z]/.test(l));
      desc = ocLabels.length === 1 ? `${ocLabels[0]} picks up — ${plainDesc(ocLabels[0], true)}` : `Overcurrent elements pick up: ${ocLabels.join(', ')}`;
    } else if (hasUV) {
      const uvLabels = asserts.filter(l => /^27/.test(l));
      desc = uvLabels.length === 1 ? `${uvLabels[0]} picks up — ${plainDesc(uvLabels[0], true)}` : `Undervoltage elements pick up: ${uvLabels.join(', ')}`;
    } else if (hasOV) {
      const ovLabels = asserts.filter(l => /^59/.test(l));
      desc = ovLabels.length === 1 ? `${ovLabels[0]} picks up — ${plainDesc(ovLabels[0], true)}` : `Overvoltage elements pick up: ${ovLabels.join(', ')}`;
    } else if (hasFreq) {
      const freqLabels = allChanged.filter(l => /^81[DR]/.test(l));
      desc = `Frequency element ${asserts.some(l => freqLabels.includes(l)) ? 'picks up' : 'resets'}: ${freqLabels.join(', ')}`;
    } else if (hasDir) {
      const dirLabels = asserts.filter(l => /^(67[PGQ]?\d|F32[QVGP]?|R32[QVGP]?)/.test(l));
      desc = `Directional element asserts: ${dirLabels.join(', ')} (forward/reverse per this relay's own polarity setting)`;
    } else if (hasER) {
      desc = 'Event Report triggered — recorded as a separate record, not itself a trip';
    } else if (hasComm) {
      const commLabels = allChanged.filter(l => ['COMMLOSS','COMMFLT','COMMIDLE','LINKA','LINKFAIL'].includes(l));
      desc = `Communications status change: ${commLabels.map(l => `${asserts.includes(l) ? '+' : '-'}${l}`).join(', ')}`;
    } else if (hasTarget) {
      desc = 'Front-panel target/LED reset';
    } else if (hasPB) {
      const pbLabels = asserts.filter(l => /^PB\d+_PUL$/.test(l));
      desc = `Front-panel pushbutton pressed: ${pbLabels.join(', ')}`;
    } else if (hasIN) {
      const inLabels = allChanged.filter(l => /^IN\d+$/.test(l));
      desc = inLabels.length === 1
        ? `Digital input ${inLabels[0]} ${asserts.includes(inLabels[0]) ? 'asserts' : 'de-asserts'} — ${plainDesc(inLabels[0], asserts.includes(inLabels[0]))}`
        : `Digital input change: ${inLabels.join(', ')}`;
    } else if (hasOUT) {
      const outLabels = allChanged.filter(l => /^OUT\d+$/.test(l));
      desc = `Output contact change: ${outLabels.map(l => `${asserts.includes(l) ? '+' : '-'}${l}`).join(', ')}`;
    } else {
      // Fallback — describe the first bit that actually changed rather than a bare "Digital
      // state change". Virtually everything reaching this point still gets a real sentence,
      // since plainDesc() draws on the same tooltip reference used throughout the rest of the
      // tool; only a bit with genuinely no reference anywhere falls back to its bare name.
      const first = asserts[0] || deasserts[0];
      const firstAsserted = asserts.includes(first);
      desc = first ? `${first} ${firstAsserted ? 'asserts' : 'de-asserts'} — ${plainDesc(first, firstAsserted)}` : 'Digital state change';
      if (allChanged.length > 1) desc += ` (+${allChanged.length - 1} more)`;
    }

    return { ...t, asserts, deasserts, desc, isTrip: hasTrip };
  });

  // ══════════════════════════════════════════════════════════════════════
  // INVESTIGATION FLAGS
  // ══════════════════════════════════════════════════════════════════════
  // These deliberately don't tell anyone what to DO about a trip — no "check the CT wiring",
  // no "contact the FST". They exist for one narrower purpose: an event that resolves to a
  // plain-looking relay-word name, or a waveform shape that resembles a familiar fault
  // signature, can get misread by anyone scanning the summary quickly. Each flag here names a
  // specific, checkable fact (an element that picked up but wasn't in the trip path; a breaker
  // that was already open; a trip that traces to logic/status bits instead of a measured
  // quantity) so that misreading doesn't happen silently.
  A.investigationFlags = [];

  // ══════════════════════════════════════════════════════════════════════
  // CLOSE-ATTEMPT ANALYSIS
  // ══════════════════════════════════════════════════════════════════════
  // A breaker CLOSE command is a distinct kind of event from a protection trip, and deserves
  // its own read rather than being folded into the generic trip-cause logic above. Three
  // outcomes look superficially similar (a close command, maybe followed by a trip) but mean
  // very different things:
  //   1. The breaker never confirms closed at all — a genuine close failure (stuck mechanism,
  //      failed close coil, an interlock/permissive blocking the close). A device-health
  //      question, not an electrical one.
  //   2. The breaker confirms closed, then a protection element operates within a few cycles,
  //      with the fault indication appearing BEFORE the breaker even finished traveling to
  //      closed — the classic "closing into a pre-existing fault" signature (prestrike arcing
  //      across the still-closing gap as the contacts approach). The line was faulted, not
  //      the breaker.
  //   3. The breaker confirms closed, a protection element operates shortly after, but only
  //      AFTER full closure was confirmed — consistent with a fault (or inrush) that appeared
  //      once the circuit was actually energized, a materially different read from case 2.
  //   4. The breaker confirms closed and stays closed — a normal, successful close; nothing
  //      flagged, matching this tool's existing philosophy of staying quiet on routine outcomes.
  // This runs independently of whatever A.tripCause resolved to (or whether it resolved at
  // all) — a close attempt is worth reading on its own terms.
  {
    const dLabels = P.digitalLabels || [];
    const closeLabel = ['CLOSE', 'CL'].find(l => dLabels.includes(l));
    const remoteCloseLabel = dLabels.includes('CC') ? 'CC' : null;
    const bkrCloseLabel = ['52A3P', '52A'].find(l => dLabels.includes(l));
    const tripLabels = ['TRIP3P', 'TRIPA', 'TRIPB', 'TRIPC', 'TRIP'].filter(l => dLabels.includes(l));

    // First CLOSE assertion actually observed as a transition in this record (an
    // already-asserted-at-record-start CLOSE can't be timed from here, so it's left undetected
    // rather than guessed at — consistent with how the breaker-already-open flag above handles
    // the analogous "can't see the start" case).
    const closeTransition = closeLabel
      ? digitalTransitions.find(t => t.changes.some(c => c.label === closeLabel && c.asserted))
      : null;

    if (closeTransition) {
      const spcC = P.eventInfo.samPerCycA || 32;
      const msPerSampleC = 1000 / (freq * spcC);
      const closeIdx = closeTransition.analogSampleIdx;
      const closeTransIdx = digitalTransitions.indexOf(closeTransition);

      // Best-effort read of what initiated the close, from whatever else asserted in the same
      // transition bundle as CLOSE itself.
      const bundle = closeTransition.changes.filter(c => c.asserted).map(c => c.label);
      let initiatedBy = 'not determinable from this record';
      if (remoteCloseLabel && bundle.includes(remoteCloseLabel)) initiatedBy = 'a remote/SCADA close command';
      else if (bundle.some(l => /^PB\d+_PUL$/.test(l))) initiatedBy = 'the local front-panel close pushbutton';

      // Breaker confirmation: first assertion of the closed-status bit at or after the close cmd.
      const bkrConfirmTransition = bkrCloseLabel
        ? digitalTransitions.slice(closeTransIdx).find(t => t.changes.some(c => c.label === bkrCloseLabel && c.asserted))
        : null;
      const closeTimeMs = bkrConfirmTransition ? (bkrConfirmTransition.analogSampleIdx - closeIdx) * msPerSampleC : null;

      // Next trip after the close command, if any.
      const tripTransitionAfterClose = tripLabels.length
        ? digitalTransitions.slice(closeTransIdx).find(t => t.changes.some(c => tripLabels.includes(c.label) && c.asserted))
        : null;
      const tripDelayMs = tripTransitionAfterClose ? (tripTransitionAfterClose.analogSampleIdx - closeIdx) * msPerSampleC : null;
      const tripElement = tripTransitionAfterClose
        ? tripLabels.find(l => tripTransitionAfterClose.changes.some(c => c.label === l && c.asserted)) : null;

      // Did a protection ELEMENT pick up (not just the final trip bit) before the breaker
      // confirmed fully closed? That's the tell for prestrike/closing-into-a-fault — a fault
      // indication appearing while the contacts were still traveling, not after.
      const protPickupRe = /^(50|51|59|67|27)[A-Z0-9]*P$/;
      let firstProtPickup = null;
      for (const t of digitalTransitions.slice(closeTransIdx)) {
        if (bkrConfirmTransition && t.analogSampleIdx > bkrConfirmTransition.analogSampleIdx) break;
        const hit = t.changes.find(c => c.asserted && protPickupRe.test(c.label));
        if (hit) { firstProtPickup = { label: hit.label, idx: t.analogSampleIdx }; break; }
      }
      const pickupBeforeFullyClosed = !!firstProtPickup;

      A.closeAttempt = {
        closeLabel, initiatedBy, closeMs: closeIdx * msPerSampleC,
        bkrCloseLabel, bkrConfirmed: !!bkrConfirmTransition, closeTimeMs,
        tripElement, tripDelayMs, firstProtPickup, pickupBeforeFullyClosed,
        _tripTransitionRef: tripTransitionAfterClose || null,
      };

      // ── Breaker never confirmed closed at all — genuine close failure ──
      if (bkrCloseLabel && !bkrConfirmTransition) {
        const recordEndMs = (analogData.length - 1 - closeIdx) * msPerSampleC;
        if (recordEndMs > 10 * (1000 / freq)) {
          A.investigationFlags.push({
            severity: 'high',
            title: 'Close Command Issued — Breaker Never Confirmed Closed',
            detail: `A close command (${tt(closeLabel, P)}, initiated by ${initiatedBy}) was issued at t=${(closeIdx * msPerSampleC).toFixed(0)} ms, but ${tt(bkrCloseLabel, P)} never asserts anywhere in the following ${recordEndMs.toFixed(0)} ms of record. This looks like a genuine failure of the breaker to close — the operating mechanism, the close coil circuit, or an interlock/permissive blocking the close — rather than an electrical condition on the line. Worth checking the breaker/recloser directly.`,
          });
        }
      }

      // ── Closed, then re-tripped almost immediately ──
      if (bkrConfirmTransition && tripTransitionAfterClose && tripDelayMs != null && tripDelayMs < (1000 / freq) * 15) {
        const cyc = (tripDelayMs / (1000 / freq)).toFixed(1);
        if (pickupBeforeFullyClosed) {
          const pickupMs = (firstProtPickup.idx - closeIdx) * msPerSampleC;
          A.investigationFlags.push({
            severity: 'high',
            title: 'Closed Into an Existing Fault',
            detail: `${tt(firstProtPickup.label, P)} picked up ${pickupMs.toFixed(0)} ms after the close command — BEFORE ${tt(bkrCloseLabel, P)} confirmed the breaker fully closed (at ${closeTimeMs.toFixed(0)} ms). A fault indication appearing while the contacts were still traveling is consistent with prestrike arcing across the closing gap — a fault was already present on the line, and the breaker closed directly into it. The trip that followed, ${cyc} cycles after the close command via ${tt(tripElement, P)}, reads as the protection system doing its job, not a device malfunction.`,
          });
        } else {
          A.investigationFlags.push({
            severity: 'medium',
            title: 'Breaker Closed, Then Re-Tripped Shortly After',
            detail: `The breaker confirmed closed (${tt(bkrCloseLabel, P)}, ${closeTimeMs.toFixed(0)} ms after the close command), then tripped again via ${tt(tripElement, P)} ${cyc} cycles later. Unlike a prestrike pattern, no protection element picked up until after full closure was confirmed — consistent with a fault (or inrush) that appeared once the circuit was actually energized, or a condition local to the equipment being closed onto, rather than a fault already sitting on the line before contact.`,
          });
        }
      }

      // ── Slow mechanical close time (only meaningful once the breaker did confirm closed) ──
      if (bkrConfirmTransition && closeTimeMs != null) {
        const closeCyc = closeTimeMs / (1000 / freq);
        if (closeCyc > 10) {
          A.investigationFlags.push({
            severity: 'medium',
            title: 'Slow Breaker Close Time',
            detail: `${tt(bkrCloseLabel, P)} did not confirm closed until ${closeTimeMs.toFixed(0)} ms (~${closeCyc.toFixed(1)} cycles) after the close command — slower than a typical breaker's closing time. Worth comparing against this breaker's rated closing time if mechanism health is in question.`,
          });
        }
      }

      // ── Current spike / inrush check — only relevant when the close attempt was followed by ──
      // a trip. A large current spike right after energizing isn't automatically a fault: closing
      // onto a transformer routinely draws a magnetizing inrush current that can be many times
      // full-load current and can look, on a magnitude chart alone, like a fault. This check
      // gives that alternative explanation an explicit, checkable basis (2nd-harmonic content)
      // rather than leaving "was this actually a fault?" unaddressed for a failed close attempt.
      if (tripTransitionAfterClose) {
        const preWinStart = Math.max(0, closeIdx - spcC * 2);
        const preSamples = analogData.slice(preWinStart, closeIdx);
        const peakOf = (rows, ch) => rows.reduce((m, r) => Math.max(m, Math.abs(r[ch] || 0)), 0);
        const peakPre = Math.max(peakOf(preSamples, 'IA'), peakOf(preSamples, 'IB'), peakOf(preSamples, 'IC'));
        const windowEnd = Math.min(analogData.length, tripTransitionAfterClose.analogSampleIdx + 2);
        const duringSamples = analogData.slice(closeIdx, windowEnd);
        const peakDuring = Math.max(peakOf(duringSamples, 'IA'), peakOf(duringSamples, 'IB'), peakOf(duringSamples, 'IC'));
        const hasSpike = peakDuring > Math.max(peakPre * 3, 1); // secondary amps floor

        if (hasSpike) {
          const inrush = detectInrushSignature(P, closeIdx, windowEnd);
          const inrushLikely = !!inrush && inrush.pct2H >= 15;
          A.closeAttempt.currentSpike = { peakPre, peakDuring, inrush, inrushLikely };
          if (inrushLikely) {
            A.investigationFlags.push({
              severity: 'medium',
              title: 'Current Spike Consistent With Inrush, Not Necessarily a Fault',
              detail: `Phase ${inrush.phase} carried a peak of ${inrush.peak.toFixed(1)} A secondary right after the close command, with roughly ${inrush.pct2H.toFixed(0)}% second-harmonic content relative to the fundamental${inrush.asymmetry ? ` and a ${inrush.asymmetry.toFixed(1)}:1 peak asymmetry between half-cycles` : ''} — the same signature transformer differential relays use to restrain from tripping on inrush. This doesn't rule out a real fault, but the current shape by itself reads more like energizing a transformer's magnetizing inrush than a bolted fault, which normally carries much less harmonic content. Worth weighing against the specific element(s) that actually operated (see the trip cause above) before concluding this was a line fault.`,
            });
          } else if (!inrush && spcC < 8) {
            A.closeAttempt.currentSpike.note = 'Sample rate in this record (below 8 samples/cycle) is too coarse to reliably check for a 2nd-harmonic inrush signature.';
          }
        }
      }
    }
  }

  if (A.tripCause && !A.tripCause.isEventReport) {
    const cause = A.tripCause;
    const tIdx = digitalTransitions.indexOf(cause.tripTransition);
    const boundary = tIdx >= 0 ? tIdx : digitalTransitions.length;

    // ══ DETERMINATION EVIDENCE ══
    // Builds the "proof" behind the headline cause, so the determination doesn't have to be
    // taken on faith — especially in the common misreading where a visible voltage dip is
    // assumed to be the cause while the trip logic actually keyed (partly or wholly) on
    // current. Three lines of evidence, all directly checkable in this record:
    //   1. Per contributing element: when it asserted relative to the trip, and its measured
    //      value vs. its own pickup where the settings expose one.
    //   2. Which element asserted LAST — i.e., the condition whose assertion completed the
    //      logic and set the moment of the trip.
    //   3. When undervoltage (27) elements picked up in this record but appear NOWHERE in the
    //      resolved trip path: say so explicitly. The voltage dip is real, but it's an EFFECT
    //      of the event (fault current depresses voltage) — the relay's own configured logic
    //      never consulted those elements for this trip.
    {
      const spcE = P.eventInfo.samPerCycA || 32;
      const msPerE = 1000 / (freq * spcE);
      const tripSampleIdx = cause.tripTransition?.analogSampleIdx;
      const measuredEls = [...new Set((cause.causeChain || []).map(c => c.label)
        .filter(l => /^(27|59|81|5[01]|67)/.test(l)))];
      const evidence = [];
      for (const el of measuredEls) {
        // Last assertion at/before the trip (initial-state assertion counts as "before record").
        let assertMs = null;
        for (let i = 0; i <= Math.min(boundary, digitalTransitions.length - 1); i++) {
          const ch = digitalTransitions[i].changes.find(c => c.label === el);
          if (ch && ch.asserted && tripSampleIdx != null) {
            assertMs = (digitalTransitions[i].analogSampleIdx - tripSampleIdx) * msPerE;
          }
        }
        const initiallyOn = (P.initialDigitalState || []).includes(el);
        const base = el.replace(/[PT]$/, '');
        const ps = A.protectionStatus.find(p => p.element === base || p.element === el);
        const vs = A.voltageStatus.find(v => v.element === base || v.element === el);
        evidence.push({
          el,
          assertMs, initiallyOn,
          measured: ps?.measured ?? vs?.measured ?? null,
          pickup: ps?.pickup ?? vs?.pickup ?? null,
          multiple: ps?.multiple ?? null,
        });
      }
      // The condition that completed the logic = the latest assertion at/before the trip.
      const timed = evidence.filter(e => e.assertMs != null);
      const completedBy = timed.length ? timed.reduce((a, b) => (a.assertMs >= b.assertMs ? a : b)).el : null;

      // Undervoltage elements that picked up in this record but are absent from the trip path.
      const chainSet = new Set(measuredEls.map(e => e.replace(/[PT]$/, '')));
      const uvPickedUp = new Set();
      digitalTransitions.slice(0, boundary + 1).forEach(t => t.changes.forEach(c => {
        if (c.asserted && /^27/.test(c.label) && !chainSet.has(c.label.replace(/[PT]$/, ''))) uvPickedUp.add(c.label.replace(/T$/, ''));
      }));

      if (evidence.length) {
        cause.evidence = {
          items: evidence,
          completedBy,
          uninvolvedUV: [...uvPickedUp],
        };
      }
    }

    // ── Flag: trip resolved to internal logic/status bits, not a measured protection element ──
    if (cause.isNonProtection) {
      const bits = [...new Set([...(cause.negElements || []), cause.immediateCause].filter(Boolean))];
      let detail = `The trip command traces back to internal relay logic/status point(s) — ${bits.join(', ')} — not a measured overcurrent, voltage, or frequency element. No 27/59/50/51/67/81 element is behind this trip. If the waveform around this event happens to resemble a familiar fault signature, that resemblance doesn't make it one — nothing here was actually measured as a fault.`;
      if ((cause.negElementsNeverTransitioned || []).length) {
        detail += ` Notably, ${cause.negElementsNeverTransitioned.join(', ')} never change state anywhere in this record — whatever field condition they represent was already sitting at that same reading the whole time, so this record's digital data doesn't by itself show what made the internal logic flip.`;
      }
      A.investigationFlags.push({
        severity: 'high',
        title: 'Logic/Status-Driven Trip — No Protection Element Operated',
        detail,
      });
    }

    // ── Flag: one phase's voltage near-zero while its current isn't — possible loss of potential ──
    // A real fault/open conductor shows up in BOTH V and I together on that phase. A dead
    // voltage channel next to a normal current channel means the voltage MEASUREMENT failed
    // (blown PT fuse, disconnected VT, bad input) — not an actual system condition.
    // CRITICAL DISTINCTION: a real close-in single-line-to-ground fault ALSO collapses that
    // phase's voltage to near zero — but with its current ELEVATED well above the healthy
    // phases. What separates LOP from a real fault is that in LOP the current is UNCHANGED:
    // normal in magnitude relative to its siblings AND relative to its own pre-fault level.
    // Both upper-bound checks below are therefore load-bearing, not optional.
    const yV = A.voltages?.yTerminal;
    if (yV) {
      const phases = ['A', 'B', 'C'];
      const vVal = ph => yV[`V${ph}`]?.fault?.secondaryV ?? null;
      const iVal = ph => A.currents?.[`I${ph}`]?.fault?.secA ?? null;
      const iPreVal = ph => A.currents?.[`I${ph}`]?.preFault?.secA ?? null;
      phases.forEach(ph => {
        const others = phases.filter(p => p !== ph);
        const v = vVal(ph), i = iVal(ph), iPre = iPreVal(ph);
        const otherVAvg = others.reduce((s, p) => s + (vVal(p) || 0), 0) / others.length;
        const otherIAvg = others.reduce((s, p) => s + (iVal(p) || 0), 0) / others.length;
        const iNotElevated = i != null && i < otherIAvg * 2.5;                 // a real SLG fault spikes I well past siblings
        const iUnchanged = (iPre == null || iPre < 0.02) ? true                // no meaningful pre-fault load to compare against
          : (i / iPre > 0.5 && i / iPre < 2);                                  // LOP leaves current essentially undisturbed
        if (v != null && i != null && otherVAvg > 5 && v < otherVAvg * 0.1
            && otherIAvg > 0.05 && i > otherIAvg * 0.4 && iNotElevated && iUnchanged) {
          A.investigationFlags.push({
            severity: 'high',
            title: `Possible Loss of Potential — V${ph} Reads Near-Zero While I${ph} Doesn't`,
            detail: `V${ph} measures ${v.toFixed(2)} V secondary — near zero, and far below V${others[0]} (${vVal(others[0]).toFixed(2)} V) and V${others[1]} (${vVal(others[1]).toFixed(2)} V). But I${ph} (${i.toFixed(2)} A sec) sits in the same range as the other phases' currents, not similarly collapsed or elevated. A real fault or open conductor on this phase would show up in both channels together — this pattern instead points to a failed voltage measurement (blown PT fuse, disconnected VT, bad relay input) rather than an actual system condition on this phase.`,
          });
        }
      });
    }

    // ── Flag: breaker was already open when this trip was issued ──
    const bkrLabel = ['52A3P', '52A'].find(l => (P.digitalLabels || []).includes(l));
    if (bkrLabel) {
      const closedBeforeTrip = (P.initialDigitalState || []).includes(bkrLabel)
        || digitalTransitions.slice(0, boundary + 1).some(t => t.changes.some(c => c.label === bkrLabel && c.asserted));
      // Use the MEDIAN sample magnitude across the whole record rather than the earlier
      // RMS-window figures — a single anomalous sample (e.g. a digitizer startup transient in
      // the very first row of the file) can otherwise dominate a small sliding-RMS window and
      // make a genuinely quiet, no-current record look like it has real current flowing.
      const median = arr => { const s = [...arr].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
      const medPhaseI = Math.max(
        median(analogData.map(r => Math.abs(r.IA || 0))),
        median(analogData.map(r => Math.abs(r.IB || 0))),
        median(analogData.map(r => Math.abs(r.IC || 0)))
      );
      const medGroundI = median(analogData.map(r => Math.abs(r.IG || 0)));
      const smallCurrent = medPhaseI < 2 && medGroundI < 2; // secondary amps — well below any real load/fault
      // If this exact trip is the one the close-attempt analysis already identified as
      // "closed into an existing fault" (real current flowed briefly while the contacts were
      // still traveling), the whole-record median above will typically wash that brief pulse
      // out — don't let this more generic, less-precise check contradict the more specific
      // close-attempt finding for the same trip.
      const closeExplainsThisTrip = !!(A.closeAttempt && A.closeAttempt._tripTransitionRef === cause.tripTransition
        && A.closeAttempt.pickupBeforeFullyClosed);
      if (!closedBeforeTrip && smallCurrent && !closeExplainsThisTrip) {
        A.investigationFlags.push({
          severity: 'high',
          title: 'Breaker Was Already Open — Not a Fault Interruption',
          detail: `${bkrLabel} reads open for the entire record leading up to this trip, and measured current stayed near zero throughout (typical phase reading ~${medPhaseI.toFixed(2)} A sec, ground ~${medGroundI.toFixed(2)} A sec). This trip did not interrupt any load or fault current. Whatever operated here was reacting to something other than a fresh fault on an energized, closed circuit — e.g. a residual/backfeed condition, or the logic-driven path flagged above.`,
        });
      }

      // ── Slow/failed breaker operation — mechanism health, not electrical ──
      // Only meaningful when the breaker was actually closed going into this trip. A real
      // interrupter should confirm open within a handful of cycles of the trip command; a
      // long delay — or no confirmation at all — points at the breaker mechanism itself (worn
      // contacts, low control-power/trip-coil energy, a sticking mechanism), not the utility side.
      if (closedBeforeTrip) {
        const spc = P.eventInfo.samPerCycA || 32;
        const msPerSampleFlag = 1000 / (freq * spc);
        const openTransition = digitalTransitions.slice(boundary + 1)
          .find(t => t.changes.some(c => c.label === bkrLabel && !c.asserted));
        if (openTransition) {
          const delayMs = (openTransition.analogSampleIdx - tripTransition.analogSampleIdx) * msPerSampleFlag;
          const delayCyc = delayMs / (1000 / freq);
          if (delayCyc > 8) {
            A.investigationFlags.push({
              severity: 'medium',
              title: 'Slow Breaker Operation — Possible Mechanism Issue',
              detail: `${bkrLabel} did not confirm open until ${delayMs.toFixed(0)} ms (~${delayCyc.toFixed(1)} cycles) after the trip command — well beyond a healthy interrupter's typical clearing time. This points at the breaker/recloser mechanism itself (contact wear, low trip-coil/control-power energy, a sticking operating mechanism) rather than anything on the utility side.`,
            });
          }
        } else {
          // No open confirmation found — but only claim failure if the record actually
          // extends long enough past the trip to have captured a normal opening. A record
          // that ends 2 cycles after the trip command simply can't distinguish "breaker
          // failed" from "breaker opened right after the recording stopped."
          const recordEndMs = (analogData.length - 1 - tripTransition.analogSampleIdx) * msPerSampleFlag;
          if (recordEndMs > 10 * (1000 / freq)) {
            A.investigationFlags.push({
              severity: 'high',
              title: 'Breaker Did Not Confirm Open After Trip',
              detail: `A trip was commanded, but ${bkrLabel} never shows an open confirmation in the ${recordEndMs.toFixed(0)} ms of record following the trip — well beyond a healthy interrupter's clearing time. Worth checking the breaker/recloser mechanism directly — this is a device-health question, not an electrical one.`,
            });
          }
        }
      }

      // ── Voltage still present after the breaker opens — possible DER backfeed/islanding ──
      // If a phase voltage hasn't actually collapsed while the breaker reads open, on-site
      // generation is likely still energizing that side — a DER/anti-islanding question on
      // site equipment, not a utility-side condition.
      const stateNow = timeline[Math.min(boundary, timeline.length - 1)];
      const breakerOpenNow = !stateNow.has(bkrLabel);
      const yV = A.voltages?.yTerminal;
      if (breakerOpenNow && yV && VNOM > 1) {
        const highPhases = ['A', 'B', 'C']
          .map(ph => ({ ph, v: yV[`V${ph}`]?.fault?.secondaryV }))
          .filter(x => x.v != null && x.v > VNOM * 0.15);
        if (highPhases.length) {
          A.investigationFlags.push({
            severity: 'medium',
            title: 'Voltage Present With Breaker Open — Possible DER Backfeed/Islanding',
            detail: `${bkrLabel} reads open, but ${highPhases.map(x => `V${x.ph} (${x.v.toFixed(1)} V sec, ${(x.v / VNOM * 100).toFixed(0)}% of nominal)`).join(', ')} ${highPhases.length > 1 ? 'have' : 'has'} not collapsed. If these PTs are on the generation side of the open point, a de-energized section should read near zero — a sustained reading would mean on-site generation is still energizing this side, a DER/anti-islanding response question rather than a utility-side condition. If instead the PTs are on the utility source side of this device, voltage with the breaker open is expected and this is not an anomaly — the PT location determines which reading applies.`,
          });
        }
      }
    }

    // Note: an earlier version of this flag also listed OTHER protection elements that
    // happened to change state nearby without being part of the trip logic. Removed — telling
    // someone about a bit that did NOT cause the trip is not useful information regardless of
    // how it's phrased. The two flags above (logic/status-driven trip, breaker already open)
    // are the ones that actually inform judgment about THIS trip; this one was just noise.

    // ── Fault-direction element activity — the closest available signal for grid-side vs. ──
    // ── on-site origin, NOT a location proof ──
    // A directional element (67 phase/ground OC, or 32/32Q/32V power direction) tells you
    // which way current or power was flowing relative to the relay's configured polarity —
    // "forward" toward the utility source, "reverse" toward the site, or the opposite,
    // DEPENDING ON HOW THIS SPECIFIC RELAY'S CTs/PTs AND direction settings are configured.
    // The tool has no way to independently confirm that polarity convention from the file
    // alone, so this is reported as a fact (which element asserted, and when) rather than a
    // conclusion about where the fault physically is. Confirm the Forward/Reverse convention
    // against this relay's own settings/one-line before treating it as a location answer.
    {
      const dirRe = /^(67[PGQ]?\d|F32[QVGP]?|R32[QVGP]?)/;
      const msPerSampleDir = 1000 / (freq * (P.eventInfo.samPerCycA || 32));
      const dirEvents = [];
      digitalTransitions.forEach(t => {
        const ms = (tripTransition?.analogSampleIdx != null && t.analogSampleIdx != null)
          ? (t.analogSampleIdx - tripTransition.analogSampleIdx) * msPerSampleDir : null;
        if (ms == null || ms < -250 || ms > 250) return; // within ~15 cycles of the trip either way
        t.changes.forEach(c => { if (c.asserted && dirRe.test(c.label)) dirEvents.push({ label: c.label, ms }); });
      });
      if (dirEvents.length) {
        const uniq = [...new Map(dirEvents.map(e => [e.label, e])).values()];
        const desc = uniq.map(e => `${tt(e.label, P)}${e.ms != null ? ` (${e.ms >= 0 ? '+' : ''}${e.ms.toFixed(0)} ms rel. to trip)` : ''}`).join(', ');
        A.investigationFlags.push({
          severity: 'info',
          title: 'Directional Element Activity — Check Against This Relay\u2019s Polarity Convention',
          detail: `${desc} asserted around this event. Directional (67/32) elements indicate which way current or power flowed relative to how THIS relay's CTs/PTs and direction settings are configured — not an inherent "utility" or "site" label. If this relay's forward direction is confirmed to point toward the utility source, a forward-direction assertion is consistent with the disturbance originating upstream; a reverse assertion is consistent with it originating on the site side of this device. Confirm that polarity convention in the relay's own settings/one-line before treating this as a location determination — the tool cannot verify it independently from the file.`,
        });
      }
    }

    // ── Sequence voltage present with LOW current — several possible explanations, not one ──
    // A bolted fault produces sequence voltage AND elevated current together. This signature —
    // sequence voltage without elevated current — is genuinely ambiguous from the recorded data
    // alone. More than one real condition produces it: a physically separated conductor (no
    // closed path to drive current), a disturbance that originated electrically elsewhere and
    // simply didn't require this point to carry current, or — especially at a DER site — local
    // inverters riding through / momentarily curtailing output in response to a voltage
    // disturbance seen at THIS site without anything being broken here at all. Distinguishing
    // between these needs context this tool doesn't have (correlation with nearby sites,
    // whether a subsequent reclose held). So this flag deliberately does NOT name a most-likely
    // cause or suggest a specific action — it names the ambiguity itself.
    const mentionsSeqV = /3V0|ZERO.?SEQ|NEG.?SEQ|SEQUENCE VOLT/i.test(cause.causeDetail || '');
    if (cause.family === 'zeroSeqV' || cause.family === 'negSeqV' || cause.family === 'zeroSeqV+negSeqV' || mentionsSeqV) {
      const phaseIs = ['A', 'B', 'C'].map(ph => ({
        fault: A.currents?.[`I${ph}`]?.fault?.secA ?? 0,
        pre: A.currents?.[`I${ph}`]?.preFault?.secA ?? 0,
      }));
      const maxFaultI = Math.max(...phaseIs.map(x => x.fault));
      const maxPreI = Math.max(...phaseIs.map(x => x.pre));
      const closedNow = !bkrLabel || timeline[Math.min(boundary, timeline.length - 1)].has(bkrLabel);
      // "Low current" = fault-window current isn't meaningfully above whatever was already
      // flowing before the event, and small in absolute terms — i.e. no real fault current
      // developed even though the sequence-voltage element operated.
      if (closedNow && maxFaultI < Math.max(maxPreI * 1.5, 2)) {
        A.investigationFlags.push({
          severity: 'medium',
          title: 'Sequence Voltage Without Elevated Current',
          detail: `Trip resolved to a sequence-voltage element (${cause.immediateCause ? tt(cause.immediateCause, P) : 'zero/negative-sequence overvoltage'}); phase current stayed low throughout (max ${maxFaultI.toFixed(2)} A sec, vs. ${maxPreI.toFixed(2)} A sec pre-event) — not fault-level. Consistent with: an open/separated conductor, a disturbance originating elsewhere on the system, or (at a DER site) local inverters curtailing output in response to a voltage disturbance.`,
        });
      }
    }
  }

  // ── Generic "build a causal tree for ANY bit" — backs the main-page "Logic Bit Charted"
  // picker's "Filter relevant?" (checked) mode. Reuses the exact same bake/prune machinery as
  // the resolved trip cause above, just rooted at whatever equation the CHOSEN bit (not
  // necessarily the trip) resolves to, so a user exploring a different SV or equation gets the
  // same style of pruned, causally-focused diagram instead of only ever seeing the trip's own.
  // Recomputes a digital-state snapshot at an arbitrary digital-sample index directly from the
  // transition list — independent of stateAtTripSnapshot/erFoundAt above (which are scoped to
  // their own trip/ER branches), so this works uniformly regardless of which path produced A.
  function stateSetAtDigitalIdx(digIdx) {
    const running = new Set(P.initialDigitalState || []);
    for (const t of digitalTransitions) {
      if (t.digitalSampleIdx > digIdx) break;
      for (const c of t.changes) { if (c.asserted) running.add(c.label); else running.delete(c.label); }
    }
    return running;
  }
  // Finds the raw SELogic text (if any) that defines `label` — a top-level named equation
  // (TR/TR3X/ER/FAULT/79RI3P/79DTL3P) or an SV (bare or timed form). Returns null for a plain
  // recorded bit with no equation of its own (a leaf, not a defined point).
  function resolveEquationForLabel(label) {
    const clean = eq => (eq || '').split('#')[0].trim();
    if (label === (P.tripEquationName || 'TR') && clean(P.tripEquation)) return clean(P.tripEquation);
    if (label === 'TR3X' && clean(P.tripEquationX)) return clean(P.tripEquationX);
    if (label === (P.erEquationName || 'ER') && clean(P.erEquation)) return clean(P.erEquation);
    if (label === 'FAULT' && clean(P.faultEquation)) return clean(P.faultEquation);
    if (label === '79RI3P' && clean(P.recloseEquation)) return clean(P.recloseEquation);
    if (label === '79DTL3P' && clean(P.dtlEquation)) return clean(P.dtlEquation);
    const svm = label.match(/^SV(\d+)T?$/);
    if (svm) {
      const sv = svSettings.find(s => s.num === parseInt(svm[1]));
      const eq = sv && clean(sv.equation);
      if (eq && eq !== 'NA') return eq;
    }
    return null;
  }
  function buildTreeForBit(label) {
    const eqText = resolveEquationForLabel(label);
    if (!eqText) return null;
    let ast;
    try { ast = parseEq(tokenizeEq(eqText)); } catch (e) { return null; }
    const refDigIdx = (A.tripCause && A.tripCause.tripTransition && A.tripCause.tripTransition.digitalSampleIdx != null)
      ? A.tripCause.tripTransition.digitalSampleIdx
      : (digitalTransitions.length ? digitalTransitions[digitalTransitions.length - 1].digitalSampleIdx : 0);
    const refState = stateSetAtDigitalIdx(refDigIdx);
    const isAssertedFn = name => refState.has(name);
    // If the top level is a big OR of independent conditions (very common for a top-level trip
    // equation), focus on whichever single branch is actually true right now — same "show the
    // one relevant path, not every unrelated protection function" behavior as the resolved trip
    // cause — falling back to the whole equation when none is currently true.
    let rootAst = ast, otherBranchCount = 0;
    try {
      const branches = splitTopOr(ast);
      if (branches.length > 1) {
        const trueBranch = branches.find(b => evalAst(b, isAssertedFn).value);
        if (trueBranch) { rootAst = trueBranch; otherBranchCount = branches.length - 1; }
      }
    } catch (e) { /* fall through with the whole equation */ }
    let baked;
    try { baked = pruneLogicTree(bakeFullLogicTree(rootAst, isAssertedFn, new Set(), 0)); } catch (e) { return null; }
    return { logicTree: baked, finalLabel: label, logicTreeOtherBranchCount: otherBranchCount };
  }
  A._buildTreeForBit = buildTreeForBit;

  // ── Automatic reclosing outlook ──
  // Runs last: it reads A.tripCause (to anchor on the trip instant) and the parsed 79 scheme,
  // and never feeds anything back into the trip analysis above.
  try { A.reclose = analyzeReclose(P, A); } catch (e) { A.reclose = null; console.warn('reclose analysis failed', e); }

  return A;
}