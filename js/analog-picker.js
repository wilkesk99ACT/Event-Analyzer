
// ══════════════════════════════════════════════════════════════════════
// ANALOG QUANTITY PICKER + EXTRA ANALOG CHARTS
// ══════════════════════════════════════════════════════════════════════
// The Current / Voltage / relevant-quantity charts each show a fixed default set. That default is
// a conclusion about what matters; checking it means being able to overlay something the analysis
// did NOT pick — a sequence quantity on the phase-current chart, a phase-to-phase voltage next to
// the phase voltages, frequency on its own chart. This mirrors the "+ Add bit" picker on the flags
// chart (same dropdown CSS and floating-position helpers), but for analog quantities, and lists
// them ranked by relevance to this trip rather than alphabetically.
//
// EXTRA_ANALOG[kind] holds the catalog keys added to each chart, in the order added. The extra
// charts live in CUSTOM_CHART_IDS ('custom1', 'custom2', …) and sit between the relevant-quantity
// chart and the SV / Trip Chain Flags chart. Their ids are pushed into ZOOM_KINDS so zoom, cursor,
// A/B markers and playback all treat them exactly like the four built-in charts.
// Like EXTRA_FLAG_BITS, none of this survives loading a different event (renderBanner resets it):
// channel sets differ between files and a stale pick would silently draw nothing.
let EXTRA_ANALOG = {};
let CUSTOM_CHART_IDS = [];
let CUSTOM_CHART_SEQ = 0;

// Used when a quantity's own color is already taken on the chart it is being added to (e.g.
// VA.Mag's red on the current chart, where IA.Mag is already red).
const ANALOG_EXTRA_PALETTE = ['#f59e0b', '#a78bfa', '#ec4899', '#14b8a6', '#eab308', '#f97316', '#60a5fa', '#84cc16', '#e879f9', '#94a3b8'];

function resetAnalogPicks() {
  CUSTOM_CHART_IDS.forEach(id => {
    const i = ZOOM_KINDS.indexOf(id);
    if (i >= 0) ZOOM_KINDS.splice(i, 1);
    delete CHART_ZOOM[id]; delete CHART_GEOM[id];
  });
  EXTRA_ANALOG = {};
  CUSTOM_CHART_IDS = [];
}

// ── Catalog ─────────────────────────────────────────────────────────────
// Every analog quantity this record can produce, each computed the same way the built-in charts
// compute it (same RMS / one-cycle DFT helpers, same magScale), so a value added here always
// agrees with the same value shown anywhere else in the tool. Series are computed lazily and
// memoised — ranking needs them all once, after which picks are free.
let _ANALOG_CATALOG_CACHE = null;

