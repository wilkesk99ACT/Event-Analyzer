// RMS/phasor/sequence-component math and per-instant value lookups used by the charts and consistency checks.

function computeRmsMagnitude(samples, windowSize, scale = 1) {
  const n = samples.length;
  const out = new Array(n).fill(0);
  const sq = [];
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = samples[i] || 0;
    const vv = v * v;
    sq.push(vv);
    sumSq += vv;
    if (sq.length > windowSize) sumSq -= sq.shift();
    // Floating-point subtraction in the running sum can drift slightly negative over many
    // samples (especially during quiet, near-zero periods), which would otherwise feed
    // Math.sqrt() a tiny negative number and produce NaN. Clamp at 0 — the true sum of
    // squares can never be negative.
    out[i] = scale * Math.sqrt(Math.max(0, sumSq) / sq.length);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// SYMMETRICAL COMPONENTS — for trips where phase quantities alone don't show why
// ══════════════════════════════════════════════════════════════════════
// A zero- or negative-sequence trip (e.g. 59YN1 watching 3V0) can look almost
// invisible on a per-phase magnitude chart: all three phases can sit near nominal
// while the SEQUENCE component itself spikes. Zero-sequence voltage (3V0) is simple —
// it's just the instantaneous sum of the three phases, so no transform is needed
// beyond the same sliding-RMS already used elsewhere. Negative-sequence, however,
// requires a genuine phase-shifted (Fortescue) combination, which can't be done by
// summing instantaneous samples — it needs each phase's fundamental-frequency phasor
// (magnitude AND angle) first.
//
// computeFundamentalPhasors extracts a sliding one-cycle DFT phasor per sample,
// normalized so its magnitude is directly RMS-equivalent (validated against a known
// pure sinusoid: a 100-amplitude cosine yields the expected 70.7107 RMS exactly).
function computeFundamentalPhasors(samples, N, scale = 1) {
  const n = samples.length;
  const re = new Array(n).fill(0), im = new Array(n).fill(0);
  const cosT = new Array(N), sinT = new Array(N);
  for (let k = 0; k < N; k++) {
    cosT[k] = Math.cos(2 * Math.PI * k / N);
    sinT[k] = Math.sin(2 * Math.PI * k / N);
  }
  // Same per-file magnitude calibration as computeRmsMagnitude — folded into the DFT
  // normalisation so every derived sequence/phase-difference magnitude inherits it.
  const norm = scale * Math.sqrt(2) / N;
  for (let i = 0; i < n; i++) {
    if (i < N - 1) { re[i] = re[Math.max(0, i - 1)] || 0; im[i] = im[Math.max(0, i - 1)] || 0; continue; }
    let sr = 0, si = 0;
    for (let k = 0; k < N; k++) {
      const v = samples[i - k] || 0;
      sr += v * cosT[k];
      si += v * sinT[k];
    }
    re[i] = sr * norm;
    im[i] = si * norm;
  }
  return { re, im };
}

// Generalized version of the fundamental-frequency extractor above, parameterized by harmonic
// order — harmonic=1 reproduces computeFundamentalPhasors exactly. Used to estimate 2nd-harmonic
// content for inrush detection: transformer magnetizing inrush current is characteristically
// rich in 2nd harmonic (commonly 20-70% of the fundamental), while genuine fault current
// normally carries very little (commonly under ~10%) — the same signature transformer
// differential relays use for inrush restraint.
function computeHarmonicPhasors(samples, N, harmonic) {
  const n = samples.length;
  const re = new Array(n).fill(0), im = new Array(n).fill(0);
  const cosT = new Array(N), sinT = new Array(N);
  for (let k = 0; k < N; k++) {
    cosT[k] = Math.cos(2 * Math.PI * harmonic * k / N);
    sinT[k] = Math.sin(2 * Math.PI * harmonic * k / N);
  }
  const norm = Math.sqrt(2) / N;
  for (let i = 0; i < n; i++) {
    if (i < N - 1) { re[i] = re[Math.max(0, i - 1)] || 0; im[i] = im[Math.max(0, i - 1)] || 0; continue; }
    let sr = 0, si = 0;
    for (let k = 0; k < N; k++) {
      const v = samples[i - k] || 0;
      sr += v * cosT[k];
      si += v * sinT[k];
    }
    re[i] = sr * norm;
    im[i] = si * norm;
  }
  return { re, im };
}

// Best-effort check for a transformer-inrush-like signature in phase current right after a
// close attempt: elevated 2nd-harmonic content relative to the fundamental, plus (as
// supporting-only evidence) a one-sided/asymmetric peak shape. Requires at least 8 analog
// samples/cycle to say anything about the 2nd harmonic — a 2nd harmonic needs a minimum of 4
// samples/cycle just to satisfy Nyquist with essentially zero margin, which is too close to
// the sampling limit to trust; below 8, this returns null rather than a misleading number.
function detectInrushSignature(P, startIdx, endIdx) {
  const spc = P.eventInfo.samPerCycA || 32;
  if (spc < 8) return null;
  const data = P.analogData || [];
  const s = Math.max(0, startIdx), e = Math.min(data.length, endIdx);
  if (e - s < spc * 1.5) return null; // need at least ~1.5 cycles in the window to say anything

  let best = null;
  for (const ch of ['IA', 'IB', 'IC']) {
    const full = data.map(r => r[ch] || 0);
    const fundP = computeHarmonicPhasors(full, spc, 1);
    const h2P = computeHarmonicPhasors(full, spc, 2);
    // Evaluate at the end of the window (closest to whatever happens next — typically the
    // following trip), where the sliding DFT window sits fully inside the post-close current.
    const idx = e - 1;
    const fundMag = Math.hypot(fundP.re[idx], fundP.im[idx]);
    const h2Mag = Math.hypot(h2P.re[idx], h2P.im[idx]);
    const pct2H = fundMag > 0.05 ? (h2Mag / fundMag) * 100 : 0;

    // Peak-based asymmetry over the window — inrush is characteristically one-sided (a
    // DC-offset, "cuspy" waveform); a genuine fault is close to symmetric. Supporting evidence
    // only — a fault initiated at an unfavorable point-on-wave can also show some transient
    // asymmetry — so this is reported alongside the harmonic content, never in place of it.
    let posPeak = 0, negPeak = 0;
    for (let i = s; i < e; i++) { const v = full[i]; if (v > posPeak) posPeak = v; if (-v > negPeak) negPeak = -v; }
    const asymmetry = Math.min(posPeak, negPeak) > 0.01 ? Math.max(posPeak, negPeak) / Math.max(0.01, Math.min(posPeak, negPeak)) : null;

    const peak = Math.max(posPeak, negPeak);
    if (!best || peak > best.peak) best = { phase: ch.slice(1), peak, pct2H, asymmetry };
  }
  return best;
}

// Zero-sequence magnitude series (3V0 = |Va + Vb + Vc| at FUNDAMENTAL frequency) from three
// phase sample arrays. Uses the same one-cycle DFT phasors as the negative-sequence transform,
// which inherently rejects DC offset and all harmonics — including the triplen harmonics that
// are themselves zero-sequence and would otherwise contaminate a raw instantaneous sum.
function computeZeroSeqMagnitude(sA, sB, sC, N, scale = 1) {
  const pA = computeFundamentalPhasors(sA, N, scale);
  const pB = computeFundamentalPhasors(sB, N, scale);
  const pC = computeFundamentalPhasors(sC, N, scale);
  const n = sA.length;
  const mag = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const re = pA.re[i] + pB.re[i] + pC.re[i];
    const im = pA.im[i] + pB.im[i] + pC.im[i];
    mag[i] = Math.sqrt(re * re + im * im);
  }
  return mag;
}

