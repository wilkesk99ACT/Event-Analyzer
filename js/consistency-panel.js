
// Build the SV/digital flags panel from whichever labels actually appear in the
// resolved trip-cause chain (the same chain driving the sequence-diagram in the
// banner) — usually SV/timer pairs, but generalizes to any element or the trip bit
// itself, matching how SynchroWAVe shows exactly the points relevant to the trip.
// Render one sequence-component consistency check (zero or negative) as an HTML block.
function renderConsistencyCheckBlock(check, opts) {
  if (!check) {
    return `<div style="padding:12px;color:var(--text-muted);font-size:12px;">No current channel available for this check.</div>`;
  }
  const compact = !!opts?.compact;
  const fmt = (v, d) => v == null ? '—' : v.toFixed(d ?? 2);
  const fmtPct = (v) => v == null ? 'no reference pickup found' : v.toFixed(1) + '%';

  const title = check.kind === 'zero' ? 'Zero-Sequence (3V0 vs. Ground Current)' : 'Negative-Sequence (V2 vs. I2)';
  const statusColor = check.flagged ? 'var(--red)' : (check.vSustainedPct == null || check.iSustainedPct == null) ? 'var(--text-muted)' : 'var(--green)';
  const statusText = check.flagged ? '⚠ Inconsistent' : (check.vSustainedPct == null || check.iSustainedPct == null) ? '— Insufficient reference' : '✓ Consistent';

  let html = `<div style="border:1px solid ${check.flagged ? '#5c1a1a' : 'var(--card-border)'};border-radius:8px;padding:${compact ? '10px' : '14px'};background:${check.flagged ? 'var(--red-dim)' : 'var(--card)'};margin-bottom:10px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <span style="font-weight:600;font-size:${compact ? '12px' : '13px'};color:var(--text);">${title}</span>
      <span style="font-size:11px;font-weight:700;color:${statusColor};">${statusText}</span>
    </div>
    <table style="width:100%;font-size:${compact ? '11px' : '12px'};border-collapse:collapse;">
      <tr style="color:var(--text-muted);"><td></td><td style="text-align:right;padding:2px 8px;">Sustained</td><td style="text-align:right;padding:2px 8px;">Peak</td><td style="text-align:right;padding:2px 8px;">Reference</td></tr>
      <tr>
        <td style="color:var(--text-dim);">${check.vLabel} (voltage)</td>
        <td style="text-align:right;padding:2px 8px;font-family:var(--mono);">${fmtPct(check.vSustainedPct)}</td>
        <td style="text-align:right;padding:2px 8px;font-family:var(--mono);">${fmtPct(check.vPeakPct)}</td>
        <td style="text-align:right;padding:2px 8px;color:var(--text-muted);font-size:10px;">${check.vRefIsPickup ? 'own pickup' : 'VNOM'}</td>
      </tr>
      <tr>
        <td style="color:var(--text-dim);">${check.iLabel} (current)</td>
        <td style="text-align:right;padding:2px 8px;font-family:var(--mono);font-weight:${check.flagged ? 700 : 400};color:${check.flagged ? 'var(--red)' : 'inherit'}">${fmtPct(check.iSustainedPct)}</td>
        <td style="text-align:right;padding:2px 8px;font-family:var(--mono);">${fmtPct(check.iPeakPct)}</td>
        <td style="text-align:right;padding:2px 8px;color:var(--text-muted);font-size:10px;">${check.iRefIsPickup ? 'own pickup' : 'phase I'}</td>
      </tr>
    </table>`;

  if (!compact) {
    html += `<div style="margin-top:8px;font-size:10px;color:var(--text-muted);font-family:var(--mono);">
      ${check.vLabel}: ${fmt(check.vSustained, 3)} sustained / ${fmt(check.vPeak, 3)} peak
      ${check.vPickupPrimary != null ? ` (pickup ${check.vPickupPrimary.toFixed(3)})` : ''}
      &nbsp;|&nbsp; ${check.iLabel}: ${fmt(check.iSustained, 3)} sustained / ${fmt(check.iPeak, 3)} peak
      ${check.iPickupPrimary != null ? ` (pickup ${check.iPickupPrimary.toFixed(2)})` : ''}
    </div>`;
  }

  if (check.flagged) {
    html += `<p style="margin-top:8px;font-size:${compact ? '11px' : '12px'};color:#fecaca;line-height:1.5;">
      ${check.vLabel} is at <b>${check.vSustainedPct.toFixed(0)}%</b> of pickup but ${check.iLabel} is only
      <b>${check.iSustainedPct.toFixed(1)}%</b>. Possible disconnected or miswired
      ${check.kind === 'zero' ? 'grounding transformer or ground CT' : 'current circuit, or an open phase'}.
    </p>`;
  } else if (check.vSustainedPct != null && check.iSustainedPct != null
             && check.vSustainedPct >= 40 && check.iSustainedPct <= 8) {
    // The raw numbers show a mismatch, but a physics gate determined it isn't evidence of a
    // wiring problem in this specific situation — say why, rather than showing a bare pass.
    const reason = !check.breakerClosedMajority
      ? `the breaker was open, so no current is expected`
      : `no ground overcurrent is set, so this system is not expected to carry ground current (e.g. behind a delta winding)`;
    html += `<p style="margin-top:8px;font-size:${compact ? '11px' : '12px'};color:var(--text-muted);line-height:1.5;">
      ${check.vLabel} is elevated (${check.vSustainedPct.toFixed(0)}% of reference) with ${check.iLabel} near zero. Not flagged: ${reason}.
    </p>`;
  }

  html += `</div>`;
  return html;
}