function getAnalogCatalog(P, A) {
  if (_ANALOG_CATALOG_CACHE && _ANALOG_CATALOG_CACHE.P === P && _ANALOG_CATALOG_CACHE.A === A) return _ANALOG_CATALOG_CACHE.items;
  const data = P.analogData || [];
  const N = P.eventInfo.samPerCycA || 32;
  const MAGS = P.magScale || 1;
  const col = f => data.map(r => r[f]);
  const has = f => data.some(r => Math.abs(r[f] || 0) > 1e-6);
  const iUnit = detectChannelUnit(P, ['IA'], 'A');
  const vUnit = detectChannelUnit(P, ['VA', 'VAY', 'VB', 'VBY'], 'V');
  const vzUnit = detectChannelUnit(P, ['VAZ', 'VBZ'], vUnit);
  const vl = detectVoltageLabelSet(P);

  const items = [];
  // zeroBase: whether a chart made only of quantities like this one should start its y-axis at
  // zero. False for quantities that sit near a large nominal value (phase voltage, frequency),
  // where a zero baseline would flatten the very excursion being looked for.
  const add = (key, label, unit, group, color, zeroBase, compute) =>
    items.push({ key, label, unit, group, color, zeroBase, compute, _v: null });

  const hasI = has('IA') || has('IB') || has('IC');
  if (hasI) {
    add('IA', 'IA.Mag', iUnit, 'Phase current', '#ef4444', true, () => computeRmsMagnitude(col('IA'), N, MAGS));
    add('IB', 'IB.Mag', iUnit, 'Phase current', '#3b82f6', true, () => computeRmsMagnitude(col('IB'), N, MAGS));
    add('IC', 'IC.Mag', iUnit, 'Phase current', '#22c55e', true, () => computeRmsMagnitude(col('IC'), N, MAGS));
  }
  if (has('IN')) add('IN', 'IN.Mag', iUnit, 'Ground current', '#f59e0b', true, () => computeRmsMagnitude(col('IN'), N, MAGS));
  if (has('IG')) add('IG', 'IG.Mag', iUnit, 'Ground current', '#a78bfa', true, () => computeRmsMagnitude(col('IG'), N, MAGS));
  if (hasI) {
    add('3I0', '3I0.Mag', iUnit, 'Sequence current', '#f97316', true, () => computeZeroSeqMagnitude(col('IA'), col('IB'), col('IC'), N, MAGS));
    add('I1', 'I1.Mag', iUnit, 'Sequence current', '#14b8a6', true, () => computePosSeqMagnitude(...seqPhaseOrder(P, col('IA'), col('IB'), col('IC')), N, MAGS));
    // Same series the relevant chart and the Protection tab use for 50Q/51Q, so all three agree.
    add('3I2', '3I2.Mag', iUnit, 'Sequence current', '#a78bfa', true, () => A?.cursorData?.current?.negSeq3I
      || computeNegSeqMagnitude(...seqPhaseOrder(P, col('IA'), col('IB'), col('IC')), N, MAGS).map(v => 3 * v));
  }

  const hasV = has('VAY') || has('VBY') || has('VCY');
  if (hasV) {
    add('VA', `${vl[0]}.Mag`, vUnit, 'Phase voltage', '#ef4444', false, () => computeRmsMagnitude(col('VAY'), N, MAGS));
    add('VB', `${vl[1]}.Mag`, vUnit, 'Phase voltage', '#3b82f6', false, () => computeRmsMagnitude(col('VBY'), N, MAGS));
    add('VC', `${vl[2]}.Mag`, vUnit, 'Phase voltage', '#22c55e', false, () => computeRmsMagnitude(col('VCY'), N, MAGS));
    add('VAB', 'VAB.Mag', vUnit, 'Phase-to-phase voltage', '#ec4899', false, () => computePhaseDiffMagnitude(col('VAY'), col('VBY'), N, MAGS));
    add('VBC', 'VBC.Mag', vUnit, 'Phase-to-phase voltage', '#60a5fa', false, () => computePhaseDiffMagnitude(col('VBY'), col('VCY'), N, MAGS));
    add('VCA', 'VCA.Mag', vUnit, 'Phase-to-phase voltage', '#84cc16', false, () => computePhaseDiffMagnitude(col('VCY'), col('VAY'), N, MAGS));
    // Same method as the relevant chart's 3V0 trace (RMS of the instantaneous sum), so the two match.
    add('3V0', '3V0.Mag', vUnit, 'Sequence voltage', '#f59e0b', true, () => computeRmsMagnitude(data.map(r => (r.VAY || 0) + (r.VBY || 0) + (r.VCY || 0)), N, MAGS));
    add('V1', 'V1.Mag', vUnit, 'Sequence voltage', '#14b8a6', false, () => computePosSeqMagnitude(...seqPhaseOrder(P, col('VAY'), col('VBY'), col('VCY')), N, MAGS));
    add('V2', 'V2.Mag', vUnit, 'Sequence voltage', '#a78bfa', true, () => computeNegSeqMagnitude(...seqPhaseOrder(P, col('VAY'), col('VBY'), col('VCY')), N, MAGS));
  }
  if (has('VAZ') || has('VBZ') || has('VCZ')) {
    add('VAZ', 'VAZ.Mag', vzUnit, 'Phase voltage (Z)', '#f87171', false, () => computeRmsMagnitude(col('VAZ'), N, MAGS));
    add('VBZ', 'VBZ.Mag', vzUnit, 'Phase voltage (Z)', '#93c5fd', false, () => computeRmsMagnitude(col('VBZ'), N, MAGS));
    add('VCZ', 'VCZ.Mag', vzUnit, 'Phase voltage (Z)', '#86efac', false, () => computeRmsMagnitude(col('VCZ'), N, MAGS));
  }
  if (has('FREQ')) add('FREQ', 'FREQ', 'Hz', 'Frequency', '#22c55e', false, () => col('FREQ').map(v => v || 0));

  // Raw sample values, for looking at the waveform itself (offset, clipping, distortion).
  [['IA', iUnit, '#ef4444'], ['IB', iUnit, '#3b82f6'], ['IC', iUnit, '#22c55e'], ['IN', iUnit, '#f59e0b'], ['IG', iUnit, '#a78bfa'],
   ['VAY', vUnit, '#ef4444', vl[0]], ['VBY', vUnit, '#3b82f6', vl[1]], ['VCY', vUnit, '#22c55e', vl[2]],
   ['VAZ', vzUnit, '#f87171'], ['VBZ', vzUnit, '#93c5fd'], ['VCZ', vzUnit, '#86efac']].forEach(([f, unit, color, label]) => {
    if (has(f)) add('inst:' + f, `${label || f} (inst)`, unit, 'Instantaneous sample', color, true, () => data.map(r => (r[f] || 0) * MAGS));
  });

  _ANALOG_CATALOG_CACHE = { P, A, items, ranked: null };
  return items;
}

