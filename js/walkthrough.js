
// ══════════════════════════════════════════════════════════════════════
// GUIDED WALKTHROUGH
// ══════════════════════════════════════════════════════════════════════
// A step-by-step tour of the analysis screen. It runs by itself the first time someone loads
// an event, and the Tour button (top bar, and Help → Quick Start) replays it.
//
// The point is reading order. The banner, the logic diagram, the flags, the charts and nine tabs
// all look equally loud to someone new, so each step spotlights one piece and says what it
// answers. Steps whose target is not on screen for this event are skipped, or shown centered
// when knowing the piece exists still matters (flags, for example, only appear when raised).

const TOUR_SEEN_KEY = 'cevTripAnalyzer.tourSeen.v1';

// The tour's styles travel with the script rather than in styles.css. A browser that serves a
// cached styles.css beside a fresh copy of this file would otherwise draw the card as bare,
// unstyled text across the bottom of the page.
const TOUR_CSS = `
.tour-backdrop { position: fixed; inset: 0; z-index: 4000; background: transparent; }
.tour-spotlight {
  position: fixed; z-index: 4001; pointer-events: none;
  border: 2px solid var(--accent); border-radius: 10px;
  box-shadow: 0 0 0 9999px rgba(3, 6, 12, 0.78), 0 0 24px rgba(59, 158, 255, 0.35);
  transition: top 0.25s ease, left 0.25s ease, width 0.25s ease, height 0.25s ease;
}
.tour-spotlight.tour-centered { border-color: transparent; box-shadow: 0 0 0 9999px rgba(3, 6, 12, 0.78); }
.tour-card {
  position: fixed; z-index: 4002; box-sizing: border-box;
  width: min(380px, calc(100vw - 32px));
  background: var(--card); color: var(--text);
  border: 1px solid var(--accent); border-radius: 10px;
  padding: 16px 18px 14px; font-family: var(--sans);
  box-shadow: 0 12px 36px rgba(0, 0, 0, 0.55);
  transition: top 0.25s ease, left 0.25s ease;
}
.tour-step-count {
  font-size: 10px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--text-muted); margin-bottom: 4px;
}
.tour-title { font-size: 15px; font-weight: 700; color: var(--text); margin-bottom: 6px; }
.tour-body { font-size: 12.5px; line-height: 1.6; color: var(--text-dim); }
.tour-body b { color: var(--text); }
.tour-body ul { padding-left: 18px; margin: 6px 0 0; }
.tour-body li { margin-bottom: 4px; }
.tour-dots { display: flex; gap: 5px; margin-top: 12px; }
.tour-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--card-border); }
.tour-dot.on { background: var(--accent); }
.tour-actions { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
.tour-skip {
  background: none; border: none; cursor: pointer; padding: 0;
  font-family: var(--sans); font-size: 11.5px; color: var(--text-muted); text-decoration: underline;
}
.tour-skip:hover { color: var(--text-dim); }
.tour-actions .tour-push { margin-left: auto; }
.btn-ghost { background: transparent; color: var(--text-dim); border-color: var(--card-border); }
.btn-ghost:hover { background: var(--bg2); color: var(--text); }
`;
(function injectTourCss() {
  const style = document.createElement('style');
  style.id = 'tourStyles';
  style.textContent = TOUR_CSS;
  document.head.appendChild(style);
})();

let TOUR = null; // { steps, idx, els, onReflow }

function tourSeen() {
  try { return localStorage.getItem(TOUR_SEEN_KEY) === '1'; } catch (e) { return false; }
}
function markTourSeen() {
  try { localStorage.setItem(TOUR_SEEN_KEY, '1'); } catch (e) { /* private window: tour just shows again next time */ }
}

// Called once after the first event of a load is on screen.
function maybeStartTour() {
  if (tourSeen()) return;
  // Charts and the logic diagram finish laying out a moment after selectEvent returns.
  setTimeout(() => startTour(), 450);
}

