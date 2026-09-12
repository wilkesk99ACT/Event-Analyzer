
// A duplicated fan-out leaf carries a synthetic id like "52A\u0001dup3" so multiple copies stay
// distinct nodes; everywhere a node's DISPLAY label or true-state is needed, this recovers the
// original bit name. Harmless on ordinary ids (returns them unchanged).
function llgDisplayLabel(nodeId) {
  const i = nodeId.indexOf('\u0001');
  return i === -1 ? nodeId : nodeId.slice(0, i);
}

// Finds every [startIdx, endIdx] window (digital-sample-index units) where a priority edge's
// timer is genuinely running — a base bit's assertion paired with its timed output's NEXT
// matching transition, same pairing rule as timedPhaseFor in renderLocalLogicGraph, just applied
// across the WHOLE record up front rather than "as of right now". Without this, a GIF export
// would only ever land a frame at the transitions that bookend a timer (nothing else changes
// DURING the delay itself), so the animation would jump straight from 0% to 100% with nothing
// visible in between — this is what lets the export insert real in-between frames.
function findTimerAnimationWindows(P, graph) {
  const trans = P.digitalTransitions || [];
  const windows = [];
  const samplesPerCyc = P.eventInfo?.samPerCycD || 4;
  (graph?.edges || []).forEach(e => {
    if (e.priority) {
      const base = llgDisplayLabel(e.from), target = llgDisplayLabel(e.to);
      for (let i = 0; i < trans.length; i++) {
        const c = trans[i].changes.find(ch => ch.label === base);
        if (!c) continue;
        const startIdx = trans[i].digitalSampleIdx;
        const want = c.asserted;
        let endIdx = null, aborted = false;
        for (let j = i + 1; j < trans.length; j++) {
          const cb = trans[j].changes.find(ch => ch.label === base);
          if (cb && cb.asserted !== want) { aborted = true; break; }
          const ct = trans[j].changes.find(ch => ch.label === target);
          if (ct && ct.asserted === want) { endIdx = trans[j].digitalSampleIdx; break; }
        }
        if (!aborted && endIdx != null && endIdx > startIdx) windows.push({ startIdx, endIdx });
      }
      return;
    }
    // An SV's own pickup/dropout delay (see svOwnDelayPhaseFor in renderLocalLogicGraph) — the
    // exact delay is already known from settings, so this doesn't need to search for a
    // confirming future transition the way the priority-edge case above does; it just windows
    // [transition, transition + delay] for every relevant change of this edge's own source bit.
    // A little more generous than strictly necessary for an AND-group member that wasn't
    // actually the one completing the condition — harmless, since those extra frames simply
    // render as already-fully-settled (svOwnDelayPhaseFor's own fraction clamp handles that).
    const target = llgDisplayLabel(e.to);
    const svm = target.match(/^SV(\d+)$/);
    if (!svm) return;
    const sv = (P.svSettings || []).find(s => s.num === parseInt(svm[1]));
    if (!sv) return;
    const base = llgDisplayLabel(e.from);
    const wantNot = /\bNOT\b/.test(e.mod || '');
    trans.forEach(t => {
      const c = t.changes.find(ch => ch.label === base);
      if (!c) return;
      const groupGoingTrue = wantNot ? !c.asserted : c.asserted;
      const delayCyc = groupGoingTrue ? (sv.pickupDelay || 0) : (sv.dropoutDelay || 0);
      if (!delayCyc) return;
      const startIdx = t.digitalSampleIdx;
      windows.push({ startIdx, endIdx: startIdx + Math.round(delayCyc * samplesPerCyc) });
    });
  });
  return windows;
}
// Given a set of timer windows, returns extra sample indices (roughly `perWindow` of them,
// evenly spaced) to insert into a GIF's frame list so each window's animation is actually
// visible rather than jumping straight from start to finish. Capped at `maxTotal` extra frames
// overall (spread proportionally across windows) so a chart with a LOT of timer windows can't
// balloon a GIF's frame count/export time unreasonably — a smoother animation is a nice-to-have,
// not worth the export becoming slow or huge.
function timerWindowSampleIdxs(windows, perWindow, maxTotal) {
  maxTotal = maxTotal || 150;
  const perWin = windows.length ? Math.max(2, Math.min(perWindow, Math.floor(maxTotal / windows.length) + 1)) : perWindow;
  const extra = [];
  windows.forEach(w => {
    const span = w.endIdx - w.startIdx;
    for (let k = 1; k < perWin; k++) {
      const idx = Math.round(w.startIdx + (span * k) / perWin);
      if (idx > w.startIdx && idx < w.endIdx) extra.push(idx);
    }
  });
  return extra.slice(0, maxTotal);
}

