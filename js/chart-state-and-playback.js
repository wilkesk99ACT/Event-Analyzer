
// ══════════════════════════════════════════════════════════════════════
// TIME-AXIS ZOOM/PAN — scroll to zoom, drag to pan, double-click to reset
// ══════════════════════════════════════════════════════════════════════
// CHART_ZOOM holds the current visible sample-index window per chart ('current'/'voltage'/
// 'relevant'), or null for the full record. CHART_GEOM holds the pixel/margin/index geometry
// from the MOST RECENT render of each chart, so the interaction handlers (registered once,
// globally, below) can convert a mouse position back into a sample index without duplicating
// layout constants. CHART_DRAG tracks an in-progress pan gesture.
const CHART_ZOOM = {};
const CHART_GEOM = {};
let CHART_DRAG = null;
let CURSOR_IDX = null;   // full-record sample index of the draggable measurement cursor, or null (hidden)
let CURSOR_DRAG = null;  // { kind } while actively dragging the cursor line
// Main-page playback: A/B markers bound the play/GIF window (full-record ANALOG sample indices,
// or null when unset), and MAIN_PLAY_TIMER holds the running playback interval. MARKER_DRAG
// tracks dragging one of the A/B markers.
let PLAY_MARK_A = null, PLAY_MARK_B = null;
// Which bit's logic graph the main-page charted-logic slot shows, and how — null CHARTED_BIT
// means "use the default (the resolved trip/ER cause)". CHARTED_FILTER_RELEVANT true shows the
// same kind of pruned, causally-relevant tree as the resolved trip cause (just rooted at
// whatever bit is chosen); false shows the fuller, unpruned local logic graph — the same one
// the per-bit tooltip popup uses — for that bit instead.
let CHARTED_BIT = null;

// ── USER-PINNED BITS ON THE SV / TRIP CHAIN FLAGS CHART ──────────────────────
// The flags chart shows the bits the analysis resolved as the trip cause plus the small
// "relevant to this trip" set. That is the right default, but it is a CONCLUSION — and checking a
// conclusion means being able to plot a bit the analysis did NOT pick, precisely because you
// suspect it matters. EXTRA_FLAG_BITS holds whatever the operator pinned, in the order pinned,
// and survives zooming, cursor moves and playback (it is read fresh on every rebuild).
// Deliberately NOT persisted across loading a different event: the bit names are file-specific
// and a stale pin would silently render as a permanently-low row on the next record.
let EXTRA_FLAG_BITS = [];
// Set only for the duration of a GIF/PNG export, so the picker chrome (which is interactive and
// meaningless in a still image) is left out of exported frames while the pinned ROWS stay in.
let SVFLAGS_HIDE_PICKER = false;
let CHARTED_FILTER_RELEVANT = true;
// Captured by renderBanner each render — the plain sequence-diagram fallback used only when the
// DEFAULT bit has no bakeable logic tree at all (mirrors the tool's original fallback).
let LAST_SEQ_HTML = '';
let MAIN_PLAY_TIMER = null;
let MARKER_DRAG = null;   // { which: 'A'|'B', kind } while dragging a range marker
// Whether to keep showing the trip-instant's own value-readout box even while a cursor is also
// active (scrubbing/playing) — off by default, since the two boxes competing for the same space
// is what prompted suppressing the trip box in the first place, but now user-toggleable back on.
let SHOW_TRIP_VALUES = false;
const ZOOM_KINDS = ['current', 'voltage', 'relevant', 'svflags'];

function resetChartZoom() {
  ZOOM_KINDS.forEach(k => { CHART_ZOOM[k] = null; });
  CURSOR_IDX = null;
  if (typeof stopMainPlay === 'function') stopMainPlay();
  PLAY_MARK_A = null; PLAY_MARK_B = null;
  if (typeof setLogicChartViewIdx === 'function') setLogicChartViewIdx(null);
  if (typeof redrawMainLogicTree === 'function') redrawMainLogicTree();
  if (typeof refreshProtectionTab === 'function') refreshProtectionTab(null);
}

