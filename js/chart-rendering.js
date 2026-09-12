function rerenderZoomChart(kind) {
  const slot = document.getElementById('chartSlot-' + kind);
  if (!slot || !PARSED || !ANALYSIS) return;
  let html;
  if (kind === 'current') html = buildCurrentMagChart(PARSED, ANALYSIS, true);
  else if (kind === 'voltage') html = buildVoltageMagChart(PARSED, ANALYSIS, true);
  else if (kind === 'relevant') html = buildRelevantQuantityChart(PARSED, ANALYSIS, true);
  else if (kind === 'svflags') html = buildSVFlagsChart(PARSED, ANALYSIS, true);
  if (!html) return;
  // The builder returns the whole wrapper (title + slot) — pull just the slot's inner content
  // back out rather than replacing the wrapper itself (which would also blow away the title's
  // "click to reset" badge listener we just fired from).
  const m = html.match(/<div class="chart-svg-slot"[^>]*>([\s\S]*?)<\/div>/);
  slot.innerHTML = m ? m[1] : html;
  const wrapperTitle = slot.parentElement && slot.parentElement.querySelector('.banner-mini-chart-title');
  if (wrapperTitle) {
    const hintMatch = html.match(/<div class="banner-mini-chart-title">([\s\S]*?)<\/div>/);
    if (hintMatch) wrapperTitle.innerHTML = hintMatch[1];
  }
  slot.style.cursor = CHART_ZOOM[kind] ? 'grab' : 'default';
}

function idxFromClientX(kind, clientX) {
  const geom = CHART_GEOM[kind];
  const slot = document.getElementById('chartSlot-' + kind);
  if (!geom || !slot) return null;
  const rect = slot.getBoundingClientRect();
  const svgX = (clientX - rect.left) / rect.width * geom.viewW;
  const plotW = geom.viewW - geom.marginLeft - geom.marginRight;
  if (svgX < geom.marginLeft || svgX > geom.marginLeft + plotW) return null;
  const frac = Math.max(0, Math.min(1, (svgX - geom.marginLeft) / plotW));
  return geom.startIdx + Math.round(frac * (geom.endIdx - geom.startIdx));
}

// Registered ONCE at module scope (not per-render) — mousemove/mouseup on `window` would
// otherwise accumulate a new listener every time an event is (re)loaded, since each of those
// calls rebuilds the banner's DOM but a window-level listener isn't part of that subtree and
// so never gets garbage-collected on its own.
window.addEventListener('mousemove', e => {
  if (CURSOR_DRAG) {
    const idx = idxFromClientX(CURSOR_DRAG.kind, e.clientX);
    if (idx != null) setCursorAll(idx);
    return;
  }
  if (!CHART_DRAG) return;
  const { kind, startClientX, startRange } = CHART_DRAG;
  const slot = document.getElementById('chartSlot-' + kind);
  const geom = CHART_GEOM[kind];
  if (!slot || !geom) return;
  const rect = slot.getBoundingClientRect();
  const plotW = geom.viewW - geom.marginLeft - geom.marginRight;
  const pxPerSample = (rect.width * (plotW / geom.viewW)) / Math.max(1, (startRange.end - startRange.start));
  if (!pxPerSample) return;
  const dSamples = -(e.clientX - startClientX) / pxPerSample;
  const len = startRange.end - startRange.start;
  let newStart = startRange.start + dSamples, newEnd = startRange.end + dSamples;
  if (newStart < 0) { newStart = 0; newEnd = len; }
  if (newEnd > geom.totalLen - 1) { newEnd = geom.totalLen - 1; newStart = newEnd - len; }
  setZoomAll({ start: Math.round(newStart), end: Math.round(newEnd) });
});
window.addEventListener('mouseup', () => {
  if (CHART_DRAG) {
    const slot = document.getElementById('chartSlot-' + CHART_DRAG.kind);
    if (slot) slot.style.cursor = CHART_ZOOM[CHART_DRAG.kind] ? 'grab' : 'default';
  }
  CHART_DRAG = null;
  CURSOR_DRAG = null;
});