function tourSteps(format) {
  const welcome = {
    title: 'Welcome to the Trip Analyzer',
    body: `This tool reads the relay's own event record and settings and works out why the device operated.
      <br><br>A lot is on screen at once. Read every event in the same order and most of it can wait:
      <ul><li><b>Headline</b> — what happened</li><li><b>Logic path and flags</b> — why, and what might mislead</li>
      <li><b>Waveforms</b> — confirm it</li><li><b>Start here tabs</b> — the follow-up questions</li></ul>
      About a minute. Replay it any time with the <b>Tour</b> button.`,
  };
  const help = {
    target: '.top-bar-right',
    title: 'Help, bug reports and this tour',
    body: `<b>Help</b> explains the diagram colors, sequence components and each tab.
      <b>Report a bug</b> packages the loaded files and your note into a .zip to email. <b>Tour</b> replays this walkthrough.
      <b>New Files</b> goes back to the drop screen.`,
  };
  const events = {
    target: '#eventSelector',
    title: 'Several records loaded',
    body: `Each record from the sequence has a button here, in time order. A note below them calls out a
      cause that repeats, or fault current at more than one reclose: that points to an ongoing condition,
      not a one-off.`,
  };

  if (format === 'sel851') return [
    welcome, events,
    { target: '#tripBanner > .card', title: '1. The verdict',
      body: `The SEL-851 writes its full settings into the record, so the tool checks the trip against them.
        <b>Green</b> — the trip agrees with the settings. <b>Yellow</b> — review needed.
        <b>Red</b> — something in the record contradicts the settings, and the Verdict tab names it.` },
    { target: '.tab-group-primary', title: '2. Start here tabs',
      body: `<ul><li><b>Verdict</b> — every finding and the trip equation, term by term.</li>
        <li><b>Elements</b> — each element's setting beside the value measured from this record.</li>
        <li><b>Event Timeline</b> — every bit change, in order.</li></ul>` },
    { target: '.tab-group-reference', title: 'Reference tabs',
      body: `Voltages, currents and the full settings file. Use them to check a number the Verdict quotes;
        most events don't need them.` },
    help,
  ];

  if (format === 'form6') return [
    welcome, events,
    { target: '#tripBanner', title: '1. The event summary',
      body: `Form 6 records carry waveforms, digital channels and (with settings.txt) the pickups.
        There is no logic to trace, so the tool compares what was measured against what was set.` },
    { target: '.tab-group-primary', title: '2. Start here tabs',
      body: `<ul><li><b>Waveforms</b> — current and voltage across the event.</li>
        <li><b>Protection</b> — each pickup against the measured value.</li>
        <li><b>Digital Channels</b> — which status and trip channels changed, and when.</li></ul>` },
    { target: '.tab-group-reference', title: 'Reference tabs',
      body: `The raw settings file, for checking a pickup the Protection tab quotes.` },
    help,
  ];

  return [
    welcome, events,
    { target: '.trip-banner-header', title: '1. Start with the headline',
      body: `The likely cause, traced through the relay's own trip logic. <b>Red</b> means the relay tripped.
        <b>Blue</b> means it recorded an event but did not trip. The paragraph under it says what drove it.
        <br><br>It is a starting point, not the final word: the next steps are how you check it.` },
    { target: '#mainChartedLogicSlot', title: '2. Check the logic path',
      body: `Read left to right, from the first condition to the trip command.
        <ul><li><b>Green</b> — true at the trip. <b>Grey</b> — false, shown only when it explains the result.</li>
        <li>A bracket with <b>&amp;</b> means all of them had to be true; without it, any one was enough.</li>
        <li>Hover a box for its equation. Click it for its own logic and history.</li></ul>` },
    { target: '.tour-flags', title: '3. Read the flags',
      fallbackBody: `<b>Nothing is flagged on this event.</b> When something is, a yellow or red panel appears
        under the headline. Flags mark the cases where the headline can mislead: a trip from internal logic,
        a trip on an open breaker, a failed VT or CT channel, or an overcurrent trip with no fault signature.
        When you see one, read it before trusting the headline.`,
      body: `These mark the cases where the headline can mislead: a trip from internal logic, a trip on an
        open breaker, a failed VT or CT channel, or an overcurrent trip with no fault signature.
        <b>Read these before trusting the headline.</b> They say what deserves a closer look, not what to do.` },
    { target: '.tour-reclose', title: '4. Will it come back by itself?',
      body: `A one-line answer from the reclose and close logic. <b>Full reclose analysis →</b> opens the
        Reclosing tab with each close path and the condition it waits on.` },
    { target: '.trip-banner-charts', title: '5. Confirm on the waveforms',
      body: `Every chart shares one time axis, so the trip lines up across all of them.
        <ul><li><b>Scroll</b> to zoom all charts together. <b>Drag</b> to pan.</li>
        <li><b>Click</b> to place the cursor and read every value at that instant. <b>Double-click</b> to reset.</li>
        <li><b>▶</b> on the bar above the charts plays the cursor through the event.</li></ul>` },
    { target: '.tab-group-primary', title: '6. Then the Start here tabs',
      body: `These answer the follow-up questions on almost every event.
        <ul><li><b>Protection</b> — each element's pickup, measured value and multiple of pickup.</li>
        <li><b>Diagnostics</b> — would a close work now, why a close failed, and VT/CT consistency checks.</li>
        <li><b>Reclosing</b> — whether the device comes back by itself, and what it waits on.</li>
        <li><b>Event Timeline</b> — every bit change, in order.</li></ul>` },
    { target: '.tab-group-reference', title: 'Reference tabs',
      body: `Voltages, Currents, SV Logic, Frequency and the raw Equations. They hold the data behind the answers
        above. Open them to check a specific number or equation; most events don't need them.` },
    help,
  ];
}

