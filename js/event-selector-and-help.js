
function renderEventSelector() {
  const sel = document.getElementById('eventSelector');
  if (ALL_EVENTS.length <= 1) { sel.style.display = 'none'; return; }
  sel.style.display = 'block';

  const firstTs = getTimestampMs(ALL_EVENTS[0].parsed.timestamp);

  const buttons = ALL_EVENTS.map((evt, i) => {
    const ts = evt.parsed.timestamp;
    const evtType = evt.parsed.eventInfo.eventType || 'Event';
    const isTrip = /trip/i.test(evtType);
    const deltaMs = getTimestampMs(ts) - firstTs;
    const deltaStr = i === 0 ? '' : `+${deltaMs < 1000 ? deltaMs + 'ms' : deltaMs < 60000 ? (deltaMs / 1000).toFixed(1) + 's' : (deltaMs / 60000).toFixed(1) + 'm'}`;
    const timeStr = `${String(ts.hour).padStart(2, '0')}:${String(ts.min).padStart(2, '0')}:${String(ts.sec).padStart(2, '0')}.${ts.msec}`;
    const cause = evt.analysis?.tripCause?.causeText || '';
    return `<button class="evt-btn ${i === CURRENT_IDX ? 'active' : ''}" onclick="selectEvent(${i})">
      <span class="evt-type ${isTrip ? 'trip' : 'event'}">${i + 1}</span>
      <span>${evtType}</span>
      <span class="evt-time">${timeStr}</span>
      ${deltaStr ? `<span class="evt-delta">${deltaStr}</span>` : ''}
      ${cause ? `<span class="evt-cause">${cause}</span>` : ''}
    </button>`;
  }).join('');

  // Recurring-cause detection: the same resolved cause appearing more than once across this
  // loaded sequence is worth calling out — it's the difference between "one-off event" and
  // "an ongoing condition", which changes how it should be investigated.
  const causeCounts = {};
  ALL_EVENTS.forEach(evt => {
    const c = evt.analysis?.tripCause?.causeText;
    if (c) causeCounts[c] = (causeCounts[c] || 0) + 1;
  });
  const recurring = Object.entries(causeCounts).filter(([, n]) => n > 1);
  let patternNote = recurring.length
    ? `<div class="evt-pattern-note">🔁 ${recurring.map(([c, n]) => `"${c}" × ${n}`).join(' · ')} in this sequence — an ongoing condition, not an isolated event.</div>`
    : '';

  // Real fault current recurring at multiple reclose/re-energization points: some event types
  // are named by the phases + ground involved in what was detected (e.g. "BCG", "CAG") — that
  // naming itself, combined with genuinely elevated absolute current, is a reliable signal
  // independent of comparing against this specific event's own pre-fault window (which, right
  // at a reclose-into-fault, can itself already be mid-disturbance and not a clean baseline).
  // One instance could be coincidence; the same real-current signature recurring across
  // multiple, separately-named events is objective, stronger evidence of a persisting
  // condition on this circuit than any single event's signature offers alone.
  const realFaultEvents = ALL_EVENTS.filter(evt => {
    const cur = evt.analysis;
    const evtType = evt.parsed.eventInfo?.eventType || '';
    if (!/^[ABC]{1,2}G?$/.test(evtType) && !/^[ABC]{2}G$/.test(evtType)) return false;
    const maxI = Math.max(...['A', 'B', 'C'].map(p => cur?.currents?.[`I${p}`]?.fault?.secA || 0));
    return maxI > 20; // clearly fault-level current, not load — robust regardless of this event's own pre-fault baseline
  });
  if (realFaultEvents.length >= 2) {
    const types = realFaultEvents.map(e => e.parsed.eventInfo.eventType);
    patternNote += `<div class="evt-pattern-note">⚠ Real, elevated fault current recorded at ${realFaultEvents.length} separate reclose points in this sequence (${types.join(', ')})${new Set(types).size > 1 ? ' — different phases each time' : ''}. Recurring across independent attempts points to a persisting condition on this circuit.</div>`;
  }  sel.innerHTML = `<div style="display:flex;align-items:center;gap:4px;overflow-x:auto;white-space:nowrap;padding-bottom:2px;">
    <span style="font-size:11px;color:var(--text-muted);font-weight:600;flex-shrink:0;">EVENTS:</span>${buttons}
  </div>${patternNote}`;
}

