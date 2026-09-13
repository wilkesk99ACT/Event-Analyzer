

// ══════════════════════════════════════════════════════════════════════
// SEL-851 RENDERING
// ══════════════════════════════════════════════════════════════════════
// Kept separate from the SEL CEV renderers, for the same reason the Form 6 renderers are:
// those are built around CEV-specific structures. PARSED.format === 'sel851' branches here
// from renderBanner, renderTabs and renderContent.
//
// The Verdict tab comes first and holds the answer. Every other tab exists to let a reader
// check that answer against the record.

const SEL851_VERDICT_STYLE = {
  ok:    { accent: 'green-accent',  color: 'var(--green)',  icon: '✅', label: 'Trip agrees with settings' },
  check: { accent: 'yellow-accent', color: 'var(--yellow)', icon: '⚠️', label: 'Review needed' },
  error: { accent: 'red-accent',    color: 'var(--red)',    icon: '⛔', label: 'Disagreement found' },
  info:  { accent: 'blue-accent',   color: 'var(--accent)', icon: 'ℹ️', label: 'For information' },
};

function sel851Esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ══════════════════════════════════════════════════════════════════════
// BANNER
// ══════════════════════════════════════════════════════════════════════
function renderSel851Banner() {
  const P = PARSED, A = ANALYSIS;
  const V = A.verdict || { level: 'info', headline: 'No verdict', detail: '' };
  const st = SEL851_VERDICT_STYLE[V.level] || SEL851_VERDICT_STYLE.info;
  const el = document.getElementById('tripBanner');

  const errorCount = A.findings.filter(f => f.level === 'error').length;
  const checkCount = A.findings.filter(f => f.level === 'check').length;

  el.innerHTML = `<div class="card ${st.accent}" style="margin:20px 24px 0;">
    <div style="display:flex;align-items:flex-start;gap:16px;">
      <div style="font-size:32px;line-height:1;">${st.icon}</div>
      <div style="flex:1;">
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;">
          SEL-851 &nbsp;·&nbsp; Relay reported: ${sel851Esc(P.eventInfo.eventType)}
        </div>
        <div style="font-size:20px;font-weight:700;color:${st.color};margin-top:2px;">${sel851Esc(V.headline)}</div>
        <div style="font-size:13px;color:var(--text-dim);margin-top:8px;line-height:1.55;">${sel851Esc(V.detail)}</div>
      </div>
      <div style="text-align:right;font-size:11px;color:var(--text-muted);white-space:nowrap;">
        ${errorCount ? `<div style="color:var(--red);font-weight:700;">${errorCount} disagreement${errorCount > 1 ? 's' : ''}</div>` : ''}
        ${checkCount ? `<div style="color:var(--yellow);font-weight:700;">${checkCount} to review</div>` : ''}
        ${!errorCount && !checkCount ? `<div style="color:var(--green);font-weight:700;">All checks agree</div>` : ''}
      </div>
    </div>
    <div style="margin-top:12px;font-size:12px;color:var(--text-dim);">
      ${sel851Esc(P.fileName)} &nbsp;·&nbsp; ${sel851Esc(P.deviceLocation || P.device)} &nbsp;·&nbsp;
      Event ${sel851Esc(P.eventInfo.refNum)} &nbsp;·&nbsp; ${formatTimestamp(P.timestamp)} &nbsp;·&nbsp;
      ${P.analogData.length} samples at ${(P.cfg.rates[0]?.sampFreq || 0).toFixed(0)} Hz &nbsp;·&nbsp;
      ${P.digitalLabels.length} named bits
    </div>
    ${!P._debug.hdrPresent ? `<div style="margin-top:10px;padding:8px 12px;background:var(--yellow-dim);border-radius:6px;font-size:12px;color:var(--yellow);">This archive has no .hdr file. Without it there are no settings and no trip equation, so the trip cannot be checked for reasonableness. Only the waveforms and bit states are available.</div>` : ''}
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════
// TABS
// ══════════════════════════════════════════════════════════════════════
function renderSel851Tabs() {
  const tabs = [
    { id: 'sel851-verdict', label: 'Verdict', icon: '⚖️' },
    { id: 'sel851-elements', label: 'Elements', icon: '🛡️' },
    { id: 'sel851-timeline', label: 'Event Timeline', icon: '📍' },
    { id: 'sel851-voltages', label: 'Voltages', icon: '🔌' },
    { id: 'sel851-currents', label: 'Currents', icon: '〰️' },
    { id: 'sel851-settings', label: 'Settings', icon: '⚙️' },
  ];
  document.getElementById('tabBar').innerHTML = tabs.map(t =>
    `<button class="tab-btn ${t.id === 'sel851-verdict' ? 'active' : ''}" data-tab="${t.id}">${t.icon} ${t.label}</button>`
  ).join('');
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('panel-' + btn.dataset.tab)?.classList.add('active');
    });
  });
}

// ══════════════════════════════════════════════════════════════════════
// CONTENT
// ══════════════════════════════════════════════════════════════════════
function renderSel851Content() {
  const P = PARSED, A = ANALYSIS;
  let html = '';
  html += sel851VerdictPanel(P, A);
  html += sel851ElementsPanel(P, A);
  html += sel851TimelinePanel(P, A);
  html += sel851VoltagePanel(P, A);
  html += sel851CurrentPanel(P, A);
  html += sel851SettingsPanel(P, A);
  document.getElementById('contentArea').innerHTML = html;
}

// ── Verdict ──
function sel851VerdictPanel(P, A) {
  const V = A.verdict || {};
  const st = SEL851_VERDICT_STYLE[V.level] || SEL851_VERDICT_STYLE.info;
  let h = `<div class="tab-panel active" id="panel-sel851-verdict">`;

  // 1. Why did it trip
  h += `<div class="card ${st.accent}">
    <div class="card-header">⚖️ Was this trip reasonable?</div>
    <div style="font-size:16px;font-weight:700;color:${st.color};margin-bottom:8px;">${st.icon} ${sel851Esc(V.headline)}</div>
    <p style="font-size:13px;color:var(--text-dim);line-height:1.6;margin:0;">${sel851Esc(V.detail)}</p>
  </div>`;

  // 2. The cause, in order
  const C = A.tripCause;
  if (C) {
    const rows = [];
    rows.push(['Relay event label', sel851Esc(P.eventInfo.eventType)]);
    rows.push(['Trip decided at', `${C.seconds.toFixed(4)} s into the record`]);
    rows.push(['Started by', C.element ? `${sel851Esc(C.element)} — ${sel851Esc(C.label)}` : sel851Esc(C.label)]);
    if (C.measuredText) rows.push(['Measured when it operated', sel851Esc(C.measuredText)]);
    if (A.breaker && A.breaker.clearSeconds != null) {
      rows.push(['Breaker opened', `${A.breaker.clearSeconds.toFixed(4)} s after the trip (${A.breaker.clearCycles.toFixed(1)} cycles)`]);
    }
    if (P.eventInfo.targets) rows.push(['Relay targets', `<span style="font-family:var(--mono)">${sel851Esc(P.eventInfo.targets)}</span>`]);
    h += `<div class="card blue-accent"><div class="card-header">🔎 What happened</div>
      <table class="data-table"><tbody>
      ${rows.map(([k, v]) => `<tr><td style="width:30%;color:var(--text-muted)">${k}</td><td>${v}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  // 3. Findings
  if (A.findings.length) {
    const order = { error: 0, check: 1, info: 2, ok: 3 };
    const sorted = [...A.findings].sort((a, b) => order[a.level] - order[b.level]);
    h += `<div class="card ${A.findings.some(f => f.level === 'error') ? 'red-accent' : A.findings.some(f => f.level === 'check') ? 'yellow-accent' : 'blue-accent'}">
      <div class="card-header">🩺 Findings</div>
      <p style="font-size:12px;color:var(--text-dim);margin-bottom:14px;">Each finding names two things in this file that must agree, and says whether they do. A finding tells you what disagrees and what could cause it. It does not tell you what to do.</p>`;
    for (const f of sorted) {
      const fs = SEL851_VERDICT_STYLE[f.level] || SEL851_VERDICT_STYLE.info;
      h += `<div style="border-left:3px solid ${fs.color};background:rgba(255,255,255,0.02);padding:10px 14px;margin-bottom:10px;border-radius:0 6px 6px 0;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:14px;">${fs.icon}</span>
          <span style="font-weight:700;color:${fs.color};font-size:13px;">${sel851Esc(f.title)}</span>
          <span style="font-family:var(--mono);font-size:10px;color:var(--text-muted);margin-left:auto;">${sel851Esc(f.code)}</span>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-top:6px;line-height:1.6;">${sel851Esc(f.detail)}</div>
      </div>`;
    }
    h += `</div>`;
  }

  // 4. The trip equation, term by term
  if (P.tripEquation) {
    h += `<div class="card blue-accent"><div class="card-header">📋 Trip equation at the moment of the trip</div>
      <p style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">${sel851Esc(P.tripEquationName)} is the equation the relay uses to decide to trip. Each term is shown with the state it read at that sample.</p>
      <div style="font-family:var(--mono);font-size:11px;background:#0a0e17;padding:12px;border-radius:6px;color:var(--text-dim);line-height:1.7;word-break:break-word;margin-bottom:12px;">${sel851Esc(P.tripEquation)}</div>
      <table class="data-table"><thead><tr><th>Term</th><th>State at trip</th><th>In this record?</th></tr></thead><tbody>
      ${(A.equationTermStates || []).map(t => `<tr>
        <td style="font-family:var(--mono);color:${t.state ? 'var(--red)' : 'var(--text-dim)'}">${sel851Esc(t.name)}</td>
        <td>${t.known ? badge(!!t.state, t.state ? '1' : '0') : '<span class="badge badge-yellow"><span class="badge-dot"></span>NOT RECORDED</span>'}</td>
        <td style="color:var(--text-muted)">${t.known ? 'Yes' : 'No — this bit is not a recorded channel'}</td>
      </tr>`).join('')}
      </tbody></table></div>`;
  }

  // 5. Scaling basis — stated up front, because every comparison rests on it
  if (A.scaling && A.scaling.status) {
    const sc = A.scaling;
    const good = sc.status === 'agrees';
    h += `<div class="card ${good ? 'green-accent' : sc.status === 'disagrees' ? 'red-accent' : 'blue-accent'}">
      <div class="card-header">📐 Measurement basis</div>
      <p style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">Element pickups on this relay are in secondary units. Every measured value in this tool is taken from the raw sampled waveforms and divided by the ratio settings below. This is what those numbers rest on.</p>
      <table class="data-table"><tbody>
        <tr><td style="width:38%;color:var(--text-muted)">VT ratio (VTP.Rat)</td><td>${P.ratios.PTP ?? 'not set'} &nbsp;·&nbsp; connection ${sel851Esc(P.ratios.vtConn || 'not set')}</td></tr>
        <tr><td style="color:var(--text-muted)">CT ratio (CTP.Rat)</td><td>${P.ratios.CTP ?? 'not set'} &nbsp;·&nbsp; nominal secondary ${P.ratios.CTPsec ?? '?'} A</td></tr>
        <tr><td style="color:var(--text-muted)">Nominal system voltage (Sys.VNom)</td><td>${P.ratios.VNomKv ?? 'not set'} kV</td></tr>
        ${sc.expectedLLsec != null ? `<tr><td style="color:var(--text-muted)">Expected phase-to-phase secondary</td><td>${sc.expectedLLsec.toFixed(1)} V</td></tr>` : ''}
        ${sc.measuredLLsec != null ? `<tr><td style="color:var(--text-muted)">Measured before the disturbance</td><td style="color:${good ? 'var(--green)' : 'var(--red)'}">${sc.measuredLLsec.toFixed(1)} V${sc.errorPct != null ? ` (${sc.errorPct > 0 ? '+' : ''}${sc.errorPct.toFixed(1)}%)` : ''}</td></tr>` : ''}
      </tbody></table>
      ${sc.status === 'no-window' ? `<p style="font-size:11px;color:var(--yellow);margin-top:10px;">This record has no quiet window before the disturbance, so the scaling could not be cross-checked.</p>` : ''}
      ${sc.status === 'no-nominal' ? `<p style="font-size:11px;color:var(--yellow);margin-top:10px;">Sys.VNom or VTP.Rat is missing, so the scaling could not be cross-checked.</p>` : ''}
    </div>`;
  }

  h += `</div>`;
  return h;
}

// ── Elements ──
function sel851ElementsPanel(P, A) {
  let h = `<div class="tab-panel" id="panel-sel851-elements">`;
  if (!A.elements || !A.elements.length) {
    h += `<p style="color:var(--text-dim);font-size:13px;padding:0 4px;">No protection elements from the trip equation could be evaluated for this record.</p></div>`;
    return h;
  }
  h += `<div class="card blue-accent"><div class="card-header">🛡️ Elements in the trip equation</div>
  <p style="font-size:12px;color:var(--text-dim);margin-bottom:14px;">Each row compares the relay's setting against the value measured from this record's own waveforms. "Started the trip" marks the element whose output was true when the relay decided to trip.</p>
  <table class="data-table"><thead><tr>
    <th>Element</th><th>Type</th><th>Enabled</th><th>Pickup</th>
    <th>Measured when it operated</th><th>Set delay</th><th>Measured delay</th><th>Started the trip</th>
  </tr></thead><tbody>`;
  for (const e of A.elements) {
    const delaySet = e.timedType === 'curve'
      ? `${sel851Esc(e.curve || '?')} at TD ${e.timeDial ?? '?'}${e.expectedCurveSeconds != null ? ` → ${e.expectedCurveSeconds.toFixed(3)} s` : ''}`
      : (e.delay != null ? `${e.delay} s` : '—');
    const delayObs = e.observedDelay != null ? `${e.observedDelay.toFixed(4)} s` : '—';
    const delayColor = e.delayAgrees === false ? 'var(--yellow)' : e.delayAgrees === true ? 'var(--green)' : 'var(--text-dim)';
    const measured = e.measuredAtTimeout != null
      ? `<span style="color:${e.beyondPickupAtTimeout === false ? 'var(--red)' : 'var(--text)'}">${e.measuredAtTimeout.toFixed(e.measuredAtTimeout >= 100 ? 1 : 3)} ${sel851Esc(e.qtyUnit)}</span>`
      : (e.evaluated ? '<span style="color:var(--text-muted)">did not operate</span>' : '<span style="color:var(--text-muted)">not evaluated</span>');
    h += `<tr>
      <td style="font-family:var(--mono);color:var(--accent);font-weight:700">${sel851Esc(e.element)}</td>
      <td>${sel851Esc(e.label)}${e.qtyDesc ? `<div style="font-size:10px;color:var(--text-muted)">compares ${sel851Esc(e.qtyDesc)}</div>` : ''}</td>
      <td>${e.enabled === false ? '<span class="badge badge-yellow"><span class="badge-dot"></span>OFF</span>' : e.enabled === true ? '<span class="badge badge-green"><span class="badge-dot"></span>ON</span>' : '<span style="color:var(--text-muted)">—</span>'}</td>
      <td>${e.pickup != null ? `${e.pickup} ${sel851Esc(e.qtyUnit)}${e.dir ? `<div style="font-size:10px;color:var(--text-muted)">operates ${e.dir === 'below' ? 'under' : 'over'}</div>` : ''}` : '—'}</td>
      <td>${measured}</td>
      <td>${delaySet}</td>
      <td style="color:${delayColor}">${delayObs}</td>
      <td>${e.initiated ? '<span class="badge badge-red"><span class="badge-dot"></span>YES</span>' : '<span style="color:var(--text-muted)">no</span>'}</td>
    </tr>`;
    if (e.notes.length) {
      h += `<tr><td colspan="8" style="font-size:11px;color:var(--text-muted);padding-top:0;">${e.notes.map(sel851Esc).join(' ')}</td></tr>`;
    }
  }
  h += `</tbody></table></div>`;

  // Chart the operating quantity of whichever element started the trip, with its pickup drawn
  // on it. This is the single most direct way to check the verdict by eye.
  const primary = A.elements.find(e => e.initiated && e.evaluated);
  if (primary && A.quantities[primary.qtyName]) {
    const series = A.quantities[primary.qtyName];
    const traces = [{ label: primary.qtyName, color: '#3b9eff', values: series }];
    traces.push({ label: 'pickup', color: '#f87171', values: series.map(() => primary.pickup) });
    h += `<div class="card red-accent"><div class="card-header">📈 ${sel851Esc(primary.element)} operating quantity against its pickup</div>
      ${renderMagnitudeChartSVG(traces, { msPerSample: P.msPerSample, yUnit: primary.qtyUnit, forceZeroBaseline: true, triggerIdx: primary.puIdx ?? undefined, tripIdx: A.tripIdx })}
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px;">Blue is the ${sel851Esc(primary.qtyDesc)}, computed from the raw sampled waveforms in this file with a one-cycle Fourier window. Red is the ${primary.pickup} ${sel851Esc(primary.qtyUnit)} pickup setting.</p>
    </div>`;
  }
  h += `</div>`;
  return h;
}

// ── Timeline ──
function sel851TimelinePanel(P, A) {
  let h = `<div class="tab-panel" id="panel-sel851-timeline">
    <div class="card red-accent"><div class="card-header">⏱️ Digital Event Timeline</div>
    <p style="font-size:12px;color:var(--text-dim);margin-bottom:12px;">Every change of state among the ${P.digitalLabels.length} named relay bits in this record, in order. The ${P.cfg.numDigital - P.digitalLabels.length} unused bit positions the relay declares are not shown.</p>`;

  {
    h += `<div style="font-size:11px;color:var(--text-muted);margin-bottom:12px;padding:8px 12px;background:rgba(255,255,255,0.02);border-radius:6px;">
      <b style="color:var(--text-dim)">Already asserted when the record opened:</b> ${P.initialDigitalState.length ? P.initialDigitalState.map(sel851Esc).join(', ') : 'none'}
    </div>`;
  }

  h += `<div class="timeline-scroll" style="max-height:640px;overflow:auto;">`;
  for (const step of A.timeline) {
    const isTrip = A.tripIdx != null && step.idx === A.tripIdx;
    h += `<div style="display:flex;gap:12px;padding:6px 10px;border-left:2px solid ${isTrip ? 'var(--red)' : 'var(--border,#1e293b)'};margin-bottom:3px;background:${isTrip ? 'var(--red-dim)' : 'transparent'};">
      <div style="font-family:var(--mono);font-size:11px;color:var(--text-muted);min-width:78px;">${step.seconds.toFixed(4)} s</div>
      <div style="flex:1;display:flex;flex-wrap:wrap;gap:5px;">
        ${step.changes.map(c => `<span class="tl-bit ${c.state ? 'assert' : 'deassert'}" style="font-family:var(--mono);font-size:11px;padding:2px 7px;border-radius:4px;background:${c.state ? 'var(--red-dim)' : 'var(--green-dim)'};color:${c.state ? 'var(--red)' : 'var(--green)'};">${c.state ? '▲' : '▼'} ${sel851Esc(c.label)}</span>`).join('')}
      </div>
    </div>`;
  }
  h += `</div></div></div>`;
  return h;
}

// ── Voltages ──
function sel851VoltagePanel(P, A) {
  const Q = A.quantities;
  let h = `<div class="tab-panel" id="panel-sel851-voltages">`;
  if (Q._vab) {
    h += `<div class="card blue-accent"><div class="card-header">🔌 Phase-to-phase voltage (V secondary)</div>
      ${renderMagnitudeChartSVG([
        { label: 'VAB', color: '#ef4444', values: Q._vab },
        { label: 'VBC', color: '#22c55e', values: Q._vbc },
        { label: 'VCA', color: '#3b82f6', values: Q._vca },
      ], { msPerSample: P.msPerSample, yUnit: 'V', forceZeroBaseline: true, tripIdx: A.tripIdx })}
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px;">Divide by nothing further — these are already secondary volts, scaled by VTP.Rat = ${P.ratios.PTP ?? '?'}. Multiply by ${P.ratios.PTP ?? '?'} for primary volts.</p>
    </div>`;
  }
  if (Q._va) {
    h += `<div class="card blue-accent"><div class="card-header">🔌 Phase-to-neutral voltage (V secondary)</div>
      ${renderMagnitudeChartSVG([
        { label: 'VA', color: '#ef4444', values: Q._va },
        { label: 'VB', color: '#22c55e', values: Q._vb },
        { label: 'VC', color: '#3b82f6', values: Q._vc },
      ], { msPerSample: P.msPerSample, yUnit: 'V', forceZeroBaseline: true, tripIdx: A.tripIdx })}
    </div>`;
  }
  if (Q.v3v0 || Q.v1) {
    const traces = [];
    if (Q.v1) traces.push({ label: 'V1', color: '#38bdf8', values: Q.v1 });
    if (Q.v3v0) traces.push({ label: '3V0', color: '#f59e0b', values: Q.v3v0 });
    h += `<div class="card blue-accent"><div class="card-header">⚡ Sequence voltage (V secondary)</div>
      ${renderMagnitudeChartSVG(traces, { msPerSample: P.msPerSample, yUnit: 'V', forceZeroBaseline: true, tripIdx: A.tripIdx })}
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px;">V1 is the positive-sequence voltage. 3V0 is the zero-sequence voltage, taken as the sum of the three phase phasors. A balanced disturbance moves V1 and leaves 3V0 near zero.</p>
    </div>`;
  }
  if (Q.freq) {
    h += `<div class="card blue-accent"><div class="card-header">📊 Frequency (Hz)</div>
      ${renderMagnitudeChartSVG([{ label: 'Freq', color: '#a78bfa', values: Q.freq }], { msPerSample: P.msPerSample, yUnit: 'Hz', forceZeroBaseline: false, tripIdx: A.tripIdx })}
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px;">This is the relay's own frequency channel, used as written. There is no waveform to re-derive it from.</p>
    </div>`;
  }
  h += `</div>`;
  return h;
}

// ── Currents ──
function sel851CurrentPanel(P, A) {
  const Q = A.quantities;
  let h = `<div class="tab-panel" id="panel-sel851-currents">`;
  if (Q._ia) {
    const ctr = A.CTR || 1;
    h += `<div class="card blue-accent"><div class="card-header">〰️ Phase current (A primary)</div>
      ${renderMagnitudeChartSVG([
        { label: 'IA', color: '#ef4444', values: Q._ia.map(v => v * ctr) },
        { label: 'IB', color: '#22c55e', values: Q._ib.map(v => v * ctr) },
        { label: 'IC', color: '#3b82f6', values: Q._ic.map(v => v * ctr) },
      ], { msPerSample: P.msPerSample, yUnit: 'A', forceZeroBaseline: true, tripIdx: A.tripIdx })}
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px;">Primary amps, from the raw waveforms. Divide by CTP.Rat = ${ctr} to compare against a pickup setting.</p>
    </div>`;
  }
  const seqTraces = [];
  if (Q.i3i2) seqTraces.push({ label: '3I2', color: '#f59e0b', values: Q.i3i2.map(v => v * (A.CTR || 1)) });
  if (Q.i3i0) seqTraces.push({ label: '3I0 (from IA+IB+IC)', color: '#a78bfa', values: Q.i3i0.map(v => v * (A.CTR || 1)) });
  if (Q.iGnd) seqTraces.push({ label: 'IGnd (measured)', color: '#38bdf8', values: Q.iGnd.map(v => v * (A.CTR || 1)) });
  if (Q.iN) seqTraces.push({ label: 'IN (measured)', color: '#22c55e', values: Q.iN.map(v => v * (A.CTN || A.CTR || 1)) });
  if (seqTraces.length) {
    h += `<div class="card blue-accent"><div class="card-header">⚡ Ground and sequence current (A primary)</div>
      ${renderMagnitudeChartSVG(seqTraces, { msPerSample: P.msPerSample, yUnit: 'A', forceZeroBaseline: true, tripIdx: A.tripIdx })}
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px;">3I0 is derived from the three phase currents. IGnd and IN are separate measured channels. If the derived and measured values disagree widely on a healthy system, one of the CT connections is wrong.</p>
    </div>`;
  }
  if (A.faultOrigin) {
    const F = A.faultOrigin;
    h += `<div class="card ${F.ratio != null && F.ratio < 1.25 ? 'green-accent' : 'yellow-accent'}"><div class="card-header">🧭 Where did the disturbance come from?</div>
      <table class="data-table"><tbody>
        <tr><td style="width:45%;color:var(--text-muted)">Highest phase current before the disturbance</td><td>${(F.preCurrent * (A.CTR || 1)).toFixed(1)} A primary</td></tr>
        <tr><td style="color:var(--text-muted)">Highest phase current during the disturbance</td><td>${(F.peakCurrent * (A.CTR || 1)).toFixed(1)} A primary</td></tr>
        <tr><td style="color:var(--text-muted)">Ratio</td><td>${F.ratio != null ? F.ratio.toFixed(2) + '×' : '—'}</td></tr>
        ${F.lowestOcPickup != null ? `<tr><td style="color:var(--text-muted)">Lowest enabled overcurrent pickup</td><td>${sel851Esc(F.lowestOcName)} at ${F.lowestOcPickup} A secondary (${(F.lowestOcPickup * (A.CTR || 1)).toFixed(0)} A primary)</td></tr>` : ''}
      </tbody></table>
      <p style="font-size:12px;color:var(--text-dim);margin-top:10px;">A fault on the protected feeder raises current through these CTs. A disturbance elsewhere on the system lowers voltage without raising current here.</p>
    </div>`;
  }
  h += `</div>`;
  return h;
}

// ── Settings ──
function sel851SettingsPanel(P, A) {
  let h = `<div class="tab-panel" id="panel-sel851-settings">`;
  const hdr = P.hdr;
  if (!hdr || !Object.keys(hdr.values).length) {
    h += `<p style="color:var(--text-dim);font-size:13px;padding:0 4px;">This archive has no .hdr file, so no settings are available.</p></div>`;
    return h;
  }
  h += `<div class="card blue-accent"><div class="card-header">⚙️ Relay settings from the .hdr file</div>
    <p style="font-size:12px;color:var(--text-dim);margin-bottom:12px;">These are the settings the relay wrote into this event record. They are grouped exactly as the relay wrote them.</p>`;
  for (const section of Object.keys(hdr.sections)) {
    const keys = hdr.sections[section];
    if (!keys.length) continue;
    h += `<div style="margin-bottom:18px;">
      <div style="font-size:12px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;">${sel851Esc(section)}</div>
      <table class="data-table"><tbody>
      ${keys.map(k => `<tr>
        <td style="width:34%;font-family:var(--mono);color:var(--accent)">${sel851Esc(k)}</td>
        <td style="font-family:var(--mono);word-break:break-word;">${sel851Esc(hdr.values[k])}</td>
      </tr>`).join('')}
      </tbody></table></div>`;
  }
  h += `</div>`;

  h += `<div class="card blue-accent"><div class="card-header">📄 Record details</div>
    <table class="data-table"><tbody>
      <tr><td style="width:40%;color:var(--text-muted)">COMTRADE revision</td><td>${P.cfg.revYear}</td></tr>
      <tr><td style="color:var(--text-muted)">Data file format</td><td>${sel851Esc(P.cfg.fileType)}</td></tr>
      <tr><td style="color:var(--text-muted)">Date order read from the .cfg</td><td>${P.cfg.dateOrder === 'DMY' ? 'day/month/year' : 'month/day/year'}</td></tr>
      <tr><td style="color:var(--text-muted)">Sample rate</td><td>${(P.cfg.rates[0]?.sampFreq || 0).toFixed(0)} Hz (${P.eventInfo.samPerCycA} samples per cycle)</td></tr>
      <tr><td style="color:var(--text-muted)">Samples in record</td><td>${P.analogData.length} (${(P.analogData.length * P.msPerSample / 1000).toFixed(3)} s)</td></tr>
      <tr><td style="color:var(--text-muted)">Analog channels</td><td>${P.cfg.numAnalog}</td></tr>
      <tr><td style="color:var(--text-muted)">Digital channels</td><td>${P.cfg.numDigital} declared, ${P.digitalLabels.length} named</td></tr>
      <tr><td style="color:var(--text-muted)">Firmware ID</td><td style="font-family:var(--mono)">${sel851Esc(P.fid)}</td></tr>
      <tr><td style="color:var(--text-muted)">Serial number</td><td style="font-family:var(--mono)">${sel851Esc(P.serialNumber)}</td></tr>
      <tr><td style="color:var(--text-muted)">Time source</td><td>${sel851Esc(P.eventInfo.timeSource || 'not stated')}</td></tr>
    </tbody></table>
  </div>`;

  h += `</div>`;
  return h;
}