// Negative-sequence magnitude series from three phase sample arrays, via the Fortescue
// transform V2 = (Va + a²·Vb + a·Vc)/3 where a = 1∠120°. Formula convention verified
// against a synthetic three-phase signal with a known injected 20∠30° negative-sequence
// component — recovered exactly.
function computeNegSeqMagnitude(sA, sB, sC, N, scale = 1) {
  const pA = computeFundamentalPhasors(sA, N, scale);
  const pB = computeFundamentalPhasors(sB, N, scale);
  const pC = computeFundamentalPhasors(sC, N, scale);
  const aRe = -0.5, aIm = Math.sqrt(3) / 2;       // a  = 1∠120°
  const a2Re = -0.5, a2Im = -Math.sqrt(3) / 2;     // a² = 1∠240°
  const n = sA.length;
  const mag = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    // a² * Vb
    const a2bRe = a2Re * pB.re[i] - a2Im * pB.im[i];
    const a2bIm = a2Re * pB.im[i] + a2Im * pB.re[i];
    // a * Vc
    const acRe = aRe * pC.re[i] - aIm * pC.im[i];
    const acIm = aRe * pC.im[i] + aIm * pC.re[i];
    const vre = (pA.re[i] + a2bRe + acRe) / 3;
    const vim = (pA.im[i] + a2bIm + acIm) / 3;
    mag[i] = Math.sqrt(vre * vre + vim * vim);
  }
  return mag;
}

// Positive-sequence magnitude series, via V1 = (Va + a·Vb + a²·Vc)/3 where a = 1∠120°.
// Same one-cycle DFT phasors as computeNegSeqMagnitude, with a/a² swapped between Vb/Vc.
// Used for 59YV1/59ZV1 (positive-sequence overvoltage).
function computePosSeqMagnitude(sA, sB, sC, N, scale = 1) {
  const pA = computeFundamentalPhasors(sA, N, scale);
  const pB = computeFundamentalPhasors(sB, N, scale);
  const pC = computeFundamentalPhasors(sC, N, scale);
  const aRe = -0.5, aIm = Math.sqrt(3) / 2;        // a  = 1∠120°
  const a2Re = -0.5, a2Im = -Math.sqrt(3) / 2;      // a² = 1∠240°
  const n = sA.length;
  const mag = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const abRe = aRe * pB.re[i] - aIm * pB.im[i];
    const abIm = aRe * pB.im[i] + aIm * pB.re[i];
    const a2cRe = a2Re * pC.re[i] - a2Im * pC.im[i];
    const a2cIm = a2Re * pC.im[i] + a2Im * pC.re[i];
    const vre = (pA.re[i] + abRe + a2cRe) / 3;
    const vim = (pA.im[i] + abIm + a2cIm) / 3;
    mag[i] = Math.sqrt(vre * vre + vim * vim);
  }
  return mag;
}

