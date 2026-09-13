

// ══════════════════════════════════════════════════════════════════════
// SEL-851 — TRIP DIAGNOSIS AND REASONABLENESS
// ══════════════════════════════════════════════════════════════════════
// This module answers two questions, in order:
//
//   1. WHY did the relay trip?   Which element started the trip, and what did the relay
//      measure when it did.
//   2. WAS THAT REASONABLE?      Does the operation agree with the relay's own settings and
//      with the waveforms in the same file. If it does not, what is the possible error.
//
// The second question is what makes this different from a waveform viewer. Every check below
// compares two things that must agree, and names the disagreement when they do not. A check
// only fires on evidence in this file. Where the file cannot settle a question, the check
// reports that it could not, and does not guess. A missing verdict is an honest result.
//
// The findings are informational. They name what disagrees and what could cause it. They do
// not tell anyone what to do about it.

// ── Verdict levels, strongest first ──
const SEL851_LEVELS = { error: 3, check: 2, info: 1, ok: 0 };

// ══════════════════════════════════════════════════════════════════════
// SELOGIC EXPRESSION EVALUATION
// ══════════════════════════════════════════════════════════════════════
// The 851 writes its logic in the same Boolean form as SELogic, but with dotted relay word
// names (Trip_01.Init, 27PP_02.TmOut). Operator precedence is NOT, then AND, then OR.
// Literals 0 and 1 are allowed. Anything else is treated as a bit name.

function sel851Tokenize(expr) {
  const out = [];
  const re = /\(|\)|\bNOT\b|\bAND\b|\bOR\b|[A-Za-z0-9_][A-Za-z0-9_.]*/gi;
  let m;
  while ((m = re.exec(expr)) !== null) out.push(m[0]);
  return out;
}

// Returns true, false, or null when a name in the expression cannot be resolved.
function evalSel851Expr(expr, getBit) {
  if (expr == null) return null;
  const toks = sel851Tokenize(String(expr));
  if (!toks.length) return null;
  let i = 0;
  const peek = () => toks[i];
  const take = () => toks[i++];
  const isOp = (t, op) => t && t.toUpperCase() === op;

  let failed = false;

  function primary() {
    const t = peek();
    if (t === undefined) { failed = true; return false; }
    if (t === '(') { take(); const v = orExpr(); if (peek() === ')') take(); else failed = true; return v; }
    if (isOp(t, 'NOT')) { take(); return !primary(); }
    take();
    if (t === '1') return true;
    if (t === '0') return false;
    const v = getBit(t);
    if (v === null || v === undefined) { failed = true; return false; }
    return !!v;
  }
  function andExpr() {
    let v = primary();
    while (isOp(peek(), 'AND')) { take(); const r = primary(); v = v && r; }
    return v;
  }
  function orExpr() {
    let v = andExpr();
    while (isOp(peek(), 'OR')) { take(); const r = andExpr(); v = v || r; }
    return v;
  }
  const result = orExpr();
  if (i < toks.length) failed = true;
  return failed ? null : result;
}

