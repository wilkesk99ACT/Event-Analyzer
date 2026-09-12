
function renderTabs() {
  if (PARSED.format === 'form6') { renderForm6Tabs(); return; }
  const tabs = [
    { id: 'timeline', label: 'Event Timeline', icon: '📍' },
    { id: 'voltages', label: 'Voltages', icon: '🔌' },
    { id: 'currents', label: 'Currents', icon: '〰️' },
    { id: 'protection', label: 'Protection', icon: '🛡️' },
    { id: 'diagnostics', label: 'Diagnostics', icon: '🩺' },
    { id: 'reclose', label: 'Reclosing', icon: '🔄' },
    { id: 'sv', label: 'SV Logic', icon: '🔗' },
    { id: 'freq', label: 'Frequency', icon: '📊' },
    { id: 'equations', label: 'Equations', icon: '📋' },
  ];

  document.getElementById('tabBar').innerHTML = tabs.map(t =>
    `<button class="tab-btn ${t.id === 'timeline' ? 'active' : ''}" data-tab="${t.id}">${t.icon} ${t.label}</button>`
  ).join('');

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('panel-' + btn.dataset.tab)?.classList.add('active');
      if (btn.dataset.tab === 'timeline' && CURSOR_IDX != null) scrollTimelineToCursor(CURSOR_IDX);
    });
  });
}

