// ══════════════════════════════════════════════════════════════════════
// TRIP MEASUREMENTS — the measured values a trip record keeps
// ══════════════════════════════════════════════════════════════════════
// Site Notes keeps the cause of each trip but not the waveforms. This reduces an event to the
// few numbers worth keeping with it: each phase current, the residual and sequence quantities,
// each phase voltage and the frequency, at the trip instant and at their highest (and, for
// voltage and frequency, lowest) in the record. When the cause resolves to a protection element
// with a pickup, the operating quantity is kept against that pickup too.
//
// Site Notes carries an unchanged copy of this file, so a trip recorded there and the same
// event open here report the same numbers.
//
// Every series is read from what the analysis already built (A.cursorData for a CEV,
// A.quantities for an SEL-851), so the figures agree with the Protection tab sample for sample.
// Currents are primary amps and voltages primary kV. The operating quantity is also given in
// secondary units, because that is what its pickup is set in.
//
// Windows: the first cycle of the record has no full DFT window behind it and is skipped. Highs
// are taken over the rest of the record. Lows stop at the trip: after the breaker opens a
// line-side voltage can fall to zero, and that is not what tripped it.

const TRIP_MEAS_VERSION = 1;

function tripMeasRound(v) {
  if (v == null || !isFinite(v)) return null;
  const a = Math.abs(v);
  const d = a >= 100 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : 4;
  return Math.round(v * 10 ** d) / 10 ** d;
}

// One series reduced to {trip, max, maxMs[, min, minMs]}. Times are ms from the trip.
function tripMeasReduce(series, conv, tripIdx, w0, msPerSample, withMin) {
  if (!series || !series.length) return null;
  const n = series.length;
  const ti = Math.max(0, Math.min(n - 1, tripIdx));
  // The trip sample and the one before it: a DFT magnitude can step down on the very sample the
  // breaker opens, and the value that tripped it is the one leading up to that.
  const tripRaw = Math.max(series[Math.max(0, ti - 1)] || 0, series[ti] || 0);
  let maxI = w0, minI = w0;
  for (let i = w0; i < n; i++) if ((series[i] || 0) > (series[maxI] || 0)) maxI = i;
  for (let i = w0; i <= ti; i++) if ((series[i] || 0) < (series[minI] || 0)) minI = i;
  const out = {
    trip: tripMeasRound(conv(tripRaw)),
    max: tripMeasRound(conv(series[maxI] || 0)),
    maxMs: Math.round((maxI - ti) * msPerSample * 10) / 10,
  };
  if (withMin) {
    out.min = tripMeasRound(conv(series[minI] || 0));
    out.minMs = Math.round((minI - ti) * msPerSample * 10) / 10;
  }
  return out;
}

function tripMeasHasChannel(P, key) {
  const d = P.analogData || [];
  return d.length > 0 && d.some(r => r[key] != null && r[key] !== 0);
}

// The protection row behind the cause: the immediate cause first, then the cause chain from the
// trip back, then the bits that were asserted at the leaves of the logic tree (a trip through
// SV logic names only SVs in its chain; the 27P2 that started it sits inside SV09's equation).
// 51QT → 51Q, 27P1T → 27P1, 27YA1 → 27YA1.
function tripMeasTreeLeaves(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (node.op === 'VAR' && node.value === true && node.name) out.push(node.name);
  if (node.child) tripMeasTreeLeaves(node.child, out);
  for (const c of (node.children || [])) tripMeasTreeLeaves(c, out);
  return out;
}
function tripMeasCauseRow(A) {
  const tc = A.tripCause || {};
  const labels = [tc.immediateCause, ...(tc.causeChain || []).map(c => c.label).reverse(),
    ...tripMeasTreeLeaves(tc.logicTree, [])].filter(Boolean);
  for (const lab of labels) {
    const base = String(lab).replace(/[PT]$/, '');
    const oc = (A.protectionRows || []).find(r => r.el === base || r.el === lab);
    if (oc) return { oc, label: lab };
    const v = (A.voltageRows || []).find(r => r.element === base || r.element === lab);
    if (v) return { v, label: lab };
  }
  return null;
}

