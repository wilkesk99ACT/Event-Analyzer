// SVG magnitude (current/voltage) chart renderer.

function renderMagnitudeChartSVG(traces, opts) {
  const n = traces[0]?.values.length || 0;
  if (!n) return `<div style="color:var(--text-muted);font-size:12px;padding:16px;">No waveform data available for this event.</div>`;

  const width = opts.width || 900, height = opts.height || 220;
  const marginLeft = opts.marginLeft ?? 48, marginRight = opts.marginRight ?? 96,
        marginTop = opts.marginTop ?? 16, marginBottom = opts.marginBottom ?? 28;
  const plotW = width - marginLeft - marginRight;
  const plotH = height - marginTop - marginBottom;

  let allVals = [];
  traces.forEach(t => { allVals = allVals.concat(t.values); });
  let minV = Math.min(...allVals);
  let maxV = Math.max(...allVals);
  if (opts.forceZeroBaseline) minV = Math.min(0, minV);
  const span = (maxV - minV) || 1;
  minV -= span * 0.06;
  maxV += span * 0.10;

  const xScale = i => marginLeft + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const yScale = v => marginTop + plotH - ((v - minV) / (maxV - minV)) * plotH;

  // Horizontal gridlines + value labels
  const numHGrid = opts.numHGrid ?? 5;
  const fontSize = opts.fontSize ?? 10;
  let gridLines = '', yLabels = '';
  for (let g = 0; g <= numHGrid; g++) {
    const v = minV + (g / numHGrid) * (maxV - minV);
    const y = yScale(v);
    gridLines += `<line x1="${marginLeft}" y1="${y.toFixed(1)}" x2="${marginLeft + plotW}" y2="${y.toFixed(1)}" stroke="var(--card-border)" stroke-width="1"/>`;
    yLabels += `<text x="${marginLeft - 6}" y="${(y + 3.2).toFixed(1)}" text-anchor="end" font-size="${fontSize}" fill="var(--text-dim)">${Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(1)}</text>`;
  }

  // Vertical gridlines + time labels
  const msPerSample = opts.msPerSample || 1;
  const numVGrid = opts.numVGrid ?? 6;
  let vGridLines = '', xLabels = '';
  for (let g = 0; g <= numVGrid; g++) {
    const idx = Math.round((g / numVGrid) * (n - 1));
    const x = xScale(idx);
    const ms = idx * msPerSample + (opts.xOffsetMs || 0);
    vGridLines += `<line x1="${x.toFixed(1)}" y1="${marginTop}" x2="${x.toFixed(1)}" y2="${marginTop + plotH}" stroke="var(--card-border)" stroke-width="1"/>`;
    xLabels += `<text x="${x.toFixed(1)}" y="${marginTop + plotH + (opts.compact ? 14 : 17)}" text-anchor="middle" font-size="${fontSize}" fill="var(--text-dim)">${ms.toFixed(0)}${opts.compact ? '' : ' ms'}</text>`;
  }

  // Trigger / trip markers, matching SynchroWAVe's dashed reference lines
  let markers = '';
  const markerFont = opts.compact ? 8 : 9;
  function drawMarker(idx, lineColor, dashArr, label, showBox) {
    if (idx == null || idx < 0 || idx >= n) return '';
    if (showBox == null) showBox = true;
    const x = xScale(idx);
    let out = `<line x1="${x.toFixed(1)}" y1="${marginTop}" x2="${x.toFixed(1)}" y2="${marginTop + plotH}" stroke="${lineColor}" stroke-width="1.5" stroke-dasharray="${dashArr}"/>`;
    if (!opts.compact && label) out += `<text x="${(x + 4).toFixed(1)}" y="${marginTop + 23}" font-size="${markerFont}" fill="${lineColor}">${label}</text>`;

    // Data-value box: a single boxed legend at this instant listing every trace's exact value
    // (color swatch + label + value), mirroring SynchroWAVe's cursor readout box — read the
    // whole point at a glance instead of tracing each line back to the axis.
    const dotR = opts.compact ? 2 : 2.6;
    const boxFont = opts.compact ? 8.5 : 10.5;
    const rowH = opts.compact ? 12.5 : 15.5;
    const padX = opts.compact ? 6 : 8, padY = opts.compact ? 5 : 7;
    const swatch = opts.compact ? 7 : 8.5;
    const rows = traces.map(t => {
      const v = t.values[idx];
      return (v == null || !isFinite(v)) ? null
        : { color: t.color, label: t.label, dotY: yScale(v), text: (Math.abs(v) < 10 ? v.toFixed(3) : v.toFixed(2)) + (opts.yUnit ? ' ' + opts.yUnit : '') };
    }).filter(Boolean);

    let dots = '';
    traces.forEach(t => {
      const v = t.values[idx];
      if (v == null || !isFinite(v)) return;
      dots += `<circle cx="${x.toFixed(1)}" cy="${yScale(v).toFixed(1)}" r="${dotR}" fill="${t.color}" stroke="var(--bg2)" stroke-width="1"/>`;
    });

    if (showBox && rows.length) {
      const longestChars = Math.max(...rows.map(r => r.label.length + r.text.length));
      const boxW = Math.min(plotW - 10, Math.max(opts.compact ? 88 : 108, longestChars * boxFont * 0.62 + swatch + padX * 2 + 10));
      const boxH = rows.length * rowH + padY * 2;

      // Find real clearance for a candidate box x-position: look at what the traces actually
      // do across that specific horizontal span (not just near this instant — a bump right at
      // it is often exactly when the trace is busiest, so the only genuinely clear band can be
      // well before or after it), and return the best of placing above vs. below that span's data.
      function clearanceAt(bx) {
        const idxStart = Math.max(0, Math.floor((bx - marginLeft) / plotW * (n - 1)));
        const idxEnd = Math.min(n - 1, Math.ceil((bx + boxW - marginLeft) / plotW * (n - 1)));
        let dataMinY = Infinity, dataMaxY = -Infinity;
        for (let i = idxStart; i <= idxEnd; i++) {
          traces.forEach(t => {
            const v = t.values[i];
            if (v != null && isFinite(v)) {
              const py = yScale(v);
              if (py < dataMinY) dataMinY = py;
              if (py > dataMaxY) dataMaxY = py;
            }
          });
        }
        if (dataMinY === Infinity) { dataMinY = marginTop; dataMaxY = marginTop; }
        const topClearance = dataMinY - marginTop, bottomClearance = (marginTop + plotH) - dataMaxY;
        const useTop = topClearance >= bottomClearance;
        return { useTop, score: (useTop ? topClearance : bottomClearance) - boxH, dataMinY, dataMaxY };
      }

      const clamp = bx => Math.max(marginLeft + 2, Math.min(marginLeft + plotW - boxW - 2, bx));
      // Step outward from this instant, alternating right/left, and take the FIRST position
      // that actually fits without overlapping data — i.e. as close as possible, only moving
      // further away when a nearer spot genuinely doesn't have room.
      const rightBase = x + 9, leftBase = x - boxW - 9;
      const step = 16;
      let best = null;
      for (let d = 0; d <= plotW; d += step) {
        for (const bx of [clamp(rightBase + d), clamp(leftBase - d)]) {
          const c = clearanceAt(bx);
          if (!best || c.score > best.score) best = Object.assign({ bx }, c);
          if (c.score >= 0) { best = Object.assign({ bx }, c); break; }
        }
        if (best && best.score >= 0) break;
      }
      const boxX = best.bx;
      const boxY = best.useTop
        ? Math.max(marginTop + 4, Math.min(marginTop + plotH - boxH - 4, best.dataMinY - boxH - 6))
        : Math.max(marginTop + 4, Math.min(marginTop + plotH - boxH - 4, best.dataMaxY + 6));

      // Connect each row to the exact point it's measuring — not just a single generic line to
      // this instant, but one per trace, from that row's position in the box to that trace's
      // own dot. Leaves from whichever box edge faces this instant.
      const edgeX = (boxX + boxW / 2 < x) ? boxX + boxW : boxX;
      let leaders = '';
      rows.forEach((r, i) => {
        const rowCenterY = boxY + padY + i * rowH + rowH / 2;
        leaders += `<line x1="${edgeX.toFixed(1)}" y1="${rowCenterY.toFixed(1)}" x2="${x.toFixed(1)}" y2="${r.dotY.toFixed(1)}" stroke="${r.color}" stroke-width="1" stroke-dasharray="2,2" opacity="0.55"/>`;
      });

      let rowsSvg = '';
      rows.forEach((r, i) => {
        const ry = boxY + padY + i * rowH + rowH * 0.72;
        rowsSvg += `<rect x="${(boxX + padX).toFixed(1)}" y="${(ry - swatch * 0.78).toFixed(1)}" width="${swatch}" height="${swatch}" fill="${r.color}" rx="1"/>`;
        rowsSvg += `<text x="${(boxX + padX + swatch + 5).toFixed(1)}" y="${ry.toFixed(1)}" font-size="${boxFont}" fill="var(--text-dim)">${r.label}</text>`;
        rowsSvg += `<text x="${(boxX + boxW - padX).toFixed(1)}" y="${ry.toFixed(1)}" text-anchor="end" font-size="${boxFont}" font-weight="600" fill="${r.color}">${r.text}</text>`;
      });
      out += leaders + `<rect x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH.toFixed(1)}" fill="rgba(6,9,15,0.94)" stroke="var(--card-border)" stroke-width="1" rx="4"/>${rowsSvg}`;
    }
    out += dots;
    return out;
  }
  if (opts.triggerIdx != null && opts.triggerIdx >= 0 && opts.triggerIdx < n) {
    const x = xScale(opts.triggerIdx);
    markers += `<line x1="${x.toFixed(1)}" y1="${marginTop}" x2="${x.toFixed(1)}" y2="${marginTop + plotH}" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="4,3"/>`;
    if (!opts.compact) markers += `<text x="${(x + 4).toFixed(1)}" y="${marginTop + 11}" font-size="${markerFont}" fill="#f59e0b">TRIG</text>`;
  }
  markers += drawMarker(opts.tripIdx, '#ef4444', '2,3', 'TRIP', SHOW_TRIP_VALUES || opts.cursorIdx == null);
  markers += drawMarker(opts.cursorIdx, '#38bdf8', '0', '');
  // A/B playback-window markers + shaded region between them. Solid green verticals with small
  // A/B caps; the band between is faintly tinted so the chosen play/GIF window reads at a glance.
  {
    const aX = (opts.markAIdx != null && opts.markAIdx >= 0 && opts.markAIdx < n) ? xScale(opts.markAIdx) : null;
    const bX = (opts.markBIdx != null && opts.markBIdx >= 0 && opts.markBIdx < n) ? xScale(opts.markBIdx) : null;
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

  // Trace polylines
  let polylines = '';
  traces.forEach(t => {
    const pts = t.values.map((v, i) => `${xScale(i).toFixed(1)},${yScale(v).toFixed(1)}`).join(' ');
    polylines += `<polyline points="${pts}" fill="none" stroke="${t.color}" stroke-width="${opts.compact ? 1.2 : 1.4}" opacity="0.95"/>`;
  });

  // Legend
  let legend = '';
  const legendSwatch = opts.compact ? 7 : 9;
  traces.forEach((t, i) => {
    const ly = marginTop + 6 + i * (opts.compact ? 12 : 15);
    legend += `<rect x="${width - marginRight + 10}" y="${ly - legendSwatch + 2}" width="${legendSwatch}" height="${legendSwatch}" fill="${t.color}"/>`;
    legend += `<text x="${width - marginRight + legendSwatch + 14}" y="${ly}" font-size="${fontSize}" fill="var(--text-dim)">${t.label}</text>`;
  });

  const bg = opts.bg || 'var(--bg2)';
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="width:100%;height:${height}px;background:${bg};border-radius:${opts.compact ? 6 : 8}px;display:block;">
    ${gridLines}${vGridLines}
    <rect x="${marginLeft}" y="${marginTop}" width="${plotW}" height="${plotH}" fill="none" stroke="var(--card-border)" stroke-width="1"/>
    ${polylines}
    ${markers}
    ${yLabels}${xLabels}
    ${legend}
    <text x="${marginLeft}" y="${opts.compact ? 9 : 12}" font-size="${fontSize}" fill="var(--text-muted)">${opts.yUnit}</text>
  </svg>`;
}

// Build the current-magnitude chart (IA.Mag/IB.Mag/IC.Mag) for a parsed+analyzed event.
// compact=true renders a small, banner-sidebar-sized version (own viewBox scaled to match
// its actual rendered size, so text stays legible — see note on renderMagnitudeChartSVG).
// Shared geometry for the three full-width banner charts (current mag, voltage mag,
// SV/flags). All three MUST use the same width/marginLeft/marginRight so their time
// axes land on identical pixel positions — that was the root cause of the earlier
// misalignment (each panel had picked its own margins to fit its own left/right
// content, which put "t=0" and "t=500ms" at different x positions per panel).
//
// BANNER_CHART_WIDTH used to be a fixed constant (1200), tuned to look right at roughly
// the width the banner happened to render at. On any OTHER window width — especially a
// wide monitor — that mismatch between the SVG's fixed logical viewBox width and its
// actual (CSS-stretched) rendered width forced a non-uniform horizontal scale, which is
// what made text and lines look "stretched"/blurry. Rather than capping the page to avoid
// ever hitting that mismatch, this now measures the REAL rendered width of the banner
// each time a chart is (re)built, so the viewBox always matches the actual pixel size —
// scale stays 1:1 in both directions at any window size, and the page itself stays fluid.
let BANNER_CHART_WIDTH = 1200;
const BANNER_CHART_MARGIN_LEFT = 110;  // must fit the longest SV/flag row label
const BANNER_CHART_MARGIN_RIGHT = 100; // must fit the magnitude charts' legend

// Measures the trip banner's actual current inner width (its own left/right padding, plus
// the mini-chart card's own left/right padding, subtracted out) and updates
// BANNER_CHART_WIDTH to match. Safe to call before any chart has been built yet — the
// banner element itself is present in the page skeleton from load, sized by CSS
// independently of its (possibly still-empty) content.
function updateBannerChartWidth() {
  const banner = document.getElementById('tripBanner');
  if (!banner) return;
  const TRIP_BANNER_PAD = 28, MINI_CHART_PAD = 12; // must match .trip-banner / .banner-mini-chart CSS
  const inner = banner.getBoundingClientRect().width - TRIP_BANNER_PAD * 2 - MINI_CHART_PAD * 2;
  if (inner > 0) BANNER_CHART_WIDTH = Math.round(inner);
}

// Re-measures and redraws every banner chart in place — used on window resize. Debounced
// since 'resize' can fire continuously while a window is actively being dragged.
let _bannerResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_bannerResizeTimer);
  _bannerResizeTimer = setTimeout(() => {
    if (!PARSED || !ANALYSIS) return;
    updateBannerChartWidth();
    ZOOM_KINDS.forEach(k => rerenderZoomChart(k));
  }, 150);
});

// ══════════════════════════════════════════════════════════════════════
// TIME-AXIS ZOOM/PAN — scroll to zoom, drag to pan, double-click to reset
// ══════════════════════════════════════════════════════════════════════
// CHART_ZOOM holds the current visible sample-index window per chart ('current'/'voltage'/
// 'relevant'), or null for the full record. CHART_GEOM holds the pixel/margin/index geometry
// from the MOST RECENT render of each chart, so the interaction handlers (registered once,
// globally, below) can convert a mouse position back into a sample index without duplicating
// layout constants. CHART_DRAG tracks an in-progress pan gesture.
