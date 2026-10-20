// ══════════════════════════════════════════════════════════════════════
// TRIP MARGIN AND FAULT-SIGNATURE CHECK (CEV overcurrent trips)
// ══════════════════════════════════════════════════════════════════════
// Answers one question for an overcurrent trip: was the operating quantity well past pickup
// because of a fault, or did it sit near pickup with no fault in the record?
//
// Why this exists: an SEL-751 trip on ORED51T reads as "overcurrent" in the event summary, and
// the phase-current chart shows normal load. When the element that timed out is 51Q (3I2) or
// 51G/51N set low, the quantity that caused the trip is not on the phase-current chart at all,
// and the operator sees an overcurrent trip with no overcurrent. This module measures that
// quantity against its own pickup, looks for the signs a real fault leaves in the record, and
// lists what can make a no-fault trip happen. It does not rank those causes and it does not say
// what to do — the record alone cannot decide between them.
//
// Every number is read from series analyzeCEV already built (A.cursorData), so it agrees with
// the Protection tab and the relevant-quantity chart sample for sample.

const TRIP_MARGIN_LOW_MULTIPLE = 1.5;   // operating quantity below this × pickup = low margin
const FAULT_PHASE_RISE = 1.2;          // phase current rise inside the record that marks a fault
const FAULT_VOLTAGE_DIP = 0.10;        // phase-voltage dip (fraction) that marks a fault
const SEQ_QUANTITY_LABEL = { negSeq3I: '3I2', groundI: 'IG (3I0)', neutralI: 'IN', maxPhaseI: 'max phase current' };