// Attach scroll-to-zoom / drag-to-pan-or-move-cursor / double-click-to-reset to each of the
// four interactive banner charts. Safe to call after every render — the slots themselves are
// fresh DOM nodes each time (the banner's innerHTML was just fully replaced), so there's
// nothing stale to double-bind here; only the WINDOW-level handlers above need the
// "registered once" guard.
function wireChartInteractivity() {
  ZOOM_KINDS.forEach(kind => {
    const slot = document.getElementById('chartSlot-' + kind);
    if (!slot) return;
    slot.style.cursor = CHART_ZOOM[kind] ? 'grab' : 'default';

    slot.addEventListener('wheel', e => {
      const geom = CHART_GEOM[kind];
      if (!geom) return;
      const rect = slot.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const svgX = px / rect.width * geom.viewW;
      const plotW = geom.viewW - geom.marginLeft - geom.marginRight;
      if (svgX < geom.marginLeft || svgX > geom.marginLeft + plotW) return; // outside the plot (e.g. over the legend) — let the page scroll normally
      e.preventDefault();
      const frac = Math.max(0, Math.min(1, (svgX - geom.marginLeft) / plotW));
      const curLen = geom.endIdx - geom.startIdx;
      const cursorIdx = geom.startIdx + frac * curLen;
      const zoomFactor = e.deltaY < 0 ? 0.82 : 1.22; // scroll up = zoom in, down = zoom out
      let newLen = curLen * zoomFactor;
      newLen = Math.max(6, Math.min(geom.totalLen - 1, newLen));
      let newStart = cursorIdx - frac * newLen;
      let newEnd = newStart + newLen;
      if (newStart < 0) { newEnd -= newStart; newStart = 0; }
      if (newEnd > geom.totalLen - 1) { newStart -= (newEnd - (geom.totalLen - 1)); newEnd = geom.totalLen - 1; }
      newStart = Math.max(0, Math.round(newStart));
      newEnd = Math.min(geom.totalLen - 1, Math.round(newEnd));
      if (newEnd - newStart < 4) return;
      setZoomAll((newStart <= 0 && newEnd >= geom.totalLen - 1) ? null : { start: newStart, end: newEnd });
    }, { passive: false });

    // Dragging near the existing cursor line moves it; dragging elsewhere pans (if zoomed);
    // a plain click on empty space (not zoomed, no cursor nearby) plants the cursor there and
    // starts dragging it immediately, so click-and-drag from anywhere works in one motion.
    slot.addEventListener('mousedown', e => {
      const geom = CHART_GEOM[kind];
      const idx = idxFromClientX(kind, e.clientX);
      if (idx == null) return;
      const nearCursor = CURSOR_IDX != null && geom && Math.abs(idx - CURSOR_IDX) * ((slot.getBoundingClientRect().width) / Math.max(1, geom.endIdx - geom.startIdx)) < 10;
      if (nearCursor || !CHART_ZOOM[kind]) {
        CURSOR_DRAG = { kind };
        setCursorAll(idx);
        return;
      }
      CHART_DRAG = { kind, startClientX: e.clientX, startRange: { ...CHART_ZOOM[kind] } };
      slot.style.cursor = 'grabbing';
    });

    slot.addEventListener('dblclick', () => setZoomAll(null));
  });
}