function analogSeries(item) {
  if (!item._v) item._v = item.compute();
  return item._v;
}

// ── Relevance ranking ───────────────────────────────────────────────────
// Two signals, in this order of weight:
//  1. Is it the operating quantity of an element in the resolved trip chain (or of the trip-margin
//     element / the trip-cause family)? Those go first, tagged "trip quantity".
//  2. How much did it move during the record, relative to its own pre-trigger level? A quantity
//     that sat still is rarely the one worth plotting.
// Raw instantaneous samples always swing through zero, so their "change" says nothing; they rank
// with a fixed penalty under their magnitude counterpart.
const ANALOG_FAMILY_KEYS = {
  zeroSeqV: ['3V0'], negSeqV: ['V2'], 'zeroSeqV+negSeqV': ['3V0', 'V2'],
  groundI: ['IN', 'IG', '3I0'], negSeqI: ['3I2'], freq: ['FREQ'],
};
// First match wins per label, so the specific patterns (PP, N/G, Q, V1) sit above the general ones.
const ANALOG_ELEMENT_RULES = [
  [/^(ORED)?5[01]Q|^46/, ['3I2']],
  [/^(ORED)?5[01]G/, ['IG', '3I0']],
  [/^(ORED)?5[01]N/, ['IN']],
  [/^(ORED)?5[01](P|[ABC]\d|PP)/, ['IA', 'IB', 'IC']],
  [/^(27|59)[YZ]?(PP|AB|BC|CA)/, ['VAB', 'VBC', 'VCA']],
  [/^59[YZ]?(N|G)/, ['3V0']],
  [/^59[YZ]?Q|^47/, ['V2']],
  [/^(27|59)[YZ]?V1/, ['V1']],
  [/^(27|59)Z/, ['VAZ', 'VBZ', 'VCZ']],
  [/^(27|59)Y?([ABC]|P)?\d/, ['VA', 'VB', 'VC']],
  [/^81/, ['FREQ']],
];