// Phase-to-phase fundamental magnitude (e.g. Va - Vb), via the same one-cycle DFT phasors —
// a true fundamental-frequency difference rather than a raw instantaneous subtraction, so
// harmonic content doesn't inflate the value compared against a 27#PP1/59#PP1 pickup.
function computePhaseDiffMagnitude(sX, sY, N, scale = 1) {
  const pX = computeFundamentalPhasors(sX, N, scale);
  const pY = computeFundamentalPhasors(sY, N, scale);
  const n = sX.length;
  const mag = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const re = pX.re[i] - pY.re[i];
    const im = pX.im[i] - pY.im[i];
    mag[i] = Math.sqrt(re * re + im * im);
  }
  return mag;
}

// ══════════════════════════════════════════════════════════════════════
// TORQUE CONTROL (element supervision)
// ══════════════════════════════════════════════════════════════════════
// Every SEL overcurrent element has a torque-control SELogic equation (50P1TC, 50G1TC,
// 51G1TC, …). While that equation is false the element is supervised OFF: the current can sit
// far above pickup and the element still will not operate. A protection table that compares
// magnitude against pickup alone therefore reports elements as "asserted" that the relay
// itself has deliberately disabled — the same false-positive class as a unit-conversion error,
// just from a different direction.
//
// How the supervision applies differs by family, and this distinction is not cosmetic — it was
// confirmed bit-for-bit against a real record where 50G1TC = 51G1TC = LT01 and LT01 never
// asserted:
//   * 51 (inverse-time): torque control gates the ELEMENT. The relay's own 51G1 pickup bit
//     stayed low for the entire fault despite ~3x pickup of ground current.
//   * 50 (instantaneous/definite-time): torque control gates the TIMED output. The relay's raw
//     50G1 comparator bit did assert, while 50G1T (the output that can actually trip) never
//     did. So the pickup is real, but it cannot cause a trip.

// Relay-word bit state as of a given ANALOG sample index, from the record's own digital data.
function bitStateAtAnalogIdx(P, label, analogIdx) {
  let state = (P.initialDigitalState || []).includes(label);
  let seen = state;
  for (const tr of (P.digitalTransitions || [])) {
    if (tr.analogSampleIdx > analogIdx) break;
    const c = (tr.changes || []).find(c => c.label === label);
    if (c) { state = c.asserted; seen = true; }
  }
  // A bit SEL never records a transition for simply never changed from its default off state.
  return { state, known: seen || (P.digitalLabels || []).includes(label) };
}

// Minimal standalone SELogic evaluator for torque-control equations, which are overwhelmingly
// either a literal 1/0 or a short combination of relay-word bits. Returns `null` (meaning "can't
// tell — don't claim anything") rather than guessing when an operand isn't a bit this record
// carries, so an unparseable equation degrades to today's unsupervised behaviour plus a note,
// never to a wrong "blocked" verdict.
function evalTorqueControlAt(P, expr, analogIdx) {
  if (expr == null) return { value: true, known: true, trivial: true };
  const clean = String(expr).split('#')[0].trim();
  if (!clean) return { value: true, known: true, trivial: true };
  if (/^1$/.test(clean)) return { value: true, known: true, trivial: true };
  if (/^0$/.test(clean) || /^NA$/i.test(clean)) return { value: false, known: true, trivial: true };

  const toks = clean.match(/\(|\)|\bAND\b|\bOR\b|\bNOT\b|\bR_TRIG\b|\bF_TRIG\b|[A-Za-z0-9_]+/g) || [];
  let i = 0, unknown = false;
  const peek = () => toks[i], next = () => toks[i++];
  const factor = () => {
    const tk = peek();
    if (tk === undefined) { unknown = true; return false; }
    if (tk === 'NOT') { next(); return !factor(); }
    if (tk === 'R_TRIG' || tk === 'F_TRIG') { next(); factor(); unknown = true; return false; }
    if (tk === '(') { next(); const v = expr2(); if (peek() === ')') next(); return v; }
    next();
    if (/^[01]$/.test(tk)) return tk === '1';
    const b = bitStateAtAnalogIdx(P, tk, analogIdx);
    if (!b.known) unknown = true;
    return b.state;
  };
  const term = () => { let v = factor(); while (peek() === 'AND') { next(); const r = factor(); v = v && r; } return v; };
  const expr2 = () => { let v = term(); while (peek() === 'OR') { next(); const r = term(); v = v || r; } return v; };
  const value = expr2();
  if (unknown) return { value: null, known: false, trivial: false };
  return { value, known: true, trivial: false };
}