// Slice a set of full-record traces down to a zoom window (or pass them through unchanged for
// the full view), re-deriving trigger/trip marker indices and the time-axis offset to match,
// and record the geometry needed to map a future mouse event back to a sample index.
function sliceChartWindow(kind, fullTraces, tripIdxFull, triggerIdxFull, msPerSample, zoomRange) {
  const totalLen = fullTraces[0]?.values.length || 0;
  const startIdx = zoomRange ? Math.max(0, Math.min(totalLen - 1, Math.round(zoomRange.start))) : 0;
  const endIdx = zoomRange ? Math.max(startIdx + 1, Math.min(totalLen - 1, Math.round(zoomRange.end))) : totalLen - 1;
  const slicedTraces = fullTraces.map(t => ({ label: t.label, color: t.color, values: t.values.slice(startIdx, endIdx + 1) }));
  const tripIdx = (tripIdxFull != null && tripIdxFull >= startIdx && tripIdxFull <= endIdx) ? tripIdxFull - startIdx : null;
  const triggerIdx = (triggerIdxFull != null && triggerIdxFull >= startIdx && triggerIdxFull <= endIdx) ? triggerIdxFull - startIdx : null;
  const cursorIdx = (CURSOR_IDX != null && CURSOR_IDX >= startIdx && CURSOR_IDX <= endIdx) ? CURSOR_IDX - startIdx : null;
  const markAIdx = (PLAY_MARK_A != null && PLAY_MARK_A >= startIdx && PLAY_MARK_A <= endIdx) ? PLAY_MARK_A - startIdx : null;
  const markBIdx = (PLAY_MARK_B != null && PLAY_MARK_B >= startIdx && PLAY_MARK_B <= endIdx) ? PLAY_MARK_B - startIdx : null;
  CHART_GEOM[kind] = {
    startIdx, endIdx, totalLen, msPerSample,
    marginLeft: BANNER_CHART_MARGIN_LEFT, marginRight: BANNER_CHART_MARGIN_RIGHT, viewW: BANNER_CHART_WIDTH,
  };
  return { slicedTraces, tripIdx, triggerIdx, cursorIdx, markAIdx, markBIdx, xOffsetMs: startIdx * msPerSample };
}

function buildCurrentMagChart(P, A, compact, heightOverride) {
  const data = P.analogData || [];
  if (!data.length) return '';
  const samplesPerCycle = P.eventInfo.samPerCycA || 32;
  const MAGS = P.magScale || 1;
  const msPerSample = 1000 / ((P.eventInfo.freq || 60) * samplesPerCycle);
  const unit = detectChannelUnit(P, ['IA'], 'A');

  const iaMag = computeRmsMagnitude(data.map(r => r.IA), samplesPerCycle, MAGS);
  const ibMag = computeRmsMagnitude(data.map(r => r.IB), samplesPerCycle, MAGS);
  const icMag = computeRmsMagnitude(data.map(r => r.IC), samplesPerCycle, MAGS);

  const tripIdxFull = A?.tripCause?.tripTransition?.analogSampleIdx ?? null;
  const triggerIdxFull = P.triggerSampleIndex ?? null;

  const traces = [
    { label: 'IA.Mag', color: '#ef4444', values: iaMag },
    { label: 'IB.Mag', color: '#3b82f6', values: ibMag },
    { label: 'IC.Mag', color: '#22c55e', values: icMag },
  ];

  if (compact) {
    const { slicedTraces, tripIdx, triggerIdx, cursorIdx, markAIdx, markBIdx, xOffsetMs } = sliceChartWindow('current', traces, tripIdxFull, triggerIdxFull, msPerSample, CHART_ZOOM.current);
    const svg = renderMagnitudeChartSVG(slicedTraces, {
      width: BANNER_CHART_WIDTH, height: heightOverride || 190,
      marginLeft: BANNER_CHART_MARGIN_LEFT, marginRight: BANNER_CHART_MARGIN_RIGHT,
      marginTop: 12, marginBottom: 22,
      numHGrid: 4, numVGrid: 8, fontSize: 12, msPerSample, yUnit: unit,
      forceZeroBaseline: true, triggerIdx, tripIdx, cursorIdx, markAIdx, markBIdx, compact: true, bg: 'var(--card)', xOffsetMs,
    });
    return `<div class="banner-mini-chart"><div class="banner-mini-chart-title">Current Magnitude${zoomHintHTML('current')}</div><div class="chart-svg-slot" id="chartSlot-current">${svg}</div></div>`;
  }

  const svg = renderMagnitudeChartSVG(traces, { msPerSample, yUnit: unit, forceZeroBaseline: true, triggerIdx: triggerIdxFull, tripIdx: tripIdxFull });
  return `<div class="card blue-accent"><div class="card-header">〰️ Current Magnitude (RMS envelope)</div>${svg}
    <div style="margin-top:8px;font-size:11px;color:var(--text-muted)">${magMethodNote(P)}</div>
  </div>`;
}