// CEV events (SEL-751, SEL-651R and the like). Returns null when the record has no analog data.
function tripMeasurementsCev(P, A) {
  const cd = A && A.cursorData;
  if (!cd || !cd.length || !(P.analogData || []).length) return null;
  const tc = A.tripCause || {};
  const n = cd.length;
  const cyc = P.eventInfo.samPerCycA || 32;
  const freq = cd.freq || P.eventInfo.freq || 60;
  const msPerSample = 1000 / (freq * cyc);
  let tripIdx = tc.tripTransition && tc.tripTransition.analogSampleIdx;
  const atTrip = tripIdx != null;
  if (tripIdx == null) tripIdx = P.triggerSampleIndex > 0 ? P.triggerSampleIndex : n - 1;
  const w0 = Math.min(cyc, Math.max(0, n - 1));

  const CTR = cd.CTR || 1;
  const iPri = v => (cd.iDataIsPrimary ? v : v * CTR);
  const iSec = v => (cd.iDataIsPrimary ? v / CTR : v);
  const vPriKv = ptr => raw => rawToSecondaryV(cd, raw, ptr) * ptr / 1000;
  const vSec = ptr => raw => rawToSecondaryV(cd, raw, ptr);
  const red = (s, conv, withMin) => tripMeasReduce(s, conv, tripIdx, w0, msPerSample, withMin);

  const q = {};
  const MAGS = cd.magScale || 1;
  for (const ph of ['IA', 'IB', 'IC']) {
    if (!tripMeasHasChannel(P, ph)) continue;
    q[ph] = red(computeRmsMagnitude(P.analogData.map(r => r[ph]), cyc, MAGS), iPri, false);
  }
  if (tripMeasHasChannel(P, 'IG')) q.IG = red(cd.current.groundI, iPri, false);
  if (tripMeasHasChannel(P, 'IN')) q.IN = red(cd.current.neutralI, iPri, false);
  if (q.IA && q.IB && q.IC) q['3I2'] = red(cd.current.negSeq3I, iPri, false);

  const vY = cd.voltage && cd.voltage.yTerminal;
  const yHas = ['VAY', 'VBY', 'VCY', 'VA', 'VB', 'VC'].some(k => tripMeasHasChannel(P, k));
  if (vY && yHas) {
    const conv = vPriKv(cd.PTRY || 1);
    for (const ph of ['A', 'B', 'C']) q['V' + ph] = red(vY[ph], conv, true);
    q['3V0'] = red(vY.zero, conv, false);
    q.V2 = red(vY.neg, conv, false);
  }
  if (tripMeasHasChannel(P, 'FREQ')) {
    q.FREQ = red(P.analogData.map(r => r.FREQ), v => v, true);
  }

  let op = null;
  const hit = tripMeasCauseRow(A);
  if (hit && hit.oc) {
    const s = cd.current[hit.oc.seriesKey];
    const r = red(s, iSec, false);
    if (r) op = {
      element: hit.oc.el, bit: hit.label, kind: 'max', quantity: TRIP_MEAS_OC_QTY[hit.oc.seriesKey] || hit.oc.seriesKey,
      unit: 'A sec', pickup: hit.oc.pickup, trip: r.trip, peak: r.max, peakMs: r.maxMs,
      ratio: CTR, priUnit: 'A pri',
    };
  } else if (hit && hit.v) {
    const row = hit.v;
    const ptr = (row.term === 'Y' ? cd.PTRY : cd.PTRZ) || 1;
    const term = cd.voltage[row.term === 'Y' ? 'yTerminal' : 'zTerminal'];
    const s = term && term[row.kind];
    const under = row.type === 'UV';
    const r = red(s, vSec(ptr), under);
    if (r) op = {
      element: row.element, bit: hit.label, kind: under ? 'min' : 'max',
      quantity: TRIP_MEAS_V_QTY[row.kind] || row.kind, unit: 'V sec', pickup: row.pickup,
      trip: r.trip, peak: under ? r.min : r.max, peakMs: under ? r.minMs : r.maxMs,
      ratio: ptr, priUnit: 'V pri',
    };
  }
  if (op && op.pickup > 0) {
    op.multTrip = tripMeasRound(op.trip / op.pickup);
    op.multPeak = tripMeasRound(op.peak / op.pickup);
  }

  return { v: TRIP_MEAS_VERSION, atTrip, q, op };
}

const TRIP_MEAS_OC_QTY = { maxPhaseI: 'highest phase current', groundI: 'IG', neutralI: 'IN', negSeq3I: '3I2' };
const TRIP_MEAS_V_QTY = {
  A: 'VA', B: 'VB', C: 'VC', ab: 'VAB', bc: 'VBC', ca: 'VCA',
  minPhase: 'lowest phase voltage', maxPhase: 'highest phase voltage',
  minPP: 'lowest phase-to-phase voltage', maxPP: 'highest phase-to-phase voltage',
  zero: '3V0', neg: 'V2', pos: 'V1',
};