function renderContent() {
  if (PARSED.format === 'form6') { renderForm6Content(); return; }
  const A = ANALYSIS;
  const P = PARSED;
  const CTR = P.settings.CTR || 1;
  const PTRY = P.settings.PTRY || 1;
  const PTRZ = P.settings.PTRZ || 1;
  const VNOM = P.settings.VNOM || 1;

  let html = '';

  // ── Timeline ──
  const tripRelevant = getTripRelevantLabels(P, A);
  html += `<div class="tab-panel active" id="panel-timeline">
    <div class="card red-accent">
      <div class="card-header">⏱️ Digital Event Timeline</div>
      <p style="font-size:12px;color:var(--text-dim);margin-bottom:16px;">
        Step-by-step sequence of digital state changes decoded from the CEV event record.
        Each entry shows exactly which relay word bits changed and when.
      </p>
      <div class="tab-legend">
        <span><span class="legend-dot" style="background:var(--red);box-shadow:0 0 6px rgba(248,113,113,0.5)"></span> Trip event</span>
        <span><span class="tl-bit assert" style="padding:2px 6px;">▲ bit</span> Asserted (turned ON) at this step</span>
        <span><span class="tl-bit deassert" style="padding:2px 6px;">▼ bit</span> De-asserted (turned OFF) at this step</span>
      </div>
      ${tripRelevant.size ? `<label style="display:flex;align-items:center;gap:7px;font-size:12px;color:var(--text-dim);margin-bottom:14px;cursor:pointer;">
        <input type="checkbox" id="timelineTripOnlyToggle" onchange="toggleTimelineTripFilter(this.checked)">
        Show only bits relevant to the trip
      </label>` : ''}
      <div class="timeline-scroll" id="timelineScroll">
      <div class="timeline">`;

  // Show initial state summary — always visible regardless of the trip-relevant filter, since
  // it's orientation for the whole record rather than a candidate step to filter out.
  // data-tl-idx="-1" marks this as the "before every transition" row, so cursor-sync scrolling
  // can still land here when the playback position is earlier than the first recorded change.
  html += `<div class="tl-event tl-initial" data-tl-idx="-1">
    <div class="tl-time">t = 0 ms (record start)</div>
    <div class="tl-label">Initial State</div>
    <div class="tl-desc">Key initial conditions: ${(P.initialDigitalState || []).filter(l =>
      ['52A3P','LT02','LT06','SV10T','SV17T','SV23T','TCCAP','FREQOK','79RS3P'].includes(l)
    ).map(l => `<span class="tl-bit assert" style="background:var(--green-dim);color:var(--green)">${tt(l,P)}</span>`).join(' ') || 'None notable'}</div>
  </div>`;

  A.digitalTimeline.forEach((evt, evtIdx) => {
    const relevantAsserts = evt.asserts.filter(l => tripRelevant.has(l));
    const relevantDeasserts = evt.deasserts.filter(l => tripRelevant.has(l));
    const rowRelevant = relevantAsserts.length || relevantDeasserts.length;
    // data-tl-idx lines up 1:1 with PARSED.digitalTransitions / A.digitalTimeline's own order,
    // so dragging the cursor in the charts above can scroll straight to the matching row here
    // (see scrollTimelineToCursor) without re-deriving it from the displayed time text.
    html += `<div class="tl-event ${evt.isTrip ? 'trip' : ''}" data-tl-relevant="${rowRelevant ? '1' : '0'}" data-tl-idx="${evtIdx}">
      <div class="tl-time">t = ${evt.timeMs.toFixed(1)} ms</div>
      <div class="tl-label">${evt.desc}</div>
      ${evt.asserts.length ? `<div class="tl-bits">${evt.asserts.map(l =>
        `<span class="tl-bit assert" data-tl-bit-relevant="${tripRelevant.has(l) ? '1' : '0'}">▲ ${tt(l,P)}</span>`).join('')}</div>` : ''}
      ${evt.deasserts.length ? `<div class="tl-bits" style="margin-top:3px">${evt.deasserts.map(l =>
        `<span class="tl-bit deassert" data-tl-bit-relevant="${tripRelevant.has(l) ? '1' : '0'}">▼ ${tt(l,P)}</span>`).join('')}</div>` : ''}
    </div>`;
  });

  html += `</div></div></div></div>`;


  // ── Voltages ──
  html += `<div class="tab-panel" id="panel-voltages">`;
  ['yTerminal', 'zTerminal'].forEach(term => {
    const ptr = term === 'yTerminal' ? PTRY : PTRZ;
    const label = term === 'yTerminal' ? 'Y-Terminal' : 'Z-Terminal';
    html += `<div class="card blue-accent"><div class="card-header">🔌 ${label} Voltages (PTR=${ptr})</div>
      <table class="data-table"><thead><tr>
        <th>Phase</th><th>Pre-Fault kV (Pri)</th><th>Pre-Fault V (Sec)</th>
        <th>Fault kV (Pri)</th><th>Fault V (Sec)</th><th>Change</th>
      </tr></thead><tbody>`;
    for (const ph of ['VA', 'VB', 'VC']) {
      const d = A.voltages[term]?.[ph];
      if (!d) continue;
      const chg = d.change;
      const color = Math.abs(chg) > 10 ? 'var(--red)' : Math.abs(chg) > 5 ? 'var(--yellow)' : 'var(--green)';
      html += `<tr>
        <td>${ph}</td>
        <td>${d.preFault.primaryKV.toFixed(2)}</td><td>${d.preFault.secondaryV.toFixed(2)}</td>
        <td>${d.fault.primaryKV.toFixed(2)}</td><td>${d.fault.secondaryV.toFixed(2)}</td>
        <td style="color:${color};font-weight:700">${chg > 0 ? '+' : ''}${chg.toFixed(1)}%</td>
      </tr>`;
    }
    html += `</tbody></table>
      <div style="margin-top:10px;font-size:11px;color:var(--text-muted)">VNOM = ${VNOM} V (secondary nominal)</div>
    </div>`;
  });

  html += `</div>`;

  // ── Currents ──
  html += `<div class="tab-panel" id="panel-currents">
    <div class="card blue-accent"><div class="card-header">〰️ Current Measurements (CTR=${CTR})</div>
      <table class="data-table"><thead><tr>
        <th>Channel</th><th>Pre-Fault (Sec A)</th><th>Pre-Fault (Pri A)</th>
        <th>Fault (Sec A)</th><th>Fault (Pri A)</th><th>Change</th>
      </tr></thead><tbody>`;
  for (const ch of ['IA', 'IB', 'IC', 'IG', 'IN']) {
    const d = A.currents[ch];
    const chg = d.change;
    const color = Math.abs(chg) > 100 ? 'var(--red)' : Math.abs(chg) > 50 ? 'var(--yellow)' : 'var(--green)';
    html += `<tr>
      <td>${ch}</td>
      <td>${d.preFault.secA.toFixed(3)}</td><td>${d.preFault.priA.toFixed(1)}</td>
      <td>${d.fault.secA.toFixed(3)}</td><td>${d.fault.priA.toFixed(1)}</td>
      <td style="color:${color};font-weight:700">${chg > 500 ? '>>>' : `${chg > 0 ? '+' : ''}${chg.toFixed(0)}%`}</td>
    </tr>`;
  }
  html += `</tbody></table></div></div>`;

  // ── Protection ──
  html += `<div class="tab-panel" id="panel-protection">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">
      <span id="protectionInstantLabel" style="font-size:12px;color:var(--text-dim);font-family:var(--mono);"></span>
      <span style="font-size:11px;color:var(--text-muted);cursor:pointer;" onclick="refreshProtectionTab(null)" title="Reset to trip instant">Drag the measurement cursor on any chart (Timeline/Voltages/Currents tabs) to see values at that instant — click here to reset to the trip instant.</span>
    </div>
    <div class="card red-accent"><div class="card-header">🛡️ Overcurrent Protection Elements</div>
      ${renderBasisNote(P)}
      <div class="table-scroll"><table class="data-table"><thead><tr>
        <th>Element</th><th>Type</th><th>Pickup</th><th>Measured</th>
        <th>Multiple</th><th>Time Setting</th><th>Op Time</th><th>Status</th>
      </tr></thead><tbody id="ocProtectionTbody">${renderOcTableRows(A.protectionStatus)}</tbody></table></div></div>`;

  if (A.voltageStatus.length) {
    html += `<div class="card yellow-accent"><div class="card-header">📐 Voltage Protection Elements</div>
      <p style="font-size:11px;color:var(--text-muted);margin-bottom:10px;">
        "Measured" shows both the secondary-V figure compared against the relay's own setting, and the same value in chart-native units (kV/A primary, whichever this file's channels use) — matching what's plotted on the Voltages/Currents/Timeline charts, so the two can be read side-by-side.
      </p>
      <div class="table-scroll"><table class="data-table"><thead><tr>
        <th>Element</th><th>Terminal</th><th>Type</th><th>Pickup</th><th>Measured</th><th>Status</th>
      </tr></thead><tbody id="voltProtectionTbody">${renderVoltTableRows(A.voltageStatus)}</tbody></table></div></div>`;
  }
  html += `</div>`;

  // ── Diagnostics ──
  html += `<div class="tab-panel" id="panel-diagnostics">
    ${buildCloseAttemptCard(P, A)}
    ${buildConsistencyChecksCard(P, A)}
  </div>`;

  // ── Reclosing ──
  html += `<div class="tab-panel" id="panel-reclose">
    ${buildRecloseTabHTML(P, A)}
  </div>`;

  // ── SV Logic ──
  html += `<div class="tab-panel" id="panel-sv">
    <div class="tab-legend">
      <span><span class="legend-swatch" style="border-left:3px solid var(--red);"></span> Left border / name in red = this SV is part of the trip equation chain</span>
      <span><span class="legend-swatch" style="border-left:3px solid var(--accent);"></span> Left border / name in accent color = active elsewhere in the record, not part of this trip</span>
      <span><span style="color:var(--yellow)">PU</span> = pickup delay (how long the condition must hold before this SV asserts)</span>
      <span><span style="color:var(--text-muted)">DO</span> = dropout delay (how long it must clear before de-asserting)</span>
    </div>
    <div class="card red-accent"><div class="card-header">🔗 SVs in Trip Equation</div>
      <p style="font-size:12px;color:var(--text-dim);margin-bottom:14px;">
        These SVs are directly referenced in the trip equation (${P.tripEquationName || 'TR'}). Each one's pickup delay determines how long the input condition must persist before the trip path activates.
      </p>`;
  A.svChain.filter(sv => sv.inTrip).forEach(sv => {
    const eq = sv.equation;
    const comment = eq.includes('#') ? eq.split('#')[1].trim() : '';
    const eqClean = eq.split('#')[0].trim();
    html += `<div class="sv-card in-trip">
      <div class="sv-header">
        <span class="sv-name">${tt(sv.label, P)}</span>
        <div class="sv-delays">
          <span class="pu">PU: ${sv.pickupDelay} cyc (${(sv.pickupDelay / (P.eventInfo.freq||60) * 1000).toFixed(1)} ms)</span>
          <span class="do">DO: ${sv.dropoutDelay} cyc</span>
        </div>
      </div>
      <div class="sv-eq">${linkifyEquationBits(eqClean, P)}${comment ? ` <span class="sv-comment"># ${comment}</span>` : ''}</div>
    </div>`;
  });
  html += `</div>`;

  html += `<div class="card blue-accent"><div class="card-header">⚙️ All Active SVs</div>`;
  A.svChain.forEach(sv => {
    const eq = sv.equation;
    const comment = eq.includes('#') ? eq.split('#')[1].trim() : '';
    const eqClean = eq.split('#')[0].trim();
    html += `<div class="sv-card ${sv.inTrip ? 'in-trip' : ''}">
      <div class="sv-header">
        <span class="sv-name">${tt(sv.label, P)}</span>
        <div class="sv-delays">
          <span class="pu">PU: ${sv.pickupDelay} cyc (${(sv.pickupDelay / (P.eventInfo.freq||60) * 1000).toFixed(1)} ms)</span>
          <span class="do">DO: ${sv.dropoutDelay} cyc</span>
        </div>
      </div>
      <div class="sv-eq">${linkifyEquationBits(eqClean, P)}${comment ? ` <span class="sv-comment"># ${comment}</span>` : ''}</div>
    </div>`;
  });
  html += `</div></div>`;

  // ── Frequency ──
  html += `<div class="tab-panel" id="panel-freq">
    <div class="card blue-accent"><div class="card-header">📊 Frequency Protection Elements</div>`;
  if (A.freqStatus.length) {
    html += `<table class="data-table"><thead><tr>
      <th>Element</th><th>Type</th><th>Pickup</th><th>Time Delay</th><th>Measured</th><th>Status</th>
    </tr></thead><tbody>`;
    A.freqStatus.forEach(f => {
      html += `<tr><td>${f.element}</td><td>${f.type}</td><td>${f.pickup}</td>
        <td>${f.timeDelay}</td><td>${f.measured}</td><td>${badge(f.asserted)}</td></tr>`;
    });
    html += `</tbody></table>`;
  } else {
    html += `<p style="color:var(--text-dim);font-size:13px;">No frequency elements configured or asserted.</p>`;
  }
  html += `</div></div>`;

  // ── Equations ──
  html += `<div class="tab-panel" id="panel-equations">
    <div class="card blue-accent"><div class="card-header">📋 Key Relay Equations</div>`;
  [
    [`${P.tripEquationName || 'TR'} (Trip)`, P.tripEquation],
    ['TR3X (Trip Unconditional)', P.tripEquationX || '—'],
    ['FAULT', P.faultEquation],
    ['79RI3P (Reclose Initiate)', P.recloseEquation],
    ['79DTL3P (Dead Timer Lockout)', P.dtlEquation],
  ].forEach(([label, eq]) => {
    html += `<div style="margin-bottom:16px">
      <div style="font-size:11px;color:var(--accent);font-weight:600;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.08em">${label}</div>
      <div class="code-block">${eq && eq !== '—' ? linkifyEquationBits(eq, P) : '—'}</div>
    </div>`;
  });
  html += `</div>`;

  html += `<div class="card"><div class="card-header">⚙️ Instrument Transformer Settings</div>
    <table class="data-table"><thead><tr><th>Setting</th><th>Value</th><th>Description</th></tr></thead><tbody>`;
  [
    ['RID', P.settings.RID?.trim(), 'Relay Identifier'],
    ['TID', P.settings.TID?.trim(), 'Terminal Identifier'],
    ['CTR', P.settings.CTR, 'Current Transformer Ratio'],
    ['PTRY', P.settings.PTRY, 'PT Ratio (Y-terminal)'],
    ['PTRZ', P.settings.PTRZ, 'PT Ratio (Z-terminal)'],
    ['VNOM', P.settings.VNOM, 'Nominal Voltage (sec V)'],
    ['V1YRCF', P.settings.VYRCF?.[0], 'Voltage Ratio Correction Y-A'],
    ['V2YRCF', P.settings.VYRCF?.[1], 'Voltage Ratio Correction Y-B'],
    ['V3YRCF', P.settings.VYRCF?.[2], 'Voltage Ratio Correction Y-C'],
    ['V1ZRCF', P.settings.VZRCF?.[0], 'Voltage Ratio Correction Z-A'],
    ['V2ZRCF', P.settings.VZRCF?.[1], 'Voltage Ratio Correction Z-B'],
    ['V3ZRCF', P.settings.VZRCF?.[2], 'Voltage Ratio Correction Z-C'],
  ].forEach(([k, v, d]) => {
    html += `<tr><td style="color:var(--accent)">${k}</td><td>${v ?? '—'}</td><td style="font-family:var(--sans);color:var(--text-dim)">${d}</td></tr>`;
  });
  html += `</tbody></table></div></div>`;

  document.getElementById('contentArea').innerHTML = html;
}