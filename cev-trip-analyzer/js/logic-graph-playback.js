// Logic-graph scrub/playback controls and fullscreen view.

let LLG_CURRENT = null;

// Rebuilds ONLY the inner SVG + boxes of the currently-shown chart, at whatever LLG_VIEW_SAMPLE_IDX
// is currently set to — used by the timeline scrubber and playback. Rebuilds edges/boxes (their
// colors depend on time) but reuses the already-computed layout by re-running the render's own
// drawing off the stored graph. Simplest correct approach: re-run renderLocalLogicGraph and pull
// just its inner diagram out, then swap it into both the popup and (if open) the fullscreen copy.
function redrawLogicChartInner() {
  if (!LLG_CURRENT) return;
  const { graph, P, tripFocus } = LLG_CURRENT;
  const fullHTML = renderLocalLogicGraph(graph, P, tripFocus); // recomputes with current view time
  const tmp = document.createElement('div');
  tmp.innerHTML = fullHTML;
  const freshInner = tmp.querySelector('#llgInnerDiagram');
  if (!freshInner) return;
  const liveInner = document.getElementById('llgInnerDiagram');
  if (liveInner) liveInner.innerHTML = freshInner.innerHTML;
  // Mirror into the fullscreen overlay's cloned diagram if it's open.
  const fs = document.getElementById('llgFullscreenOverlay');
  if (fs) {
    const fsInner = fs.querySelector('#llgInnerDiagram');
    if (fsInner) fsInner.innerHTML = freshInner.innerHTML;
  }
}

// Builds the timeline strip shown above the diagram: a scrubber over the event's digital
// samples, a play/pause button, a time readout, and a "download GIF" button. The scrubber's
// value is a digital-sample index; moving it sets LLG_VIEW_SAMPLE_IDX and redraws. Only shown
// when there are transitions to scrub through.
function renderLogicTimeline(P) {
  const trans = (P.digitalTransitions || []);
  if (!trans.length) return '';
  const maxIdx = trans[trans.length - 1].digitalSampleIdx;
  // Default the scrubber to the trip moment (or the last sample if no trip resolved).
  const tripDIdx = (typeof ANALYSIS !== 'undefined' && ANALYSIS?.tripCause?.tripTransition?.digitalSampleIdx);
  const startIdx = (tripDIdx != null) ? tripDIdx : maxIdx;
  const markLabel = (idx) => idx != null ? llgTimeLabelForIdx(P, idx) : '—';
  // Class-based (not id-based) controls: the fullscreen view gets its own live copy of this
  // same strip, and both must drive the one shared LLG_VIEW_SAMPLE_IDX and stay in sync — so
  // handlers query ALL .llgScrubber/.llgTimeReadout/.llgPlayBtn elements rather than one id.
  return `<div class="llg-timeline" data-maxidx="${maxIdx}">
    <button type="button" class="llg-tool-btn llgPlayBtn" title="Play through the event" onclick="toggleLogicChartPlay()">▶</button>
    <button type="button" class="llg-tool-btn llgSpeedBtn" title="Playback speed (also sets the GIF's pace)" onclick="cycleLlgSpeed()" style="width:auto;padding:0 7px;font-weight:700;">${LLG_PLAYBACK_SPEED}×</button>
    <div class="llg-scrubber-wrap">
      <input type="range" class="llgScrubber" min="0" max="${maxIdx}" value="${startIdx}" step="1"
        oninput="onLogicChartScrub(this.value)" style="accent-color:var(--accent);">
      <div class="llg-scrub-mark llg-scrub-mark-a" title="Window start (A)"></div>
      <div class="llg-scrub-mark llg-scrub-mark-b" title="Window end (B)"></div>
    </div>
    <span class="llg-time-readout llgTimeReadout"></span>
    <span class="main-timeline-sep"></span>
    <button type="button" class="llg-tool-btn" title="Set window start (A) to the current position" onclick="setLlgPlayMarker('A')" style="width:auto;padding:0 8px;">Set A</button>
    <button type="button" class="llg-tool-btn" title="Set window end (B) to the current position" onclick="setLlgPlayMarker('B')" style="width:auto;padding:0 8px;">Set B</button>
    <button type="button" class="llg-tool-btn" title="Clear the A/B window (play/GIF the whole record)" onclick="clearLlgPlayMarkers()" style="width:auto;padding:0 8px;">Clear</button>
    <span class="llg-time-readout llgMarkerReadout" style="min-width:150px;">A ${markLabel(LLG_MARK_A)}  ·  B ${markLabel(LLG_MARK_B)}</span>
    <button type="button" class="llg-tool-btn llgGifBtn" title="Download an animated GIF of the event" onclick="downloadLogicChartGIF()">GIF</button>
  </div>`;
}