function analogTripKeys(A) {
  const keys = new Set(ANALOG_FAMILY_KEYS[A?.tripCause?.family] || []);
  const labels = (A?.tripCause?.causeChain || []).map(c => c.label);
  if (A?.tripMargin?.element) labels.push(A.tripMargin.element);
  labels.forEach(l => {
    const rule = ANALOG_ELEMENT_RULES.find(([re]) => re.test(l));
    if (rule) rule[1].forEach(k => keys.add(k));
  });
  return keys;
}

// Largest excursion from the pre-trigger median, as a fraction of that median (or of 5% of the
// series' peak, so a quantity that is normally near zero — 3V0, I2 — still scores sensibly).
// Capped at 10 (= 1000%). The first cycle is skipped: the one-cycle RMS/DFT window is still
// filling there, and its ramp up from zero would otherwise read as a 100% change on everything.
function analogChangeScore(vals, trigIdx, N) {
  const n = vals.length;
  const skip = Math.min(N, Math.floor(n / 4));
  if (n - skip < 2) return 0;
  const preEnd = trigIdx != null && trigIdx > skip + 1 ? trigIdx - Math.floor(N / 2) : Math.max(skip + 2, Math.floor(n / 4));
  const pre = vals.slice(skip, Math.max(skip + 1, preEnd)).filter(v => isFinite(v));
  const base = pre.length ? median(pre) : 0;
  let maxDev = 0, peak = 0;
  for (let i = skip; i < n; i++) {
    const v = vals[i];
    if (!isFinite(v)) continue;
    maxDev = Math.max(maxDev, Math.abs(v - base));
    peak = Math.max(peak, Math.abs(v));
  }
  const ref = Math.max(Math.abs(base), peak * 0.05, 1e-9);
  return Math.min(10, maxDev / ref);
}

function rankedAnalogCatalog(P, A) {
  const items = getAnalogCatalog(P, A);
  if (_ANALOG_CATALOG_CACHE.ranked) return _ANALOG_CATALOG_CACHE.ranked;
  const N = P.eventInfo.samPerCycA || 32;
  const trip = analogTripKeys(A);
  const ranked = items.map((it, order) => {
    const isInst = it.key.startsWith('inst:');
    const change = isInst ? 0 : analogChangeScore(analogSeries(it), P.triggerSampleIndex, N);
    const isTrip = !isInst && trip.has(it.key);
    // Log scale so a 900% change still outranks a 150% one without either swamping "trip quantity".
    const score = (isTrip ? 100 : 0) + 40 * Math.log10(1 + change) / Math.log10(11) - (isInst ? 30 : 0);
    return Object.assign(it, { trip: isTrip, change, score, order });
  }).sort((a, b) => (b.score - a.score) || (a.order - b.order));
  _ANALOG_CATALOG_CACHE.ranked = ranked;
  return ranked;
}

// What each built-in chart already draws, so the picker can mark those "already shown".
function defaultAnalogKeys(kind) {
  if (kind === 'current') return ['IA', 'IB', 'IC'];
  if (kind === 'voltage') return ['VA', 'VB', 'VC'];
  if (kind === 'relevant') {
    const fam = ANALYSIS?.tripCause?.family;
    return fam === 'groundI' ? ['IN', 'IG'] : (ANALOG_FAMILY_KEYS[fam] || []);
  }
  return [];
}

// ── Building traces ─────────────────────────────────────────────────────
// Appends the picked quantities for `kind` onto `traces` (mutates). A quantity whose unit differs
// from the chart's carries its unit in the legend label, and every added trace carries `unit` so
// the value readout box shows the right unit per row.
function appendExtraAnalogTraces(kind, traces, chartUnit) {
  const keys = EXTRA_ANALOG[kind] || [];
  if (!keys.length || !PARSED) return traces;
  const cat = getAnalogCatalog(PARSED, ANALYSIS);
  const used = new Set(traces.map(t => t.color));
  keys.forEach(k => {
    const it = cat.find(c => c.key === k);
    if (!it) return;
    let color = it.color;
    if (used.has(color)) color = ANALOG_EXTRA_PALETTE.find(c => !used.has(c)) || color;
    used.add(color);
    const label = chartUnit && it.unit !== chartUnit ? `${it.label} (${it.unit})` : it.label;
    traces.push({ label, color, unit: it.unit, zeroBase: it.zeroBase, values: analogSeries(it) });
  });
  return traces;
}