function tourTargetEl(step) {
  if (!step.target) return null;
  const el = document.querySelector(step.target);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  return el;
}

// Steps whose target is missing are dropped, unless they carry a fallback to show centered.
function resolveTourSteps(format) {
  return tourSteps(format).filter(s => !s.target || tourTargetEl(s) || s.fallbackBody);
}

function startTour() {
  if (!PARSED) return;
  endTour(false);
  toggleHelp(false);
  const steps = resolveTourSteps(PARSED.format);

  const backdrop = document.createElement('div');
  backdrop.className = 'tour-backdrop';
  const spot = document.createElement('div');
  spot.className = 'tour-spotlight';
  const card = document.createElement('div');
  card.className = 'tour-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-live', 'polite');
  document.body.append(backdrop, spot, card);

  const onReflow = () => positionTour();
  const onKey = e => {
    if (e.key === 'Escape') endTour(true);
    else if (e.key === 'ArrowRight') tourGo(1); // Enter already clicks the focused Next button
    else if (e.key === 'ArrowLeft') tourGo(-1);
  };
  window.addEventListener('resize', onReflow);
  window.addEventListener('scroll', onReflow, true);
  document.addEventListener('keydown', onKey);

  TOUR = { steps, idx: 0, els: { backdrop, spot, card }, onReflow, onKey };
  showTourStep();
}

function tourGo(delta) {
  if (!TOUR) return;
  const next = TOUR.idx + delta;
  if (next < 0) return;
  if (next >= TOUR.steps.length) { endTour(true); return; }
  TOUR.idx = next;
  showTourStep();
}

function endTour(markSeen) {
  if (markSeen) markTourSeen();
  if (!TOUR) return;
  Object.values(TOUR.els).forEach(el => el.remove());
  window.removeEventListener('resize', TOUR.onReflow);
  window.removeEventListener('scroll', TOUR.onReflow, true);
  document.removeEventListener('keydown', TOUR.onKey);
  TOUR = null;
}