// Small title-bar hint/badge — shows a static hint on the full view, and a "reset" affordance
// once zoomed in (functionally identical to double-click, for anyone who doesn't know that
// gesture is available).
function zoomHintHTML(kind) {
  if (CHART_ZOOM[kind]) {
    return ` <span class="zoom-badge" onclick="event.stopPropagation(); CHART_ZOOM['${kind}']=null; rerenderZoomChart('${kind}');" title="Double-click the chart to reset zoom">🔍 zoomed — click to reset</span>`;
  }
  return ` <span class="zoom-hint">scroll to zoom · drag to pan</span>`;
}

// Re-invoke the correct chart builder with the current zoom state and swap just the SVG
// slot's contents — the wrapping card/title (and its event listeners) stay in place.
function setZoomAll(range) {
  ZOOM_KINDS.forEach(k => { CHART_ZOOM[k] = range; rerenderZoomChart(k); });
}
function setCursorAll(idxFull) {
  CURSOR_IDX = idxFull;
  ZOOM_KINDS.forEach(k => rerenderZoomChart(k));
  syncMainScrubber(idxFull);
  updateMainTimeReadout(idxFull);
  if (typeof refreshProtectionTab === 'function') refreshProtectionTab(idxFull);
  // Keep the shared "current view instant" — used by currentBitState() everywhere, including
  // both the popup logic chart's own timeline and the main-page logic tree below — in sync with
  // the cursor, converting this analog sample index to the corresponding digital-sample index.
  const dIdx = analogIdxToDigitalIdx(idxFull);
  if (dIdx != null) setLogicChartViewIdx(dIdx);
  // If a logic-chart popup is open, keep its diagram in sync too.
  syncLogicChartToCursor(idxFull);
  // Animate the main-page logic tree to the same instant as the four waveform/flag charts.
  redrawMainLogicTree();
  // Keep the Digital Event Timeline's own scroll position following the cursor too, whether or
  // not that tab happens to be the active one right now (see the tab-click handler in
  // renderTabs, which re-syncs it again on activation just in case the browser didn't retain
  // scrollTop while the panel was hidden).
  scrollTimelineToCursor(idxFull);
}

// Finds the digital-transition row (by its own index into PARSED.digitalTransitions /
// A.digitalTimeline, which line up 1:1) whose state is in effect at `analogIdx` — the last
// transition at or before it — mirroring analogIdxToDigitalIdx's own "last one at or before"
// rule so the two stay consistent.
function findTimelineEventIdxForAnalogIdx(analogIdx) {
  const trans = (PARSED && PARSED.digitalTransitions) || [];
  let best = -1;
  for (let i = 0; i < trans.length; i++) {
    if (trans[i].analogSampleIdx <= analogIdx) best = i; else break;
  }
  return best;
}
// Scrolls the Digital Event Timeline panel (its own independent scrollbar — see #timelineScroll
// in the CSS) so the row matching the cursor's current instant is centered and highlighted.
function scrollTimelineToCursor(analogIdx) {
  const container = document.getElementById('timelineScroll');
  if (!container || analogIdx == null) return;
  const idx = findTimelineEventIdxForAnalogIdx(analogIdx);
  const target = container.querySelector(`.tl-event[data-tl-idx="${idx}"]`);
  container.querySelectorAll('.tl-cursor-active').forEach(el => el.classList.remove('tl-cursor-active'));
  if (!target) return;
  target.classList.add('tl-cursor-active');
  const targetTop = target.offsetTop - container.clientHeight / 2 + target.clientHeight / 2;
  container.scrollTop = Math.max(0, targetTop);
}
function syncMainScrubber(idxFull) {
  const s = document.querySelector('.mainScrubber');
  if (s && parseInt(s.value, 10) !== idxFull) s.value = idxFull;
}