function buildCustomAnalogChart(P, A, id, compact, heightOverride) {
  const data = P.analogData || [];
  if (!data.length) return '';
  const samplesPerCycle = P.eventInfo.samPerCycA || 32;
  const msPerSample = 1000 / ((P.eventInfo.freq || 60) * samplesPerCycle);
  const tripIdxFull = A?.tripCause?.tripTransition?.analogSampleIdx ?? null;
  const triggerIdxFull = P.triggerSampleIndex ?? null;

  const traces = appendExtraAnalogTraces(id, [], null);
  const yUnit = [...new Set(traces.map(t => t.unit))].join(' / ');
  const forceZeroBaseline = traces.every(t => t.zeroBase);
  const title = `Analog Chart ${CUSTOM_CHART_IDS.indexOf(id) + 1}`;
  const removeBtn = SVFLAGS_HIDE_PICKER ? ''
    : ` <span class="zoom-badge" onclick="event.stopPropagation(); removeCustomAnalogChart('${id}');" title="Remove this chart">✕ remove chart</span>`;

  let svg;
  if (!traces.length) {
    delete CHART_GEOM[id]; // nothing to map a mouse position onto until something is plotted
    svg = `<p class="ana-empty">No quantities yet — use “+ Add quantity” below.</p>`;
  } else {
    const { slicedTraces, tripIdx, triggerIdx, cursorIdx, markAIdx, markBIdx, xOffsetMs } = sliceChartWindow(id, traces, tripIdxFull, triggerIdxFull, msPerSample, CHART_ZOOM[id]);
    svg = renderMagnitudeChartSVG(slicedTraces, {
      width: BANNER_CHART_WIDTH, height: heightOverride || 190,
      marginLeft: BANNER_CHART_MARGIN_LEFT, marginRight: BANNER_CHART_MARGIN_RIGHT,
      marginTop: 12, marginBottom: 22,
      numHGrid: 4, numVGrid: 8, fontSize: 12, msPerSample, yUnit,
      forceZeroBaseline, triggerIdx, tripIdx, cursorIdx, markAIdx, markBIdx, compact: true, bg: 'var(--card)', xOffsetMs,
    });
  }
  return `<div class="banner-mini-chart"><div class="banner-mini-chart-title">${title}${traces.length ? zoomHintHTML(id) : ''}${removeBtn}</div><div class="chart-svg-slot" id="chartSlot-${id}">${svg}</div>${analogPickerHTML(id)}</div>`;
}