function selectEvent(idx) {
  CURRENT_IDX = idx;
  PARSED = ALL_EVENTS[idx].parsed;
  ANALYSIS = ALL_EVENTS[idx].analysis;
  CHARTED_BIT = null;
  CHARTED_FILTER_RELEVANT = true;

  // Update header
  const ts = PARSED.timestamp;
  const devInfo = [PARSED.device, PARSED.settings?.RID?.trim?.(), PARSED.settings?.TID?.trim?.()].filter(Boolean).join(' — ');
  document.getElementById('topBarMeta').textContent =
    `${devInfo || PARSED.fileName} — Event #${PARSED.eventInfo.refNum} — ${PARSED.eventInfo.eventType}`;
  document.getElementById('topBarTimestamp').textContent = formatTimestamp(ts);
  const ratios =
    PARSED.format === 'form6'  ? ['Form6-TS COMTRADE'] :
    PARSED.format === 'sel851' ? [
      `CTR=${PARSED.ratios.CTP ?? '?'}`,
      `PTR=${PARSED.ratios.PTP ?? '?'}`,
      `VNOM=${PARSED.ratios.VNomKv ?? '?'}kV`,
    ] : [`CTR=${PARSED.settings.CTR || '?'}`];
  let vPriText = '', vPriTitle = '';
  // The 851 states its nominal system voltage directly as Sys.VNom, so the phase-to-neutral
  // figure needs none of the L-L/L-N inference the CEV path has to do.
  if (PARSED.format === 'sel851' && PARSED.ratios.VNomKv) {
    const vLn = (PARSED.ratios.VNomKv * 1000) / Math.sqrt(3);
    vPriText = `Nominal V(L-N) primary = ${(vLn / 1000).toFixed(2)} kV`;
    vPriTitle = `Sys.VNom is ${PARSED.ratios.VNomKv} kV phase-to-phase, so phase-to-neutral is ${vLn.toFixed(0)} V. This relay states its nominal voltage directly, so no inference is needed.`;
  }
  if (PARSED.format !== 'form6' && PARSED.format !== 'sel851') {
    if (PARSED.settings.PTRY) ratios.push(`PTR=${PARSED.settings.PTRY}`);
    if (PARSED.settings.VNOM) ratios.push(`VNOM=${PARSED.settings.VNOM}V`);
    // Expected phase-to-neutral primary voltage: VNOM (nominal secondary) x PTR — but VNOM
    // is NOT reliably phase-to-neutral. Some SEL files set it to the nominal phase-to-PHASE
    // secondary voltage instead (see the V_CANDIDATES / vRatio note in calibrateAnalogBasis,
    // which already has to solve exactly this ambiguity to calibrate magnitude scale). Naively
    // reporting VNOM x PTR as if it were always phase-to-neutral overstates it by sqrt(3) (73%)
    // on any file where the convention is actually phase-to-phase — confirmed on a real 751
    // PRIM_VAL=YES file where VNOM x PTR = 22,864 V but the file's own primary-referred VA/VB/VC
    // samples average ~13,200 V (22,864 / sqrt(3) = 13,201 V — a match, not a coincidence).
    // calibrateAnalogBasis() resolves this per-file, from the actual samples, and records it on
    // PARSED.vnomIsPhaseToPhase (true/false/null-if-undetermined); use that instead of assuming.
    const ptrForVnom = PARSED.settings.PTRY || PARSED.settings.PTRZ;
    if (PARSED.settings.VNOM && ptrForVnom) {
      const llFactor = PARSED.vnomIsPhaseToPhase === true ? Math.sqrt(3) : 1;
      const vPri = (PARSED.settings.VNOM * ptrForVnom) / llFactor;
      const vPriStr = vPri >= 1000 ? `${(vPri / 1000).toFixed(2)} kV` : `${vPri.toFixed(1)} V`;
      const inferredFromSibling = !!PARSED.vnomInferredFromSibling;
      const unresolved = PARSED.vnomIsPhaseToPhase == null;
      vPriText = `Expected V(L-N) primary ≈ ${vPriStr}${unresolved ? ' *' : inferredFromSibling ? ' †' : ''}`;
      vPriTitle = inferredFromSibling
        ? `Expected phase-to-neutral primary voltage ≈ ${PARSED.vnomIsPhaseToPhase ? '(VNOM ÷ sqrt(3)) × PTR' : 'VNOM × PTR'} = ${vPri.toFixed(1)} V (${vPriStr}). † This file's own pre-fault voltage samples could not confirm the VNOM L-L/L-N convention (e.g. bus was still de-energized or mid-recovery through most of the pre-fault window), so it was inferred from event ${PARSED.vnomInferredFromSibling} — the same relay, same CTR/PTR/VNOM settings. Cross-check against the measured voltage in the Voltages tab if this event's own energization looks incomplete.`
        : PARSED.vnomIsPhaseToPhase === true
        ? `Expected phase-to-neutral primary voltage ≈ (VNOM ÷ sqrt(3)) × PTR = (${PARSED.settings.VNOM} ÷ 1.732) × ${ptrForVnom} = ${vPri.toFixed(1)} V (${vPriStr}). This file's VNOM is nominal phase-to-PHASE secondary voltage (detected from its own VA/VB/VC samples vs VNOM × PTR), so the sqrt(3) is divided back out.`
        : unresolved
          ? `Expected phase-to-neutral primary voltage ≈ VNOM × PTR = ${PARSED.settings.VNOM} × ${ptrForVnom} = ${vPri.toFixed(1)} V (${vPriStr}). * Could not confirm from this file's own voltage samples whether VNOM is phase-to-neutral or phase-to-phase — assuming the more common phase-to-neutral convention. Treat this figure with caution and cross-check against the measured pre-fault voltage in the Voltages tab.`
          : `Expected phase-to-neutral primary voltage ≈ VNOM × PTR = ${PARSED.settings.VNOM} × ${ptrForVnom} = ${vPri.toFixed(1)} V (${vPriStr}). Confirmed from this file's own voltage samples that VNOM is already phase-to-neutral.`;
    }
  }
  document.getElementById('topBarRatios').textContent = ratios.join(' | ');
  const topBarVPriEl = document.getElementById('topBarVPri');
  topBarVPriEl.textContent = vPriText;
  topBarVPriEl.title = vPriTitle;

  // Update event selector active state
  document.querySelectorAll('.evt-btn').forEach((btn, i) => {
    btn.classList.toggle('active', i === idx);
  });

  // Render
  renderBanner();
  renderTabs();
  renderContent();
  // The Protection tab's initial values (baked into the HTML above) use a generic fault-window
  // instant since the precise trip-transition sample isn't resolved until analyzeCEV finishes —
  // re-sync now to the real trip instant (falls back to trigger/end-of-record if this event
  // has no resolved trip transition, e.g. an ER/non-trip record).
  if (typeof refreshProtectionTab === 'function') refreshProtectionTab(null);
}

