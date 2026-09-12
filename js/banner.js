
function renderBanner() {
  if (PARSED.format === 'form6') { renderForm6Banner(); return; }
  const el = document.getElementById('tripBanner');
  const cause = ANALYSIS.tripCause;
  EXTRA_FLAG_BITS = [];
  resetChartZoom(); // a freshly (re)loaded event has a different sample range — don't carry over a stale zoom window from whatever was previously displayed

  // ── DEBUG PANEL — shows parsing diagnostics ──
  const D = PARSED._debug || {};
  let debugHTML = `<div id="debugPanel" style="background:#0a0e17;border:1px solid #2d1b00;border-radius:8px;padding:16px;margin:20px 24px 0;font-family:var(--mono);font-size:11px;color:#fbbf24;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <span style="font-weight:700;font-size:13px;color:#fbbf24;">🔧 DEBUG PANEL (remove when resolved)</span>
      <button onclick="this.parentElement.parentElement.style.display='none'" style="background:#3b2a06;color:#fbbf24;border:1px solid #5c4506;border-radius:4px;padding:2px 10px;cursor:pointer;font-size:11px;">Hide</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 20px;color:var(--text);">
      <div>Format detected: <b style="color:#38bdf8">${PARSED.format}</b></div>
      <div>Device: <b style="color:#38bdf8">${PARSED.device?.substring(0,50)}</b></div>
      <div>Event type: <b style="color:#38bdf8">${PARSED.eventInfo?.eventType}</b></div>
      <div>Analog rows parsed: <b style="color:${PARSED.analogData?.length > 0 ? '#22c55e' : '#ef4444'}">${PARSED.analogData?.length || 0}</b></div>
      <div>Digital labels found: <b style="color:${PARSED.digitalLabels?.length > 0 ? '#22c55e' : '#ef4444'}">${PARSED.digitalLabels?.length || 0}</b></div>
      <div>Hex samples found: <b style="color:${D.hexSampleCount > 0 ? '#22c55e' : '#ef4444'}">${D.hexSampleCount ?? '?'}</b></div>
      <div>Hex word bit length: <b style="color:#38bdf8">${D.hexBitLength ?? '?'}</b></div>
      <div>Digital transitions: <b style="color:${PARSED.digitalTransitions?.length > 0 ? '#22c55e' : '#ef4444'}">${PARSED.digitalTransitions?.length || 0}</b></div>
      <div>Trigger sample index: <b style="color:#38bdf8">${PARSED.triggerSampleIndex}</b></div>
      <div>Trip equation found: <b style="color:${PARSED.tripEquation ? '#22c55e' : '#ef4444'}">${PARSED.tripEquation ? 'YES [' + (PARSED.tripEquationName || '?') + '] (' + PARSED.tripEquation.substring(0,60) + '...)' : 'NO'}</b></div>
      <div>Trip equation X: <b style="color:#38bdf8">${PARSED.tripEquationX ? 'YES' : 'none'}</b></div>
      <div>SV settings parsed: <b style="color:#38bdf8">${PARSED.svSettings?.length || 0}</b></div>
    </div>
    <div style="margin-top:8px;border-top:1px solid #2d1b00;padding-top:8px;">
      <div>Trip bits in labels: <b style="color:#38bdf8">${['TRIP3P','TRIPA','TRIPB','TRIPC','TRIP','TR'].filter(b => PARSED.digitalLabels?.includes(b)).join(', ') || 'NONE FOUND'}</b></div>
      <div>TRIP3P label index: <b style="color:#38bdf8">${PARSED.digitalLabels?.indexOf('TRIP3P') ?? -1}</b></div>
      <div>TRIP label index: <b style="color:#38bdf8">${PARSED.digitalLabels?.indexOf('TRIP') ?? -1}</b></div>
      <div>tripCause set: <b style="color:${cause ? '#22c55e' : '#ef4444'}">${cause ? 'YES — ' + cause.causeText?.substring(0,50) : 'NO (null)'}</b></div>
      <div>immediateCause: <b style="color:#38bdf8">${cause?.immediateCause || 'null'}</b></div>
    </div>`;

  // Show transitions summary
  if (PARSED.digitalTransitions?.length > 0) {
    debugHTML += `<div style="margin-top:8px;border-top:1px solid #2d1b00;padding-top:8px;">
      <div style="font-weight:600;margin-bottom:4px;">Digital Transitions (${PARSED.digitalTransitions.length}):</div>`;
    PARSED.digitalTransitions.slice(0, 15).forEach((t, i) => {
      const asserts = t.changes.filter(c => c.asserted).map(c => c.label);
      const isTripTrans = asserts.some(l => ['TRIP3P','TRIP','TRIPA','TRIPB','TRIPC'].includes(l));
      debugHTML += `<div style="color:${isTripTrans ? '#ef4444' : 'var(--text-dim)'};font-size:10px;">
        [${i}] t=${t.timeMs?.toFixed(1)}ms: <span style="color:${isTripTrans ? '#ef4444' : '#22c55e'}">▲${asserts.slice(0,8).join(' ')}${asserts.length > 8 ? '...' : ''}</span>
        ${isTripTrans ? ' ← TRIP FOUND' : ''}</div>`;
    });
    if (PARSED.digitalTransitions.length > 15) debugHTML += `<div style="color:var(--text-muted)">...${PARSED.digitalTransitions.length - 15} more</div>`;
    debugHTML += `</div>`;
  } else {
    debugHTML += `<div style="margin-top:8px;color:#ef4444;font-weight:700;">⚠️ NO DIGITAL TRANSITIONS DETECTED — this is likely the root problem</div>`;
    if (D.hexSampleCount === 0) {
      debugHTML += `<div style="color:#ef4444;">No hex words found in data rows. Check data format.</div>`;
    } else if (D.hexSampleCount === 1) {
      debugHTML += `<div style="color:#ef4444;">Only 1 hex sample — need at least 2 to detect transitions.</div>`;
    } else if (D.allHexIdentical) {
      debugHTML += `<div style="color:#fbbf24;">All ${D.hexSampleCount} hex words are identical — no state changes occurred in the recorded data.</div>`;
    }
  }

  // Show initial digital state
  if (PARSED.initialDigitalState?.length > 0) {
    const keyBits = PARSED.initialDigitalState.filter(l =>
      /^(SV|TRIP|52A|27|59|81D|50|51|FAULT|TR\b|OC|LT|LOP|TOSLP|ORED)/.test(l));
    debugHTML += `<div style="margin-top:8px;border-top:1px solid #2d1b00;padding-top:8px;">
      <div style="font-weight:600;margin-bottom:4px;">Key Initial State (${keyBits.length} of ${PARSED.initialDigitalState.length} total):</div>
      <div style="font-size:10px;color:var(--text-dim);word-break:break-all;">${keyBits.join(', ')}</div></div>`;
  }

  debugHTML += `</div>`;
  // Only surface the debug panel when it's actually needed — i.e. when cause resolution
  // came up empty and there's genuinely something worth digging into. When a cause (trip or
  // event report) was found, this diagnostic noise just clutters the banner for no reason.
  el.innerHTML = cause ? '' : debugHTML;

  // Mini waveform charts shown in the banner's right-hand column, regardless of whether
  // the digital-logic cause was resolved — the waveform is often still informative (e.g.
  // visually confirming a fault) even in the rare case the trip term couldn't be traced.
  // Measure the banner's actual current width first — it's a real, already-laid-out element
  // in the page (sized by CSS independently of its content), so this reflects whatever the
  // window's actual width is right now rather than a value tuned for one particular size.
  updateBannerChartWidth();
  const mainTimelineHTML = buildMainTimelineHTML(PARSED, ANALYSIS);
  const chartsHTML = `<div class="trip-banner-charts">
    ${mainTimelineHTML}
    ${buildCurrentMagChart(PARSED, ANALYSIS, true)}
    ${buildVoltageMagChart(PARSED, ANALYSIS, true)}
    ${buildRelevantQuantityChart(PARSED, ANALYSIS, true)}
    ${buildSVFlagsChart(PARSED, ANALYSIS, true)}
  </div>`;

  if (!cause) {
    el.classList.remove('event-report');
    el.innerHTML += `
      <div style="margin-top:16px;">
      <div class="trip-banner-layout">
        <div class="trip-banner-main">
          <div class="trip-banner-header">
            <div class="trip-banner-icon">❓</div>
            <div>
              <div class="trip-banner-label">Trip Cause</div>
              <div class="trip-banner-cause">Unable to determine from digital data</div>
            </div>
          </div>
          <p style="color:var(--text-dim);font-size:13px;">The digital word did not show a trip transition in this event record. The protection elements and SV logic tabs contain the underlying element states for this record.</p>
          ${buildRecloseBannerBlock(PARSED, ANALYSIS)}
        </div>
        ${chartsHTML}
      </div>
      </div>`;
    wireChartInteractivity();
    return;
  }

  // Build sequence arrows — kept as a fallback for event-report (ER) events, which don't
  // currently get the richer branching-tree treatment below (that's built only for real
  // trips, where the AND/OR structure matters most).
  let seqHTML = '';
  if (cause.causeChain.length) {
    // Deduplicate and keep order
    const seen = new Set();
    const chain = cause.causeChain.filter(c => { if (seen.has(c.label)) return false; seen.add(c.label); return true; });
    const terminalLabels = cause.isEventReport
      ? [PARSED.erEquationName || 'ER']
      : ['TRIP3P', 'TRIPA', 'TRIPB', 'TRIPC', 'TRIP'];
    seqHTML = '<div class="trip-sequence">';
    chain.forEach((step, i) => {
      const isTrip = terminalLabels.includes(step.label);
      const isSV = step.label.startsWith('SV');
      seqHTML += `<div class="seq-step">
        <div class="seq-node ${isTrip ? 'active' : ''}">
          <div class="seq-node-label">${tt(step.label,PARSED)}</div>
          <div class="seq-node-desc">${step.delay > 0 ? step.delay + ' cyc' : (isTrip ? (cause.isEventReport ? 'RECORDED' : 'TRIP') : 'instant')}</div>
        </div>
        ${i < chain.length - 1 ? '<div class="seq-arrow">→</div>' : ''}
      </div>`;
    });
    seqHTML += '</div>';
  }

  // Total time calculation
  const totalCycles = cause.causeChain.reduce((sum, c) => sum + (c.delay || 0), 0);
  const totalMs = totalCycles / (PARSED.eventInfo.freq || 60) * 1000;

  // Toggle the calmer, non-alarming palette for event-report (no-trip) events — this
  // represents the relay choosing to record a condition, not a fault it acted on.
  el.classList.toggle('event-report', !!cause.isEventReport);

  el.innerHTML += `
    <div class="trip-banner-layout">
      <div class="trip-banner-main">
        <div class="trip-banner-header">
          <div class="trip-banner-icon">${cause.isEventReport ? '📋' : '⚡'}</div>
          <div>
            <div class="trip-banner-label">${cause.isEventReport ? 'Event Report Triggered — No Trip' : 'Root Cause Identified'}</div>
            <div class="trip-banner-cause">${cause.causeText}</div>
          </div>
        </div>
        ${cause.crossEvent ? '<div style="display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:4px;background:var(--yellow-dim);color:var(--yellow);font-size:11px;font-weight:600;margin-bottom:10px;border:1px solid #5c4506"><span>🔗</span> CROSS-EVENT: Condition started in a prior event record</div>' : ''}
        <p style="color:${cause.isEventReport ? '#bfdbfe' : '#fecaca'};font-size:13px;margin-bottom:16px;line-height:1.6;">${cause.causeDetail}</p>
        ${buildEvidenceBlock(PARSED, cause)}
        <div id="mainChartedLogicSlot"></div>
        <div class="trip-timing">
          <div class="timing-chip"><span class="label">${cause.isEventReport ? 'Timer Delay:' : 'Total Timer Delay:'}</span> <span class="value">${totalCycles} cycles (${totalMs.toFixed(0)} ms)</span></div>
          <div class="timing-chip"><span class="label">Immediate Cause:</span> <span class="value">${cause.immediateCause || '—'}</span></div>
          <div class="timing-chip"><span class="label">${cause.isEventReport ? 'Event Report Equation:' : 'Trip Equation:'}</span> <span class="value">${(cause.isEventReport ? (PARSED.erEquationName || 'ER') : (cause.sourceEquationName || PARSED.tripEquationName || 'TR'))}${cause.immediateCause ? ' via ' + cause.immediateCause : ''}</span></div>
          ${renderChartedBitChipHTML(PARSED, ANALYSIS)}
        </div>
        ${buildRecloseBannerBlock(PARSED, ANALYSIS)}
        ${buildConsistencyWarningBanner(PARSED, ANALYSIS)}
        ${buildInvestigationPanel(PARSED, ANALYSIS)}
      </div>
      ${chartsHTML}
    </div>
  `;
  LAST_SEQ_HTML = seqHTML;
  wireChartInteractivity();
  renderChartedLogicSlot();
}