function showTourStep() {
  const { steps, idx, els } = TOUR;
  const step = steps[idx];
  const el = tourTargetEl(step);
  const body = el ? step.body : (step.fallbackBody || step.body);
  const last = idx === steps.length - 1;

  els.card.innerHTML = `
    <div class="tour-step-count">Step ${idx + 1} of ${steps.length}</div>
    <div class="tour-title">${step.title}</div>
    <div class="tour-body">${body}</div>
    <div class="tour-dots">${steps.map((_, i) => `<span class="tour-dot ${i <= idx ? 'on' : ''}"></span>`).join('')}</div>
    <div class="tour-actions">
      ${last ? '' : `<button class="tour-skip" onclick="endTour(true)">Skip tour</button>`}
      ${idx > 0 ? `<button class="btn btn-ghost tour-push" onclick="tourGo(-1)">Back</button>` : ''}
      <button class="btn ${idx > 0 ? '' : 'tour-push'}" onclick="tourGo(1)">${last ? 'Done' : idx === 0 ? 'Show me' : 'Next'}</button>
    </div>`;

  // A target inside the sticky top bar never needs the page to move.
  if (el && !el.closest('.top-bar')) {
    // Bring the target under the sticky top bar with the card below it. When the two fit
    // together they are centered as one block; otherwise (the chart stack) the target is
    // aligned to the top and the card sits over its lower part.
    const topBar = document.querySelector('.top-bar');
    const topH = topBar ? topBar.getBoundingClientRect().height : 0;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // horizontal: the tab bar scrolls sideways on narrow screens
    const r = el.getBoundingClientRect();
    const avail = window.innerHeight - topH;
    const block = r.height + 18 + els.card.offsetHeight;
    const y = block <= avail - 16
      ? window.scrollY + r.top - topH - (avail - block) / 2
      : window.scrollY + r.top - topH - 16;
    window.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
  }
  positionTour();
  els.card.querySelector('.tour-actions .btn:last-child')?.focus();
}

function positionTour() {
  if (!TOUR) return;
  const { steps, idx, els } = TOUR;
  const el = tourTargetEl(steps[idx]);
  const vw = window.innerWidth, vh = window.innerHeight;
  const card = els.card;
  const cw = card.offsetWidth, ch = card.offsetHeight;
  const gap = 12, pad = 6;

  if (!el) {
    els.spot.classList.add('tour-centered');
    Object.assign(els.spot.style, { top: `${vh / 2}px`, left: `${vw / 2}px`, width: '0px', height: '0px' });
    Object.assign(card.style, { top: `${Math.max(16, (vh - ch) / 2)}px`, left: `${Math.max(16, (vw - cw) / 2)}px` });
    return;
  }

  els.spot.classList.remove('tour-centered');
  const r = el.getBoundingClientRect();
  // Clip the spotlight to the viewport so a tall target still leaves a visible edge.
  const top = Math.max(4, r.top - pad);
  const bottom = Math.min(vh - 4, r.bottom + pad);
  const left = Math.max(4, r.left - pad);
  const right = Math.min(vw - 4, r.right + pad);
  Object.assign(els.spot.style, {
    top: `${top}px`, left: `${left}px`,
    width: `${Math.max(0, right - left)}px`, height: `${Math.max(0, bottom - top)}px`,
  });

  // Below the target, else above it, else pinned to the bottom-right corner over it.
  let cTop;
  if (bottom + gap + ch <= vh - 8) cTop = bottom + gap;
  else if (top - gap - ch >= 8) cTop = top - gap - ch;
  else cTop = vh - ch - 16;
  let cLeft = Math.min(Math.max(16, left), vw - cw - 16);
  if (cTop === vh - ch - 16) cLeft = vw - cw - 16;
  Object.assign(card.style, { top: `${cTop}px`, left: `${cLeft}px` });
}