// Split an expression into its top-level OR branches, ignoring OR inside parentheses.
// A relay trip equation is almost always one OR chain, and the branch that reads 1 is the
// thing that caused the trip. Evaluating loose TERMS instead would name any bit that happens
// to read 1, including ones sitting inside a branch whose AND gate is false — which is how a
// supervised element gets wrongly blamed for a trip it did not cause.
function sel851TopLevelOrBranches(expr) {
  const toks = sel851Tokenize(String(expr || ''));
  const branches = [];
  let depth = 0, cur = [];
  for (const t of toks) {
    if (t === '(') depth++;
    if (t === ')') depth--;
    if (depth === 0 && /^OR$/i.test(t)) { branches.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) branches.push(cur);
  return branches.map(b => b.join(' ').replace(/\(\s/g, '(').replace(/\s\)/g, ')'));
}

// Every bit name referenced anywhere in an expression, in order, without duplicates.
function sel851ExprTerms(expr) {
  const out = [];
  for (const t of sel851Tokenize(String(expr || ''))) {
    if (/^(AND|OR|NOT)$/i.test(t) || t === '(' || t === ')' || t === '0' || t === '1') continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// SETTINGS HELPERS
// ══════════════════════════════════════════════════════════════════════

function sel851Num(S, key) {
  const v = parseFloat(S[key]);
  return Number.isFinite(v) ? v : null;
}

// Split a relay word into its element name and level, e.g. "27PP_02.TmOut" -> 27PP / 2.
function sel851SplitElement(bitName) {
  const m = String(bitName).match(/^([A-Za-z0-9]+)_(\d+)\.(\w+)$/);
  if (!m) return null;
  return { element: `${m[1]}_${m[2]}`, family: m[1], level: parseInt(m[2]), suffix: m[3] };
}

// Is the family enabled, and does the enable setting reach this level?
// The 851 writes this setting three different ways: a level count ("2"), a yes/no ("Y", "N"),
// or "OFF". All three appear in one stock settings file, so all three are handled.
// Returns true, false, or null when the setting is absent.
function sel851FamilyEnabled(S, family, level) {
  const raw = S[`${family}.Ena`];
  if (raw === undefined) return null;
  const v = String(raw).trim().toUpperCase();
  if (/^(OFF|N|NO)$/.test(v)) return false;
  if (/^(Y|YES|ON)$/.test(v)) return true;
  const n = parseFloat(v);
  if (Number.isFinite(n)) return n > 0 && level <= n;
  return null;
}

// ══════════════════════════════════════════════════════════════════════
// INVERSE-TIME CURVES
// ══════════════════════════════════════════════════════════════════════
// Standard US (U1-U5) and IEC (C1-C5) shapes, as published for SEL relays. t is the operate
// time in seconds at a steady multiple M of pickup, for time dial TD.
const SEL851_CURVES = {
  U1: M => 0.0226 + 0.0104 / (Math.pow(M, 0.02) - 1),
  U2: M => 0.180 + 5.95 / (M * M - 1),
  U3: M => 0.0963 + 3.88 / (M * M - 1),
  U4: M => 0.0352 + 5.67 / (M * M - 1),
  U5: M => 0.00262 + 0.00342 / (Math.pow(M, 0.02) - 1),
  C1: M => 0.14 / (Math.pow(M, 0.02) - 1),
  C2: M => 13.5 / (M - 1),
  C3: M => 80 / (M * M - 1),
  C4: M => 120 / (M - 1),
  C5: M => 0.05 / (Math.pow(M, 0.04) - 1),
};

// Expected operate time for a current that changes during the fault. A real relay integrates
// its progress toward trip sample by sample rather than using one fixed multiple, so this does
// the same: it accumulates dt / t(M) from the pickup instant and reports the sample at which
// the total reaches 1. Reset is treated as instantaneous, matching RstMod on the files seen so
// far; if the setting says otherwise this returns null rather than applying the wrong model.
function sel851IntegrateCurve(curveName, timeDial, measured, pickup, startIdx, msPerSample, rstMod) {
  const f = SEL851_CURVES[String(curveName || '').toUpperCase()];
  if (!f || !Number.isFinite(timeDial) || !Number.isFinite(pickup) || pickup <= 0) return null;
  if (rstMod && !/^instant/i.test(rstMod)) return null;
  const dt = msPerSample / 1000;
  let acc = 0;
  for (let i = startIdx; i < measured.length; i++) {
    const M = measured[i] / pickup;
    if (M <= 1.0) { acc = 0; continue; }          // dropped back inside pickup: element resets
    const t = timeDial * f(M);
    if (!Number.isFinite(t) || t <= 0) continue;
    acc += dt / t;
    if (acc >= 1) return { idx: i, seconds: (i - startIdx) * msPerSample / 1000 };
  }
  return { idx: null, seconds: null, reached: acc };
}

// ══════════════════════════════════════════════════════════════════════
// MEASURED QUANTITY SERIES
// ══════════════════════════════════════════════════════════════════════
// Every number the analysis compares against a pickup is built here, from the raw sampled
// waveforms only. Pickup settings on the 851 are in SECONDARY units, so each series is
// divided by its instrument transformer ratio. Any series whose source channels are missing
// is left out entirely rather than filled with a substitute, so a later comparison reports
// "not evaluated" instead of comparing against the wrong thing.
function buildSel851Quantities(P) {
  const rows = P.analogData;
  const N = P.eventInfo.samPerCycA;
  const R = P.ratios;
  const col = key => key ? rows.map(r => r[key] || 0) : null;
  const ch = P.chan || {};

  const PTR = R.PTP && R.PTP > 0 ? R.PTP : 1;
  const CTR = R.CTP && R.CTP > 0 ? R.CTP : 1;
  const CTRn = R.CTN && R.CTN > 0 ? R.CTN : CTR;

  const Q = {};
  const meta = {};
  const add = (name, series, unit, desc) => { if (series) { Q[name] = series; meta[name] = { unit, desc }; } };

  const va = col(ch.va), vb = col(ch.vb), vc = col(ch.vc);
  const ia = col(ch.ia), ib = col(ch.ib), ic = col(ch.ic);

  if (va && vb && vc) {
    const vab = computePhaseDiffMagnitude(va, vb, N, 1 / PTR);
    const vbc = computePhaseDiffMagnitude(vb, vc, N, 1 / PTR);
    const vca = computePhaseDiffMagnitude(vc, va, N, 1 / PTR);
    Q._vab = vab; Q._vbc = vbc; Q._vca = vca;
    add('vppMin', vab.map((v, i) => Math.min(v, vbc[i], vca[i])), 'V sec', 'lowest of VAB, VBC and VCA');
    add('vppMax', vab.map((v, i) => Math.max(v, vbc[i], vca[i])), 'V sec', 'highest of VAB, VBC and VCA');
    add('v3v0', computeZeroSeqMagnitude(va, vb, vc, N, 1 / PTR), 'V sec', 'zero-sequence voltage, 3V0');
    const pa = computeRmsMagnitude(va, N, 1 / PTR), pb = computeRmsMagnitude(vb, N, 1 / PTR), pc = computeRmsMagnitude(vc, N, 1 / PTR);
    Q._va = pa; Q._vb = pb; Q._vc = pc;
    add('vpnMin', pa.map((v, i) => Math.min(v, pb[i], pc[i])), 'V sec', 'lowest of VA, VB and VC');
    add('vpnMax', pa.map((v, i) => Math.max(v, pb[i], pc[i])), 'V sec', 'highest of VA, VB and VC');
    add('v1', computePosSeqMagnitude(va, vb, vc, N, 1 / PTR), 'V sec', 'positive-sequence voltage, V1');
  }
  if (ia && ib && ic) {
    const ra = computeRmsMagnitude(ia, N, 1 / CTR), rb = computeRmsMagnitude(ib, N, 1 / CTR), rc = computeRmsMagnitude(ic, N, 1 / CTR);
    Q._ia = ra; Q._ib = rb; Q._ic = rc;
    add('iPhMax', ra.map((v, i) => Math.max(v, rb[i], rc[i])), 'A sec', 'highest of IA, IB and IC');
    add('iPhMin', ra.map((v, i) => Math.min(v, rb[i], rc[i])), 'A sec', 'lowest of IA, IB and IC');
    // 3I2, because that is the quantity SEL negative-sequence overcurrent pickups are set in.
    add('i3i2', computeNegSeqMagnitude(ia, ib, ic, N, 1 / CTR).map(v => 3 * v), 'A sec', 'negative-sequence current, 3I2');
    add('i3i0', computeZeroSeqMagnitude(ia, ib, ic, N, 1 / CTR), 'A sec', 'residual current from IA+IB+IC, 3I0');
  }
  const ign = col(ch.iGnd), inn = col(ch.iN);
  if (ign) add('iGnd', computeRmsMagnitude(ign, N, 1 / CTR), 'A sec', 'measured ground current channel');
  if (inn) add('iN', computeRmsMagnitude(inn, N, 1 / CTRn), 'A sec', 'measured neutral current channel');

  // Frequency is reported by the relay as a value channel, not a waveform, so it is used as
  // written. There is nothing to re-derive it from.
  if (ch.freq) add('freq', col(ch.freq), 'Hz', 'relay frequency channel');
  if (ch.freqTrk) add('freqTrk', col(ch.freqTrk), 'Hz', 'relay tracked frequency channel');

  return { Q, meta, PTR, CTR, CTN: CTRn };
}

// ══════════════════════════════════════════════════════════════════════
// ELEMENT REGISTRY
// ══════════════════════════════════════════════════════════════════════
// Which measured quantity each element family compares against, and in which direction.
// `dir` is 'below' for elements that operate when the value falls under pickup, 'above' for
// elements that operate when it rises over pickup, and 'auto' where the settings decide.
const SEL851_FAMILIES = {
  '27PP': { qty: 'vppMin', dir: 'below', timed: 'definite', label: 'Phase-to-phase undervoltage (27)' },
  '27PN': { qty: 'vpnMin', dir: 'below', timed: 'definite', label: 'Phase-to-neutral undervoltage (27)' },
  '59PP': { qty: 'vppMax', dir: 'above', timed: 'definite', label: 'Phase-to-phase overvoltage (59)' },
  '59PN': { qty: 'vpnMax', dir: 'above', timed: 'definite', label: 'Phase-to-neutral overvoltage (59)' },
  '59Gnd': { qty: 'v3v0', dir: 'above', timed: 'definite', label: 'Zero-sequence overvoltage (59G)' },
  '50P': { qty: 'iPhMax', dir: 'above', timed: 'definite', label: 'Phase instantaneous overcurrent (50P)' },
  '50Gnd': { qty: 'iGnd', dir: 'above', timed: 'definite', label: 'Ground instantaneous overcurrent (50G)' },
  '50N': { qty: 'iN', dir: 'above', timed: 'definite', label: 'Neutral instantaneous overcurrent (50N)' },
  '50Neg': { qty: 'i3i2', dir: 'above', timed: 'definite', label: 'Negative-sequence overcurrent (50Q)' },
  '51P': { qty: 'iPhMax', dir: 'above', timed: 'curve', label: 'Phase time overcurrent (51P)' },
  '51Gnd': { qty: 'iGnd', dir: 'above', timed: 'curve', label: 'Ground time overcurrent (51G)' },
  '51N': { qty: 'iN', dir: 'above', timed: 'curve', label: 'Neutral time overcurrent (51N)' },
  '51Neg': { qty: 'i3i2', dir: 'above', timed: 'curve', label: 'Negative-sequence time overcurrent (51Q)' },
  '81': { qty: 'freq', dir: 'auto', timed: 'definite', label: 'Frequency (81)' },
};

// ══════════════════════════════════════════════════════════════════════
// EDGE FINDING
// ══════════════════════════════════════════════════════════════════════
function sel851FirstRise(P, label, fromIdx = 0) {
  const s = P.digitalSeries[label];
  if (!s) return null;
  for (let i = Math.max(1, fromIdx); i < s.length; i++) if (s[i] === 1 && s[i - 1] === 0) return i;
  return null;
}
function sel851LastRiseBefore(P, label, beforeIdx) {
  const s = P.digitalSeries[label];
  if (!s) return null;
  for (let i = Math.min(beforeIdx, s.length - 1); i >= 1; i--) if (s[i] === 1 && s[i - 1] === 0) return i;
  return s[0] === 1 ? 0 : null;   // already asserted when the record opened
}
function sel851StateAt(P, label, idx) {
  const s = P.digitalSeries[label];
  if (!s) return null;
  return s[Math.max(0, Math.min(idx, s.length - 1))] === 1;
}

// ══════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ══════════════════════════════════════════════════════════════════════
function analyzeSel851(P) {
  const S = P.settings;
  const msPerSample = P.msPerSample;
  const nRec = P.analogData.length;
  const { Q, meta, PTR, CTR, CTN } = buildSel851Quantities(P);

  const A = {
    quantities: Q, quantityMeta: meta, PTR, CTR, CTN: CTN,
    findings: [], elements: [], timeline: [], verdict: null,
    tripIdx: null, tripCause: null, initiators: [],
    preEventIdx: null, breaker: null,
    equationTerms: sel851ExprTerms(P.tripEquation),
  };

  const addFinding = (level, code, title, detail) => A.findings.push({ level, code, title, detail });
  const tSec = i => (i * msPerSample / 1000);
  const fmtT = i => `${tSec(i).toFixed(4)} s into the record`;

  // ── Timeline of every named bit change ──
  A.timeline = P.digitalTransitions.map(tr => ({
    idx: tr.analogSampleIdx, seconds: tr.analogSampleIdx * msPerSample / 1000,
    changes: tr.changes,
  }));

  // ── Locate the trip ──
  // Anchor on Trip_01.Init, the output of the trip equation, because that is the moment the
  // relay itself decided to trip. Trip_01.Sta is the sealed-in trip output and can stay
  // asserted for the minimum duration long after the cause has gone.
  const tripInitIdx = sel851FirstRise(P, 'Trip_01.Init');
  const tripStaIdx = sel851FirstRise(P, 'Trip_01.Sta');
  A.tripIdx = tripInitIdx != null ? tripInitIdx : tripStaIdx;

  if (A.tripIdx == null) {
    // No trip in this record. That is a normal result for a triggered-but-no-operation event.
    A.verdict = {
      level: 'info', code: 'NO_TRIP',
      headline: 'No trip in this record',
      detail: 'Neither Trip_01.Init nor Trip_01.Sta asserted during this record. The relay captured the event but did not trip.',
    };
    sel851CheckScaling(P, A, Q, addFinding);
    return A;
  }

  // ── No settings? Then nothing can be judged, and the tool must say so plainly. ──
  if (!P.tripEquation) {
    A.verdict = {
      level: 'info', code: 'NO_SETTINGS',
      headline: 'This trip cannot be checked — the archive has no settings',
      detail: `The relay tripped at ${fmtT(A.tripIdx)}. This archive has no .hdr file, so there is no trip equation and no element settings to check the trip against. The waveforms, the bit states and the timeline are all available. Export the event again from SEL Grid Configurator or the relay web server to get the .hdr file.`,
    };
    addFinding('info', 'NO_SETTINGS',
      'No settings are available for this record',
      'An SEL-851 .evzip normally holds three files: .cfg, .dat and .hdr. This one has no .hdr. Without it the tool can show what the relay did, but it cannot say whether that agrees with how the relay is set.');
    A.breaker = sel851CheckBreaker(P, A, msPerSample, addFinding, fmtT);
    sel851CheckScaling(P, A, Q, addFinding);
    A.tripCause = { element: null, label: 'Not checked — no settings in this archive', idx: A.tripIdx, seconds: tSec(A.tripIdx), measuredText: null, eventTypeFromRelay: P.eventInfo.eventType };
    return A;
  }

  // ── Which terms of the trip equation were true at that instant ──
  const getBit = name => {
    const v = sel851StateAt(P, name, A.tripIdx);
    return v === null ? null : v;
  };
  const equationResult = evalSel851Expr(P.tripEquation, getBit);
  A.equationResult = equationResult;
  A.equationTermStates = A.equationTerms.map(t => ({
    name: t, state: sel851StateAt(P, t, A.tripIdx),
    known: P.digitalSeries[t] !== undefined,
  }));

  // The branch that read 1 is what caused the trip.
  A.branches = sel851TopLevelOrBranches(P.tripEquation).map(text => ({
    text, state: evalSel851Expr(text, getBit), terms: sel851ExprTerms(text),
  }));
  const trueBranches = A.branches.filter(b => b.state === true);
  A.initiators = [];
  for (const b of trueBranches) for (const t of b.terms) if (!A.initiators.includes(t)) A.initiators.push(t);
  // Bits inside a true branch that are themselves asserted — the ones that actually carried it.
  A.initiatorBits = A.initiators.filter(t => sel851StateAt(P, t, A.tripIdx) === true);

  // ══════════════════════════════════════════════════════════════════
  // CHECK: did anything in the trip equation actually assert?
  // ══════════════════════════════════════════════════════════════════
  if (trueBranches.length === 0) {
    const commandBits = ['Comm.TripCmd', 'HMI.TripCmd', 'Trip_01.LocInit', 'Trip_01.RemInit', 'Trip_01.LocSta', 'Trip_01.RemSta']
      .filter(b => sel851StateAt(P, b, A.tripIdx) === true);
    if (commandBits.length) {
      addFinding('info', 'EXTERNAL_COMMAND',
        'The trip came from a command, not a protection element',
        `No term of ${P.tripEquationName} was true at ${fmtT(A.tripIdx)}, but ${commandBits.join(', ')} was asserted. This was an operator or SCADA trip. Protection did not cause it.`);
    } else {
      addFinding('error', 'NO_INITIATOR',
        'The trip started with no protection element asserted',
        `Trip_01 asserted at ${fmtT(A.tripIdx)}, but every branch of ${P.tripEquationName} read 0 at that sample, and no local, remote or communications trip command was asserted either. The recorded cause is missing. Possible causes: the initiating bit is not in the event report channel list, the trip came through a path this record does not capture, or the relay asserted its trip output for a reason outside the trip equation.`);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // EVALUATE EVERY ELEMENT NAMED IN THE TRIP EQUATION
  // ══════════════════════════════════════════════════════════════════
  // One row per element, not per relay word. 27PP_01.TmOut and 27PP_01.PU both name element
  // 27PP_01, and listing it twice would double every finding it raises.
  const seenElements = new Set();
  for (const term of A.equationTerms) {
    const split = sel851SplitElement(term);
    if (!split) continue;
    if (seenElements.has(split.element)) continue;
    const fam = SEL851_FAMILIES[split.family];
    if (!fam && !P.settings[`${split.element}.PUVal`]) continue;  // not a protection element
    seenElements.add(split.element);
    // An element started the trip only if one of its bits sits in a branch that read 1.
    const initiated = A.initiatorBits.some(b => {
      const bs = sel851SplitElement(b);
      return bs && bs.element === split.element;
    });
    const ev = sel851EvaluateElement(P, A, Q, meta, split, term, fam, initiated, msPerSample, addFinding);
    if (ev) A.elements.push(ev);
  }
  // Whatever started the trip goes first; everything else keeps settings order.
  A.elements.sort((a, b) => (b.initiated ? 1 : 0) - (a.initiated ? 1 : 0));

  // Elements that operated but are NOT in the trip equation. Worth naming: an element that
  // times out with no path to the trip output is either intentionally alarm-only or a wiring
  // gap in the scheme, and the record cannot tell which.
  const equationSet = new Set(A.equationTerms);
  const strayTimeouts = P.digitalLabels.filter(l =>
    /\.TmOut$/.test(l) && !equationSet.has(l) && sel851FirstRise(P, l) != null);
  if (strayTimeouts.length) {
    addFinding('info', 'NOT_IN_EQUATION',
      'An element timed out but cannot trip the breaker',
      `${strayTimeouts.join(', ')} timed out during this record, but none of these appear in ${P.tripEquationName}. They cannot cause a trip as the relay is set. This is normal for an alarm-only element.`);
  }

  // ══════════════════════════════════════════════════════════════════
  // CHECK: instrument transformer scaling against the nominal settings
  // ══════════════════════════════════════════════════════════════════
  // Runs first. Every measured comparison below rests on this basis, and the loss-of-potential
  // check reads its result to decide whether that bit tracks the measured voltage at all.
  sel851CheckScaling(P, A, Q, addFinding);

  // ══════════════════════════════════════════════════════════════════
  // CHECK: loss of potential during a voltage trip
  // ══════════════════════════════════════════════════════════════════
  const voltageInitiators = A.initiators.filter(t => {
    const s = sel851SplitElement(t);
    return s && /^(27|59)/.test(s.family);
  });
  const lopAtTrip = sel851StateAt(P, '60LOP.PU', A.tripIdx);
  if (voltageInitiators.length && lopAtTrip === true) {
    const lopRise = sel851LastRiseBefore(P, '60LOP.PU', A.tripIdx);
    const wasAlreadyUp = lopRise === 0;
    // A loss-of-potential bit is only evidence of a VT problem if it tracks the voltage. If it
    // was also asserted while this record's own waveforms show healthy, balanced voltage, then
    // it does not track the measurement, and this record cannot tell a standing VT problem from
    // a bit that carries some other meaning. Say which of the two situations applies rather
    // than letting an unchanging bit lower the verdict on its own.
    const healthyWhileAsserted = wasAlreadyUp && A.scaling && A.scaling.status === 'agrees';
    if (healthyWhileAsserted) {
      addFinding('info', 'LOP_ASSERTED_THROUGHOUT',
        'The loss-of-potential bit was asserted for the whole record',
        `60LOP.PU read 1 at every sample, including the window before the disturbance where the measured voltage was ${A.scaling.measuredLLsec.toFixed(1)} V secondary against an expected ${A.scaling.expectedLLsec.toFixed(1)} V, balanced and healthy. A loss-of-potential bit that stays up while the voltage is healthy is not tracking the voltage. This record cannot show whether a standing VT problem exists or the bit reports something else. Check the Sequential Events Recorder for when 60LOP.PU last changed.`);
    } else {
      addFinding('check', 'LOP_ACTIVE',
        'Loss of potential was asserted during a voltage trip',
        `60LOP.PU read 1 at ${fmtT(A.tripIdx)}, while ${voltageInitiators.join(', ')} caused the trip. Loss of potential means the relay judged its voltage inputs unreliable. ${wasAlreadyUp ? 'The bit was already asserted when the record opened, so this record cannot show what set it.' : `The bit asserted at ${fmtT(lopRise)}.`} A voltage element that operates while this bit is up can be measuring a VT problem instead of a system problem. Possible causes: a blown VT fuse, an open VT secondary, or a lost VT connection. Check 60LOP.Blk and the VT circuit.`);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // CHECK: breaker response
  // ══════════════════════════════════════════════════════════════════
  A.breaker = sel851CheckBreaker(P, A, msPerSample, addFinding, fmtT);

  // ══════════════════════════════════════════════════════════════════
  // CHECK: did the disturbance come from this feeder?
  // ══════════════════════════════════════════════════════════════════
  sel851CheckFaultOrigin(P, A, Q, addFinding, fmtT);

  // ── Trip cause summary ──
  const primary = A.elements.find(e => e.initiated) || null;
  A.tripCause = {
    element: primary ? primary.element : null,
    label: primary ? primary.label : (A.findings.find(f => f.code === 'EXTERNAL_COMMAND') ? 'Operator or SCADA command' : 'Not resolved'),
    idx: A.tripIdx,
    seconds: tSec(A.tripIdx),
    measuredText: primary ? primary.measuredAtTimeoutText : null,
    eventTypeFromRelay: P.eventInfo.eventType,
  };

  // ══════════════════════════════════════════════════════════════════
  // VERDICT
  // ══════════════════════════════════════════════════════════════════
  A.verdict = sel851BuildVerdict(P, A);
  return A;
}

// ══════════════════════════════════════════════════════════════════════
// PER-ELEMENT EVALUATION
// ══════════════════════════════════════════════════════════════════════
function sel851EvaluateElement(P, A, Q, meta, split, term, fam, initiated, msPerSample, addFinding) {
  const S = P.settings;
  const el = split.element;
  const tSec = i => (i * msPerSample / 1000);
  const fmtT = i => `${tSec(i).toFixed(4)} s into the record`;

  const pickup = sel851Num(S, `${el}.PUVal`);
  const delay = sel851Num(S, `${el}.PUDly`);
  const curve = S[`${el}.Crv`] || null;
  const timeDial = sel851Num(S, `${el}.TmDial`);
  const rstMod = S[`${el}.RstMod`] || null;
  const torqCtl = S[`${el}.TorqCtl`];
  const enabled = sel851FamilyEnabled(S, split.family, split.level);

  const ev = {
    element: el, family: split.family, bit: term, initiated,
    label: fam ? fam.label : `${split.family} level ${split.level}`,
    pickup, delay, curve, timeDial, rstMod, torqCtl, enabled,
    qtyName: fam ? fam.qty : null,
    timedType: fam ? fam.timed : null,
    evaluated: false, notes: [],
  };

  const tmOutIdx = sel851FirstRise(P, `${el}.TmOut`);
  const puIdx = tmOutIdx != null ? sel851LastRiseBefore(P, `${el}.PU`, tmOutIdx) : sel851FirstRise(P, `${el}.PU`);
  ev.tmOutIdx = tmOutIdx;
  ev.puIdx = puIdx;
  ev.pickedUp = puIdx != null;
  ev.timedOut = tmOutIdx != null;
  if (tmOutIdx != null) ev.timeoutSeconds = tSec(tmOutIdx);
  if (puIdx != null) ev.pickupSeconds = tSec(puIdx);

  // Direction of operation. For frequency the setting decides: a pickup under nominal is an
  // underfrequency element, a pickup over nominal is an overfrequency element.
  let dir = fam ? fam.dir : null;
  if (dir === 'auto' && Number.isFinite(pickup)) {
    const fnom = P.ratios.FNom || 60;
    dir = pickup < fnom ? 'below' : 'above';
  }
  ev.dir = dir;

  const series = fam && Q[fam.qty] ? Q[fam.qty] : null;
  ev.qtyDesc = fam && meta[fam.qty] ? meta[fam.qty].desc : null;
  ev.qtyUnit = fam && meta[fam.qty] ? meta[fam.qty].unit : '';

  if (!fam) {
    ev.notes.push(`This tool does not have a measured quantity mapped for the ${split.family} family, so its pickup was not checked against the waveforms.`);
    return ev;
  }
  if (!series) {
    ev.notes.push(`The channels needed for ${fam.qty} are not in this record, so this element's pickup was not checked against the waveforms.`);
    return ev;
  }
  if (!Number.isFinite(pickup)) {
    ev.notes.push(`No ${el}.PUVal setting is present in the header, so this element's pickup was not checked.`);
    return ev;
  }

  ev.evaluated = true;
  const beyond = v => dir === 'below' ? v < pickup : v > pickup;
  const at = i => series[Math.max(0, Math.min(i, series.length - 1))];
  const fmtV = v => `${v.toFixed(v >= 100 ? 1 : 3)} ${ev.qtyUnit}`;

  if (tmOutIdx != null) ev.measuredAtTimeout = at(tmOutIdx);
  if (puIdx != null) ev.measuredAtPickup = at(puIdx);
  ev.measuredAtTrip = at(A.tripIdx != null ? A.tripIdx : series.length - 1);
  ev.measuredAtTimeoutText = ev.measuredAtTimeout != null ? fmtV(ev.measuredAtTimeout) : null;
  ev.pickupText = `${pickup} ${ev.qtyUnit}`;

  // ── Check 1: was the measured value really beyond pickup when the element operated? ──
  if (tmOutIdx != null) {
    const m = at(tmOutIdx);
    ev.beyondPickupAtTimeout = beyond(m);
    if (!beyond(m)) {
      const marginPct = pickup !== 0 ? Math.abs((m - pickup) / pickup) * 100 : 0;
      addFinding('error', 'BELOW_PICKUP',
        `${el} timed out while its measured value was inside pickup`,
        `${el} asserted TmOut at ${fmtT(tmOutIdx)}. Its pickup is ${pickup} ${ev.qtyUnit} (operate ${dir === 'below' ? 'under' : 'over'} pickup), but the ${ev.qtyDesc} measured from this record's own waveforms was ${fmtV(m)} at that sample, which is ${marginPct.toFixed(1)}% on the wrong side. These two must agree. Possible causes: the CT or VT ratio setting does not match the installed ratio, a channel is mapped to the wrong phase, the element is set in different units than assumed here, or the element was driven by a different quantity than the one shown.`);
    }
  }

  // ── Check 2: does the time from pickup to timeout match the setting? ──
  if (tmOutIdx != null && puIdx != null) {
    const observed = (tmOutIdx - puIdx) * msPerSample / 1000;
    ev.observedDelay = observed;
    if (fam.timed === 'definite' && Number.isFinite(delay)) {
      ev.settingDelay = delay;
      // One sample plus one cycle covers the relay's own processing interval and the DFT
      // window. Anything outside that is a real disagreement, not measurement slop.
      const tol = Math.max(msPerSample / 1000 * 2, 1 / (P.ratios.FNom || 60)) + delay * 0.05;
      ev.delayTolerance = tol;
      ev.delayAgrees = Math.abs(observed - delay) <= tol;
      if (!ev.delayAgrees) {
        addFinding('check', 'DELAY_MISMATCH',
          `${el} did not time out after its set delay`,
          `${el}.PU asserted at ${fmtT(puIdx)} and ${el}.TmOut asserted at ${fmtT(tmOutIdx)}, which is ${observed.toFixed(4)} s apart. The ${el}.PUDly setting is ${delay} s. The difference is ${Math.abs(observed - delay).toFixed(4)} s, outside the ${tol.toFixed(4)} s this tool allows for processing and window effects. Possible causes: the settings in this header are not the settings that were active when the event happened, the element dropped out and picked up again inside the window, or the pickup bit was already asserted before the record opened.`);
      }
    } else if (fam.timed === 'curve') {
      const r = sel851IntegrateCurve(curve, timeDial, series, pickup, puIdx, msPerSample, rstMod);
      if (r && r.idx != null) {
        ev.expectedCurveSeconds = r.seconds;
        const tol = Math.max(0.02, r.seconds * 0.15);
        ev.delayAgrees = Math.abs(observed - r.seconds) <= tol;
        if (!ev.delayAgrees) {
          addFinding('check', 'CURVE_MISMATCH',
            `${el} did not operate on its curve`,
            `${el} operated ${observed.toFixed(4)} s after pickup. Curve ${curve} at time dial ${timeDial}, integrated against the current measured in this record, gives ${r.seconds.toFixed(4)} s. Possible causes: a different setting group was active, the reset mode is not instantaneous, or the curve setting shown here is not the one that ran.`);
        }
      } else if (r && r.idx === null) {
        ev.notes.push(`Curve ${curve} at time dial ${timeDial} does not reach operate within this record. The record covers ${(series.length * msPerSample / 1000).toFixed(3)} s, which is shorter than the element needs at the current measured here.`);
      } else {
        ev.notes.push(`No operate-time estimate: curve ${curve || 'not set'} with reset mode ${rstMod || 'not set'} is outside the models this tool applies.`);
      }
    }
  }

  // ── Check 3: did the value stay beyond pickup for the whole timing window? ──
  if (tmOutIdx != null && puIdx != null && tmOutIdx > puIdx) {
    let insideCount = 0;
    for (let i = puIdx; i <= tmOutIdx; i++) if (!beyond(at(i))) insideCount++;
    const frac = insideCount / (tmOutIdx - puIdx + 1);
    ev.insideFraction = frac;
    if (frac > 0.10) {
      addFinding('check', 'PICKUP_NOT_HELD',
        `${el} timed out although its measured value came back inside pickup`,
        `Between pickup and timeout, the ${ev.qtyDesc} was inside the ${pickup} ${ev.qtyUnit} pickup for ${(frac * 100).toFixed(0)}% of the window. An element with a definite-time delay should reset when the value returns inside pickup. Possible causes: the element uses a dropout delay this tool does not model, or the quantity compared here is not the quantity the element used.`);
    }
  }

  // ── Check 4: enable and torque control ──
  if (tmOutIdx != null && enabled === false) {
    addFinding('error', 'ELEMENT_DISABLED',
      `${el} operated while its enable setting says it is off`,
      `${el}.TmOut asserted at ${fmtT(tmOutIdx)}, but ${split.family}.Ena reads "${S[`${split.family}.Ena`]}", which does not enable level ${split.level}. Possible causes: the header settings are not the settings that were active during the event, or the settings were changed after the event.`);
  }
  if (tmOutIdx != null && torqCtl !== undefined && torqCtl !== '1') {
    const tcBit = `${el}.TorqCtl`;
    const tcState = sel851StateAt(P, tcBit, tmOutIdx);
    ev.torqCtlState = tcState;
    if (tcState === false) {
      addFinding('error', 'TORQUE_OFF',
        `${el} operated while its torque control was 0`,
        `${tcBit} read 0 at ${fmtT(tmOutIdx)}, which supervises the element off, yet ${el}.TmOut asserted. The torque control equation is "${torqCtl}". These two cannot both be right.`);
    }
  }

  return ev;
}

// ══════════════════════════════════════════════════════════════════════
// BREAKER RESPONSE
// ══════════════════════════════════════════════════════════════════════
function sel851CheckBreaker(P, A, msPerSample, addFinding, fmtT) {
  const S = P.settings;
  const s52a = P.digitalSeries['Bkr_01.52A_Sta'];
  const out = { openIdx: null, clearSeconds: null, wasClosed: null };
  if (!s52a) {
    addFinding('info', 'NO_52A',
      'Breaker position is not in this record',
      'Bkr_01.52A_Sta is not among the recorded channels, so this record cannot show whether the breaker opened.');
    return out;
  }
  out.wasClosed = s52a[A.tripIdx] === 1;
  if (!out.wasClosed) {
    addFinding('info', 'ALREADY_OPEN',
      'The breaker was already open when the trip asserted',
      `Bkr_01.52A_Sta read 0 at ${fmtT(A.tripIdx)}. The trip did not interrupt load.`);
    return out;
  }
  for (let i = A.tripIdx; i < s52a.length; i++) {
    if (s52a[i] === 0) { out.openIdx = i; break; }
  }
  if (out.openIdx == null) {
    const bfDly = sel851Num(S, 'BF_01.PUDly');
    const recordEnd = (s52a.length - 1 - A.tripIdx) * msPerSample / 1000;
    addFinding('error', 'BREAKER_NO_OPEN',
      'The breaker did not open before the record ended',
      `Trip asserted at ${fmtT(A.tripIdx)} and Bkr_01.52A_Sta was still 1 at the end of the record, ${recordEnd.toFixed(3)} s later.${Number.isFinite(bfDly) ? ` The breaker failure delay BF_01.PUDly is ${bfDly} s.` : ''} Possible causes: the breaker failed to operate, the trip coil circuit is open, or the 52a contact is not reporting position correctly. Check the Sequential Events Recorder for what happened after this record ended.`);
    return out;
  }
  out.clearSeconds = (out.openIdx - A.tripIdx) * msPerSample / 1000;
  const cycles = out.clearSeconds * (P.ratios.FNom || 60);
  out.clearCycles = cycles;
  if (cycles > 8) {
    addFinding('check', 'BREAKER_SLOW',
      'The breaker took longer than expected to open',
      `The breaker opened ${out.clearSeconds.toFixed(4)} s after the trip, which is ${cycles.toFixed(1)} cycles. A healthy distribution breaker normally opens in about 3 to 5 cycles. Possible causes: a slow or worn mechanism, low control voltage, or a 52a contact that reports late.`);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// SCALING CHECK
// ══════════════════════════════════════════════════════════════════════
// The single most useful cross-check in the file. The header states the nominal system
// voltage and the VT ratio. Those two give the voltage the relay should measure on a healthy
// system. The waveforms say what it did measure. If those disagree by a wide margin before
// the disturbance started, every voltage pickup comparison in this record rests on a wrong
// basis, and that must be said before any other conclusion is drawn.
function sel851CheckScaling(P, A, Q, addFinding) {
  const R = P.ratios;
  const out = {};
  A.scaling = out;
  if (!Q.vppMax || !Q._vab) return;

  // Pre-event window: the earliest full cycle after the DFT window has filled, and before the
  // first protection pickup of any kind. If a pickup was already up at the start there is no
  // clean window, and the check reports that rather than using disturbed data.
  const N = P.eventInfo.samPerCycA;
  let firstPu = Q.vppMax.length;
  for (const l of P.digitalLabels) {
    if (!/\.PU$/.test(l)) continue;
    const r = sel851FirstRise(P, l);
    if (r != null && r < firstPu) firstPu = r;
  }
  const from = N, to = Math.min(firstPu - 1, Q.vppMax.length - 1);
  out.windowFrom = from; out.windowTo = to;
  if (to - from < N) {
    out.status = 'no-window';
    addFinding('info', 'NO_PREFAULT_WINDOW',
      'There is no quiet window before the disturbance',
      'This record starts too close to the disturbance to measure a healthy pre-event voltage, so the instrument transformer scaling could not be cross-checked against the nominal settings.');
    return;
  }

  const slice = Q.vppMax.slice(from, to + 1);
  const measured = slice.reduce((s, v) => s + v, 0) / slice.length;
  out.measuredLLsec = measured;

  if (!Number.isFinite(R.VNomKv) || !Number.isFinite(R.PTP) || R.PTP <= 0) {
    out.status = 'no-nominal';
    return;
  }
  const expected = (R.VNomKv * 1000) / R.PTP;
  out.expectedLLsec = expected;
  const errPct = ((measured - expected) / expected) * 100;
  out.errorPct = errPct;
  out.status = Math.abs(errPct) <= 15 ? 'agrees' : 'disagrees';

  if (out.status === 'disagrees') {
    // sqrt(3) and 1/sqrt(3) are the two errors this almost always turns out to be, so name
    // them directly when the numbers fit rather than leaving the reader to spot the ratio.
    const ratio = measured / expected;
    let hint = '';
    if (Math.abs(ratio - Math.sqrt(3)) < 0.12) hint = ` The measured value is about sqrt(3) times the expected value. This is the signature of a phase-to-neutral and phase-to-phase mix-up in Sys.VNom or VTP.Rat.`;
    else if (Math.abs(ratio - 1 / Math.sqrt(3)) < 0.06) hint = ` The measured value is about 1/sqrt(3) of the expected value. This is the signature of a phase-to-neutral and phase-to-phase mix-up in Sys.VNom or VTP.Rat.`;
    addFinding('error', 'SCALING_SUSPECT',
      'Measured voltage does not match the nominal settings',
      `Before the disturbance, the highest phase-to-phase voltage in this record was ${measured.toFixed(1)} V secondary. Sys.VNom of ${R.VNomKv} kV with VTP.Rat of ${R.PTP} gives an expected ${expected.toFixed(1)} V secondary. That is ${errPct > 0 ? '+' : ''}${errPct.toFixed(1)}% off.${hint} Every voltage pickup comparison in this record rests on this basis. Possible causes: the VT ratio setting does not match the installed VT, Sys.VNom does not match the system, or the system was not at nominal voltage before the event.`);
  }
}

// ══════════════════════════════════════════════════════════════════════
// FAULT ORIGIN CHECK
// ══════════════════════════════════════════════════════════════════════
// For a voltage-driven trip, this separates two very different situations that look the same
// on a voltage chart: a fault on this feeder, and a disturbance somewhere upstream. A fault
// drawn through this relay's CTs raises current. A disturbance that does not pass through
// them does not. On a solar or other distributed generation interconnection this distinction
// decides whether the site caused the event or only responded to it.
function sel851CheckFaultOrigin(P, A, Q, addFinding, fmtT) {
  if (!Q.iPhMax || !Q.vppMin) return;
  const voltageInitiators = A.initiators.filter(t => {
    const s = sel851SplitElement(t);
    return s && /^(27|59)/.test(s.family);
  });
  if (!voltageInitiators.length) return;

  const N = P.eventInfo.samPerCycA;
  const from = N;
  const to = Math.min(A.tripIdx, Q.iPhMax.length - 1);
  if (to - from < N) return;

  const pre = Q.iPhMax.slice(from, from + N).reduce((s, v) => s + v, 0) / N;
  let peak = 0, peakIdx = from;
  for (let i = from; i <= to; i++) if (Q.iPhMax[i] > peak) { peak = Q.iPhMax[i]; peakIdx = i; }
  const ratio = pre > 0 ? peak / pre : null;

  // The relay's own overcurrent pickups are the right yardstick, not a bare ratio. They are
  // what the protection engineer set as "more current than this feeder should ever carry", so
  // a peak that never reaches the lowest of them is a direct statement that no overcurrent
  // element saw a fault — verifiable against the settings rather than against a chosen number.
  let lowestOcPickup = null, lowestOcName = null;
  for (const key of Object.keys(P.settings)) {
    const m = key.match(/^((?:50P|51P)_\d+)\.PUVal$/);
    if (!m) continue;
    const sp = sel851SplitElement(`${m[1]}.PUVal`);
    if (sp && sel851FamilyEnabled(P.settings, sp.family, sp.level) === false) continue;
    const v = sel851Num(P.settings, key);
    if (v != null && (lowestOcPickup == null || v < lowestOcPickup)) { lowestOcPickup = v; lowestOcName = m[1]; }
  }
  const belowAllOc = lowestOcPickup != null && peak < lowestOcPickup;
  const ocFraction = lowestOcPickup ? peak / lowestOcPickup : null;
  A.faultOrigin = { preCurrent: pre, peakCurrent: peak, peakIdx, ratio, CTR: A.CTR, lowestOcPickup, lowestOcName, belowAllOc };

  if (belowAllOc) {
    addFinding('info', 'NO_FAULT_CURRENT',
      'Voltage fell with no fault current through this relay',
      `Before the disturbance the highest phase current was ${(pre * A.CTR).toFixed(1)} A primary. The highest during the disturbance was ${(peak * A.CTR).toFixed(1)} A primary, or ${peak.toFixed(3)} A secondary. The lowest enabled phase overcurrent pickup on this relay is ${lowestOcName} at ${lowestOcPickup} A secondary, and the peak reached ${(ocFraction * 100).toFixed(0)}% of it, so no phase overcurrent element picked up. A fault on the protected feeder raises current through these CTs. This one did not. The voltage disturbance came from outside this relay's zone, and the relay responded to a system condition rather than clearing a fault.`);
  } else if (ratio != null && ratio >= 2 && !belowAllOc) {
    addFinding('info', 'FAULT_CURRENT_PRESENT',
      'Current rose while voltage fell',
      `The highest phase current reached ${(peak * A.CTR).toFixed(1)} A primary at ${fmtT(peakIdx)}, which is ${ratio.toFixed(2)} times the pre-event value, while voltage fell. This is consistent with a fault drawing current through this relay's CTs.`);
  }
}

// ══════════════════════════════════════════════════════════════════════
// VERDICT
// ══════════════════════════════════════════════════════════════════════
// The headline answer. One level, one sentence, and the reason. The level is the strongest
// finding present, because a single disagreement is enough to make the operation questionable
// no matter how much else agrees.
function sel851BuildVerdict(P, A) {
  const worst = A.findings.reduce((w, f) => SEL851_LEVELS[f.level] > SEL851_LEVELS[w] ? f.level : w, 'ok');
  const primary = A.elements.find(e => e.initiated) || null;
  const cmd = A.findings.find(f => f.code === 'EXTERNAL_COMMAND');

  let causeText;
  if (primary) {
    causeText = `${primary.element} (${primary.label}) timed out and asserted ${P.tripEquationName}`;
  } else if (cmd) {
    causeText = 'an operator or SCADA command asserted the trip output';
  } else {
    causeText = 'the cause could not be resolved from this record';
  }

  if (worst === 'error') {
    const errs = A.findings.filter(f => f.level === 'error');
    return {
      level: 'error',
      code: 'NOT_REASONABLE',
      headline: 'This trip does not agree with the relay settings',
      detail: `The relay tripped because ${causeText}. ${errs.length === 1 ? 'One check disagrees' : `${errs.length} checks disagree`} with what the settings and the waveforms in this file say should have happened: ${errs.map(e => e.title).join('; ')}. Read the findings below before accepting the recorded cause.`,
    };
  }
  if (worst === 'check') {
    const checks = A.findings.filter(f => f.level === 'check');
    return {
      level: 'check',
      code: 'REASONABLE_WITH_QUESTIONS',
      headline: 'The trip agrees with the settings, but some details need review',
      detail: `The relay tripped because ${causeText}.${primary && primary.evaluated ? ' The measured values support it.' : ''} ${checks.length === 1 ? 'One detail does not' : `${checks.length} details do not`} match what this tool expected: ${checks.map(c => c.title).join('; ')}.`,
    };
  }
  if (!primary && !cmd) {
    return {
      level: 'check', code: 'CAUSE_UNRESOLVED',
      headline: 'The trip cause could not be resolved',
      detail: `Trip_01 asserted, but this record does not show which element started it. ${A.equationTerms.length ? `The trip equation ${P.tripEquationName} was checked term by term and none read 1.` : 'No trip equation is present in the header.'}`,
    };
  }
  const checkedCount = A.elements.filter(e => e.evaluated).length;
  const operatedCount = A.elements.filter(e => e.timedOut).length;
  const totalCount = A.elements.length;
  let coverage = '';
  if (checkedCount) {
    coverage = ` Of the ${totalCount} element${totalCount === 1 ? '' : 's'} in the trip equation, ${operatedCount === 0 ? 'none operated' : operatedCount === 1 ? 'one operated' : `${operatedCount} operated`}` +
      `${operatedCount ? `, and ${operatedCount === 1 ? 'its pickup and delay were' : 'their pickups and delays were'} checked against the waveforms in this file and agree` : ''}.` +
      `${checkedCount < totalCount ? ` ${totalCount - checkedCount} could not be checked against the waveforms; see the Elements tab for why.` : ''}`;
  }
  return {
    level: 'ok', code: 'REASONABLE',
    headline: 'This trip agrees with the relay settings',
    detail: `The relay tripped because ${causeText}${primary && primary.measuredAtTimeoutText ? `, with ${primary.qtyDesc} measured at ${primary.measuredAtTimeoutText} against a ${primary.pickupText} pickup` : ''}.${coverage}${A.breaker && A.breaker.clearCycles != null ? ` The breaker opened ${A.breaker.clearCycles.toFixed(1)} cycles later.` : ''}`,
  };
}