// ══════════════════════════════════════════════════════════════════════
// WAVEFORM MAGNITUDE CHARTS — mimic SEL SynchroWAVe's Mag traces
// ══════════════════════════════════════════════════════════════════════
// SynchroWAVe's IA.Mag/VAY.Mag etc. are an RMS envelope of the raw instantaneous
// waveform, not the instantaneous samples themselves. This computes an equivalent
// trailing one-cycle sliding RMS from the analog samples already parsed from the CEV —
// this is a standard RMS-envelope approximation of what SynchroWAVe shows, not a
// byte-for-bit reproduction of SEL's internal DSP filter, but it produces the same
// "flat pre-fault, rises during the fault" magnitude envelope shape.
// ── SEL *FILTERED* (4 samples/cycle) EVENT REPORTS ────────────────────────────
// A CEV whose header reports SAM/CYC_A = 4 is a FILTERED report. Its analog columns are not
// instantaneous waveform samples: they are the relay's own digital-filter output, emitted once
// per quarter cycle and already scaled so each value is an RMS-referred projection of the
// phasor. Two consecutive samples are therefore 90 degrees apart and ARE the real and
// imaginary parts of the phasor:
//
//     X[n] = x[n] + j*x[n-1]        |X[n]| = hypot(x[n], x[n-1])     (already RMS)
//
// Running a conventional sliding RMS over those values instead returns |X|/sqrt(2) in steady
// state, because each quadrature pair contributes X^2 spread across two samples. Worse, during
// a fast transient the 4-sample window spans a full cycle of a magnitude that is still moving,
// so it also smears and delays the peak — the error is not even a constant factor and cannot
// be corrected by a scalar.
//
// Verified against SEL-751 record 10824 (BG fault, 8/14/2026). At the trigger instant the
// quadrature form returns IA 126.2 / IB 821.2 / IC 319.8 A and VA 73.7 / VB 94.0 / VC 248.5 V,
// matching both the relay's own event-summary row (126.6 / 821.6 / 319.8 / 73.685 / 94.272 /
// 248.040) and SynchroWAVe's .Mag cursor readout. The sliding-RMS form returned
// 72.5 / 532.9 / 231.0 / 53.1 / 66.3 / 174.4 for the same instant — low by sqrt(2) on the
// slow-moving voltages and by 1.54x on the fast-moving fault current.
//
// A raw/unfiltered report (16 or 32 samples/cycle) carries true instantaneous samples and must
// keep using the sliding-window form, so this branches on the file's own declared rate rather
// than being applied everywhere.
function isFilteredQuarterCycle(samplesPerCycle) { return samplesPerCycle === 4; }

// One sentence under each magnitude chart saying which of the two methods produced it, so the
// number on screen can always be traced back to how it was derived.
function magMethodNote(P) {
  const spc = P?.eventInfo?.samPerCycA || 32;
  return isFilteredQuarterCycle(spc)
    ? `Filtered report (${spc} samples/cycle): magnitude is the quarter-cycle phasor |x[n] + j&middot;x[n&minus;1]|, already RMS — the same quantity SynchroWAVe plots as .Mag and the relay quotes in its event summary.`
    : `Raw report (${spc} samples/cycle): magnitude is a 1-cycle sliding RMS of the recorded instantaneous samples — an approximation of SynchroWAVe's Mag trace, not a re-implementation of SEL's exact DSP filter.`;
}