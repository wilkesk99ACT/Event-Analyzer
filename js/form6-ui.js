// Form 6-specific banner/tabs/content rendering.

function renderForm6Banner() {
  const P = PARSED, A = ANALYSIS;
  const el = document.getElementById('tripBanner');
  el.innerHTML = `<div class="card red-accent" style="margin:20px 24px 0;">
    <div style="display:flex;align-items:center;gap:16px;">
      <div style="font-size:32px;">⚡</div>
      <div>
        <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;">Eaton Form 6 (ProView) — COMTRADE</div>
        <div style="font-size:20px;font-weight:700;color:var(--text);">${A.faultSummary || 'Event captured — no fault summary text supplied'}</div>
      </div>
    </div>
    <div style="margin-top:12px;font-size:12px;color:var(--text-dim);">
      ${P.fileName} &nbsp;·&nbsp; Trigger: ${formatTimestamp(P.timestamp)} &nbsp;·&nbsp; ${P.cfg.numAnalog} analog / ${P.cfg.numDigital} digital channels &nbsp;·&nbsp; ${P.analogData.length} samples @ ${(P.cfg.rates[0]?.sampFreq || 0).toFixed(1)} Hz
    </div>
    ${!P.settings ? `<div style="margin-top:10px;padding:8px 12px;background:var(--yellow-dim,rgba(234,179,8,0.1));border-radius:6px;font-size:12px;color:var(--yellow);">No settings.txt supplied with this bundle — protection element pickups can't be evaluated, only waveforms/digital states.</div>` : ''}
  </div>`;
}

function renderForm6Tabs() {
  const tabs = [
    { id: 'form6-waveforms', label: 'Waveforms', icon: '〰️' },
    { id: 'form6-digital', label: 'Digital Channels', icon: '📍' },
    { id: 'form6-protection', label: 'Protection', icon: '🛡️' },
    { id: 'form6-settings', label: 'Settings', icon: '⚙️' },
  ];
  document.getElementById('tabBar').innerHTML = tabs.map(t =>
    `<button class="tab-btn ${t.id === 'form6-waveforms' ? 'active' : ''}" data-tab="${t.id}">${t.icon} ${t.label}</button>`
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

function renderForm6Content() {
  const P = PARSED, A = ANALYSIS;
  const msPerSample = P.msPerSample;
  const tripIdx = P.triggerSampleIndex;
  let html = '';

  // ── Waveforms ──
  const currentChs = P.cfg.analogChannels.filter(c => /^I/i.test(c.chId));
  const voltageChs = P.cfg.analogChannels.filter(c => /^V/i.test(c.chId));
  const colors = ['#ef4444', '#22c55e', '#3b82f6', '#f59e0b', '#a78bfa', '#38bdf8'];
  const buildTraces = chs => chs.map((c, i) => ({ label: c.chId, color: colors[i % colors.length], values: P.analogData.map(r => r[c.key] || 0) }));

  html += `<div class="tab-panel active" id="panel-form6-waveforms">
    <div class="card blue-accent"><div class="card-header">〰️ Currents (A primary)</div>
      ${renderMagnitudeChartSVG(buildTraces(currentChs), { msPerSample, yUnit: 'A', forceZeroBaseline: false, triggerIdx: tripIdx, tripIdx })}
    </div>
    <div class="card blue-accent"><div class="card-header">🔌 Voltages (V primary)</div>
      ${renderMagnitudeChartSVG(buildTraces(voltageChs), { msPerSample, yUnit: 'V', forceZeroBaseline: false, triggerIdx: tripIdx, tripIdx })}
    </div>
  </div>`;

  // ── Digital Channels — table of state at trigger instant plus any channel that changes
  // state at all across the record (a cheap, dependency-free stand-in for a full transition
  // timeline like the SEL side has; can be built out further once this format is in real use) ──
  const digRows = P.cfg.digitalChannels.map(ch => {
    const vals = P.analogData.map(r => r._digital[ch.key]);
    const atTrigger = vals[Math.min(tripIdx, vals.length - 1)];
    const changes = vals.some(v => v !== vals[0]);
    return { ch, atTrigger, changes };
  });
  html += `<div class="tab-panel" id="panel-form6-digital">
    <div class="card red-accent"><div class="card-header">📍 Digital Channel States</div>
      <p style="font-size:12px;color:var(--text-dim);margin-bottom:12px;">State at the trigger instant for every wired contact input/output. Channels that never change across this record are dimmed — likely unwired in this scheme's COMTRADE block (reads a constant 0).</p>
      <table class="data-table"><thead><tr><th>Channel</th><th>At Trigger</th><th>Changes in Record?</th></tr></thead><tbody>
      ${digRows.map(r => `<tr style="${r.changes ? '' : 'opacity:0.45'}">
        <td style="font-family:var(--mono)">${r.ch.chId}</td>
        <td>${badge(!!r.atTrigger, r.atTrigger ? '1' : '0')}</td>
        <td>${r.changes ? 'Yes' : '—'}</td>
      </tr>`).join('')}
      </tbody></table>
    </div>
  </div>`;

  // ── Protection ──
  html += `<div class="tab-panel" id="panel-form6-protection">
    <div style="font-size:12px;color:var(--yellow);margin-bottom:10px;">${A.groupAssumption || ''}</div>`;
  if (A.protectionStatus.length) {
    html += `<div class="card red-accent"><div class="card-header">🛡️ Protection Elements (from settings.txt)</div>
      <table class="data-table"><thead><tr><th>Element</th><th>Type</th><th>Pickup</th><th>Measured</th><th>Status</th></tr></thead><tbody>
      ${A.protectionStatus.map(p => `<tr>
        <td style="color:var(--accent);font-weight:700">${p.element}</td><td>${p.type}${p.curveNote ? `<div style="font-size:10px;color:var(--text-muted)">${p.curveNote}</div>` : ''}</td>
        <td>${p.pickup}</td><td>${p.measured}</td>
        <td>${p.blocked ? '<span class="badge badge-green"><span class="badge-dot"></span>BLOCKED</span>' : badge(p.asserted)}</td>
      </tr>`).join('')}
      </tbody></table>
      <div style="margin-top:10px;font-size:11px;color:var(--text-muted)">No operate-time estimate is shown — the Curve setting references an Eaton/Cooper TCC family this tool doesn't have a verified formula table for yet.</div>
    </div>`;
  } else {
    html += `<p style="color:var(--text-dim);font-size:13px;padding:0 4px;">${P.settings ? 'No recognized protection settings (CLPU, SEF, NegSeqOCAlarm) found in settings.txt.' : 'No settings.txt was supplied with this bundle.'}</p>`;
  }
  if (A.unresolvedElements && A.unresolvedElements.length) {
    html += `<div class="card yellow-accent"><div class="card-header">⚠️ Curve Settings Present, Pickup Not Found</div>
      <p style="font-size:12px;color:var(--text-dim);">${A.unresolvedElements.join(', ')} ${A.unresolvedElements.length > 1 ? 'have' : 'has'} curve/timing settings (Curve, Mult, Add, HCT, MRTA) in settings.txt, but no pickup value under either the per-curve naming (e.g. TCC1PMinTrip) or Eaton's documented stock naming (e.g. TCCPMinTrip, shared between TCC1/TCC2). ProView's Workbench builds schemes from generic function blocks rather than fixed elements, so a value like this can be wired from an adjustable setting <i>or</i> typed directly into the block as a compiled constant — the latter would never appear in any settings export. That's the most likely explanation here, not a gap in this tool's parsing.</p>
    </div>`;
  }
  html += `</div>`;

  // ── Settings (raw viewer) ──
  html += `<div class="tab-panel" id="panel-form6-settings">`;
  if (P.settings) {
    const names = Object.keys(P.settings).sort();
    html += `<div class="card blue-accent"><div class="card-header">⚙️ All Settings (settings.txt)</div>
      <p style="font-size:11px;color:var(--text-muted);margin-bottom:10px;">Values are shown as [Normal, Alt1, Alt2, Alt3, Alt4, Alt5] per setting group. ${A.groupAssumption || ''}</p>
      <table class="data-table"><thead><tr><th>Setting</th><th>Values</th><th>Description</th></tr></thead><tbody>
      ${names.map(n => `<tr><td style="font-family:var(--mono);color:var(--accent)">${n}</td><td style="font-family:var(--mono)">${P.settings[n].values.join(', ')}</td><td style="color:var(--text-dim);font-size:11px">${P.settings[n].description}</td></tr>`).join('')}
      </tbody></table>
    </div>`;
  } else {
    html += `<p style="color:var(--text-dim);font-size:13px;padding:0 4px;">No settings.txt was supplied with this bundle.</p>`;
  }
  html += `</div>`;

  document.getElementById('contentArea').innerHTML = html;
}