// The banner charts index by ANALOG sample; the digital word (and thus the logic chart's state)
// is recorded on a coarser DIGITAL sample grid. Each digital transition carries both its own
// digitalSampleIdx and the analogSampleIdx it occurred at, so converting an analog index to the
// digital state in effect at that moment is just "the last transition at or before this analog
// index".
// Analog and digital samples are both REGULAR streams (SAM/CYC_A and SAM/CYC_D), so converting
// between the two index spaces is the plain rate ratio.
//
// These used to SNAP to the nearest digital transition instead. That is harmless for reading a
// bit's state — nothing changes between transitions, by definition — but it is wrong for
// anything continuous, and timer progress is exactly that: while a delay is running nothing else
// changes, so there are no transitions to snap to, the mapped index froze, and the progress
// fraction stalled mid-timer instead of advancing (observed on record 10895: the 27PP1 -> 27PP1T
// fill sat at 28% across three consecutive cursor positions). The ratio is exact and continuous.
// The old transition-walk is kept as a fallback for any file that doesn't declare both rates.
function analogIdxToDigitalIdx(analogIdx) {
  const trans = (PARSED && PARSED.digitalTransitions) || [];
  if (!trans.length) return null;
  const spcA = PARSED?.eventInfo?.samPerCycA, spcD = PARSED?.eventInfo?.samPerCycD;
  if (spcA > 0 && spcD > 0) return Math.max(0, Math.round(analogIdx * spcD / spcA));
  let dIdx = 0;
  for (const t of trans) {
    if (t.analogSampleIdx <= analogIdx) dIdx = t.digitalSampleIdx; else break;
  }
  return dIdx;
}
function digitalIdxToAnalogIdx(digitalIdx) {
  const trans = (PARSED && PARSED.digitalTransitions) || [];
  const spcA = PARSED?.eventInfo?.samPerCycA, spcD = PARSED?.eventInfo?.samPerCycD;
  if (spcA > 0 && spcD > 0) return Math.max(0, Math.round(digitalIdx * spcA / spcD));
  let aIdx = 0;
  for (const t of trans) {
    if (t.digitalSampleIdx <= digitalIdx) aIdx = t.analogSampleIdx; else break;
  }
  return aIdx;
}

// When the main-page cursor moves during playback (or by dragging), re-color any open logic
// chart to the matching instant. Only touches the logic chart if one is currently displayed.
function syncLogicChartToCursor(analogIdx) {
  if (typeof LLG_CURRENT === 'undefined' || !LLG_CURRENT) return;
  const modal = document.getElementById('bitModal');
  if (!modal || modal.style.display === 'none') return;
  redrawLogicChartInner();
  if (typeof syncScrubbers === 'function' && LLG_VIEW_SAMPLE_IDX != null) {
    syncScrubbers(LLG_VIEW_SAMPLE_IDX); updateLlgTimeReadout(LLG_VIEW_SAMPLE_IDX);
  }
}

// Refreshes the main-page logic tree in place to reflect the CURRENT view instant (whatever
// LLG_VIEW_SAMPLE_IDX is set to — kept in sync with the cursor by setCursorAll above), so it
// animates alongside the four waveform/flag charts during playback or cursor-dragging instead of
// staying frozen at the original trip-moment snapshot it was built with.
function redrawMainLogicTree() {
  if (!PARSED || !ANALYSIS) return;

  if (CHARTED_FILTER_RELEVANT) {
    const slot = document.getElementById('mainLogicTreeCanvas');
    if (!slot) return; // nothing baked right now (e.g. the sequence-diagram/no-tree fallback is showing) — leave as-is
    const causeForTree = getCurrentChartedCauseForTree();
    if (!causeForTree || !causeForTree.logicTree) return;
    const freshTree = reEvaluateLogicTree(causeForTree.logicTree);
    // Render through a shallow-patched copy of tripCause/ANALYSIS so the refreshed values flow
    // through buildLogicTreeSection without mutating the canonical trip-moment tree that other
    // parts of the page (the Evidence block, etc.) still rely on.
    const patchedCause = Object.assign({}, causeForTree, { logicTree: freshTree });
    const patchedAnalysis = Object.assign({}, ANALYSIS, { tripCause: patchedCause });
    const html = buildLogicTreeSection(PARSED, patchedAnalysis);
    if (!html) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const freshCanvas = tmp.querySelector('#mainLogicTreeCanvas');
    if (freshCanvas) slot.innerHTML = freshCanvas.innerHTML;
    return;
  }

  // "Filter relevant?" unchecked — re-derive and patch just the local graph's inner diagram,
  // mirroring redrawLogicChartInner's own approach for the popup.
  const inner = document.getElementById('mainChartedLocalInner');
  if (!inner) return;
  const label = currentChartedBitLabel();
  const savedLLGCurrent = LLG_CURRENT;
  try {
    const tripFocus = isTripFocusLabel(label, PARSED);
    const graph = buildLocalLogicGraph(PARSED, label, tripFocus ? 25 : 20, tripFocus ? 25 : 14, !tripFocus);
    const fullHTML = renderLocalLogicGraph(graph, PARSED, tripFocus);
    const tmp = document.createElement('div');
    tmp.innerHTML = fullHTML;
    const freshInner = tmp.querySelector('#llgInnerDiagram');
    if (freshInner) inner.innerHTML = freshInner.innerHTML;
  } catch (e) {
    // leave the last good render in place on failure
  } finally {
    LLG_CURRENT = savedLLGCurrent;
  }
}