// Build the voltage-magnitude chart (VAY.Mag/VBY.Mag/VCY.Mag, or VA/VB/VC — whichever
// this file actually uses) for a parsed+analyzed event.
function buildVoltageMagChart(P, A, compact, heightOverride) {
  const data = P.analogData || [];
  if (!data.length) return '';
  const samplesPerCycle = P.eventInfo.samPerCycA || 32;
  const MAGS = P.magScale || 1;
  const msPerSample = 1000 / ((P.eventInfo.freq || 60) * samplesPerCycle);
  const labels = detectVoltageLabelSet(P);
  const unit = detectChannelUnit(P, ['VA', 'VAY', 'VB', 'VBY'], 'V');

  // Data is normalized into VAY/VBY/VCY slots during parsing regardless of the file's
  // own naming convention (VA vs VAY) — see getCol() fallback chain in parseCEV.
  const vaMag = computeRmsMagnitude(data.map(r => r.VAY), samplesPerCycle, MAGS);
  const vbMag = computeRmsMagnitude(data.map(r => r.VBY), samplesPerCycle, MAGS);
  const vcMag = computeRmsMagnitude(data.map(r => r.VCY), samplesPerCycle, MAGS);

  const tripIdxFull = A?.tripCause?.tripTransition?.analogSampleIdx ?? null;
  const triggerIdxFull = P.triggerSampleIndex ?? null;

  const traces = [
    { label: `${labels[0]}.Mag`, color: '#ef4444', values: vaMag },
    { label: `${labels[1]}.Mag`, color: '#3b82f6', values: vbMag },
    { label: `${labels[2]}.Mag`, color: '#22c55e', values: vcMag },
  ];

  if (compact) {
    const { slicedTraces, tripIdx, triggerIdx, cursorIdx, markAIdx, markBIdx, xOffsetMs } = sliceChartWindow('voltage', traces, tripIdxFull, triggerIdxFull, msPerSample, CHART_ZOOM.voltage);
    const svg = renderMagnitudeChartSVG(slicedTraces, {
      width: BANNER_CHART_WIDTH, height: heightOverride || 190,
      marginLeft: BANNER_CHART_MARGIN_LEFT, marginRight: BANNER_CHART_MARGIN_RIGHT,
      marginTop: 12, marginBottom: 22,
      numHGrid: 4, numVGrid: 8, fontSize: 12, msPerSample, yUnit: unit,
      forceZeroBaseline: false, triggerIdx, tripIdx, cursorIdx, markAIdx, markBIdx, compact: true, bg: 'var(--card)', xOffsetMs,
    });
    return `<div class="banner-mini-chart"><div class="banner-mini-chart-title">Voltage Magnitude${zoomHintHTML('voltage')}</div><div class="chart-svg-slot" id="chartSlot-voltage">${svg}</div></div>`;
  }

  const svg = renderMagnitudeChartSVG(traces, { msPerSample, yUnit: unit, forceZeroBaseline: false, triggerIdx: triggerIdxFull, tripIdx: tripIdxFull });
  return `<div class="card blue-accent"><div class="card-header">🔌 Voltage Magnitude (RMS envelope)</div>${svg}
    <div style="margin-top:8px;font-size:11px;color:var(--text-muted)">${magMethodNote(P)}</div>
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════
// SV / DIGITAL FLAGS PANEL — mimic SynchroWAVe's boolean state traces
// ══════════════════════════════════════════════════════════════════════
// SynchroWAVe shows each relevant digital point (e.g. 1:TRIP3P, 1:PB12_PUL) as a
// horizontal row: a thin flat line at "low", thickening into a solid bar whenever the
// point is asserted. This reconstructs that same view for whichever labels actually
// appear in the resolved trip-cause chain (the same chain shown in the sequence
// diagram), so the boolean trace lines up with — and explains — the sequence above it.

// Reconstruct the asserted-time intervals for one digital label across the whole
// record, in the same absolute-ms timeline the magnitude charts use.
//
// IMPORTANT: a digital transition object carries two different time references —
// `.timeMs` (derived from the digital sample rate, SAM/CYC_D) and `.analogSampleIdx`
// (the literal row index shared with `analogData`, captured at parse time from the
// exact same CSV row the hex digital word appeared on). These are NOT always the same
// instant: `.timeMs` is a modeled estimate assuming a uniform digital sample rate,
// while `.analogSampleIdx * msPerSample` is the precise, authoritative time of that
// exact row. Using `.timeMs` here (as an earlier version did) caused the boolean
// panel's bars to drift out of alignment with the magnitude charts by a few ms — small
// enough to miss on casual inspection, big enough to visibly offset a fast transition.
// Always derive time from analogSampleIdx so every panel shares one ground truth.
function computeAssertIntervals(P, label, totalMs, msPerSample) {
  let state = (P.initialDigitalState || []).includes(label);
  let start = state ? 0 : null;
  const intervals = [];
  for (const t of (P.digitalTransitions || [])) {
    const ch = t.changes.find(c => c.label === label);
    if (!ch) continue;
    const ms = t.analogSampleIdx * msPerSample;
    if (ch.asserted && !state) { state = true; start = ms; }
    else if (!ch.asserted && state) { state = false; intervals.push([start, ms]); start = null; }
  }
  if (state && start != null) intervals.push([start, totalMs]);
  return intervals;
}

// Render the boolean/digital-flags panel as horizontal step-bands, one per label.
// rows: [{label, intervals:[[startMs,endMs],...]}]
function renderBooleanFlagsSVG(rows, opts, P) {
  if (!rows.length) return `<div style="color:var(--text-muted);font-size:12px;padding:16px;">No trip-chain flags to display.</div>`;

  const width = opts.width || 460;
  const rowH = opts.rowH || 26;
  const marginLeft = opts.marginLeft ?? 96, marginRight = opts.marginRight ?? 14,
        marginTop = opts.marginTop ?? 10, marginBottom = opts.marginBottom ?? 18;
  const plotW = width - marginLeft - marginRight;
  const plotH = rows.length * rowH;
  const height = marginTop + plotH + marginBottom;
  const totalMs = opts.totalMs || 1;
  const startMs = opts.startMs ?? 0, endMs = opts.endMs ?? totalMs;
  const winMs = Math.max(1, endMs - startMs);
  const fontSize = opts.fontSize ?? 9.5;

  const xScale = ms => marginLeft + Math.max(0, Math.min(1, (ms - startMs) / winMs)) * plotW;

  // Vertical gridlines + time labels (shared bottom axis, same style as the magnitude charts)
  const numVGrid = opts.numVGrid ?? 5;
  let vGridLines = '', xLabels = '';
  for (let g = 0; g <= numVGrid; g++) {
    const ms = startMs + (g / numVGrid) * winMs;
    const x = xScale(ms);
    vGridLines += `<line x1="${x.toFixed(1)}" y1="${marginTop}" x2="${x.toFixed(1)}" y2="${marginTop + plotH}" stroke="var(--card-border)" stroke-width="1"/>`;
    xLabels += `<text x="${x.toFixed(1)}" y="${marginTop + plotH + 14}" text-anchor="middle" font-size="${fontSize}" fill="var(--text-dim)">${ms.toFixed(0)}${opts.compact ? '' : ' ms'}</text>`;
  }

  // Trigger / trip / cursor markers, matching the magnitude charts above for visual alignment
  let markers = '';
  const markerFont = opts.compact ? 8 : 9;
  if (opts.triggerMs != null) {
    const x = xScale(opts.triggerMs);
    markers += `<line x1="${x.toFixed(1)}" y1="${marginTop}" x2="${x.toFixed(1)}" y2="${marginTop + plotH}" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="4,3"/>`;
    if (!opts.compact) markers += `<text x="${(x + 4).toFixed(1)}" y="${marginTop + 11}" font-size="${markerFont}" fill="#f59e0b">TRIG</text>`;
  }
  // Draws a vertical marker at `ms` plus, per row, a dot/value showing that row's state right
  // at that instant — reused for both the fixed TRIP marker and the draggable cursor.
  function drawTimeMarker(ms, color, dashArr, label) {
    if (ms == null || ms < startMs || ms > endMs) return '';
    const x = xScale(ms);
    let out = `<line x1="${x.toFixed(1)}" y1="${marginTop}" x2="${x.toFixed(1)}" y2="${marginTop + plotH}" stroke="${color}" stroke-width="1.5" stroke-dasharray="${dashArr}"/>`;
    if (!opts.compact && label) out += `<text x="${(x + 4).toFixed(1)}" y="${marginTop + 23}" font-size="${markerFont}" fill="${color}">${label}</text>`;
    rows.forEach((row, i) => {
      const cy = marginTop + i * rowH + rowH / 2;
      const asserted = row.intervals.some(([s, e]) => ms >= s && ms <= e);
      const dotColor = asserted ? color : 'var(--text-muted)';
      out += `<circle cx="${x.toFixed(1)}" cy="${cy.toFixed(1)}" r="${opts.compact ? 2.5 : 3}" fill="${dotColor}"/>`;
      if (!opts.compact) out += `<text x="${(x + 6).toFixed(1)}" y="${(cy + 3).toFixed(1)}" font-size="${fontSize}" font-weight="600" fill="${dotColor}">${asserted ? '1' : '0'}</text>`;
    });
    return out;
  }
  markers += drawTimeMarker(opts.tripMs, '#ef4444', '2,3', 'TRIP');
  markers += drawTimeMarker(opts.cursorMs, '#38bdf8', '0', '');
  // A/B playback-window markers + shaded band, matching the magnitude charts' style.
  {
    const aOk = opts.markAMs != null && opts.markAMs >= startMs && opts.markAMs <= endMs;
    const bOk = opts.markBMs != null && opts.markBMs >= startMs && opts.markBMs <= endMs;
    const aX = aOk ? xScale(opts.markAMs) : null, bX = bOk ? xScale(opts.markBMs) : null;
    if (aX != null && bX != null) {
      const lo = Math.min(aX, bX), hi = Math.max(aX, bX);
      markers += `<rect x="${lo.toFixed(1)}" y="${marginTop}" width="${(hi - lo).toFixed(1)}" height="${plotH}" fill="var(--accent)" opacity="0.08"/>`;
    }
    const cap = (x, lbl) => {
      let s = `<line x1="${x.toFixed(1)}" y1="${marginTop}" x2="${x.toFixed(1)}" y2="${marginTop + plotH}" stroke="var(--green)" stroke-width="1.5"/>`;
      s += `<rect x="${(x - 5).toFixed(1)}" y="${(marginTop - 1).toFixed(1)}" width="10" height="11" fill="var(--green)" rx="2"/>`;
      s += `<text x="${x.toFixed(1)}" y="${(marginTop + 7.5).toFixed(1)}" text-anchor="middle" font-size="8" font-weight="700" fill="#04140c">${lbl}</text>`;
      return s;
    };
    if (aX != null) markers += cap(aX, 'A');
    if (bX != null) markers += cap(bX, 'B');
  }

  // Rows: baseline + solid asserted bars + left-hand label
  let rowsHTML = '';
  const barH = rowH * 0.44;
  rows.forEach((row, i) => {
    const cy = marginTop + i * rowH + rowH / 2;
    // Manually pinned rows are drawn in amber against the chain's blue. They are an operator's
    // hypothesis placed next to the relay's resolved logic, and a reader glancing at this chart
    // should never have to wonder which of the two a given row is.
    const rowColor = row.pinned ? 'var(--yellow)' : 'var(--accent)';
    rowsHTML += `<line x1="${marginLeft}" y1="${cy}" x2="${marginLeft + plotW}" y2="${cy}" stroke="${rowColor}" stroke-width="1" opacity="0.4"/>`;
    row.intervals.forEach(([s, e]) => {
      if (e < startMs || s > endMs) return; // outside the visible window
      const x1 = xScale(Math.max(s, startMs)), x2 = xScale(Math.min(e, endMs));
      rowsHTML += `<rect x="${x1.toFixed(1)}" y="${(cy - barH / 2).toFixed(1)}" width="${Math.max(1, x2 - x1).toFixed(1)}" height="${barH.toFixed(1)}" fill="${rowColor}" opacity="0.9" rx="1.5"/>`;
    });
    // A pinned bit that never asserts renders as a bare baseline, which is indistinguishable from
    // "asserted somewhere off-screen" or from a bit whose name didn't resolve. Say which it is —
    // "this bit never operates in this record" is frequently the answer being looked for.
    if (row.pinned && !row.intervals.length) {
      rowsHTML += `<text x="${(marginLeft + 6).toFixed(1)}" y="${(cy + 3.2).toFixed(1)}" font-size="${(fontSize - 1.5).toFixed(1)}" fill="var(--text-muted)" font-style="italic">never asserts in this record</text>`;
    } else if (row.pinned && !row.intervals.some(([s, e]) => e >= startMs && s <= endMs)) {
      rowsHTML += `<text x="${(marginLeft + 6).toFixed(1)}" y="${(cy + 3.2).toFixed(1)}" font-size="${(fontSize - 1.5).toFixed(1)}" fill="var(--text-muted)" font-style="italic">asserts outside this zoom window</text>`;
    }
    rowsHTML += `<text x="${marginLeft - 8}" y="${(cy + 3.2).toFixed(1)}" text-anchor="end" font-size="${fontSize}" font-family="var(--mono)" fill="${row.pinned ? 'var(--yellow)' : 'var(--text-dim)'}" class="svg-bit-label" onclick="event.stopPropagation(); showBitDetail('${row.label.replace(/'/g, "\\'")}');"><title>${(P ? (getSVTooltip(row.label, P) || '') : '').replace(/"/g, '&quot;') || 'Click for details'}</title>${row.label}</text>`;
  });

  const bg = opts.bg || 'var(--card)';
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="width:100%;height:${height}px;background:${bg};border-radius:${opts.compact ? 6 : 8}px;display:block;">
    ${vGridLines}
    <rect x="${marginLeft}" y="${marginTop}" width="${plotW}" height="${plotH}" fill="none" stroke="var(--card-border)" stroke-width="1"/>
    ${rowsHTML}
    ${markers}
    ${xLabels}
  </svg>`;
}