// Wrapper placed between the relevant-quantity chart and the flags chart. The "+ Add analog chart"
// button lives at its bottom, so new charts always appear directly above the flags chart.
function buildCustomAnalogChartsHTML(P, A) {
  if (!P?.analogData?.length) return '';
  return `<div id="customAnalogCharts">${customAnalogChartsInnerHTML(P, A)}</div>`;
}
function customAnalogChartsInnerHTML(P, A) {
  const charts = CUSTOM_CHART_IDS.map(id => buildCustomAnalogChart(P, A, id, true)).join('');
  const addBar = SVFLAGS_HIDE_PICKER ? ''
    : `<div class="ana-add-chart-bar"><button type="button" class="ana-add-btn" onclick="event.stopPropagation(); addCustomAnalogChart();">+ Add analog chart</button></div>`;
  return charts + addBar;
}
// Rebuilds every extra chart. Used only when a chart is added or removed — picks within a chart go
// through rerenderZoomChart so an open dropdown is not destroyed mid-selection.
function refreshCustomAnalogCharts() {
  const box = document.getElementById('customAnalogCharts');
  if (!box || !PARSED || !ANALYSIS) return;
  if (OPEN_PICKER_DD && box.contains(OPEN_PICKER_DD)) closePickerDropdown(OPEN_PICKER_DD);
  box.innerHTML = customAnalogChartsInnerHTML(PARSED, ANALYSIS);
  CUSTOM_CHART_IDS.forEach(id => wireChartSlot(id));
}
function addCustomAnalogChart() {
  const id = 'custom' + (++CUSTOM_CHART_SEQ);
  CUSTOM_CHART_IDS.push(id);
  ZOOM_KINDS.push(id);
  CHART_ZOOM[id] = CHART_ZOOM.current || null; // all charts share one time window
  EXTRA_ANALOG[id] = [];
  refreshCustomAnalogCharts();
  toggleAnalogDropdown(id);
}
function removeCustomAnalogChart(id) {
  const i = CUSTOM_CHART_IDS.indexOf(id);
  if (i < 0) return;
  CUSTOM_CHART_IDS.splice(i, 1);
  const z = ZOOM_KINDS.indexOf(id);
  if (z >= 0) ZOOM_KINDS.splice(z, 1);
  delete CHART_ZOOM[id]; delete CHART_GEOM[id]; delete EXTRA_ANALOG[id];
  refreshCustomAnalogCharts();
}

