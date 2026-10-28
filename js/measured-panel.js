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
  renderTripCompare();
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
  // Small, beside the values and stacked: they only have to show which way the values are moving.
  const charts = mpCharts(cur.op).map(c => mpChartHTML(c, trips, { W: 220, H: 34 }, false)).filter(Boolean).join('');
  box.innerHTML = `<div class="mp-th">Past ${mpEsc(el)} trips at ${mpEsc(site.name)} <span>${past} earlier + this event</span></div>
    <div class="mp-charts">${charts}</div>${mpLegendHTML(null, true, true)}`;
}

// ══════════════════════════════════════════════════════════════════════
// HOW THIS TRIP COMPARES — one or two plain statements under the banner headline
// ══════════════════════════════════════════════════════════════════════
// Read from the same Site Notes match as the trend charts: is the cause the usual one at this
// site, and was the operating quantity further past pickup than on earlier trips of the same
// element. Severity uses the extreme in the record (multPeak), falling back to the value at the
// trip; for an under-element a lower multiple is more severe.
function renderTripCompare() {
  const box = document.getElementById('tripCompare');
  if (!box) return;
  box.innerHTML = '';
  const cause = ANALYSIS && ANALYSIS.tripCause;
  if (!cause || cause.isEventReport || typeof snTripsFor !== 'function') return;
  const r = typeof SN !== 'undefined' && SN.results ? SN.results[CURRENT_IDX] : null;
  const site = r && r.match && r.match.site;
  if (!site) return;
  const past = snTripsFor(site).filter(t => !snSameTrip(t, r.ids));
  const pill = (tone, text, detail) => `<div class="tc-row tc-${tone}"><span class="tc-pill">${text}</span>${detail ? `<span class="tc-d">${mpEsc(detail)}</span>` : ''}</div>`;
  if (!past.length) {
    box.innerHTML = pill('info', `First recorded trip at ${mpEsc(site.name)}`);
    return;
  }

  const out = [];
  // Cause, grouped the way the Site Notes trip list groups it.
  const curGroup = snCauseGroup({ cause: { text: cause.causeText } });
  const groups = new Map();
  for (const t of past) { const g = snCauseGroup(t); groups.set(g, (groups.get(g) || 0) + 1); }
  const same = groups.get(curGroup) || 0;
  const [topGroup, topN] = [...groups].sort((a, b) => b[1] - a[1])[0];
  const N = past.length;
  if (!same) {
    out.push(pill('alert', 'Trip cause different than typical',
      `None of the ${N} earlier trip${N === 1 ? '' : 's'} at ${site.name} were ${curGroup}. Most common: ${topGroup} (${topN} of ${N}).`));
  } else if (topGroup !== curGroup && same < topN) {
    out.push(pill('warn', 'Less common trip cause',
      `${same} of ${N} earlier trips at ${site.name} were ${curGroup}. Most common: ${topGroup} (${topN} of ${N}).`));
  } else {
    out.push(pill('info', 'Typical trip cause for this site',
      `${same} of ${N} earlier trip${N === 1 ? '' : 's'} at ${site.name} were ${curGroup}.`));
  }

  // Severity against earlier trips of the same element.
  const cur = currentOpMeas();
  const sev = o => o ? (o.multPeak != null ? o.multPeak : o.multTrip) : null;
  const cs = cur && sev(cur.op);
  if (cs != null && isFinite(cs)) {
    const el = cur.op.element, under = cur.op.kind === 'min';
    const vals = past.filter(t => t.meas && t.meas.op && t.meas.op.element === el)
      .map(t => sev(t.meas.op)).filter(v => v != null && isFinite(v));
    if (vals.length) {
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const range = lo === hi ? `${lo.toFixed(2)}×` : `${lo.toFixed(2)}–${hi.toFixed(2)}×`;
      const detail = `This event ${cs.toFixed(2)}× pickup; earlier ${el} trips ${range} pickup (${vals.length}).`;
      const worse = under ? cs < lo : cs > hi;
      const milder = under ? cs > hi : cs < lo;
      out.push(worse ? pill('alert', `More severe than previous ${mpEsc(el)} trips`, detail)
        : milder ? pill('info', `Milder than previous ${mpEsc(el)} trips`, detail)
        : pill('info', `Severity within range of previous ${mpEsc(el)} trips`, detail));
    } else {
      out.push(pill('info', `First ${mpEsc(el)} trip with measured values here`));
    }
  }
  box.innerHTML = out.join('');
}