// ══════════════════════════════════════════════════════════════════════
// "MOST RELEVANT QUANTITY" PANEL — the derived signal that actually explains the trip
// ══════════════════════════════════════════════════════════════════════
// The Current/Voltage magnitude charts always show the same six phase quantities,
// which is fine for phase overcurrent/over-under-voltage trips but can look almost
// flat for sequence-component or ground/frequency trips — e.g. a 3V0 (zero-sequence)
// overvoltage trip can have all three phase voltages sitting near nominal right up to
// the trip. This panel shows whichever derived quantity actually corresponds to
// A.tripCause.family, computed fresh from the same raw analog samples.
function buildRelevantQuantityChart(P, A, compact, heightOverride) {
  const data = P.analogData || [];
  const family = A?.tripCause?.family;
  if (!data.length || !family) return '';

  const samplesPerCycle = P.eventInfo.samPerCycA || 32;
  const MAGS = P.magScale || 1;
  const msPerSample = 1000 / ((P.eventInfo.freq || 60) * samplesPerCycle);
  const tripIdxFull = A?.tripCause?.tripTransition?.analogSampleIdx ?? null;
  const triggerIdxFull = P.triggerSampleIndex ?? null;

  let traces = [], title = '', yUnit = '', forceZeroBaseline = true, note = '';

  if (family === 'zeroSeqV' || family === 'zeroSeqV+negSeqV') {
    // 3V0 = Va + Vb + Vc, instantaneously — no phasor transform needed, since summing
    // three time-domain waveforms IS the zero-sequence (residual) voltage directly.
    const sum = data.map(r => (r.VAY || 0) + (r.VBY || 0) + (r.VCY || 0));
    const mag = computeRmsMagnitude(sum, samplesPerCycle, MAGS);
    traces.push({ label: '3V0.Mag', color: '#f59e0b', values: mag });
    title = 'Zero-Sequence Voltage (3V0)';
    yUnit = detectChannelUnit(P, ['VA', 'VAY', 'VB', 'VBY'], 'V');
    note = '3V0 is the instantaneous sum of the three phase voltages — near zero when balanced, and the quantity 59G/59N/59YN elements actually monitor.';
  }
  if (family === 'negSeqV' || family === 'zeroSeqV+negSeqV') {
    const v2 = computeNegSeqMagnitude(data.map(r => r.VAY), data.map(r => r.VBY), data.map(r => r.VCY), samplesPerCycle, MAGS);
    traces.push({ label: 'V2.Mag', color: '#a78bfa', values: v2 });
    title = traces.length > 1 ? 'Zero + Negative-Sequence Voltage' : 'Negative-Sequence Voltage (V2)';
    yUnit = detectChannelUnit(P, ['VA', 'VAY', 'VB', 'VBY'], 'V');
    note = 'V2 is the negative-sequence voltage, computed via a Fortescue transform from each phase\'s fundamental-frequency phasor — the quantity 59Q elements monitor.';
  }
  if (family === 'groundI') {
    const unit = detectChannelUnit(P, ['IA'], 'A');
    const hasIN = data.some(r => Math.abs(r.IN || 0) > 0.01);
    const hasIG = data.some(r => Math.abs(r.IG || 0) > 0.01);
    if (hasIN) traces.push({ label: 'IN.Mag', color: '#f59e0b', values: computeRmsMagnitude(data.map(r => r.IN), samplesPerCycle, MAGS) });
    if (hasIG) traces.push({ label: 'IG.Mag', color: '#a78bfa', values: computeRmsMagnitude(data.map(r => r.IG), samplesPerCycle, MAGS) });
    if (!traces.length) return ''; // neither channel actually populated in this file
    title = 'Ground / Neutral Current';
    yUnit = unit;
    note = 'IN/IG are the ground-path currents that 50G/51G (ground) elements monitor directly, distinct from the phase currents above.';
  }
  if (family === 'negSeqI') {
    const unit = detectChannelUnit(P, ['IA'], 'A');
    const i2 = computeNegSeqMagnitude(data.map(r => r.IA), data.map(r => r.IB), data.map(r => r.IC), samplesPerCycle, MAGS);
    traces.push({ label: 'I2.Mag', color: '#a78bfa', values: i2 });
    title = 'Negative-Sequence Current (I2)';
    yUnit = unit;
    note = 'I2 is the negative-sequence current, computed via a Fortescue transform — the quantity 50Q/51Q/67Q elements and open-phase detection monitor.';
  }
  if (family === 'freq') {
    traces.push({ label: 'FREQ', color: '#22c55e', values: data.map(r => r.FREQ || 0) });
    title = 'Frequency';
    yUnit = 'Hz';
    forceZeroBaseline = false;
    note = 'System frequency as tracked by the relay — the quantity 81D (level) and 81R (rate-of-change) elements monitor.';
  }

  if (!traces.length) return '';

  if (compact) {
    const { slicedTraces, tripIdx, triggerIdx, cursorIdx, markAIdx, markBIdx, xOffsetMs } = sliceChartWindow('relevant', traces, tripIdxFull, triggerIdxFull, msPerSample, CHART_ZOOM.relevant);
    const svg = renderMagnitudeChartSVG(slicedTraces, {
      width: BANNER_CHART_WIDTH, height: heightOverride || 190,
      marginLeft: BANNER_CHART_MARGIN_LEFT, marginRight: BANNER_CHART_MARGIN_RIGHT,
      marginTop: 12, marginBottom: 22,
      numHGrid: 4, numVGrid: 8, fontSize: 12, msPerSample, yUnit,
      forceZeroBaseline, triggerIdx, tripIdx, cursorIdx, markAIdx, markBIdx, compact: true, bg: 'var(--card)', xOffsetMs,
    });
    return `<div class="banner-mini-chart"><div class="banner-mini-chart-title">${title}${zoomHintHTML('relevant')}</div><div class="chart-svg-slot" id="chartSlot-relevant">${svg}</div></div>`;
  }

  const svg = renderMagnitudeChartSVG(traces, { msPerSample, yUnit, forceZeroBaseline, triggerIdx: triggerIdxFull, tripIdx: tripIdxFull });
  return `<div class="card blue-accent"><div class="card-header">🎯 ${title}</div>${svg}
    <div style="margin-top:8px;font-size:11px;color:var(--text-muted)">${note}</div>
  </div>`;
}