// Inserts extra evenly-spaced sample indices wherever the gap between two ALREADY-selected GIF
// frames would otherwise be held for longer than maxGapMs of simulated playback time (accounting
// for playback speed/time-dilation) — this is the main lever for overall exported-GIF smoothness,
// not just the timer animation specifically: a cursor/marker sweeping across a long quiet stretch
// with no recorded transitions would otherwise jump straight from one end of that stretch to the
// other in a single cut. Capped at maxExtra total inserted frames so a long, mostly-quiet record
// can't balloon the export.
function smoothFrameGaps(frameIdxs, msPerSample, playbackSpeed, timeDilation, maxGapMs, maxExtra) {
  const extra = [];
  const speedDiv = Math.max(0.0001, playbackSpeed * timeDilation);
  for (let i = 0; i < frameIdxs.length - 1 && extra.length < maxExtra; i++) {
    const a = frameIdxs[i], b = frameIdxs[i + 1];
    const gapMs = (b - a) * msPerSample / speedDiv;
    if (gapMs <= maxGapMs) continue;
    const parts = Math.min(20, Math.ceil(gapMs / maxGapMs));
    for (let k = 1; k < parts && extra.length < maxExtra; k++) extra.push(Math.round(a + ((b - a) * k) / parts));
  }
  return extra;
}

// Shortens a long, uneventful trailing hold — e.g. several quiet real seconds after the last
// actual bit change before the record/window's own end — down to a fixed, short pause (default
// ~1.5s of simulated playback time) instead of letting the export run all the way out to the
// literal end. That trailing dead time was BOTH extra real minutes of nothing happening in the
// GIF AND (once the general smoothness pass exists) a single huge gap that pass would otherwise
// subdivide into a pile of frames just to sweep a cursor across flat, uninteresting data. Only
// applied when the window's end wasn't explicitly chosen by the user (an explicit A/B end is
// respected as-is, even if it runs long — that was a deliberate choice, not a default).
function cappedTailEnd(transitionIdxs, start, end, msPerSample, playbackSpeed, timeDilation, endWasExplicit, holdMs) {
  if (endWasExplicit) return end;
  const inRange = transitionIdxs.filter(i => i >= start && i <= end);
  const lastActivity = inRange.length ? Math.max(...inRange) : start;
  const speedDiv = Math.max(0.0001, playbackSpeed * timeDilation);
  const tailCapSamples = ((holdMs || 1500) * speedDiv) / msPerSample;
  return Math.min(end, Math.round(lastActivity + tailCapSamples));
}

// True when `label` is the trip bit itself, another terminal command bit, or something the
// trip equation references directly — the cases where seeing the FULL chain (not just a
// handful of hops) actually matters for diagnosing why the relay tripped.
function isTripFocusLabel(label, P) {
  const tripName = P.tripEquationName || 'TR';
  if (label === tripName || label === 'TR3X' || isTerminalBit(label, P)) return true;
  // Prefer the ACTUAL resolved cause for this specific event, when one is available — a bit
  // genuinely on the causal chain (the immediate cause itself, or any label the chain-building
  // logic recorded en route to it) gets the full, unfiltered chart; everything else — including
  // other alternatives that merely happen to share the same top-level OR — gets the scoped view.
  const cause = (typeof ANALYSIS !== 'undefined') ? ANALYSIS?.tripCause : null;
  if (cause) {
    if (label === cause.immediateCause) return true;
    if ((cause.causeChain || []).some(c => c.label === label)) return true;
    return false;
  }
  // No resolved cause to key off (e.g. an event-report-only record, or cause couldn't be
  // determined) — fall back to "referenced directly by the top-level trip equation" so browsing
  // still gets SOME full-detail context rather than everything being aggressively pruned.
  const { eqByLabel } = getEquationRefIndex(P);
  const tokensOf = eq => (eq.match(/\bAND\b|\bOR\b|\bNOT\b|\bR_TRIGGER\b|\bF_TRIGGER\b|\bR_TRIG\b|\bF_TRIG\b|[A-Za-z0-9_]+/g) || [])
    .filter(t => !SELOGIC_KEYWORDS.has(t));
  const tripEq = eqByLabel[tripName];
  if (tripEq && tokensOf(tripEq).includes(label)) return true;
  const tripEqX = eqByLabel['TR3X'];
  if (tripEqX && tokensOf(tripEqX).includes(label)) return true;
  return false;
}