function clampIdx(len, i) {
  return Math.max(0, Math.min(len - 1, i));
}

// Evaluate one overcurrent/time-overcurrent row at a specific full-record sample index.
// Called once per row at analysis time (idx = trigger/trip instant) AND again from the
// client-side cursor-refresh path (idx = wherever the measurement cursor sits) — using the
// exact same function both times keeps the two paths from ever producing different numbers
// for the same instant.
function evalOcRowAtIdx(A, row, idx) {
  const cd = A.cursorData;
  const seriesArr = cd.current[row.seriesKey];
  const measured = seriesArr[clampIdx(seriesArr.length, idx)] || 0;
  const { pickup, delay, delayUnit, el, type } = row;
  // UNITS — the bug this guards against: SEL overcurrent pickups (50P1P, 50G1P, 51PJP, …) are
  // ALWAYS secondary amps, while the analog channel may be primary-referred (SEL-651R exports
  // primary amps with a bare "IA" header). Comparing the two directly overstates every element
  // by the CT ratio: a 13 A-sec (1300 A pri) 50P1 read as "7.96x pickup, asserted" on a fault
  // whose max phase current was ~350 A primary — while the relay's own 50P1 bit, correctly,
  // never asserted. Both quantities are now brought to the SAME basis before comparing, and
  // both unit labels below are now truthful rather than assumed.
  const CTRl = cd.CTR || 1;
  const measuredSec = cd.iDataIsPrimary ? measured / CTRl : measured;
  const measuredPri = cd.iDataIsPrimary ? measured : measured * CTRl;
  const pickupSec = pickup;
  const pickupPri = pickup * CTRl;
  const overPickup = measuredSec >= pickupSec;
  const multiple = pickupSec > 0 ? measuredSec / pickupSec : 0;

  // Torque-control supervision — see evalTorqueControlAt(). For a 51 element a false TC holds
  // the element itself off; for a 50 element the comparator still picks up but its timed
  // output (the one that can trip) is blocked.
  const tc = evalTorqueControlAt(cd.P, row.tcExpr, idx);
  const tcExprText = row.tcExpr ? String(row.tcExpr).split('#')[0].trim() : null;
  const tcBlocks = tc.known && tc.value === false;
  const tcUnknown = row.tcExpr != null && !tc.known;
  const gatesElement = row.family === '51';
  const asserted = overPickup && !(tcBlocks && gatesElement);
  let tcNote = null;
  if (tcBlocks && tcExprText) {
    tcNote = gatesElement
      ? `Supervised OFF — torque control ${el}TC := ${tcExprText} is de-asserted at this instant, so the element cannot pick up regardless of current.`
      : `Picked up, but torque control ${el}TC := ${tcExprText} is de-asserted at this instant, so the timed output ${el}T is blocked and this element cannot trip.`;
  } else if (tcUnknown && tcExprText) {
    tcNote = `Torque control ${el}TC := ${tcExprText} could not be resolved from this record's digital data — pickup shown unsupervised.`;
  }

  let opTime = null;
  if (el.startsWith('51') && asserted) {
    const curve = row.curve || 'U1';
    const td = row.td || 1;
    if (curve === 'U1') opTime = calcU1Time(multiple, td);
  } else if (asserted && delayUnit === 'cycles') {
    opTime = delay / (cd.freq || 60);
  }
  return {
    element: el, type, asserted, multiple: multiple.toFixed(2),
    overPickup, torqueBlocked: tcBlocks, torqueControl: tcExprText, torqueNote: tcNote,
    blocked: tcBlocks && gatesElement,
    pickup: `${pickupSec} A sec (${pickupPri.toFixed(0)} A pri)`,
    measured: `${measuredSec.toFixed(3)} A sec (${measuredPri.toFixed(1)} A pri)`,
    timeDelay: delayUnit === 'cycles' ? `${delay} cycles` : `TD=${delay}`,
    operationTime: (asserted && !tcBlocks && opTime !== null && opTime < 9999)
      ? (opTime < 1 ? `${(opTime * 1000).toFixed(1)} ms` : `${opTime.toFixed(2)} sec`)
      : (tcBlocks ? 'blocked' : 'N/A'),
  };
}

// Primary<->secondary conversions for a single raw channel reading, matching the basis
// established for the 59YN1 investigation: SEL pickups/VNOM are always secondary V, while the
// exported analog channel can be secondary-referenced OR primary-referenced (kV or plain V).
function rawToSecondaryV(cd, raw, ptr) {
  const primaryKV = cd.isPrimaryDataV ? (cd.voltChannelIsKV ? raw : raw / 1000) : (raw * ptr) / 1000;
  return primaryKV * 1000 / ptr;
}
function secondaryVToRaw(cd, secondaryV, ptr) {
  if (!cd.isPrimaryDataV) return secondaryV; // channel already secondary-referenced — no conversion
  const primaryV = secondaryV * ptr;
  return cd.voltChannelIsKV ? primaryV / 1000 : primaryV;
}