// ── Main-page playback (cursor sweeps all charts in sync) ──
// Advances the cursor at a CONSTANT rate of simulated-time-per-real-time (scaled by
// MAIN_PLAYBACK_SPEED), sampled on a fine real-time tick — not by stepping through transitions
// with a fixed delay per step. The previous transition-stepping approach held every transition
// for the same wall-clock duration regardless of how much simulated time separated it from the
// next one, which made bursts of closely-spaced changes crawl by in slow motion while long quiet
// stretches vanished instantly — exactly the uneven pacing this fixes.
let MAIN_PLAYBACK_SPEED = 1;
// A typical event spans well under a second of simulated time — playing that back at literal
// real-time (1ms of wall-clock per 1ms of simulated time) finishes almost instantly and is much
// too fast to actually watch. This dilation factor slows every playback option (both live
// timelines and both GIF exports) down to a sensibly watchable pace by default; the speed
// buttons then act as relative multipliers on top of it, not on raw real-time.
const BASE_TIME_DILATION = 1 / 30;
const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
function cycleMainSpeed() {
  const i = PLAYBACK_SPEEDS.indexOf(MAIN_PLAYBACK_SPEED);
  MAIN_PLAYBACK_SPEED = PLAYBACK_SPEEDS[(i + 1) % PLAYBACK_SPEEDS.length];
  document.querySelectorAll('.mainSpeedBtn').forEach(b => { b.textContent = MAIN_PLAYBACK_SPEED + '×'; });
}
function toggleShowTripValues(checked) {
  SHOW_TRIP_VALUES = !!checked;
  ZOOM_KINDS.forEach(k => rerenderZoomChart(k));
}
function toggleMainPlay() {
  if (MAIN_PLAY_TIMER) { stopMainPlay(); return; }
  if (!PARSED || !ANALYSIS || !PARSED.analogData) return;
  const totalLen = PARSED.analogData.length;
  if (!totalLen) return;
  const loA = PLAY_MARK_A != null ? PLAY_MARK_A : 0;
  const loB = PLAY_MARK_B != null ? PLAY_MARK_B : totalLen - 1;
  const start = Math.min(loA, loB), end = Math.max(loA, loB);
  if (end <= start) { setCursorAll(start); return; }
  const samplesPerCycle = PARSED.eventInfo?.samPerCycA || 32;
  const msPerSample = 1000 / ((PARSED.eventInfo?.freq || 60) * samplesPerCycle);
  document.querySelectorAll('.mainPlayBtn').forEach(b => { b.textContent = '❚❚'; });
  // Resume from wherever the cursor already is if it's inside the window, rather than always
  // restarting from the beginning — lets play/pause/play continue naturally.
  const startIdx = (CURSOR_IDX != null && CURSOR_IDX >= start && CURSOR_IDX < end) ? CURSOR_IDX : start;
  setCursorAll(startIdx);
  const playStartWall = performance.now();
  const TICK_MS = 40; // fine-grained real-time tick for smooth, continuous motion
  MAIN_PLAY_TIMER = setInterval(() => {
    const elapsedSimMs = (performance.now() - playStartWall) * MAIN_PLAYBACK_SPEED * BASE_TIME_DILATION;
    const targetIdx = Math.round(startIdx + elapsedSimMs / msPerSample);
    if (targetIdx >= end) { setCursorAll(end); stopMainPlay(); return; }
    setCursorAll(targetIdx);
  }, TICK_MS);
}
function stopMainPlay() {
  if (MAIN_PLAY_TIMER) { clearInterval(MAIN_PLAY_TIMER); MAIN_PLAY_TIMER = null; }
  document.querySelectorAll('.mainPlayBtn').forEach(b => { b.textContent = '▶'; });
}