// Full card for the Diagnostics tab — always shown, both sequences, whether flagged or not.
function buildConsistencyChecksCard(P, A) {
  const zeroCheck = computeConsistencyCheck(P, A, 'zero');
  const negCheck = computeConsistencyCheck(P, A, 'neg');
  return `<div class="card red-accent"><div class="card-header">🩺 Physical Consistency Checks</div>
    <p style="font-size:12px;color:var(--text-dim);margin-bottom:14px;line-height:1.5;">
      Sequence voltage should be matched by sequence current. A large sustained gap points to CT wiring, a grounding
      transformer connection, or an open phase.
    </p>
    ${renderConsistencyCheckBlock(zeroCheck)}
    ${renderConsistencyCheckBlock(negCheck)}
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════
// CLOSE ATTEMPT CARD
// ══════════════════════════════════════════════════════════════════════
// Always shown when a close command is detected in this record (A.closeAttempt, computed in
// analyzeCEV) — whether or not anything about it got flagged above. Whatever the outcome, an
// operator looking at a close attempt wants the plain facts laid out: when the command went
// out, how it was initiated, whether/when the breaker confirmed closed, and what — if anything
// — happened right after.
function buildCloseAttemptCard(P, A) {
  const ca = A?.closeAttempt;
  const trace = A?.closeTrace;
  const haveTrace = !!(trace && typeof buildCloseTraceCard === 'function');
  // No CLOSE rising edge here (a carried-in close, or a CF record), or the close output never
  // operated: the trace card says everything the breaker-confirmation card would, and more.
  if (!ca) return haveTrace ? buildCloseTraceCard(P, A) : '';
  if (haveTrace && trace.verdict && (trace.verdict.kind === 'blocked' || trace.verdict.kind === 'pending')) return buildCloseTraceCard(P, A);

  let verdict, verdictColor;
  if (!ca.bkrConfirmed) {
    verdict = '✕ Breaker never confirmed closed';
    verdictColor = 'var(--red)';
  } else if (ca.currentSpike?.inrushLikely) {
    verdict = ca.pickupBeforeFullyClosed ? '⚡ Tripped — current shape suggests inrush, not a fault' : '⚡ Re-tripped — current shape suggests inrush, not a fault';
    verdictColor = 'var(--yellow)';
  } else if (ca.tripElement && ca.pickupBeforeFullyClosed) {
    verdict = '⚠ Closed into an existing fault';
    verdictColor = 'var(--red)';
  } else if (ca.tripElement) {
    verdict = '⚠ Closed, then re-tripped shortly after';
    verdictColor = 'var(--yellow)';
  } else {
    verdict = '✓ Close succeeded and held';
    verdictColor = 'var(--green)';
  }

  const rows = [];
  rows.push(['Close command', `${tt(ca.closeLabel, P)} at t=${ca.closeMs.toFixed(0)} ms, initiated by ${ca.initiatedBy}`]);
  rows.push(['Breaker confirmation', ca.bkrConfirmed
    ? `${tt(ca.bkrCloseLabel, P)} confirmed closed ${ca.closeTimeMs.toFixed(0)} ms later (~${(ca.closeTimeMs / (1000 / (P.eventInfo.freq || 60))).toFixed(1)} cycles)`
    : (ca.bkrCloseLabel ? `${tt(ca.bkrCloseLabel, P)} never confirmed closed in the rest of this record` : 'No breaker-status bit (52A/52A3P) in this file')]);
  if (ca.tripElement) {
    const freqL = P.eventInfo.freq || 60;
    rows.push(['Following trip', `${tt(ca.tripElement, P)} asserted ${ca.tripDelayMs.toFixed(0)} ms after the close command (~${(ca.tripDelayMs / (1000 / freqL)).toFixed(1)} cycles)`]);
    if (ca.firstProtPickup) {
      rows.push(['First protection pickup', `${tt(ca.firstProtPickup.label, P)}, ${ca.pickupBeforeFullyClosed ? 'before the breaker confirmed fully closed' : 'after the breaker confirmed fully closed'}`]);
    }
    if (ca.currentSpike) {
      const cs = ca.currentSpike;
      let spikeText = `peaked at ${cs.peakDuring.toFixed(1)} A sec (vs. ${cs.peakPre.toFixed(1)} A sec just before the close)`;
      if (cs.inrush) {
        spikeText += cs.inrushLikely
          ? ` — ~${cs.inrush.pct2H.toFixed(0)}% 2nd harmonic on phase ${cs.inrush.phase}: likely transformer inrush`
          : ` — ~${cs.inrush.pct2H.toFixed(0)}% 2nd harmonic on phase ${cs.inrush.phase}: typical of fault current`;
      } else if (cs.note) {
        spikeText += ` — ${cs.note}`;
      }
      rows.push(['Current spike', spikeText]);
    }
  } else {
    rows.push(['Following trip', 'None in this record']);
  }

  return `<div class="card yellow-accent"><div class="card-header">🔌 Close Attempt</div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
      <span style="font-size:13px;font-weight:700;color:${verdictColor};">${verdict}</span>
    </div>
    <table class="data-table"><tbody>
      ${rows.map(([k, v]) => `<tr><td style="font-weight:600;color:var(--text);white-space:nowrap;">${k}</td><td>${v}</td></tr>`).join('')}
    </tbody></table>
    ${haveTrace ? `<div style="margin-top:14px;">${buildCloseTraceSections(P, A)}</div>` : ''}
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════
// INVESTIGATION FLAGS PANEL
// ══════════════════════════════════════════════════════════════════════
// Renders A.investigationFlags (computed in analyzeCEV). Deliberately worded as
// observations, not instructions — no "check X" or "replace Y". Appears only when there's
// something to say; silent otherwise so it doesn't add noise to a routine, unambiguous trip.
function buildInvestigationPanel(P, A) {
  const flags = A?.investigationFlags || [];
  if (!flags.length) return '';
  const sevColor = { high: 'var(--red)', medium: 'var(--yellow)', info: 'var(--accent)' };
  const sevBg = { high: 'var(--red-dim)', medium: 'var(--yellow-dim)', info: 'var(--accent-dim)' };
  const sevBorder = { high: '#5c1414', medium: '#5c4506', info: '#123a5c' };
  return `<div class="tour-flags" style="margin-top:14px;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
      <span style="font-size:16px;">🔍</span>
      <span style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--text);">Flagged for Further Investigation</span>
    </div>
    ${flags.map(f => `
      <div style="background:${sevBg[f.severity] || sevBg.info};border:1px solid ${sevBorder[f.severity] || sevBorder.info};border-radius:8px;padding:12px 14px;margin-bottom:8px;">
        <div style="font-size:12.5px;font-weight:700;color:${sevColor[f.severity] || sevColor.info};margin-bottom:4px;">${f.title}</div>
        <div style="font-size:12px;color:var(--text-dim);line-height:1.55;">${f.detail}</div>
      </div>`).join('')}
  </div>`;
}

// Compact warning-only variant for the banner — appears ONLY when something is actually
// flagged, so it doesn't add noise to events where everything checks out normally.
function buildConsistencyWarningBanner(P, A) {
  const zeroCheck = computeConsistencyCheck(P, A, 'zero');
  const negCheck = computeConsistencyCheck(P, A, 'neg');
  const flaggedChecks = [zeroCheck, negCheck].filter(c => c && c.flagged);
  if (!flaggedChecks.length) return '';
  return `<div class="tour-flags" style="margin-top:14px;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
      <span style="font-size:16px;">🩺</span>
      <span style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--red);">Physical Consistency Warning</span>
    </div>
    ${flaggedChecks.map(c => renderConsistencyCheckBlock(c, { compact: true })).join('')}
  </div>`;
}