// Filters the Event Timeline (panel-timeline) to only the bits relevant to the resolved trip.
// Operates on the already-rendered DOM (each row/bit was tagged with data-tl-relevant /
// data-tl-bit-relevant at render time) rather than re-rendering, so it's instant and doesn't
// disturb scroll position or any other tab's state.
function toggleTimelineTripFilter(checked) {
  document.querySelectorAll('#panel-timeline .tl-event').forEach(evt => {
    if (evt.classList.contains('tl-initial')) return; // orientation row — always visible
    evt.querySelectorAll('[data-tl-bit-relevant]').forEach(bit => {
      bit.style.display = (!checked || bit.dataset.tlBitRelevant === '1') ? '' : 'none';
    });
    const show = !checked || evt.dataset.tlRelevant === '1';
    evt.style.display = show ? '' : 'none';
  });
}

function toggleHelp(show, tab) {
  const el = document.getElementById('helpModal');
  if (el) el.style.display = show ? 'flex' : 'none';
  if (show && tab) setHelpTab(tab);
  // Only one overlay should ever be open at a time — otherwise opening this one from a link
  // inside the bit-detail popup leaves that popup stacked underneath, and closing back out to
  // the main view takes two separate dismiss clicks instead of one.
  if (show) {
    const bitModal = document.getElementById('bitModal');
    if (bitModal) bitModal.style.display = 'none';
  }
}

function setHelpTab(tab) {
  document.querySelectorAll('.help-tab').forEach(b => b.classList.toggle('active', b.dataset.helptab === tab));
  document.querySelectorAll('.help-tab-panel').forEach(p => p.classList.toggle('active', p.id === 'helptab-' + tab));
  const body = document.querySelector('#helpModal .help-modal-body');
  if (body) body.scrollTop = 0;
}

// Best-effort lookup of this bit's state in the currently loaded event: state at the trip
// instant if a trip has been resolved, otherwise the last known state anywhere in the record.
// When set (by the logic-chart timeline scrubber/playback), currentBitState reports each bit's
// state AS OF this digital-sample index, instead of its default "at the moment of the trip".
// null = default (trip moment). Set via setLogicChartViewIdx below.
let LLG_VIEW_SAMPLE_IDX = null;
function setLogicChartViewIdx(idx) { LLG_VIEW_SAMPLE_IDX = idx; }