// Opens an enlarged, scrollable copy of whichever logic chart is currently shown in the bit
// popup — legend included, so the color/dash-pattern key is still visible at this size, not
// just in the compact popup. Operates on CLONES so the live popup (and its click-to-recenter
// behavior) is left alone; the clones are purely for viewing/screenshotting at a size that's
// actually legible once a chart has many columns (e.g. the full trip-chain view).
function expandLogicChart() {
  // Replace, rather than stack on top of, any overlay already open — this is also what makes
  // clicking a bit INSIDE the fullscreen view work: showBitDetail() re-renders the popup's
  // chart for the newly-clicked bit, then calls back into this function to refresh the
  // fullscreen copy to match, and that refresh must fully replace the stale one.
  closeLLGFullscreen();

  const body = document.getElementById('llgSourceBody');
  if (!body) return;
  const legend = document.getElementById('llgSourceLegend');
  const titleEl = document.getElementById('bitModalTitle');
  const title = titleEl ? titleEl.textContent : 'Logic chart';

  // Show the equation of the bit being charted in the fullscreen header, when it has one (via
  // the TR/TRIP canonical alias so a terminal trip bit still shows the trip equation). Rendered
  // with linkified bit references so each token stays explorable.
  let eqHTML = '';
  if (PARSED) {
    const { eqByLabel } = getEquationRefIndex(PARSED);
    const canonical = canonicalTripLabel(title, PARSED);
    const eq = eqByLabel[canonical];
    if (eq) eqHTML = `<div class="llg-fs-equation"><span style="color:var(--text-muted);">${canonical} :=</span> ${linkifyEquationBits(eq, PARSED)}</div>`;
  }

  // `body` itself scrolls internally when its content is wider than the popup (see .llg-wrap's
  // overflow-x:auto), so getBoundingClientRect() only reports the visible, CLIPPED viewport —
  // not the diagram's true full extent. scrollWidth/scrollHeight report the real content size
  // regardless of clipping, which is what's actually needed to size this so the whole chart
  // ends up visible at once, not just re-cropped at a different scale.
  const w = Math.max(1, body.scrollWidth);
  const h = Math.max(1, body.scrollHeight);

  const overlay = document.createElement('div');
  overlay.className = 'llg-fullscreen-overlay';
  overlay.id = 'llgFullscreenOverlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) closeLLGFullscreen(); });
  overlay.innerHTML = `<div class="llg-fullscreen-modal">
    <div class="llg-fullscreen-header">
      <div style="display:flex;flex-direction:column;gap:4px;min-width:0;flex:1;">
        <span>${title} — logic chart</span>
        ${eqHTML}
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex:0 0 auto;">
        <button type="button" class="llg-tool-btn" title="Save as image" onclick="downloadLogicChart()">⬇</button>
        <button type="button" class="llg-tool-btn" title="Close" onclick="closeLLGFullscreen()">✕</button>
      </div>
    </div>
    <div class="llg-fullscreen-controls"></div>
    <div class="llg-fullscreen-body"></div>
  </div>`;

  // Live timeline (class-based, so it stays in sync with the popup's copy through the shared
  // handlers) and legend, both at natural size above the scaled diagram.
  const controls = overlay.querySelector('.llg-fullscreen-controls');
  if (legend) controls.appendChild(legend.cloneNode(true));
  const tlWrap = document.createElement('div');
  tlWrap.innerHTML = renderLogicTimeline(PARSED || {});
  const tlEl = tlWrap.firstElementChild;
  if (tlEl) controls.appendChild(tlEl);

  // Budget the space the fullscreen modal has for the diagram, after its header + these controls,
  // then scale the diagram to fit. Measured after the controls are in the DOM so their real
  // height is known.
  const fsBody = overlay.querySelector('.llg-fullscreen-body');
  document.body.appendChild(overlay);
  const HEADER_H = overlay.querySelector('.llg-fullscreen-header').getBoundingClientRect().height;
  const CONTROLS_H = controls.getBoundingClientRect().height;
  const PAD = 40;
  const availW = window.innerWidth * 0.95 - PAD;
  const availH = window.innerHeight * 0.92 - HEADER_H - CONTROLS_H - PAD;
  const scale = Math.max(0.05, Math.min(3, availW / w, availH / h));

  const clone = body.cloneNode(true);
  clone.removeAttribute('id');
  clone.style.overflow = 'visible'; // the clone is sized exactly to its content — no inner scrollbar needed
  clone.style.transform = `scale(${scale})`;
  clone.style.transformOrigin = 'top left';
  clone.style.width = w + 'px';
  clone.style.height = h + 'px';

  const spacer = document.createElement('div');
  spacer.style.position = 'relative';
  spacer.style.width = (w * scale) + 'px';
  spacer.style.height = (h * scale) + 'px';
  spacer.appendChild(clone);
  fsBody.appendChild(spacer);

  // Reflect the current view/scrub position in the freshly-created fullscreen timeline.
  const curIdx = (LLG_VIEW_SAMPLE_IDX != null)
    ? LLG_VIEW_SAMPLE_IDX
    : (ANALYSIS?.tripCause?.tripTransition?.digitalSampleIdx ?? null);
  if (curIdx != null) { syncScrubbers(curIdx); updateLlgTimeReadout(curIdx); }
  updateLlgMarkerPositions();
}