// ── Picker UI ───────────────────────────────────────────────────────────
function analogPickerHTML(kind) {
  if (SVFLAGS_HIDE_PICKER || !PARSED) return '';
  return `<div class="svflags-bit-bar">
    <div class="timing-chip charted-bit-chip ana-add-chip">
      <button type="button" class="ana-add-btn" onclick="event.stopPropagation(); toggleAnalogDropdown('${kind}');">+ Add quantity ▾</button>
      <div class="charted-bit-dropdown ana-dropdown" id="anaDropdown-${kind}" style="display:none;">
        <input type="text" class="charted-bit-search" id="anaSearch-${kind}" placeholder="Search quantities…" oninput="renderAnalogOptions('${kind}', this.value)">
        <div class="ana-list-hint">Sorted by relevance to this event</div>
        <div class="charted-bit-list" id="anaList-${kind}"></div>
      </div>
    </div><span class="svflags-pins" id="anaPins-${kind}">${analogPinsHTML(kind)}</span>
  </div>`;
}
function analogPinsHTML(kind) {
  const keys = EXTRA_ANALOG[kind] || [];
  if (!keys.length || !PARSED) return '';
  const cat = getAnalogCatalog(PARSED, ANALYSIS);
  const chips = keys.map(k => {
    const label = (cat.find(c => c.key === k) || {}).label || k;
    return `<span class="svflags-pin" title="Click × to remove ${label} from the chart">${label}<button type="button" class="svflags-pin-x" onclick="event.stopPropagation(); toggleAnalogQuantity('${kind}', '${k}');">&times;</button></span>`;
  }).join('');
  const clearBtn = keys.length > 1
    ? `<button type="button" class="svflags-clear" onclick="event.stopPropagation(); clearAnalogQuantities('${kind}');">clear all</button>` : '';
  return chips + clearBtn;
}
function toggleAnalogDropdown(kind) {
  const dd = document.getElementById('anaDropdown-' + kind);
  if (!dd) return;
  if (dd.style.display !== 'none') { closePickerDropdown(dd); return; }
  renderAnalogOptions(kind, '');
  openPickerDropdown(dd);
  const search = document.getElementById('anaSearch-' + kind);
  if (search) { search.value = ''; search.focus(); }
}
// The unit the chart is already drawn in, so the list can flag quantities in a different one
// (they share the y-axis, and e.g. Hz on an amps chart is rarely readable).
function analogChartUnit(kind) {
  if (!PARSED) return null;
  if (kind === 'current') return detectChannelUnit(PARSED, ['IA'], 'A');
  if (kind === 'voltage') return detectChannelUnit(PARSED, ['VA', 'VAY', 'VB', 'VBY'], 'V');
  const keys = kind === 'relevant' ? defaultAnalogKeys(kind) : (EXTRA_ANALOG[kind] || []);
  const first = getAnalogCatalog(PARSED, ANALYSIS).find(c => c.key === keys[0]);
  return first ? first.unit : null;
}
function renderAnalogOptions(kind, filterText) {
  const list = document.getElementById('anaList-' + kind);
  if (!list || !PARSED) return;
  const ranked = rankedAnalogCatalog(PARSED, ANALYSIS);
  const q = (filterText || '').trim().toUpperCase();
  const filtered = q ? ranked.filter(it => (it.label + ' ' + it.key + ' ' + it.group).toUpperCase().includes(q)) : ranked;
  const picked = EXTRA_ANALOG[kind] || [];
  const defaults = new Set(defaultAnalogKeys(kind));
  const chartUnit = analogChartUnit(kind);
  list.innerHTML = filtered.map(it => {
    const on = picked.includes(it.key);
    const auto = !on && defaults.has(it.key);
    const notes = [];
    if (it.trip) notes.push(`<span class="ana-tag ana-tag-trip">trip quantity</span>`);
    else if (it.change >= 0.1) notes.push(`<span class="ana-tag">${it.change >= 10 ? '>999' : Math.round(it.change * 100)}% change</span>`);
    if (auto) notes.push(`<span class="svflags-opt-note">already shown</span>`);
    else if (chartUnit && it.unit !== chartUnit) notes.push(`<span class="svflags-opt-note">${it.unit}</span>`);
    // stopPropagation: picking re-renders this list and detaches the clicked node, which would
    // otherwise make the document-level outside-click handler close the panel after every pick.
    return `<div class="charted-bit-option ${on ? 'pinned' : ''} ${auto ? 'dimmed' : ''}" title="${it.group}" onclick="event.stopPropagation(); toggleAnalogQuantity('${kind}', '${it.key}')">${on ? '&#10003; ' : ''}${it.label} ${notes.join(' ')}</div>`;
  }).join('') || `<div class="charted-bit-option-empty">No matching quantities</div>`;
}
function refreshAnalogChart(kind) {
  rerenderZoomChart(kind);
  const pins = document.getElementById('anaPins-' + kind);
  if (pins) pins.innerHTML = analogPinsHTML(kind);
  const search = document.getElementById('anaSearch-' + kind);
  renderAnalogOptions(kind, search ? search.value : '');
  positionPickerDropdown(OPEN_PICKER_DD);
}
function toggleAnalogQuantity(kind, key) {
  if (defaultAnalogKeys(kind).includes(key)) return; // already drawn by the chart itself
  const list = EXTRA_ANALOG[kind] || (EXTRA_ANALOG[kind] = []);
  const i = list.indexOf(key);
  if (i >= 0) list.splice(i, 1); else list.push(key);
  refreshAnalogChart(kind);
}
function clearAnalogQuantities(kind) {
  if (!(EXTRA_ANALOG[kind] || []).length) return;
  EXTRA_ANALOG[kind] = [];
  refreshAnalogChart(kind);
}

// Close an open quantity picker when clicking anywhere outside its chip (same rule as the bit
// pickers in logic-tree-panel.js).
document.addEventListener('click', (e) => {
  const dd = OPEN_PICKER_DD;
  if (!dd || !dd.classList.contains('ana-dropdown')) return;
  const chip = dd.closest('.ana-add-chip');
  if (chip && !chip.contains(e.target)) closePickerDropdown(dd);
});