// SEL-851 events. A.quantities is in secondary units; the ratios bring it to primary.
function tripMeasurements851(P, A) {
  const Q = A && A.quantities;
  if (!Q || !(P.analogData || []).length) return null;
  const n = P.analogData.length;
  const cyc = P.eventInfo.samPerCycA || 16;
  const msPerSample = P.msPerSample || 1000 / ((P.eventInfo.freq || 60) * cyc);
  let tripIdx = A.tripIdx;
  const atTrip = tripIdx != null;
  if (tripIdx == null) tripIdx = n - 1;
  const w0 = Math.min(cyc, Math.max(0, n - 1));
  const CTR = A.CTR || 1, CTN = A.CTN || CTR, PTR = A.PTR || 1;
  const red = (s, conv, withMin) => tripMeasReduce(s, conv, tripIdx, w0, msPerSample, withMin);
  const iPri = v => v * CTR, vPriKv = v => v * PTR / 1000;

  const q = {};
  if (Q._ia) { q.IA = red(Q._ia, iPri); q.IB = red(Q._ib, iPri); q.IC = red(Q._ic, iPri); }
  if (Q.iGnd) q.IG = red(Q.iGnd, iPri);
  if (Q.iN) q.IN = red(Q.iN, v => v * CTN);
  if (Q.i3i2) q['3I2'] = red(Q.i3i2, iPri);
  if (Q._va) {
    q.VA = red(Q._va, vPriKv, true); q.VB = red(Q._vb, vPriKv, true); q.VC = red(Q._vc, vPriKv, true);
  }
  if (Q.v3v0) q['3V0'] = red(Q.v3v0, vPriKv);
  if (Q.freq) q.FREQ = red(Q.freq, v => v, true);

  // The 851 check already names the element and the quantity it compares; keep that one.
  let op = null;
  const tc = A.tripCause || {};
  const el = (A.elements || []).find(e => e.element === tc.element && e.evaluated) || null;
  const qty = el && el.qtyName;
  if (el && qty && Q[qty] && el.pickup > 0) {
    const under = el.dir === 'below';
    const r = red(Q[qty], v => v, under);
    if (r) op = {
      element: el.element, bit: el.bit || el.element, kind: under ? 'min' : 'max',
      quantity: el.qtyDesc || qty, unit: el.qtyUnit || '', pickup: el.pickup,
      trip: r.trip, peak: under ? r.min : r.max, peakMs: under ? r.minMs : r.maxMs,
      multTrip: tripMeasRound(r.trip / el.pickup), multPeak: tripMeasRound((under ? r.min : r.max) / el.pickup),
    };
  }
  return { v: TRIP_MEAS_VERSION, atTrip, q, op };
}

function tripMeasurements(P, A) {
  try {
    if (!P || !A) return null;
    return P.format === 'sel851' ? tripMeasurements851(P, A) : tripMeasurementsCev(P, A);
  } catch (e) {
    console.warn('trip measurements failed', e);
    return null;
  }
}

// A table of the kept values, for the trip history in either tool. esc is the caller's escaper.
function tripMeasHTML(m, esc) {
  if (!m || !m.q) return '';
  const f = v => (v == null ? '—' : String(v));
  const t = ms => (ms == null ? '' : ` <span class="tm-when">${ms > 0 ? '+' : ''}${ms} ms</span>`);
  const rows = [];
  const unit = k => (k === 'FREQ' ? 'Hz' : /^V|3V0/.test(k) ? 'kV' : 'A');
  for (const [k, r] of Object.entries(m.q)) {
    if (!r) continue;
    rows.push(`<tr><td>${esc(k)}</td><td>${f(r.trip)}</td><td>${f(r.max)}${t(r.maxMs)}</td>` +
      `<td>${r.min != null ? f(r.min) + t(r.minMs) : ''}</td><td>${unit(k)}</td></tr>`);
  }
  let op = '';
  if (m.op) {
    const o = m.op;
    op = `<div class="tm-op"><b>${esc(o.element)}</b> on ${esc(o.quantity)}: ` +
      `${f(o.trip)} ${esc(o.unit)} at the trip${o.multTrip != null ? ` (${o.multTrip}× pickup)` : ''}, ` +
      `${o.kind === 'min' ? 'lowest' : 'highest'} ${f(o.peak)} ${esc(o.unit)}${o.multPeak != null ? ` (${o.multPeak}×)` : ''}${t(o.peakMs)}. ` +
      `Pickup ${f(o.pickup)} ${esc(o.unit)}.</div>`;
  }
  return `${op}<table class="tm-table"><thead><tr><th></th><th>At the trip</th><th>Highest</th><th>Lowest before the trip</th><th></th></tr></thead>` +
    `<tbody>${rows.join('')}</tbody></table>` +
    (m.atTrip ? '' : `<div class="tm-note">No trip instant was found in this record; "at the trip" is the trigger.</div>`) +
    `<div class="tm-note">Primary values. Times are from the trip.</div>`;
}