function getTripRelevantLabels(P, A) {
  const cause = A?.tripCause;
  const set = new Set();
  if (cause?.causeChain?.length) {
    cause.causeChain.forEach(c => set.add(c.label));
    if (cause.immediateCause) set.add(cause.immediateCause);
    const last = cause.causeChain[cause.causeChain.length - 1]?.label;
    if (last) set.add(last);
  }
  ['CLOSE', 'CL', 'CC', 'ER', '52A3P', '52A', '52B'].forEach(l => {
    if ((P.digitalLabels || []).includes(l) && (P.digitalTransitions || []).some(t => t.changes.some(c => c.label === l))) {
      set.add(l);
    }
  });
  return set;
}

// The labels the ANALYSIS puts on the flags chart on its own: the resolved trip-cause chain plus
// the small "relevant to this trip" set. Split out from buildSVFlagsChart so the bit picker can
// mark these as "already shown" instead of letting a click on one look like it did nothing.
function svflagsBaseLabels(P, A) {
  const cause = A?.tripCause;
  if (!cause || !cause.causeChain?.length) return [];
  const seen = new Set();
  const labels = cause.causeChain.map(c => c.label).filter(l => { if (seen.has(l)) return false; seen.add(l); return true; });
  [cause.immediateCause, cause.causeChain[cause.causeChain.length - 1]?.label].filter(Boolean)
    .forEach(l => { if (!labels.includes(l)) labels.push(l); });
  getTripRelevantLabels(P, A).forEach(l => { if (!labels.includes(l)) labels.push(l); });
  // For every timed bit on the chart, also show the raw input that started its timer (27PP1T ->
  // 27PP1, SV07T -> SV07). The gap between the two IS the timer, and reading it off the chart is
  // the whole point of plotting a timed bit — showing only the timed form hides both when the
  // condition arose and how long the relay waited. Inserted directly ahead of its timed output;
  // the chronological row sort then puts them in the order they actually happened.
  // Only bits this file records are added, so this never introduces a permanently-blank row.
  const recorded = new Set((P.digitalLabels || []).filter(l => l && l !== '*'));
  for (let i = 0; i < labels.length; i++) {
    const input = timedBitInputLabel(labels[i], P);
    if (input && recorded.has(input) && !labels.includes(input)) labels.splice(i++, 0, input);
  }
  return labels;
}

