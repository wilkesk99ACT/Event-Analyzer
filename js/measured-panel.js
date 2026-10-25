// ══════════════════════════════════════════════════════════════════════
// MEASURED VALUE PANEL — the operating quantity of the element that tripped
// ══════════════════════════════════════════════════════════════════════
// Puts the one number that explains the trip at the top of the Evidence card: the element's
// operating quantity at the trip instant, its extreme in the record (highest for an over-element,
// lowest for an under-element), and the pickup it was compared with, in the units the pickup is
// set in. The numbers come from tripMeasurements(), the same values Site Notes keeps with each
// trip, so this event and the site's past trips are measured the same way.
//
// Beside it, small charts of the same element across the site's past trips (from the Site
// Notes link, site-notes-link.js; the charts themselves are in trip-measurements.js). They only
// have to show whether the values are drifting, so they stay small. They fill in once Site
// Notes has been read; renderMeasTrend() is called again then.

// The operating-quantity measurement for the event on screen, or null.
function currentOpMeas() {
  if (typeof tripMeasurements !== 'function' || !PARSED || !ANALYSIS) return null;
  const m = tripMeasurements(PARSED, ANALYSIS);
  return m && m.op ? m : null;
}

function buildMeasuredPanel(P, A) {
  if (typeof tripMeasurements !== 'function') return '';
  const m = tripMeasurements(P, A);
  const o = m && m.op;
  if (!o) return '';
  const under = o.kind === 'min';
  const pri = v => (o.ratio && o.priUnit && v != null && isFinite(v))
    ? `${mpFmt(o.priUnit === 'V pri' ? v * o.ratio / 1000 : v * o.ratio)} ${o.priUnit === 'V pri' ? 'kV' : 'A'} pri` : '';
  const mult = v => (v == null || !isFinite(v)) ? '' : `${v.toFixed(2)}× pickup`;
  // An under-element tripped because the value was BELOW pickup; an over-element, above.
  const beyond = o.multTrip == null ? null : under ? o.multTrip < 1 : o.multTrip > 1;
  const tone = beyond == null ? '' : beyond ? 'mp-beyond' : 'mp-short';
  const when = o.peakMs == null ? '' : `${o.peakMs > 0 ? '+' : ''}${Math.round(o.peakMs)} ms`;
  return `<div class="mp">
    <div class="mp-head">
      <span class="mp-el">${typeof tt === 'function' ? tt(o.bit || o.element, P) : mpEsc(o.element)}</span>
      <span class="mp-q">${mpEsc(mpQtyName(o.quantity))}</span>
    </div>
    <div class="mp-body">
      <div class="mp-stat ${tone}">
        <div class="mp-k">At the trip</div>
        <div class="mp-v">${mpFmt(o.trip)} <small>${mpEsc(o.unit)}</small></div>
        <div class="mp-s">${[mult(o.multTrip), pri(o.trip)].filter(Boolean).join(' · ')}</div>
      </div>
      <div class="mp-stat">
        <div class="mp-k">${under ? 'Lowest' : 'Highest'} in record</div>
        <div class="mp-v">${mpFmt(o.peak)} <small>${mpEsc(o.unit)}</small></div>
        <div class="mp-s">${[mult(o.multPeak), when ? when + ' from trip' : ''].filter(Boolean).join(' · ')}</div>
      </div>
      <div class="mp-stat mp-pick">
        <div class="mp-k">Pickup</div>
        <div class="mp-v">${mpFmt(o.pickup)} <small>${mpEsc(o.unit)}</small></div>
        <div class="mp-s">${under ? 'trips below this' : 'trips above this'}</div>
      </div>
      <div class="mp-trend" id="mpTrend"></div>
    </div>
  </div>`;
}

function renderMeasTrend() {
  const box = document.getElementById('mpTrend');
  if (!box) return;
  const cur = currentOpMeas();
  const r = typeof SN !== 'undefined' && SN.results ? SN.results[CURRENT_IDX] : null;
  const site = r && r.match && r.match.site;
  if (!cur) { box.innerHTML = ''; return; }
  const el = cur.op.element;
  if (!site) {
    box.innerHTML = `<div class="mp-tnote">${typeof SN !== 'undefined' && SN.supported && !SN.dir
      ? 'Connect Site Notes (below) to compare with past trips at this site.' : 'No site matched yet, so there are no past trips to compare.'}</div>`;
    return;
  }
  // The trips: this element's past trips at the site, plus the event on screen (its own numbers).
  const trips = [];
  for (const t of (site.trips || [])) {
    if (!t.meas || !t.meas.op || t.meas.op.element !== el || t.atMs == null) continue;
    if (r.ids && t.at === r.ids.at) continue;
    trips.push({ at: t.at, ms: t.atMs, m: t.meas, cause: t.cause && t.cause.text, cur: false });
  }
  const past = trips.length;
  if (r.ids && r.ids.atMs != null) trips.push({ at: r.ids.at, ms: r.ids.atMs, m: cur, cur: true });
  trips.sort((a, b) => a.ms - b.ms);
  if (!past) {
    box.innerHTML = `<div class="mp-tnote">No earlier ${mpEsc(el)} trips with measured values at ${mpEsc(site.name)}.</div>`;
    return;
  }
  // Small, beside the values: they only have to show which way the values are moving.
  const charts = mpCharts(cur.op).map(c => mpChartHTML(c, trips, { W: 172, H: 46 }, false)).filter(Boolean).join('');
  box.innerHTML = `<div class="mp-th">Past ${mpEsc(el)} trips at ${mpEsc(site.name)} <span>${past} earlier + this event</span></div>
    <div class="mp-charts">${charts}</div>${mpLegendHTML(null, true, true)}`;
}