// Evaluate one voltage protection row at a specific full-record sample index. `raw` is read
// directly off A.cursorData.voltage[term][kind] — the same per-sample series the "relevant
// quantity" waveform chart itself is built from — so it is, by construction, always in the
// exact units and value that chart shows at that same instant. The pickup (a secondary-V
// setting) is converted the other direction into that same chart-native basis for direct
// side-by-side comparison, in addition to the secondary-V figure used for the assert decision.
function evalVoltRowAtIdx(A, row, idx) {
  const cd = A.cursorData;
  const ptr = row.term === 'Y' ? cd.PTRY : cd.PTRZ;
  const arr = cd.voltage[row.term === 'Y' ? 'yTerminal' : 'zTerminal'][row.kind];
  const raw = arr[clampIdx(arr.length, idx)] || 0;
  const secV = rawToSecondaryV(cd, raw, ptr);
  const pickupChart = secondaryVToRaw(cd, row.pickup, ptr);
  const asserted = row.type === 'UV' ? secV < row.pickup : secV > row.pickup;
  const pct = (row.pickup / (cd.VNOM || 1) * 100).toFixed(1);
  return {
    element: row.element, type: row.typeLabel, terminal: row.term, kind: row.kind,
    pickup: `${row.pickup.toFixed(2)} V sec (${pct}% VNOM) &nbsp;=&nbsp; ${pickupChart.toFixed(2)} ${cd.voltUnit} (chart)`,
    measured: `${secV.toFixed(2)} V sec &nbsp;=&nbsp; ${raw.toFixed(2)} ${cd.voltUnit} (chart)`,
    asserted,
  };
}

// ══════════════════════════════════════════════════════════════════════
// PHYSICAL CONSISTENCY CHECKS — does this reading make physical sense?
// ══════════════════════════════════════════════════════════════════════
// Prompted by a real field finding: a site's 59YN1 (zero-sequence overvoltage) was
// tripping on a genuinely elevated 3V0, but the corresponding ground current (IG) stayed
// essentially flat — a pattern the EOR flagged as consistent with a disconnected/miswired
// grounding transformer or ground CT, since a real, sustained zero-sequence voltage on a
// solidly (or resistance-) grounded system should drive a roughly proportional zero-
// sequence current through whatever's actually grounding the system. Voltage-with-no-
// corresponding-current is the tell — not a spike, a sustained mismatch in how "engaged"
// each measurement is relative to its OWN protection pickup.
//
// UNITS: SEL settings (pickups, VNOM) are always expressed in relay/CT/PT SECONDARY
// terms, regardless of what the exported analog CHANNEL data uses. Newer SEL-651R/851
// CEV exports commonly report analog channels in PRIMARY units (kV/A) directly — this was
// confirmed empirically against a real file: VNOM(secondary) × PTR landed almost exactly
// on the observed primary-kV phase magnitudes, and a ground-OC pickup(secondary) × CTR
// landed within 2% of a value the EOR independently quoted from the grounding bank's
// nameplate rating. So pickups are converted to primary (×PTR for voltage, ×CTR for
// current) before comparing against the channel data, not the other way around.
function getSettingNum(P, names) {
  for (const name of names) {
    const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(?:^|[^A-Z0-9_])' + safe + '\\s*:=\\s*(-?[\\d.]+)', 'm');
    const x = (P.raw || '').match(re);
    if (x) return parseFloat(x[1]);
  }
  return null;
}

// Unlike getSettingNum (first match wins), this collects every matching value across all
// candidate name patterns — used when a site may have multiple numbered elements in the same
// family (59G1, 59G2, 59G3...) and, absent a specific element to tie the check to, the most
// sensitive (lowest) one is the most defensible reference point.
function getAllSettingNums(P, namePatterns) {
  const found = [];
  for (const pattern of namePatterns) {
    const safe = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('#', '\\d+');
    const re = new RegExp('(?:^|[^A-Z0-9_])' + safe + '\\s*:=\\s*(-?[\\d.]+)', 'gm');
    let m;
    while ((m = re.exec(P.raw || '')) !== null) found.push(parseFloat(m[1]));
  }
  return found;
}