function closeLLGFullscreen() {
  const overlay = document.getElementById('llgFullscreenOverlay');
  if (overlay) overlay.remove();
}

// ── Logic chart timeline: scrub / play / GIF ──
// The scrubber's value is a digital-sample index. Moving it sets the view time and redraws the
// diagram's colors to match that instant. Playback advances the scrubber smoothly over real
// time (see toggleLogicChartPlay below), not by stepping between transitions with a fixed delay.
let LLG_PLAY_TIMER = null;
let LLG_MARK_A = null, LLG_MARK_B = null; // digital-sample indices bounding the play/GIF window
let LLG_PLAYBACK_SPEED = 1;
function cycleLlgSpeed() {
  const i = PLAYBACK_SPEEDS.indexOf(LLG_PLAYBACK_SPEED);
  LLG_PLAYBACK_SPEED = PLAYBACK_SPEEDS[(i + 1) % PLAYBACK_SPEEDS.length];
  document.querySelectorAll('.llgSpeedBtn').forEach(b => { b.textContent = LLG_PLAYBACK_SPEED + '×'; });
}
function setLlgPlayMarker(which) {
  const scrubber = document.querySelector('.llgScrubber');
  const idx = scrubber ? parseInt(scrubber.value, 10) : (LLG_VIEW_SAMPLE_IDX ?? 0);
  if (which === 'A') LLG_MARK_A = idx; else LLG_MARK_B = idx;
  updateLlgMarkerReadout();
}
function clearLlgPlayMarkers() {
  LLG_MARK_A = null; LLG_MARK_B = null;
  updateLlgMarkerReadout();
}
function updateLlgMarkerReadout() {
  if (!PARSED) return;
  const label = idx => idx != null ? llgTimeLabelForIdx(PARSED, idx) : '—';
  const text = `A ${label(LLG_MARK_A)}  ·  B ${label(LLG_MARK_B)}`;
  document.querySelectorAll('.llgMarkerReadout').forEach(el => { el.textContent = text; });
  updateLlgMarkerPositions();
}
// Positions the small A/B tick markers overlaid on every visible logic-chart timeline scrubber
// (the popup's own copy and, if open, the fullscreen copy) to sit directly above wherever
// LLG_MARK_A/LLG_MARK_B currently point — hidden entirely when a mark isn't set. A plain
// percentage-of-track position (value/max) rather than pixel-measuring the native slider's own
// thumb geometry; close enough to be a clear visual reference without depending on
// browser-specific range-input internals.
function updateLlgMarkerPositions() {
  document.querySelectorAll('.llg-scrubber-wrap').forEach(wrap => {
    const scrubber = wrap.querySelector('.llgScrubber');
    if (!scrubber) return;
    const maxIdx = parseFloat(scrubber.max) || 0;
    const markA = wrap.querySelector('.llg-scrub-mark-a');
    const markB = wrap.querySelector('.llg-scrub-mark-b');
    [[markA, LLG_MARK_A], [markB, LLG_MARK_B]].forEach(([el, idx]) => {
      if (!el) return;
      if (idx == null || maxIdx <= 0) { el.style.display = 'none'; return; }
      el.style.left = Math.max(0, Math.min(100, (idx / maxIdx) * 100)) + '%';
      el.style.display = 'block';
    });
  });
}