// ══════════════════════════════════════════════════════════════════════
// TRIP TREND CHARTS — the same element across a site's trips
// ══════════════════════════════════════════════════════════════════════
// Small charts of trips' measured values, oldest to newest. Drawn beside the measured value in
// the analyzer (measured-panel.js) and in the Trip history section of Site Notes. Each page
// styles the classes (mp-*) to its own theme.

function mpFmt(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  return a >= 1000 ? v.toFixed(0) : a >= 100 ? v.toFixed(1) : a >= 10 ? v.toFixed(2) : v.toFixed(3);
}
function mpEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// "IN" alone does not say what was measured; spell the short codes out.
const MP_QTY_NAME = {
  IN: 'neutral current (IN)', IG: 'ground current (IG)', '3I2': 'negative-sequence current (3I2)',
  '3V0': 'zero-sequence voltage (3V0)', V2: 'negative-sequence voltage (V2)', V1: 'positive-sequence voltage (V1)',
  VA: 'phase A voltage', VB: 'phase B voltage', VC: 'phase C voltage',
  VAB: 'A-B voltage', VBC: 'B-C voltage', VCA: 'C-A voltage',
};
function mpQtyName(q) { return MP_QTY_NAME[q] || q || ''; }

// ── Past trips at the site, as small charts ──
// One chart per quantity, all over the same trips (same element as this one), so a point in one
// lines up with the point above or beside it in the others:
//   * the tripping element's own measured value, against its pickup (always first)
//   * phase voltage and phase current at the trip and at their extreme in the record, unless
//     the element's own value already is that quantity
// Voltage and current are primary (kV, A), as Site Notes keeps them; the element's value is in
// the units of its pickup.

const MP_LOW = 'lowest', MP_HIGH = 'highest';

// What one chart plots from a trip's measured values (t.meas). Returns {trip, ext} or null.
function mpOpSeries(m) { return m && m.op ? { trip: m.op.trip, ext: m.op.peak } : null; }
function mpPhaseSeries(keys, useMax) {
  return m => {
    const q = m && m.q;
    if (!q) return null;
    const ph = keys.map(k => q[k]).filter(Boolean);
    if (!ph.length) return null;
    const pick = (arr) => { const a = arr.filter(v => v != null && isFinite(v)); return a.length ? (useMax ? Math.max(...a) : Math.min(...a)) : null; };
    return { trip: pick(ph.map(p => p.trip)), ext: pick(ph.map(p => useMax ? p.max : (p.min != null ? p.min : p.max))) };
  };
}

// Is the element's own value plain phase voltage, or plain phase current?
function mpOpIsPhaseV(op) { return /^(lowest|highest) phase voltage$|^V[ABC]$/i.test(op.quantity || ''); }
function mpOpIsPhaseI(op) { return /^(highest phase current|I[ABC]|max phase current)$/i.test(op.quantity || '') || /highest of IA, IB and IC/i.test(op.quantity || ''); }

function mpCharts(op) {
  const under = op.kind === 'min';
  const out = [{
    title: `${op.element} · ${mpQtyName(op.quantity)}`, unit: op.unit, pickup: op.pickup, ext: under ? MP_LOW : MP_HIGH,
    get: mpOpSeries, main: true,
  }];
  // Voltage: the side that matters for this trip. An overvoltage trip looks at the highest phase;
  // everything else (undervoltage, overcurrent, frequency) at the lowest, where a fault shows.
  const vHigh = !under && /voltage|^V|3V0|V[12]\b/i.test(op.quantity || '');
  if (!mpOpIsPhaseV(op))
    out.push({ title: `${vHigh ? 'Highest' : 'Lowest'} phase voltage`, unit: 'kV pri', ext: vHigh ? MP_HIGH : MP_LOW,
      get: mpPhaseSeries(['VA', 'VB', 'VC'], vHigh) });
  if (!mpOpIsPhaseI(op))
    out.push({ title: 'Highest phase current', unit: 'A pri', ext: MP_HIGH,
      get: mpPhaseSeries(['IA', 'IB', 'IC'], true) });
  return out;
}