function mainTimeLabel(analogIdx) {
  const msPerSample = (CHART_GEOM.current && CHART_GEOM.current.msPerSample) || null;
  const trigIdx = (ANALYSIS && ANALYSIS.triggerSampleIndex) || 0;
  if (msPerSample == null) return '';
  const ms = (analogIdx - trigIdx) * msPerSample;
  return `${ms >= 0 ? '+' : ''}${ms.toFixed(1)} ms`;
}
function updateMainTimeReadout(analogIdx) {
  const el = document.getElementById('mainTimeReadout');
  if (el) el.textContent = mainTimeLabel(analogIdx);
}

// Scrubber over the whole record (value = analog sample index).
function onMainScrub(value) {
  const idx = parseInt(value, 10);
  setCursorAll(idx);
  updateMainTimeReadout(idx);
}

// Set marker A or B to the current cursor position (or record start/end if no cursor yet).
function setPlayMarker(which) {
  const totalLen = (CHART_GEOM.current && CHART_GEOM.current.totalLen) || 0;
  const idx = CURSOR_IDX != null ? CURSOR_IDX : (which === 'A' ? 0 : (totalLen ? totalLen - 1 : 0));
  if (which === 'A') PLAY_MARK_A = idx; else PLAY_MARK_B = idx;
  ZOOM_KINDS.forEach(k => rerenderZoomChart(k));
  updateMarkerReadout();
}
function clearPlayMarkers() {
  PLAY_MARK_A = null; PLAY_MARK_B = null;
  ZOOM_KINDS.forEach(k => rerenderZoomChart(k));
  updateMarkerReadout();
}
function updateMarkerReadout() {
  const el = document.getElementById('mainMarkerReadout');
  if (!el) return;
  const a = PLAY_MARK_A != null ? mainTimeLabel(PLAY_MARK_A) : '—';
  const b = PLAY_MARK_B != null ? mainTimeLabel(PLAY_MARK_B) : '—';
  el.textContent = `A ${a}  ·  B ${b}`;
}

// Builds the timeline strip shown above the four waveform/logic charts: play/pause, a scrubber
// spanning the whole record (analog sample index), a time readout, Set-A/Set-B/Clear buttons for
// the playback/GIF window, a marker readout, and a GIF export button. Mirrors the logic-chart
// popup's own timeline in look and feel. Returns '' if there's no analog data to scrub over.
function buildMainTimelineHTML(P, A) {
  const data = P?.analogData || [];
  if (!data.length) return '';
  const totalLen = data.length;
  const trigIdx = A?.triggerSampleIndex ?? 0;
  const startVal = CURSOR_IDX != null ? CURSOR_IDX : trigIdx;
  return `<div class="main-timeline">
    <button type="button" class="llg-tool-btn mainPlayBtn" title="Play through the event" onclick="toggleMainPlay()">▶</button>
    <button type="button" class="llg-tool-btn mainSpeedBtn" title="Playback speed (also sets the GIF's pace)" onclick="cycleMainSpeed()" style="width:auto;padding:0 7px;font-weight:700;">${MAIN_PLAYBACK_SPEED}×</button>
    <input type="range" class="mainScrubber" min="0" max="${totalLen - 1}" value="${startVal}" step="1"
      oninput="onMainScrub(this.value)" style="flex:1;min-width:120px;accent-color:var(--accent);">
    <span id="mainTimeReadout" class="llg-time-readout">${mainTimeLabelStatic(startVal, P, A)}</span>
    <span class="main-timeline-sep"></span>
    <label class="llg-time-readout" style="display:flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap;">
      <input type="checkbox" onchange="toggleShowTripValues(this.checked)" ${SHOW_TRIP_VALUES ? 'checked' : ''} style="accent-color:var(--accent);cursor:pointer;">
      Show Trip Instant Values
    </label>
    <span class="main-timeline-sep"></span>
    <button type="button" class="llg-tool-btn" title="Set window start (A) to the current position" onclick="setPlayMarker('A')" style="width:auto;padding:0 8px;">Set A</button>
    <button type="button" class="llg-tool-btn" title="Set window end (B) to the current position" onclick="setPlayMarker('B')" style="width:auto;padding:0 8px;">Set B</button>
    <button type="button" class="llg-tool-btn" title="Clear the A/B window (play/GIF the whole record)" onclick="clearPlayMarkers()" style="width:auto;padding:0 8px;">Clear</button>
    <span id="mainMarkerReadout" class="llg-time-readout" style="min-width:150px;">${PLAY_MARK_A != null || PLAY_MARK_B != null ? `A ${PLAY_MARK_A != null ? mainTimeLabelStatic(PLAY_MARK_A, P, A) : '—'}  ·  B ${PLAY_MARK_B != null ? mainTimeLabelStatic(PLAY_MARK_B, P, A) : '—'}` : 'A —  ·  B —'}</span>
    <button type="button" class="llg-tool-btn mainGifBtn" title="Download an animated GIF sweeping the charts through the event" onclick="downloadMainGIF()" style="width:auto;padding:0 8px;font-weight:700;">GIF</button>
  </div>`;
}
// Same as mainTimeLabel but usable before CHART_GEOM.current is populated (first render), by
// computing msPerSample directly from the event info.
function mainTimeLabelStatic(analogIdx, P, A) {
  const samplesPerCycle = P?.eventInfo?.samPerCycA || 32;
  const msPerSample = 1000 / ((P?.eventInfo?.freq || 60) * samplesPerCycle);
  const trigIdx = A?.triggerSampleIndex || 0;
  const ms = (analogIdx - trigIdx) * msPerSample;
  return `${ms >= 0 ? '+' : ''}${ms.toFixed(1)} ms`;
}