// Find a documenting comment for a MIRRORED BITS point. RMB (received) points are pure
// inputs with no SELOGIC equation of their own, so there's nothing to look up directly — but
// a reciprocal TMB (transmitted) definition this same device sends often documents the real
// purpose of a related relationship (e.g. "TMB4A := TRIP3P #DTT FROM PSE OR LOCAL TRIP").
//
// IMPORTANT HONESTY NOTE: a same-numbered RMB/TMB pair is NOT guaranteed to describe the same
// logical signal — engineers assign MIRRORED BITS channel numbers independently per
// direction, so "RMB4B" and "TMB4B" can easily be two unrelated pieces of information that
// happen to share a slot number. Rather than confidently picking one candidate and asserting
// it's "the" explanation (which could just as easily be wrong), this collects every distinct
// comment found across plausible candidates (same port, other port, bare number) and returns
// them all, so the tool can present them as related context for the engineer to judge —
// not a definitive resolution.
function findMirroredBitComments(P, bitName) {
  const raw = P.raw || '';
  const m = bitName.match(/^([RT]MB)(\d+)([A-Z]?)$/);
  if (!m) return [];
  const [, prefix, num, port] = m;
  const otherPrefix = prefix === 'RMB' ? 'TMB' : 'RMB';

  const candidates = [];
  if (port) candidates.push(otherPrefix + num + port);
  for (const p of ['A', 'B']) if (p !== port) candidates.push(otherPrefix + num + p);
  candidates.push(otherPrefix + num);

  const results = [];
  const seen = new Set();
  for (const name of candidates) {
    const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(?:^|[^A-Z0-9_])' + safe + '\\s*:=[^\\r\\n]*#([^\\r\\n]+)', 'm');
    const x = raw.match(re);
    if (x) {
      const comment = x[1].trim();
      const key = name + '|' + comment;
      if (!seen.has(key)) { seen.add(key); results.push({ source: name, comment }); }
    }
  }
  if (results.length) return results;

  // Fuzzy fallback: this exact bit name referenced anywhere with a comment on the same line.
  const safeBit = bitName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fuzzyRe = new RegExp('(?:^|[^A-Z0-9_])' + safeBit + '(?:[^\\r\\n]*)#([^\\r\\n]+)', 'm');
  const fx = raw.match(fuzzyRe);
  if (fx) return [{ source: bitName, comment: fx[1].trim() }];

  return [];
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// kind: 'zero' or 'neg'. Returns null if the required channels aren't present.
function computeConsistencyCheck(P, A, kind) {
  const data = P.analogData || [];
  if (!data.length) return null;
  const samplesPerCycle = P.eventInfo.samPerCycA || 32;
  const CTR = P.settings.CTR || null;
  const PTR = P.settings.PTRY || null;
  const MAGS = P.magScale || 1;

  let vMag, vLabel, vPickupPatterns, iMag, iLabel, iPickupPatterns, hasCurrentChannel;

  if (kind === 'zero') {
    // 3V0 must be computed from FUNDAMENTAL phasors, not the raw instantaneous sum: triplen
    // harmonics (3rd, 9th, ...) are themselves zero-sequence and add constructively in a raw
    // sum — and inverter-based sites carry exactly that harmonic content. The relay's 59N/59G
    // element responds to fundamental 3V0 only, so a raw-sum RMS inflated by harmonics would
    // be compared against a pickup that never sees that content — a false-flag mechanism.
    vMag = computeZeroSeqMagnitude(data.map(r => r.VAY), data.map(r => r.VBY), data.map(r => r.VCY), samplesPerCycle, MAGS);
    vLabel = '3V0';
    vPickupPatterns = ['59YN#P', '59N#P', '59G#P', '59GN#P', '59G#AP'];
    hasCurrentChannel = data.some(r => Math.abs(r.IG || 0) > 0.001) ? 'IG'
                       : data.some(r => Math.abs(r.IN || 0) > 0.001) ? 'IN' : null;
    iLabel = hasCurrentChannel || 'IG';
    iMag = hasCurrentChannel ? computeRmsMagnitude(data.map(r => r[hasCurrentChannel]), samplesPerCycle, MAGS) : null;
    iPickupPatterns = ['51G#JP', '51G#P', '50G#P', '50GFP', '50GF#P', '50G#AP'];
  } else {
    vMag = computeNegSeqMagnitude(data.map(r => r.VAY), data.map(r => r.VBY), data.map(r => r.VCY), samplesPerCycle, MAGS);
    vLabel = 'V2';
    vPickupPatterns = ['59Q#P', '59QP', '59Q#AP'];
    hasCurrentChannel = 'computed'; // I2 is always computable from phase currents
    iLabel = 'I2';
    iMag = computeNegSeqMagnitude(data.map(r => r.IA), data.map(r => r.IB), data.map(r => r.IC), samplesPerCycle, MAGS);
    iPickupPatterns = ['51Q#JP', '51Q#P', '50Q#P', '50QFP', '50Q#AP'];
  }

  if (!iMag) return null; // no usable ground-current channel populated in this file

  const vSustained = median(vMag), vPeak = Math.max(...vMag);
  const iSustained = median(iMag), iPeak = Math.max(...iMag);

  // Prefer the SPECIFIC numbered element this event's own trip-cause chain actually used
  // (e.g. an immediateCause of "59G2T" means "59G2P" — not some unrelated "59G1P" backup
  // element with a completely different, coarser pickup — is the relevant reference).
  // Absent that, fall back to the most sensitive (lowest) pickup among every numbered
  // variant found in the settings, since that's the one most likely to actually be the
  // dedicated zero/negative-sequence protection rather than a coarse backup.
  let vPickupSec = null;
  const chainLabels = (A?.tripCause?.causeChain || []).map(c => c.label);
  for (const label of [A?.tripCause?.immediateCause, ...chainLabels]) {
    if (!label) continue;
    const m = kind === 'zero' ? label.match(/^(59[A-Z]*\d+)/) : label.match(/^(59Q\d*)/);
    if (m) { vPickupSec = getSettingNum(P, [m[1] + 'P']); if (vPickupSec != null) break; }
  }
  if (vPickupSec == null) {
    const all = getAllSettingNums(P, vPickupPatterns);
    if (all.length) vPickupSec = Math.min(...all);
  }

  let iPickupSec = null;
  for (const label of [A?.tripCause?.immediateCause, ...chainLabels]) {
    if (!label) continue;
    const m = kind === 'zero' ? label.match(/^(5[01]G\d*)/) : label.match(/^(5[01]Q\d*)/);
    if (m) {
      const base = m[1];
      iPickupSec = getSettingNum(P, [base + 'JP', base + 'P']);
      if (iPickupSec != null) break;
    }
  }
  if (iPickupSec == null) {
    const all = getAllSettingNums(P, iPickupPatterns);
    if (all.length) iPickupSec = Math.min(...all);
  }

  // CRITICAL: whether to convert settings (always secondary, by SEL convention) up to
  // primary before comparing against the analog channel data depends on which convention
  // THIS file's analog channels actually use — and that varies by relay/export format, and
  // is NOT reliably indicated by the channel's own unit label. A SEL-751 file was found with
  // an explicit PRIM_VAL=YES flag (primary-referred data) despite its header still labeling
  // the channel "(V)" — a generic unit name that doesn't reflect whether PRIM_VAL scaling was
  // actually applied. The PRIM_VAL flag itself (parsed during parseCEV, only present in
  // SEL-751-style summary rows) is authoritative when available; the "(kV)" vs "(V)"/bare
  // label heuristic is only a fallback for formats (like SEL-651R) that don't expose an
  // explicit PRIM_VAL flag at all.
  //
  // SEPARATELY: even among primary-referred files, some report the channel in kV and some
  // in raw volts — this is an independent question from primary-vs-secondary and must NOT be
  // conflated with it (an earlier version divided by 1000 unconditionally whenever data was
  // primary-referred, which was correct for a kV-scaled 651R file but wrong by 1000x for a
  // 751 file that turned out to report primary data in raw volts, not kV).
  const isPrimaryData = (P.settings.primaryValues !== undefined && P.settings.primaryValues !== null)
    ? P.settings.primaryValues
    : detectChannelUnit(P, ['VA', 'VAY', 'VB', 'VBY'], '').toUpperCase() === 'KV';
  const voltChannelIsKV = detectChannelUnit(P, ['VA', 'VAY', 'VB', 'VBY'], '').toUpperCase() === 'KV';
  const voltScaleDivisor = (isPrimaryData && voltChannelIsKV) ? 1000 : 1;
  const vPickupPrimary = vPickupSec != null ? ((isPrimaryData && PTR ? vPickupSec * PTR : vPickupSec) / voltScaleDivisor) : null;
  const iPickupPrimary = iPickupSec != null ? (isPrimaryData && CTR ? iPickupSec * CTR : iPickupSec) : null;

  // Reference bases when no matching pickup setting exists in this file: fall back to
  // %VNOM for voltage (same convention-aware conversion as above) and % of phase current
  // for the ground/sequence current (self-consistent within the same current-channel
  // group, so this fallback needs no unit conversion at all regardless of format).
  const VNOM = P.settings.VNOM;
  const vRefPrimary = vPickupPrimary != null ? vPickupPrimary
                    : VNOM ? ((isPrimaryData && PTR ? VNOM * PTR : VNOM) / voltScaleDivisor) : null;
  const vRefIsPickup = vPickupPrimary != null;

  const avgPhaseI = median(data.map(r => (Math.abs(r.IA || 0) + Math.abs(r.IB || 0) + Math.abs(r.IC || 0)) / 3));
  const iRefPrimary = iPickupPrimary != null ? iPickupPrimary : (avgPhaseI > 0.01 ? avgPhaseI : null);
  const iRefIsPickup = iPickupPrimary != null;

  const vSustainedPct = vRefPrimary ? (vSustained / vRefPrimary * 100) : null;
  const vPeakPct = vRefPrimary ? (vPeak / vRefPrimary * 100) : null;
  const iSustainedPct = iRefPrimary ? (iSustained / iRefPrimary * 100) : null;
  const iPeakPct = iRefPrimary ? (iPeak / iRefPrimary * 100) : null;

  // Flag only on a genuine, sustained mismatch — not a momentary blip, and not when the
  // voltage side is itself negligible (avoids flagging pure noise on a quiet, healthy file).
  //
  // TWO PHYSICS GATES, both mandatory:
  //
  // 1) Breaker must have been CLOSED for the majority of this record. Sequence voltage with
  //    zero corresponding current through an OPEN breaker is expected — no current flows
  //    through an open device, full stop. Without this gate, a backfeed event on an already-
  //    open recloser (voltage present from the generation side, correctly zero current) would
  //    be mislabeled as a CT/grounding wiring problem.
  //
  // 2) For the ZERO-sequence check specifically, the settings must contain a ground
  //    overcurrent pickup (iRefIsPickup). Its presence indicates the design expects a ground-
  //    current path to exist. On an ungrounded-by-design system — e.g. a solar collector
  //    system behind a delta GSU winding, which is exactly why 59N protection is applied at
  //    such sites — a ground fault legitimately produces large 3V0 with essentially NO ground
  //    current. That is correct physics, not a wiring defect, and without this gate every
  //    legitimate 59N operation on such a system would be falsely flagged (the fallback
  //    reference would compare IG against phase load current, which is meaningless there).
  //    Negative-sequence is exempt from gate 2: I2 flows for any unbalance in any 3-wire
  //    system, so a V2-without-I2 mismatch is meaningful regardless of grounding design.
  const bkr = ['52A3P', '52A'].find(l => (P.digitalLabels || []).includes(l));
  let breakerClosedMajority = true; // if no breaker status channel exists, don't block on it
  if (bkr && P.analogData?.length) {
    let closed = (P.initialDigitalState || []).includes(bkr);
    let closedSamples = 0, prevIdx = 0;
    for (const t of (P.digitalTransitions || [])) {
      const idx = Math.min(t.analogSampleIdx ?? 0, P.analogData.length - 1);
      if (closed) closedSamples += idx - prevIdx;
      const ch = t.changes.find(c => c.label === bkr);
      if (ch) closed = ch.asserted;
      prevIdx = idx;
    }
    if (closed) closedSamples += (P.analogData.length - 1) - prevIdx;
    breakerClosedMajority = closedSamples / P.analogData.length > 0.5;
  }
  const groundPathExpected = kind !== 'zero' || iRefIsPickup;
  const flagged = vSustainedPct != null && iSustainedPct != null
    && vSustainedPct >= 40 && iSustainedPct <= 8
    && breakerClosedMajority && groundPathExpected;

  return {
    kind, vLabel, iLabel,
    vSustained, vPeak, iSustained, iPeak,
    vPickupSec, iPickupSec, vPickupPrimary, iPickupPrimary,
    vRefIsPickup, iRefIsPickup,
    vSustainedPct, vPeakPct, iSustainedPct, iPeakPct,
    flagged, breakerClosedMajority, groundPathExpected,
  };
}


function detectVoltageLabelSet(P) {
  const chanNames = (P.analogChannels || []).map(c => c.replace(/\(.*\)/, '').trim().toUpperCase());
  if (chanNames.includes('VA') && chanNames.includes('VB') && chanNames.includes('VC')) {
    return ['VA', 'VB', 'VC'];
  }
  if (chanNames.includes('VAY') && chanNames.includes('VBY') && chanNames.includes('VCY')) {
    return ['VAY', 'VBY', 'VCY'];
  }
  if (chanNames.includes('VAZ') && chanNames.includes('VBZ') && chanNames.includes('VCZ')) {
    return ['VAZ', 'VBZ', 'VCZ'];
  }
  return ['VAY', 'VBY', 'VCY']; // fallback — data is normalized into these keys regardless
}

// Pull the unit suffix (A, V, kV) straight from the file's own column header rather
// than assuming one, since SEL-751 reports secondary Amps/Volts while SEL-651R/851
// commonly report primary kV for voltage and often no explicit unit for current.
function detectChannelUnit(P, baseNames, fallback) {
  for (const ch of (P.analogChannels || [])) {
    const clean = ch.replace(/\(.*\)/, '').trim().toUpperCase();
    if (baseNames.includes(clean)) {
      const m = ch.match(/\(([^)]+)\)/);
      if (m) return m[1];
    }
  }
  return fallback;
}

// Render a dark-themed, SynchroWAVe-style multi-trace SVG chart.
// traces: [{label, color, values:number[]}]   (all same length)
// opts: { msPerSample, yUnit, forceZeroBaseline, triggerIdx, tripIdx, height, width,
//         margin{Left,Right,Top,Bottom}, numHGrid, numVGrid, compact }
// IMPORTANT on sizing: SVG text/stroke sizes are defined in viewBox units, which scale
// with the ratio of the rendered container width to the viewBox width. A chart built at
// viewBox width 900 and then squeezed into a ~320px sidebar box would shrink all its text
// by the same ~0.35 ratio, making 10px labels render at an illegible ~3.5px. So `width`
// must be passed close to the actual rendered pixel width for any non-full-size usage
// (e.g. the compact banner charts use a ~320-wide viewBox to match their ~320px box).