// One small chart: title with its unit, value at the trip (solid, filled dots) and the extreme
// in the record (dashed, open dots), the pickup if it has one, and the event on screen labelled.
// size: {W, H} of the plot (default 236 × 70). legend: false leaves the per-chart key out, for a
// row of charts that shares one key (mpLegendHTML).
function mpChartHTML(c, trips, size, legend) {
  const pts = trips.map(t => Object.assign({ at: t.at, cur: t.cur, cause: t.cause }, c.get(t.m) || {}));
  if (pts.filter(p => p.trip != null || p.ext != null).length < 2) return '';
  const W = (size && size.W) || 236, H = (size && size.H) || 70, L = 32, R = 38, T = 6, B = 6;
  const vals = [];
  for (const p of pts) for (const v of [p.trip, p.ext]) if (v != null && isFinite(v)) vals.push(v);
  if (c.pickup != null && isFinite(c.pickup)) vals.push(c.pickup);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.1;
  lo = vals.every(v => v >= 0) ? Math.max(0, lo - pad) : lo - pad;   // magnitudes never go below zero
  hi += pad;
  const n = pts.length;
  const x = i => n === 1 ? L + (W - L - R) / 2 : L + i * (W - L - R) / (n - 1);
  const y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const ok = v => v != null && isFinite(v);
  const line = key => pts.map((p, i) => ok(p[key]) ? `${i && ok(pts[i - 1][key]) ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}` : '').join('');
  const tip = p => `${(p.at || '').slice(0, 16)}${p.cur ? ' — this event' : ''}\nAt the trip: ${mpFmt(p.trip)} ${c.unit}\n${c.ext === MP_LOW ? 'Lowest' : 'Highest'} in record: ${mpFmt(p.ext)} ${c.unit}${p.cause ? '\n' + p.cause : ''}`;
  const dots = (key, cls) => pts.map((p, i) => !ok(p[key]) ? '' :
    `<circle class="${cls}${p.cur ? ' mp-cur' : ''}" cx="${x(i).toFixed(1)}" cy="${y(p[key]).toFixed(1)}" r="${p.cur ? 3.6 : 2.5}"><title>${mpEsc(tip(p))}</title></circle>`).join('');
  const pk = ok(c.pickup)
    ? `<line class="mp-pk" x1="${L}" x2="${W - R}" y1="${y(c.pickup).toFixed(1)}" y2="${y(c.pickup).toFixed(1)}"/>
       <text class="mp-pkt" x="${W - R + 4}" y="${(y(c.pickup) + 3).toFixed(1)}">pickup</text>` : '';
  // the event on screen, labelled with its value at the trip
  const ci = pts.findIndex(p => p.cur);
  const curLbl = ci >= 0 && ok(pts[ci].trip)
    ? `<text class="mp-curt" x="${(x(ci) + 6).toFixed(1)}" y="${(y(pts[ci].trip) + 3).toFixed(1)}">${mpFmt(pts[ci].trip)}</text>` : '';
  const first = (pts[0].at || '').slice(0, 7), last = (pts[n - 1].at || '').slice(0, 7);
  return `<figure class="mp-chart${c.main ? ' main' : ''}">
    <figcaption><b>${mpEsc(c.title)}</b> <span>${mpEsc(c.unit)}</span></figcaption>
    <svg class="mp-spark" viewBox="0 0 ${W} ${H + 12}" width="${W}" height="${H + 12}" role="img"
        aria-label="${mpEsc(c.title)} in ${mpEsc(c.unit)}, at the trip and ${c.ext} in the record, over ${n} trips">
      <text class="mp-ax" x="${L - 4}" y="${T + 7}" text-anchor="end">${mpFmt(hi)}</text>
      <text class="mp-ax" x="${L - 4}" y="${H - B}" text-anchor="end">${mpFmt(lo)}</text>
      <line class="mp-base" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>
      ${pk}
      <path class="mp-lpeak" d="${line('ext')}"/>
      <path class="mp-ltrip" d="${line('trip')}"/>
      ${dots('ext', 'mp-dpeak')}${dots('trip', 'mp-dtrip')}
      ${curLbl}
      <text class="mp-ax" x="${L}" y="${H + 10}">${mpEsc(first)}</text>
      <text class="mp-ax" x="${W - R}" y="${H + 10}" text-anchor="end">${mpEsc(last)}</text>
    </svg>
    ${legend === false ? '' : mpLegendHTML(c.ext, ok(c.pickup), ci >= 0)}
  </figure>`;
}

// The key: solid line at the trip, dashed the extreme, the pickup, and the event on screen.
function mpLegendHTML(ext, pickup, cur) {
  return `<div class="mp-legend"><i class="mp-lt"></i>at the trip <i class="mp-lp"></i>${ext || 'lowest / highest'} in record` +
    `${pickup ? ' <i class="mp-lk"></i>pickup' : ''}${cur ? ' <i class="mp-lc"></i>this event' : ''}</div>`;
}