// Captures the four banner charts (stacked vertically) at every actual state change within the
// current A/B window (or the whole record if no window is set) and saves an animated GIF — the
// main-page equivalent of the logic chart's GIF export, same encoder, same "one frame per
// change" and ~1.4s-per-frame pacing.
// Strips characters that are illegal (or awkward) in a downloaded filename on any common OS.
function sanitizeFilenamePart(s) {
  return String(s == null ? '' : s).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}
// Builds a descriptive filename for an exported GIF/PNG from the event's own metadata — site
// (RID), device (TID, falling back to the relay model), date/time of the record, event number,
// and whatever flag/trip is the focus of this particular export — rather than a generic fixed
// name, so a folder of downloads is actually distinguishable at a glance.
function buildExportFilename(P, A, selectedLabel, kind, ext) {
  const pad2 = n => String(n).padStart(2, '0');
  const site = P?.settings?.RID?.trim() || '';
  const device = P?.settings?.TID?.trim() || P?.device || '';
  const ts = P?.timestamp || {};
  const dateStr = ts.year != null ? `${pad2(ts.month)}-${pad2(ts.day)}-${ts.year}` : '';
  const timeStr = ts.hour != null ? `${pad2(ts.hour)}${pad2(ts.min)}${pad2(ts.sec)}` : '';
  const evtNum = A?.eventInfo?.refNum || P?.eventInfo?.refNum || '';
  const baseParts = [site, device, dateStr, timeStr, evtNum ? `Event ${evtNum}` : '']
    .map(sanitizeFilenamePart).filter(Boolean);
  const flag = sanitizeFilenamePart(selectedLabel);
  const suffix = [flag, kind].filter(Boolean).join(' ');
  const base = baseParts.join(' - ');
  const full = suffix ? (base ? `${base} - ${suffix}` : suffix) : (base || 'CEV_Export');
  return `${full}.${ext}`;
}

// Fixed, viewport-INDEPENDENT sizing for the exported composite — deliberately never derived
// from the live page's own (window-width-dependent) BANNER_CHART_WIDTH, which is what let an
// ultrawide monitor (or really any window width other than whatever the code happened to be
// tuned at) push the four-chart row to a wildly different, sometimes enormous, total width from
// one export to the next. Using a constant here is what makes "constant size and resolution"
// actually true regardless of the viewer's own screen.
const GIF_CHART_WIDTH = 460;      // per-mini-chart width used ONLY for this export composite
const GIF_CHART_HEIGHT = 260;     // taller than the live banner's 190px — the export has the room to spare
const GIF_TREE_SCALE = 1.4;       // enlarge the logic tree relative to its normal on-page size