function analyzeTripMargin(P, A) {
  const tc = A?.tripCause;
  const cd = A?.cursorData;
  if (!tc || !cd || !tc.immediateCause || tc.immediateCauseNegated) return null;
  const tripIdx = tc.tripTransition?.analogSampleIdx;
  if (tripIdx == null) return null;

  // Element and its protection row. 51QT → 51Q, 51P1T → 51P1, 50G1T → 50G1.
  const elMatch = String(tc.immediateCause).match(/^(5[01][A-Z]+\d*)T$/);
  if (!elMatch) return null;
  const el = elMatch[1];
  const row = (A.protectionRows || []).find(r => r.el === el);
  if (!row) return null;
  const series = cd.current[row.seriesKey];
  if (!series || !series.length) return null;

  const CTR = cd.CTR || 1;
  const toSec = v => (cd.iDataIsPrimary ? v / CTR : v);
  const cyc = P.eventInfo?.samPerCycA || 32;
  const n = series.length;
  const msPerSample = 1000 / ((P.eventInfo?.freq || 60) * cyc);
  const w0 = Math.min(cyc, Math.max(0, tripIdx - 1));     // first index with a full DFT window
  const pre = (arr) => arr.slice(w0, Math.max(w0 + 1, tripIdx + 1));
  const med = arr => { const s = arr.filter(isFinite).slice().sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

  const pickupSec = row.pickup;
  const opPre = pre(series).map(toSec);
  const atTripSec = toSec(Math.max(series[Math.max(0, tripIdx - 1)] || 0, series[tripIdx] || 0));
  const multipleAtTrip = pickupSec > 0 ? atTripSec / pickupSec : null;
  const multipleMin = pickupSec > 0 ? Math.min(...opPre) / pickupSec : null;
  const multipleMax = pickupSec > 0 ? Math.max(...opPre) / pickupSec : null;

  // Pickup bit: was the element already timing when the record began, and did it chatter?
  const pickupBit = typeof timedBitInputLabel === 'function' ? timedBitInputLabel(tc.immediateCause, P) : null;
  let pickupAtStart = false, pickupRises = 0, pickupFalls = 0;
  if (pickupBit) {
    pickupAtStart = (P.initialDigitalState || []).includes(pickupBit);
    for (const t of (P.digitalTransitions || [])) {
      if ((t.analogSampleIdx ?? 0) > tripIdx) break;
      const ch = (t.changes || []).find(c => c.label === pickupBit);
      if (ch) ch.asserted ? pickupRises++ : pickupFalls++;
    }
  }

  // Expected operate time at the measured multiple. Inverse-time: the curve. Definite-time: delay.
  let expectedOperateSec = null;
  if (row.family === '51' && typeof calcSelCurveTime === 'function' && multipleAtTrip > 1) {
    expectedOperateSec = calcSelCurveTime(row.curve, multipleAtTrip, row.td);
  } else if (row.family === '50') {
    expectedOperateSec = (row.delay || 0) / (cd.freq || 60);
  }
  const recordPreTripMs = tripIdx * msPerSample;

  // ── Fault signature inside the record ──
  const phaseI = cd.current.maxPhaseI || [];
  const phaseBase = med(phaseI.slice(w0, w0 + cyc));
  const phasePeakPre = Math.max(0, ...pre(phaseI));
  const phaseRise = phaseBase > 0 ? phasePeakPre / phaseBase : null;
  const phasePickups = (A.protectionRows || []).filter(r => r.seriesKey === 'maxPhaseI').map(r => r.pickup).filter(p => p > 0);
  const lowestPhasePickupSec = phasePickups.length ? Math.min(...phasePickups) : null;
  const phasePeakSec = toSec(phasePeakPre);
  const phaseFracOfPickup = lowestPhasePickupSec ? phasePeakSec / lowestPhasePickupSec : null;

  const vY = cd.voltage?.yTerminal;
  let voltageDip = null;
  if (vY && vY.minPhase) {
    const vBase = med(vY.minPhase.slice(w0, w0 + cyc));
    if (vBase > 0) voltageDip = 1 - Math.min(...pre(vY.minPhase)) / vBase;
  }
  const residualPeak = Math.max(0, ...pre(cd.current.groundI || []));
  const residualFrac = phasePeakPre > 0 ? residualPeak / phasePeakPre : null;

  const noFaultSignature = (phaseRise == null || phaseRise < FAULT_PHASE_RISE)
    && (voltageDip == null || voltageDip < FAULT_VOLTAGE_DIP)
    && (phaseFracOfPickup == null || phaseFracOfPickup < 1);

  // ── Sequence context (negative-sequence trips) ──
  // I2/I1 tells a phase swap or reversed CT (I2 near or above I1) from ordinary unbalance.
  // V2/V1 before and after the breaker opens tells whether the voltage unbalance needs current
  // through this breaker to exist.
  let seq = null;
  if (row.seriesKey === 'negSeq3I') {
    const d = P.analogData || [];
    const order = (a, b, c) => (typeof seqPhaseOrder === 'function' ? seqPhaseOrder(P, a, b, c) : [a, b, c]);
    const iA = d.map(r => r.IA), iB = d.map(r => r.IB), iC = d.map(r => r.IC);
    const i1 = computePosSeqMagnitude(...order(iA, iB, iC), cyc, cd.magScale || 1);
    const i2 = cd.current.negSeqI;
    const i2i1 = med(pre(i1)) > 0 ? med(pre(i2)) / med(pre(i1)) : null;
    seq = { i2i1 };
    if (vY && vY.neg && vY.pos) {
      const v2v1Pre = med(pre(vY.pos)) > 0 ? med(pre(vY.neg)) / med(pre(vY.pos)) : null;
      // Post-trip window: from one cycle after phase current falls below 10 % of its pre-trip peak.
      let openIdx = null;
      for (let i = tripIdx; i < n; i++) if (phaseI[i] < 0.1 * phasePeakPre) { openIdx = i; break; }
      let v2v1Post = null, v1PostRatio = null;
      if (openIdx != null && openIdx + cyc < n - cyc) {
        const post = arr => arr.slice(openIdx + cyc);
        const v1Pre = med(pre(vY.pos)), v1Post = med(post(vY.pos));
        v1PostRatio = v1Pre > 0 ? v1Post / v1Pre : null;
        if (v1Post > 0 && v1PostRatio > 0.5) v2v1Post = med(post(vY.neg)) / v1Post;
      }
      Object.assign(seq, { v2v1Pre, v2v1Post, v1PostRatio });
    }
  }

  const lowMargin = multipleAtTrip != null && multipleAtTrip < TRIP_MARGIN_LOW_MULTIPLE;
  const belowPickup = multipleAtTrip != null && multipleAtTrip < 0.9;

  return {
    element: el, timedBit: tc.immediateCause, viaAggregate: tc.viaAggregate || null,
    quantityLabel: SEQ_QUANTITY_LABEL[row.seriesKey] || row.seriesKey, seriesKey: row.seriesKey,
    curve: row.curve, td: row.td, family: row.family, tcExpr: row.tcExpr,
    pickupSec, pickupPri: pickupSec * CTR, CTR,
    atTripSec, atTripPri: atTripSec * CTR,
    multipleAtTrip, multipleMin, multipleMax,
    pickupBit, pickupAtStart, pickupRises, pickupFalls,
    expectedOperateSec, recordPreTripMs,
    fault: { phaseRise, voltageDip, phasePeakSec, lowestPhasePickupSec, phaseFracOfPickup, residualFrac },
    noFaultSignature, lowMargin, belowPickup, seq,
  };
}

// ── Flag text ──
// Written to ASD-STE100 / plain-language rules: short sentences, one instruction or fact each,
// active voice. Observations only — the list of possible errors is not ranked.
function tripMarginFlag(M) {
  if (!M) return null;
  const f2 = v => (v == null || !isFinite(v) ? '—' : v.toFixed(2));
  const pct = v => (v == null || !isFinite(v) ? '—' : (v * 100).toFixed(1) + ' %');
  const q = M.quantityLabel;

  if (M.belowPickup) {
    return {
      severity: 'medium',
      title: `${M.element} operated, but measured ${q} is below pickup (${f2(M.multipleAtTrip)}× pickup)`,
      detail: `The relay timed out ${M.timedBit}, but ${q} reads ${M.atTripSec.toFixed(3)} A sec at the trip against a ${M.pickupSec} A sec pickup. Check the CT ratio (CTR := ${M.CTR}), the active setting group, or event-data filtering.`,
    };
  }
  if (!M.noFaultSignature) return null;

  const timing = M.pickupAtStart
    ? `${M.pickupBit} was already picked up when the record started (${M.recordPreTripMs.toFixed(0)} ms before the trip), so it timed longer than the record shows.`
    : `${M.pickupBit || M.element} picked up inside the record.`;
  const chatter = M.pickupFalls > 0
    ? ` ${M.pickupBit} dropped out and picked up again ${M.pickupFalls} time(s) before the trip: ${q} sat at the threshold.`
    : '';
  const curve = (M.expectedOperateSec != null && isFinite(M.expectedOperateSec))
    ? ` Curve ${M.curve}, TD ${M.td} at ${f2(M.multipleAtTrip)}× pickup gives ~${M.expectedOperateSec.toFixed(1)} s to operate.`
    : '';

  const ev = [];
  ev.push(`Highest phase current rose ${f2(M.fault.phaseRise)}× before the trip${M.fault.lowestPhasePickupSec != null ? ` (${(M.fault.phaseFracOfPickup * 100).toFixed(0)} % of the lowest phase pickup)` : ''}.`);
  if (M.fault.voltageDip != null) ev.push(`Lowest phase voltage dipped ${pct(Math.max(0, M.fault.voltageDip))}.`);

  const errors = [];
  errors.push(`<b>Setting.</b> ${M.element} pickup (${M.pickupSec} A sec, ${M.pickupPri.toFixed(1)} A pri) is at or below normal ${q}; before the trip ${q} ran ${f2(M.multipleMin)}× to ${f2(M.multipleMax)}× pickup.`);
  if (M.seq && M.seq.i2i1 != null) {
    const wiring = M.seq.i2i1 < 0.5
      ? `I2/I1 = ${pct(M.seq.i2i1)} and residual is ${pct(M.fault.residualFrac)} of phase current: no sign of a phase swap or reversed CT.`
      : `I2/I1 = ${pct(M.seq.i2i1)}; a phase swap or reversed CT reads near or above 100 %.`;
    errors.push(`<b>Current measurement.</b> CT wiring, polarity or ratio error. ${wiring}`);
  } else {
    errors.push(`<b>Current measurement.</b> CT wiring, polarity or ratio error. Residual is ${pct(M.fault.residualFrac)} of phase current.`);
  }
  if (M.seq && M.seq.v2v1Pre != null) {
    let src = `<b>System unbalance.</b> V2/V1 was ${pct(M.seq.v2v1Pre)} before the trip`;
    if (M.seq.v2v1Post != null) {
      src += ` and ${pct(M.seq.v2v1Post)} after the breaker opened, so current through this breaker is not the source.`;
    } else {
      src += '; the record does not show voltage after the breaker opened.';
    }
    src += ' A bad PT input can also look like unbalance.';
    errors.push(src);
  }

  return {
    severity: 'high',
    title: `No fault in the record — ${M.element} tripped at ${f2(M.multipleAtTrip)}× pickup on ${q}${M.viaAggregate ? ` (through ${M.viaAggregate})` : ''}`,
    detail: `${q} was ${M.atTripSec.toFixed(3)} A sec (${M.atTripPri.toFixed(1)} A pri) at the trip; pickup is ${M.pickupSec} A sec. ${timing}${chatter}${curve}`
      + `<br><br>${ev.join(' ')} No fault signature: the relay followed its settings, but no fault explains the trip.`
      + `<br><br>Possible causes (unranked):<ul style="margin:6px 0 0 18px;padding:0;">${errors.map(e => `<li style="margin-bottom:4px;">${e}</li>`).join('')}</ul>`
      + `See the <b>${q}</b> chart in the banner.`,
  };
}