// Human-readable time for a given digital-sample index, relative to the trigger where possible.
function llgTimeLabelForIdx(P, idx) {
  const trans = P.digitalTransitions || [];
  // Find the transition at-or-before idx to read its relTimeMs; fall back to interpolating.
  let best = null;
  for (const t of trans) { if (t.digitalSampleIdx <= idx) best = t; else break; }
  const freq = P.eventInfo?.freq || 60;
  const digitalRate = P.eventInfo?.samPerCycD || 4;
  const intervalMs = 1000 / (freq * digitalRate);
  if (best) {
    // relTimeMs is relative to trigger; adjust by the gap between this idx and best's idx.
    const ms = best.relTimeMs + (idx - best.digitalSampleIdx) * intervalMs;
    return `${ms >= 0 ? '+' : ''}${ms.toFixed(1)} ms`;
  }
  // Before the first recorded transition — extrapolate from transition[0].
  if (trans.length) {
    const ms = trans[0].relTimeMs - (trans[0].digitalSampleIdx - idx) * intervalMs;
    return `${ms >= 0 ? '+' : ''}${ms.toFixed(1)} ms`;
  }
  return '';
}

function updateLlgTimeReadout(idx) {
  if (!PARSED) return;
  const label = llgTimeLabelForIdx(PARSED, idx);
  document.querySelectorAll('.llgTimeReadout').forEach(el => { el.textContent = label; });
}

// Keep every scrubber instance (popup + fullscreen) showing the same position.
function syncScrubbers(idx) {
  document.querySelectorAll('.llgScrubber').forEach(s => { if (parseInt(s.value, 10) !== idx) s.value = idx; });
}

// Called by any scrubber's oninput. Sets the view time, redraws, and syncs the other scrubber.
function onLogicChartScrub(value) {
  const idx = parseInt(value, 10);
  setLogicChartViewIdx(idx);
  redrawLogicChartInner();
  updateLlgTimeReadout(idx);
  syncScrubbers(idx);
}

function toggleLogicChartPlay() {
  if (LLG_PLAY_TIMER) { stopLogicChartPlay(); return; }
  const scrubber = document.querySelector('.llgScrubber');
  if (!scrubber || !PARSED) return;
  const maxIdx = parseInt(scrubber.max, 10);
  const loA = LLG_MARK_A != null ? LLG_MARK_A : 0;
  const loB = LLG_MARK_B != null ? LLG_MARK_B : maxIdx;
  const start = Math.min(loA, loB), end = Math.max(loA, loB);
  if (end <= start) return;
  const freq = PARSED.eventInfo?.freq || 60;
  const digitalRate = PARSED.eventInfo?.samPerCycD || 4;
  const intervalMs = 1000 / (freq * digitalRate); // ms of simulated time per digital sample
  const btns = document.querySelectorAll('.llgPlayBtn');
  btns.forEach(b => { b.textContent = '❚❚'; });
  // Resume from wherever the scrubber already is if it's inside the window, rather than always
  // restarting from the beginning.
  const curVal = parseInt(scrubber.value, 10);
  const startIdx = (curVal >= start && curVal < end) ? curVal : start;
  onLogicChartScrub(startIdx);
  const playStartWall = performance.now();
  const TICK_MS = 40; // fine-grained real-time tick for smooth, continuous motion
  LLG_PLAY_TIMER = setInterval(() => {
    const elapsedSimMs = (performance.now() - playStartWall) * LLG_PLAYBACK_SPEED * BASE_TIME_DILATION;
    const targetIdx = Math.round(startIdx + elapsedSimMs / intervalMs);
    if (targetIdx >= end) { onLogicChartScrub(end); stopLogicChartPlay(); return; }
    onLogicChartScrub(targetIdx);
  }, TICK_MS);
}

function stopLogicChartPlay() {
  if (LLG_PLAY_TIMER) { clearInterval(LLG_PLAY_TIMER); LLG_PLAY_TIMER = null; }
  document.querySelectorAll('.llgPlayBtn').forEach(b => { b.textContent = '▶'; });
}

// Builds an animated GIF stepping through the event's DISTINCT digital states, holding each
// long enough to read (≈900ms). Uses a tiny self-contained GIF encoder (gif89a, per-frame local
// palette) so it works offline with no library — the diagram is already just SVG/divs we can
// rasterize the same way the PNG export does. Frames are the set of digital-sample indices where
// something actually changed (plus the initial state and the final/trip state), so the GIF only
// has as many frames as there are meaningful states.