function buildSVFlagsChart(P, A, compact) {
  const data = P.analogData || [];
  const cause = A?.tripCause;
  // A pinned bit is reason enough to draw the chart even when no trip cause resolved — that case
  // (an ER-only record, or logic this build can't resolve) is exactly when manually plotting a
  // few bits is the only way to see the sequence at all.
  if (!data.length || (!(cause && cause.causeChain?.length) && !EXTRA_FLAG_BITS.length)) return '';

  const samplesPerCycle = P.eventInfo.samPerCycA || 32;
  const msPerSample = 1000 / ((P.eventInfo.freq || 60) * samplesPerCycle);
  const totalMs = (data.length - 1) * msPerSample;

  // Same de-dup + ordering as the sequence diagram. Every bit in the resolved chain is shown —
  // no length cap. The bit directly responsible for the trip (immediateCause, e.g. "SV14T")
  // and the final trip/ER label (e.g. "TRIP3P" or "ER") are guaranteed to be present even if
  // the chain summary didn't already include them under that exact name.
  // The analysis's own set (resolved chain + the "relevant to this trip" bits, the same set the
  // Event Timeline's filter uses so the two features agree on what counts) ...
  let labels = svflagsBaseLabels(P, A);

  // ... then whatever the operator pinned via the picker, appended and flagged so they are drawn
  // in a distinct colour. Keeping them visually separate matters: the chart is read as "what the
  // relay's logic did", and a hand-added bit is an operator's hypothesis sitting next to it, not
  // part of the resolved cause.
  const pinnedSet = new Set();
  EXTRA_FLAG_BITS.forEach(l => { if (!labels.includes(l)) { labels.push(l); pinnedSet.add(l); } });

  const rows = labels
    .map(label => ({ label, pinned: pinnedSet.has(label), intervals: computeAssertIntervals(P, label, totalMs, msPerSample) }))
    // Chronological, top to bottom: whichever bit asserts earliest in the record is drawn
    // first, matching how an operator would actually narrate the sequence of events. A bit
    // already asserted at t=0 sorts first (interval start 0); one that never actually asserts
    // sorts last rather than disrupting the ordering.
    .sort((a, b) => (a.intervals[0]?.[0] ?? Infinity) - (b.intervals[0]?.[0] ?? Infinity));
  labels = rows.map(r => r.label);

  // Small, plain-text legend for every bit shown above — compact enough to sit directly under
  // the chart and still fit comfortably in a normal screenshot alongside it. An SVxxT entry is
  // skipped when its bare SVxx counterpart is also in the legend — both resolve to the exact
  // same equation/comment text, so showing both is pure repetition; the CHART rows above still
  // show both traces, since their timing relative to each other is genuinely meaningful.
  const freqForLegend = P.eventInfo?.freq || 60;
  const legendLabels = labels.filter(l => {
    const m = l.match(/^SV(\d+)T$/);
    return !(m && labels.includes(`SV${m[1]}`));
  });
  const pinnedNote = pinnedSet.size
    ? `<span class="sv-legend-item svflags-legend-note">Rows in amber were added manually and are not part of the resolved trip cause.</span>` : '';
  const legendHTML = `<div class="sv-legend">${legendLabels.map(l => {
    const svM = l.match(/^SV(\d+)T?$/);
    const sv = svM ? (P.svSettings || []).find(s => s.num === parseInt(svM[1])) : null;
    let short;
    if (sv) {
      const info = describeSVLogic(sv);
      short = info.isBlinker ? 'Blinker (self-oscillating; flashes a target/LED — no diagnostic meaning)'
        : info.comment || (info.referencedName ? `Wraps ${info.referencedName}` : `Logic variable ${sv.label}`);
    } else {
      const el = explainElementBit(l, P, freqForLegend);
      short = el ? el.short : (getSVTooltip(l, P) || l);
    }
    const eq = sv ? `<span class="sv-legend-eq">[${linkifyEquationBits(sv.equation.split('#')[0].trim(), P)}]</span> ` : '';
    return `<span class="sv-legend-item">${tt(l, P)}: ${eq}${short}</span>`;
  }).join('')}${pinnedNote}</div>`;

  const tripTransition = cause?.tripTransition;
  // Use analogSampleIdx here too (not tripTransition.timeMs) so the TRIP marker lands
  // at the exact same x position as it does in the magnitude charts above.
  const tripMs = (tripTransition?.analogSampleIdx != null) ? tripTransition.analogSampleIdx * msPerSample : null;
  const triggerMs = (P.triggerSampleIndex != null && P.triggerSampleIndex >= 0) ? P.triggerSampleIndex * msPerSample : null;
  const totalLen = data.length;
  const zr = CHART_ZOOM.svflags;
  const startIdx = zr ? Math.max(0, Math.min(totalLen - 1, Math.round(zr.start))) : 0;
  const endIdx = zr ? Math.max(startIdx + 1, Math.min(totalLen - 1, Math.round(zr.end))) : totalLen - 1;
  const startMs = startIdx * msPerSample, endMs = endIdx * msPerSample;
  const cursorMs = CURSOR_IDX != null ? CURSOR_IDX * msPerSample : null;
  const markAMs = PLAY_MARK_A != null ? PLAY_MARK_A * msPerSample : null;
  const markBMs = PLAY_MARK_B != null ? PLAY_MARK_B * msPerSample : null;
  CHART_GEOM.svflags = { startIdx, endIdx, totalLen, msPerSample, marginLeft: BANNER_CHART_MARGIN_LEFT, marginRight: BANNER_CHART_MARGIN_RIGHT, viewW: BANNER_CHART_WIDTH };

  if (compact) {
    const svg = renderBooleanFlagsSVG(rows, {
      width: BANNER_CHART_WIDTH,
      marginLeft: BANNER_CHART_MARGIN_LEFT, marginRight: BANNER_CHART_MARGIN_RIGHT,
      marginTop: 12, marginBottom: 24,
      rowH: 30, numVGrid: 8, fontSize: 12, totalMs, startMs, endMs, triggerMs, tripMs, cursorMs, markAMs, markBMs, compact: true, bg: 'var(--card)',
    }, P);
    return `<div class="banner-mini-chart"><div class="banner-mini-chart-title">SV / Trip Chain Flags${zoomHintHTML('svflags')}</div><div class="chart-svg-slot" id="chartSlot-svflags">${svg}</div>${svflagsPickerHTML(P, A)}${legendHTML}</div>`;
  }

  const svg = renderBooleanFlagsSVG(rows, { totalMs, triggerMs, tripMs, marginLeft: 110 }, P);
  return `<div class="card blue-accent"><div class="card-header">🔗 SV / Trip Chain Flags</div>${svg}${svflagsPickerHTML(P, A)}${legendHTML}
    <div style="margin-top:8px;font-size:11px;color:var(--text-muted)">Boolean state of each element in the resolved trip-cause chain, reconstructed from digital transitions across the full record. Use <b>+ Add bit</b> to plot any other bit in the record alongside it.</div>
  </div>`;
}