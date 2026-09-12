
function currentBitState(label) {
  if (!PARSED) return null;
  // Default cutoff is the trip moment; the timeline scrubber overrides it with an explicit
  // digital-sample index so the whole chart can be shown as it was at any point in the event.
  const overrideIdx = LLG_VIEW_SAMPLE_IDX;
  const tripSampleIdx = overrideIdx != null ? overrideIdx : ANALYSIS?.tripCause?.tripTransition?.analogSampleIdx;
  const useDigitalIdx = overrideIdx != null; // override is a DIGITAL sample idx; the trip cutoff is an ANALOG sample idx
  let state = (PARSED.initialDigitalState || []).includes(label);
  let seen = (PARSED.initialDigitalState || []).includes(label);
  let asOf = 'at the start of this record';
  for (const t of (PARSED.digitalTransitions || [])) {
    const tIdx = useDigitalIdx ? t.digitalSampleIdx : t.analogSampleIdx;
    if (tripSampleIdx != null && tIdx > tripSampleIdx) break;
    const c = t.changes.find(c => c.label === label);
    if (c) { state = c.asserted; seen = true; asOf = tripSampleIdx != null ? (overrideIdx != null ? 'at this point in time' : 'at the moment of the trip') : 'at this point in the record'; }
  }
  // A bit that never appears in the initial-asserted set NOR in any transition was simply
  // de-asserted (false) for the entire record — SEL only records a bit in a transition when it
  // CHANGES, so "never mentioned" means "never changed from its default off state". Returning
  // null here (as an earlier version did) made every NOT-gated edge whose source stayed quietly
  // off fall through to the muted "unknown" branch instead of correctly inverting to red — the
  // reported "NOT SV21T not turning red even though SV21T isn't asserted" bug. Report false with
  // a neverSeen flag so a caller that truly needs to distinguish "confirmed off" from "never
  // observed" still can, while the common state-based logic just sees false.
  return seen ? { state, asOf } : { state: false, asOf: 'throughout this record (never asserted)', neverSeen: true };
}

// Renders the graph from buildLocalLogicGraph as a compact, horizontally-scrollable row of
// columns — deliberately simple (flexbox, not hand-placed SVG coordinates like the main trip
// diagram) since this is a small on-demand aid, not the primary diagram. Every box is a normal
// tt() span, so it's already hoverable/clickable, and clicking one calls showBitDetail() again
// — which naturally re-centers this same graph on the newly-clicked bit, letting someone walk
// the logic outward one click at a time without leaving the popup.

// Dedicated rendering for a self-oscillating pair (SVxx / SVxxT) — rather than forcing it
// through the general left/center/forward column layout (which has no good way to represent
// "feeds back into itself"), this draws exactly the two boxes involved, connected by two
// arrows: one for the timed pickup relationship (SVxx -> SVxxT, labeled with the actual delay),
// and one for the feedback that makes SVxx what it is (SVxxT -> SVxx), labeled as the "NOT"
// modifier it actually is in the equation — same treatment the main trip diagram gives a NOT
// prefix, just relocated onto the arrow instead of the box.
// Small legend explaining the color coding shared by both logic-chart variants below — kept
// as one function so the two stay in sync if the coloring convention ever changes.
// Shared between the legend and the actual line rendering, so the two dash patterns always
// mean the same thing everywhere they appear. A plain NOT gets a longer dash; anything
// involving R_TRIG/F_TRIG (an edge-triggered condition, possibly combined with NOT) gets a
// tighter dotted pattern — visually distinct at a glance, not just distinguishable by hovering.
const LLG_NOT_DASH = '5,3';
const LLG_TRIG_DASH = '1.5,2';

function renderLLGLegend() {
  const swatch = style => `<span style="display:inline-block;width:8px;height:8px;border-radius:2px;${style}"></span>`;
  const dashSample = (pattern) => `<svg width="18" height="8" style="vertical-align:middle;overflow:visible;"><line x1="0" y1="4" x2="18" y2="4" stroke="var(--text-dim)" stroke-width="1.5" stroke-dasharray="${pattern}"/></svg>`;
  const mergeSample = `<svg width="26" height="16" style="vertical-align:middle;overflow:visible;">
    <path d="M 2 2 L 20 2" fill="none" stroke="var(--text-dim)" stroke-width="1.5"/>
    <path d="M 2 14 L 20 14" fill="none" stroke="var(--text-dim)" stroke-width="1.5"/>
    <path d="M 12 2 L 12 14" fill="none" stroke="var(--text-dim)" stroke-width="1.5"/>
    <text x="10" y="11" text-anchor="end" font-size="8" font-weight="700" font-family="var(--sans)" fill="var(--text-dim)">&amp;</text>
  </svg>`;
  return `<div id="llgSourceLegend" style="display:flex;flex-wrap:wrap;gap:6px 12px;font-size:9.5px;color:var(--text-muted);margin:4px 0 8px;align-items:center;">
    <span>${swatch('background:var(--red-dim);border:1px solid var(--red);')} Asserted</span>
    <span>${swatch('background:var(--bg2);border:1px solid var(--card-border);')} Not asserted / unknown</span>
    <span>${swatch('background:var(--bg2);border:1px solid var(--card-border);box-shadow:0 0 0 2px var(--accent);')} Bit you clicked</span>
    <span>${dashSample(LLG_NOT_DASH)} Negated (NOT)</span>
    <span>${dashSample(LLG_TRIG_DASH)} Edge-triggered (R_TRIG/F_TRIG)</span>
    <span>${mergeSample} Bracket (&amp;) marks inputs AND-ed together (colored by whether ALL are met); inputs with no bracket are alternative OR inputs</span>
    <span>🖱️ Hover any line to see exactly what it connects</span>
    <span>⏱️ A timed connection (a base bit → its timed output, or an SV's own pickup/dropout into itself) animates the color traveling along the line while that timer is actually running</span>
  </div>`;
}

// Small toolbar shown in the corner of every logic-chart instance — "expand" opens an
// enlarged, scrollable overlay copy (useful once a full trip-chain chart gets wide), and
// "save as image" renders the current chart to a PNG download. Both act on whichever chart is
// currently in the bit-detail popup (only one is ever open at a time), located by a fixed id
// rather than needing per-instance ids threaded through every caller.
function renderLLGToolbar() {
  return `<div style="display:flex;gap:6px;flex:0 0 auto;">
    <button type="button" class="llg-tool-btn" title="Expand to full size" onclick="expandLogicChart()">⛶</button>
    <button type="button" class="llg-tool-btn" title="Save as image" onclick="downloadLogicChart()">⬇</button>
  </div>`;
}
function renderLLGHeader(text, tripFocus) {
  const badge = tripFocus ? `<span class="llg-trip-badge">Full trip chain</span>` : '';
  return `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:2px;">
    <div style="font-size:11px;color:var(--text-dim);">${text}${badge}</div>
    ${renderLLGToolbar()}
  </div>`;
}

function renderBlinkerPair(clickedLabel, P) {
  const m = clickedLabel.match(/^SV(\d+)T?$/);
  const num = parseInt(m[1]);
  const sv = (P.svSettings || []).find(s => s.num === num);
  if (!sv) return '';
  const bareLabel = `SV${num}`, timedLabel = `SV${num}T`;
  const freq = P.eventInfo?.freq || 60;
  const puMs = (sv.pickupDelay / freq * 1000).toFixed(0);

  const stateCls = lbl => {
    const st = currentBitState(lbl);
    return (st && st.state) ? 'llg-true' : '';
  };
  const leftCls = `${stateCls(bareLabel)} ${clickedLabel === bareLabel ? 'llg-center' : ''}`;
  const rightCls = `${stateCls(timedLabel)} ${clickedLabel === timedLabel ? 'llg-center' : ''}`;

  return `<div class="llg-diagram-outer" style="margin-top:12px;">
    ${renderLLGHeader('Logic chart — what feeds this bit, and what it feeds into: <span style="color:var(--text-muted);">(blinker — no diagnostic meaning)</span>', false)}
    ${renderLLGLegend()}
    <div class="llg-diagram-body" id="llgSourceBody" style="position:relative;padding:26px 0 22px;">
      <svg viewBox="0 0 220 74" preserveAspectRatio="none" style="position:absolute;top:0;left:0;width:100%;height:100%;overflow:visible;pointer-events:none;">
        <text x="110" y="10" text-anchor="middle" font-size="10" font-family="var(--mono)" fill="var(--text-muted)">${puMs} ms</text>
        <path d="M 55 30 C 80 8, 140 8, 165 28" fill="none" stroke="var(--text-muted)" stroke-width="1.5"/>
        <polygon points="165,28 155,24 158,32" fill="var(--text-muted)"/>
        <path d="M 165 46 C 140 66, 80 66, 55 46" fill="none" stroke="var(--text-muted)" stroke-width="1.5" stroke-dasharray="${LLG_NOT_DASH}"><title>NOT</title></path>
        <polygon points="55,46 65,42 62,50" fill="var(--text-muted)"/>
      </svg>
      <div style="display:flex;justify-content:center;gap:56px;">
        <div class="llg-box ${leftCls}">${tt(bareLabel, P)}</div>
        <div class="llg-box ${rightCls}">${tt(timedLabel, P)}</div>
      </div>
    </div>
  </div>`;
}

function renderLocalLogicGraph(graph, P, tripFocus) {
  if (isBlinkerLabel(graph.center, P)) return renderBlinkerPair(graph.center, P);

  const columns = [...graph.backward, [graph.center], ...graph.forward];
  if (columns.length < 2) return ''; // nothing upstream or downstream worth drawing

  // Absolute-positioned grid, same idea as the main trip diagram: every box gets an exact x/y,
  // and every edge gets its OWN line between the two specific boxes it actually connects —
  // not one shared arrow standing in for a whole column-to-column relationship.
  const BOX_W = 98, BOX_H = 24, ROW_H = 32, MARGIN = 10;
  const MIN_GAP = 52;      // gap width for a simple 1-2 lane connection between columns
  const LANE_SPACING = 12; // minimum on-center spacing between two parallel lane lines
  const LANE_PAD = 5;      // clearance from each box edge, so a lane never touches a box border
  const GROUP_GAP = 14;    // extra vertical space inserted between two unrelated clusters of bits in the same column

  const colIndexOf = {};
  columns.forEach((col, ci) => col.forEach(lbl => { colIndexOf[lbl] = ci; }));

  // Every edge routes orthogonally — horizontal stub out of the source, vertical riser sitting
  // in the MIDDLE of the gap between columns (never over a column's own box range), horizontal
  // stub into the target. An edge between adjacent columns needs only one riser (there's only
  // one gap to cross); an edge that SKIPS one or more columns (which happens when a bit was
  // already placed earlier by a different branch) routes its risers through a shared lane above
  // the whole diagram instead, so the horizontal leg crossing the skipped columns clears every
  // box in them rather than cutting across at some in-between row. Each skip edge gets its own
  // lane so multiple skips don't overlap.
  const adjacentEdges = [], skipEdges = [], feedbackEdges = [];
  graph.edges.forEach(e => {
    if (e.feedback) { feedbackEdges.push(e); return; } // self-timer loop — drawn distinctly, not routed as a normal input
    const ciFrom = colIndexOf[e.from], ciTo = colIndexOf[e.to];
    if (ciFrom == null || ciTo == null) return;
    (Math.abs(ciTo - ciFrom) <= 1 ? adjacentEdges : skipEdges).push(e);
  });

  // An edge's "from" and "to" reflect logical dependency, not necessarily left-to-right screen
  // position — a bit already placed by one branch can turn out to be a direct input for
  // another branch discovered later, landing it in a column to the RIGHT of the thing it feeds.
  // Routing must always exit whichever endpoint is actually more leftward from ITS right edge,
  // and enter whichever is actually more rightward at ITS left edge — using from/to directly
  // without checking this is exactly what caused stubs to double back through their own box.
  const leftRight = e => {
    const ciFrom = colIndexOf[e.from], ciTo = colIndexOf[e.to];
    return ciFrom <= ciTo ? [e.from, e.to, ciFrom, ciTo] : [e.to, e.from, ciTo, ciFrom];
  };

  // ── Channel/lane assignment — done BEFORE pixel positions, since gap widths below now ──
  // depend on how many lanes actually pass through each one. Two different edges routing their
  // vertical riser through the SAME gap must not sit on the exact same x (that's what made
  // separate connections visually indistinguishable), so every riser is registered against the
  // gap it passes through, then spread across distinct lanes within it — like parallel traces
  // on a circuit board never running on top of each other.
  const gapRisers = {}; // gap index -> array of riser records (mutated with laneIdx/laneCount below)
  const registerRiser = gap => {
    const arr = gapRisers[gap] || (gapRisers[gap] = []);
    const r = {};
    arr.push(r);
    return r;
  };

  const edgeMeta = [];
  adjacentEdges.forEach(e => {
    const [leftLbl, rightLbl, ciL, ciR] = leftRight(e);
    if (ciL === ciR) { edgeMeta.push({ e, leftLbl, rightLbl, ciL, ciR, sameCol: true }); return; }
    edgeMeta.push({ e, leftLbl, rightLbl, ciL, ciR, riser: registerRiser(ciL) });
  });
  const skipMeta = [];
  // A skip edge used to always get its OWN dedicated lane above the diagram, even when its
  // column span never overlaps another skip edge's span — with a large chart (e.g. the full TR
  // trip chain) that meant dozens of stacked lanes and a tall, tangled-looking sweep of lines
  // across the top for no real reason. Greedy interval packing instead reuses a lane whenever
  // the new edge's span starts after a previous occupant's span has already ended, so only
  // spans that GENUINELY overlap ever need to be visually separated.
  const laneEnds = []; // laneEnds[i] = the rightmost column-index currently occupied by lane i
  skipEdges.forEach(e => {
    const [leftLbl, rightLbl, ciL, ciR] = leftRight(e);
    let laneIdx = laneEnds.findIndex(end => end < ciL);
    if (laneIdx === -1) { laneIdx = laneEnds.length; laneEnds.push(ciR - 1); }
    else laneEnds[laneIdx] = ciR - 1;
    const riserIn = registerRiser(ciL);
    const riserOut = registerRiser(ciR - 1);
    skipMeta.push({ e, leftLbl, rightLbl, ciL, ciR, riserIn, riserOut, laneIdx });
  });
  const skipLaneCount = laneEnds.length;

  Object.values(gapRisers).forEach(list => {
    list.forEach((r, i) => { r.laneIdx = i; r.laneCount = list.length; });
  });

  // Each gap gets exactly as much width as its busiest moment needs — a gap carrying many
  // parallel lines that AREN'T all converging on the same box (the case that used to get
  // cramped) is given proportionally more room, while a simple 1-2 lane gap stays compact.
  const numCols = columns.length;
  const gapWidth = gi => {
    const laneCount = gapRisers[gi] ? gapRisers[gi].length : 0;
    return Math.max(MIN_GAP, laneCount * LANE_SPACING + LANE_PAD * 2);
  };
  const colX = [MARGIN];
  for (let ci = 1; ci < numCols; ci++) colX.push(colX[ci - 1] + BOX_W + gapWidth(ci - 1));
  const gapMidX = gi => colX[gi] + BOX_W + gapWidth(gi) / 2;
  const laneX = (gap, riser) => {
    if (riser.laneCount <= 1) return gapMidX(gap);
    const usableW = gapWidth(gap) - LANE_PAD * 2;
    const startX = colX[gap] + BOX_W + LANE_PAD;
    return startX + (riser.laneIdx + 0.5) * (usableW / riser.laneCount);
  };

  // ── Column clustering ──
  // Within one column, bits that don't share any connection at all (directly, or via a common
  // neighbor) represent genuinely separate logical flows — packing them into one undifferentiated
  // stack of rows makes it hard to tell where one branch ends and an unrelated one begins.
  // Grouping by shared-neighbor connectivity and inserting extra vertical space between groups
  // (not within one) keeps a real branch visually tight while separating distinct ones. This part
  // (WHICH bits belong together) doesn't depend on column order, so it can be precomputed for
  // every column up front.
  function clusterColumn(colLabels) {
    const neighborsOf = {};
    colLabels.forEach(l => { neighborsOf[l] = new Set(); });
    graph.edges.forEach(e => {
      if (neighborsOf[e.from]) neighborsOf[e.from].add(e.to);
      if (neighborsOf[e.to]) neighborsOf[e.to].add(e.from);
    });
    const parent = {};
    colLabels.forEach(l => { parent[l] = l; });
    const find = l => (parent[l] === l ? l : (parent[l] = find(parent[l])));
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (let i = 0; i < colLabels.length; i++) {
      for (let j = i + 1; j < colLabels.length; j++) {
        const a = colLabels[i], b = colLabels[j];
        let shares = neighborsOf[a].has(b) || neighborsOf[b].has(a);
        if (!shares) for (const n of neighborsOf[a]) { if (neighborsOf[b].has(n)) { shares = true; break; } }
        if (shares) union(a, b);
      }
    }
    const rootOf = {}; colLabels.forEach(l => { rootOf[l] = find(l); });
    return rootOf;
  }

  const colGroups = columns.map(col => clusterColumn(col)); // label -> group-root, per column
  const colHeight = columns.map((col, ci) => {
    const roots = new Set(col.map(l => colGroups[ci][l]));
    return col.length * ROW_H + Math.max(0, roots.size - 1) * GROUP_GAP;
  });

  const LANE_H = 7;
  // A skip edge's horizontal lane segment only passes OVER the columns strictly BETWEEN its two
  // endpoints — the source and target columns themselves just need a plain vertical riser out to
  // that lane, which is fine at any height. Reserving the SAME clearance (based on the busiest
  // lane stack anywhere in the whole diagram) above every column, including ones no skip edge
  // ever crosses, is what forced short local hops to route all the way up to whatever height the
  // busiest, most distant part of the chart happened to need. Reserving clearance per column,
  // based on the highest lane index that ACTUALLY passes over THAT column, keeps each column —
  // and each edge's riser — no taller than its own local situation requires.
  const laneReqByCol = {}; // column index -> number of lanes that need clearance above it
  skipMeta.forEach(m => {
    for (let c = m.ciL + 1; c <= m.ciR - 1; c++) laneReqByCol[c] = Math.max(laneReqByCol[c] || 0, m.laneIdx + 1);
  });
  const topPadForCol = ci => MARGIN + (laneReqByCol[ci] || 0) * LANE_H;
  const totalW = colX[numCols - 1] + BOX_W + MARGIN;
  // Columns are vertically centered against the tallest column's content height, for a visually
  // balanced look — a short column doesn't just hug the top while a tall one stretches far below
  // it. Precomputed up front (not inside the per-column layout loop below) because skip-edge
  // lanes need to know, for the SPECIFIC columns each edge spans, where their content actually
  // starts — clearing just the tallest column between an edge's two endpoints, not the tallest
  // column anywhere in the whole diagram (that distinction is what the per-column clearance
  // above already fixed; this keeps that fix intact even with centering restored).
  const totalH = Math.max(...colHeight, ROW_H);
  const colStartY = columns.map((_, ci) => topPadForCol(ci) + (totalH - colHeight[ci]) / 2);
  const height = Math.max(...columns.map((_, ci) => colStartY[ci] + colHeight[ci])) + MARGIN;

  // ── Row ordering within each column — barycenter heuristic ──
  // WHICH row a bit lands in (within its group) is a completely separate question from which
  // group it's in, and it's what actually determines how many lines cross one another. Once a
  // column's neighbors in the PREVIOUS column already have final y-positions, sorting this
  // column's members (within each group, and the groups themselves) by the average y of their
  // already-placed neighbors is the standard "barycenter" layered-graph heuristic — it tends to
  // line connected bits up with each other instead of leaving their order to whatever sequence
  // the backward/forward BFS happened to discover them in, which is what was actually causing
  // lines to cross more than they needed to. Processed strictly left-to-right so every column's
  // ordering can lean on the previous column's FINAL (not provisional) positions.
  const pos = {}; // label -> {x, y} (top-left of its box), filled in column order below
  // A "priority" edge (see the SV/protection-element timed-output rules above) is a bit's own
  // private, single-purpose pairing with its timed output — worth weighting several times over
  // in the barycenter average below, so that relationship wins out even when the timed output
  // sits in a busy column with a dozen OTHER, less specific neighbors that would otherwise dilute
  // the average and pull the pair apart instead of keeping them close together.
  const PRIORITY_WEIGHT = 5;
  const neighborYs = lbl => {
    const ys = [];
    graph.edges.forEach(e => {
      const w = e.priority ? PRIORITY_WEIGHT : 1;
      if (e.from === lbl && pos[e.to]) { for (let i = 0; i < w; i++) ys.push(pos[e.to].y); }
      else if (e.to === lbl && pos[e.from]) { for (let i = 0; i < w; i++) ys.push(pos[e.from].y); }
    });
    return ys;
  };

  columns.forEach((col, ci) => {
    const rootOf = colGroups[ci];
    // Score each bit by its already-placed neighbors' average y (nulls — no placed neighbor
    // yet — sort after everything with a real score, keeping their original relative order).
    const scored = col.map((lbl, idx) => {
      const ys = neighborYs(lbl);
      return { lbl, idx, bary: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null };
    });
    const baryOf = {}; scored.forEach(s => { baryOf[s.lbl] = s; });
    // A group's own position is the average of its members' individual scores (falling back to
    // first-appearance order when nothing in the group has a score yet), which keeps the whole
    // group moving together rather than interleaving with another group's members.
    const groupScore = {};
    col.forEach(lbl => {
      const r = rootOf[lbl];
      if (groupScore[r] !== undefined) return;
      const members = col.filter(l => rootOf[l] === r);
      const withBary = members.map(l => baryOf[l]).filter(s => s.bary != null);
      groupScore[r] = withBary.length
        ? withBary.reduce((a, s) => a + s.bary, 0) / withBary.length
        : Math.min(...members.map(l => baryOf[l].idx));
    });
    const sorted = [...col].sort((a, b) => {
      const ga = groupScore[rootOf[a]], gb = groupScore[rootOf[b]];
      if (ga !== gb) return ga - gb;
      const sa = baryOf[a], sb = baryOf[b];
      if (sa.bary != null && sb.bary != null && sa.bary !== sb.bary) return sa.bary - sb.bary;
      if (sa.bary == null && sb.bary != null) return 1;
      if (sa.bary != null && sb.bary == null) return -1;
      return sa.idx - sb.idx;
    });
    const isGroupStart = {}; let lastRoot = null;
    sorted.forEach(l => { isGroupStart[l] = (rootOf[l] !== lastRoot); lastRoot = rootOf[l]; });

    let y = colStartY[ci];
    sorted.forEach((lbl, ri) => {
      if (ri > 0 && isGroupStart[lbl]) y += GROUP_GAP;
      pos[lbl] = { x: colX[ci], y };
      y += ROW_H;
    });
  });

  // Color reflects whether this connection is actually CONTRIBUTING to a true result right now
  // — not just the source bit's raw state. A NOT edge is satisfied when its source is NOT
  // asserted, so it needs to read red in exactly that case, not the reverse (an earlier version
  // colored purely off the raw state, so a satisfied NOT condition confusingly looked "off").
  // R_TRIG/F_TRIG have no reliable instantaneous "is this edge contributing" derivation
  // available here, so those still fall back to the raw state, same as an unmodified edge.
  // No special case for edges touching the center bit either — an earlier version forced those
  // to a fixed accent blue regardless of state, which looked like a genuine "real driver" signal
  // but wasn't one. The center box already gets its own accent ring (.llg-center) to mark which
  // one was clicked; edge color is free to mean only one thing.
  const edgeColor = ({ from, mod }) => {
    const st = currentBitState(llgDisplayLabel(from));
    if (!st) return 'var(--text-muted)';
    const contributes = /\bNOT\b/.test(mod || '') ? !st.state : st.state;
    return contributes ? 'var(--red)' : 'var(--text-muted)';
  };

  // ── Timer-pair animation (pickup/dropout) ──
  // A "priority" edge (see buildLocalLogicGraph) is a bit's own base -> timed-output pairing —
  // SV15 -> SV15T, 51P1 -> 51P1T, and the like. Rather than snapping straight to red the instant
  // the base bit asserts (which is what a plain edge does, and is misleading here — the timed
  // output hasn't actually picked up yet), find the ACTUAL recorded transition times for both
  // ends and, while the timer is genuinely in progress, animate the color traveling along the
  // line at the same real pace: red growing from the base end during pickup, muted/gray growing
  // from the base end during dropout — using the file's own observed timing, not a settings
  // lookup, so it works for hardware protection elements (which may have no separately
  // configured delay available anywhere in the parsed settings) exactly as well as it does SVs.
  const timedViewIdx = LLG_VIEW_SAMPLE_IDX != null ? LLG_VIEW_SAMPLE_IDX
    : (ANALYSIS?.tripCause?.tripTransition?.digitalSampleIdx ?? null);
  // Last transition, at or before `atIdx`, where `label` changed to exactly `wantAsserted`.
  function lastTransitionTo(label, atIdx, wantAsserted) {
    const trans = P.digitalTransitions || [];
    let found = null;
    for (const t of trans) {
      if (t.digitalSampleIdx > atIdx) break;
      const c = t.changes.find(ch => ch.label === label);
      if (c && c.asserted === wantAsserted) found = t.digitalSampleIdx;
    }
    return found;
  }
  // First transition, strictly after `afterIdx`, where `label` changed to exactly `wantAsserted`.
  function nextTransitionTo(label, afterIdx, wantAsserted) {
    const trans = P.digitalTransitions || [];
    for (const t of trans) {
      if (t.digitalSampleIdx <= afterIdx) continue;
      const c = t.changes.find(ch => ch.label === label);
      if (c && c.asserted === wantAsserted) return t.digitalSampleIdx;
    }
    return null;
  }
  // Returns {frac, kind, bgColor, overlayColor} while base/target are genuinely mid-timer right
  // now, or null when they're not (stable, instantaneous, or the record doesn't give enough
  // information to place a start/end point — in every one of those cases the edge just falls
  // back to its normal solid, non-animated color).
  function timedPhaseFor(e) {
    if (timedViewIdx == null) return null;
    if (e.priority) {
      // Delegates to the shared measuredTimerPhase() so this chart and the main-page trip tree
      // compute identical progress; only the colour choice differs between the two renderers.
      const ph = measuredTimerPhase(P, llgDisplayLabel(e.from), llgDisplayLabel(e.to), timedViewIdx);
      if (!ph) return null;
      return ph.kind === 'pickup'
        ? Object.assign({}, ph, { bgColor: 'var(--text-muted)', overlayColor: 'var(--red)' })
        : Object.assign({}, ph, { bgColor: 'var(--red)', overlayColor: 'var(--text-muted)' });
    }
    return svOwnDelayPhaseFor(e);
  }
  // An SV's OWN pickup/dropout delay — e.g. "SV20 := 27P1 OR 27P2" with a 0.16-cycle pickup —
  // applies between its input CONDITION becoming satisfied and the SV bit itself asserting, not
  // between two separately-named bits. Unlike the priority-edge case above, the exact delay is
  // already known directly from settings (sv.pickupDelay/dropoutDelay, in cycles), so there's no
  // need to search the record for a confirming transition — just animate for exactly that many
  // cycles from whichever input transition left this edge's own group satisfied-but-not-yet-
  // reflected by the SV. For a multi-member AND/OR group, every member gets checked
  // independently: the one whose transition actually just changed the group's state shows real
  // motion, while other, already-long-settled members simply compute a fraction ≥ 1 (i.e. render
  // as fully solid, same as normal) — so this naturally does the right thing without needing to
  // work out which specific member was "the" trigger.
  function svOwnDelayPhaseFor(e) {
    const target = llgDisplayLabel(e.to);
    const svm = target.match(/^SV(\d+)$/); // bare SV only — SVxxT's own timer is the priority-edge case above
    if (!svm) return null;
    const sv = (P.svSettings || []).find(s => s.num === parseInt(svm[1]));
    if (!sv) return null;
    const targetSt = currentBitState(target);
    if (!targetSt) return null;
    // Whether THIS edge's own group — its AND-branch, its parenthesized sub-expression, or just
    // itself if it's a plain ungrouped OR-alternative — is satisfied right now, compared against
    // whether the SV itself has actually caught up to that yet.
    let groupSatisfied;
    if (e.subGroup) groupSatisfied = subGroupSatisfied(e.subGroup);
    else if (e.andGroup) groupSatisfied = andGroupSatisfied(e.andGroup);
    else {
      const st = currentBitState(llgDisplayLabel(e.from));
      if (!st) return null;
      groupSatisfied = /\bNOT\b/.test(e.mod || '') ? !st.state : st.state;
    }
    if (groupSatisfied === targetSt.state) return null; // SV has already caught up — nothing running
    const delayCyc = groupSatisfied ? (sv.pickupDelay || 0) : (sv.dropoutDelay || 0);
    if (!delayCyc) return null; // no configured delay in this direction — instantaneous, nothing to animate
    const wantBaseAsserted = /\bNOT\b/.test(e.mod || '') ? !groupSatisfied : groupSatisfied;
    const tBaseChange = lastTransitionTo(llgDisplayLabel(e.from), timedViewIdx, wantBaseAsserted);
    if (tBaseChange == null) return null;
    const samplesPerCyc = P.eventInfo?.samPerCycD || 4;
    const frac = Math.max(0, Math.min(1, (timedViewIdx - tBaseChange) / Math.max(1, delayCyc * samplesPerCyc)));
    return {
      frac,
      kind: groupSatisfied ? 'pickup' : 'dropout',
      bgColor: groupSatisfied ? 'var(--text-muted)' : 'var(--red)',
      overlayColor: groupSatisfied ? 'var(--red)' : 'var(--text-muted)',
    };
  }
  // Straight-line length of an orthogonal "M x y L x y L x y…" path — dasharray follows the
  // path's actual rendered length regardless of how many bends it has, which is what makes the
  // dash-based fill-overlay below work without needing to reason about individual bend geometry.
  function pathLength(d) {
    const n = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    let total = 0;
    for (let i = 2; i + 1 < n.length; i += 2) total += Math.hypot(n[i] - n[i - 2], n[i + 1] - n[i - 1]);
    return total;
  }
  // Draws one edge — animated (a growing color overlay from the base end) while its timer is
  // genuinely in progress, otherwise the normal solid edgeLine exactly as before.
  function drawEdge(d, e) {
    const phase = timedPhaseFor(e);
    if (!phase) {
      const note = svResolutionNote(e);
      if (!note) return edgeLine(d, edgeColor(e), e);
      // Same as edgeLine, but with the resolution-limit note appended to the hover title —
      // there's genuinely no recorded instant to animate across here (see svResolutionNote), so
      // this edge always falls through to this branch for as long as that setting stands.
      const color = edgeColor(e);
      const dash = edgeDash(e && e.mod);
      const title = `<title>${edgeTitleText(e)} — ${note}</title>`;
      return `<path d="${d}" fill="none" stroke="transparent" stroke-width="12">${title}</path>` +
        `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"${dash ? ` stroke-dasharray="${dash}"` : ''}>${title}</path>`;
    }
    const total = pathLength(d);
    const fillLen = phase.frac * total;
    const baseTitle = edgeTitleText(e);
    const title = `<title>${baseTitle} — ${phase.kind} timer ${Math.round(phase.frac * 100)}% complete</title>`;
    let out = `<path d="${d}" fill="none" stroke="transparent" stroke-width="12">${title}</path>`;
    out += `<path d="${d}" fill="none" stroke="${phase.bgColor}" stroke-width="1.5">${title}</path>`;
    if (fillLen > 0.5) out += `<path d="${d}" fill="none" stroke="${phase.overlayColor}" stroke-width="1.5" stroke-dasharray="${fillLen},${total * 2 + 20}">${title}</path>`;
    return out;
  }
  // When an SV's own pickup/dropout is genuinely faster than this file's own digital recording
  // resolution can distinguish (e.g. a 0.16-cycle pickup in a file sampled at 4 digital
  // samples/cycle — 0.25-cycle resolution), there is literally no recorded instant where the SV
  // and its input disagree: both changes land in the very same recorded sample. No animation
  // logic can sweep across a moment that was never recorded — the honest thing to do is explain
  // that on hover rather than silently showing nothing with no indication why.
  function svResolutionNote(e) {
    const target = llgDisplayLabel(e.to);
    const svm = target.match(/^SV(\d+)$/);
    if (!svm) return null;
    const sv = (P.svSettings || []).find(s => s.num === parseInt(svm[1]));
    if (!sv) return null;
    const samplesPerCyc = P.eventInfo?.samPerCycD || 4;
    const minRes = 1 / samplesPerCyc;
    const pu = sv.pickupDelay || 0, dof = sv.dropoutDelay || 0;
    const bits = [];
    if (pu > 0 && pu < minRes) bits.push(`pickup ${pu} cyc`);
    if (dof > 0 && dof < minRes) bits.push(`dropout ${dof} cyc`);
    if (!bits.length) return null;
    return `${bits.join(', ')} faster than this file's digital recording resolution (${minRes.toFixed(2)} cyc/sample) — appears instantaneous here`;
  }

  // ── Port distribution ──
  // A box with several incoming (or outgoing) connections previously had all of them meet at
  // its exact vertical center — fine for one connection, but with several sharing that same
  // point, their final approaches necessarily ran on top of each other for a stretch, which is
  // exactly the "parallel lines touching" ambiguity being avoided everywhere else. Real
  // schematics instead give each connection its own point along the box's edge, like separate
  // pins on an IC, so every approach is genuinely distinct start-to-finish. Ordered by the far
  // end's row so the spread also reads top-to-bottom sensibly rather than arbitrarily.
  //
  // Every edge — AND-grouped or not — now gets its OWN independent port and its own clean line
  // all the way into the box. The earlier design merged an AND-group's members into one shared
  // trunk, which meant several lines ran PARALLEL and close together before joining — exactly
  // the hard-to-read arrangement being avoided. Instead, AND-grouping is shown separately by a
  // small bracket spanning the group's ports at the box edge (drawn below), so lines only ever
  // meet a box perpendicularly and never travel alongside each other to merge.
  const allMeta = [...edgeMeta, ...skipMeta];
  const outUsers = {}, inUsers = {}; // label -> [{meta, otherY}]
  allMeta.forEach(m => {
    const a = pos[m.leftLbl], b = pos[m.rightLbl];
    if (!a || !b) return;
    (outUsers[m.leftLbl] || (outUsers[m.leftLbl] = [])).push({ m, otherY: b.y });
    (inUsers[m.rightLbl] || (inUsers[m.rightLbl] = [])).push({ m, otherY: a.y });
  });
  const distributeFracs = (n, lo, hi, singleFrac) => n <= 1 ? [singleFrac] : Array.from({ length: n }, (_, i) => lo + (hi - lo) * i / (n - 1));
  const assignFracs = (users, isOutSide) => {
    Object.values(users).forEach(list => {
      if (isOutSide) {
        list.sort((p, q) => p.otherY - q.otherY);
      } else {
        // Inbound ports keep each AND-group's members CONTIGUOUS so its bracket (drawn below)
        // spans one unbroken block of adjacent ports — an interleaved order would make a bracket
        // visually reach across, and appear to gather, unrelated OR inputs sitting between the
        // group's own members. Sort primarily by a per-group key (a group's average source-y,
        // or an ungrouped input's own source-y), then within a group by source-y, so groups
        // still land in a sensible top-to-bottom order relative to everything else.
        const groupKey = {};
        list.forEach(p => {
          const gid = p.m.e.andGroup;
          if (gid && groupKey[gid] === undefined) {
            const members = list.filter(q => q.m.e.andGroup === gid);
            groupKey[gid] = members.reduce((s, q) => s + q.otherY, 0) / members.length;
          }
        });
        list.sort((p, q) => {
          const kp = p.m.e.andGroup ? groupKey[p.m.e.andGroup] : p.otherY;
          const kq = q.m.e.andGroup ? groupKey[q.m.e.andGroup] : q.otherY;
          if (kp !== kq) return kp - kq;
          // same key bucket — keep a group's own members together and internally ordered
          const gp = p.m.e.andGroup || '', gq = q.m.e.andGroup || '';
          if (gp !== gq) return gp < gq ? -1 : 1;
          return p.otherY - q.otherY;
        });
      }
      // Deliberately different ranges (and different single-connection offsets) for the
      // outgoing vs incoming side — otherwise an unrelated pair of boxes elsewhere in the
      // diagram can land their ports on the exact same absolute row purely by arithmetic
      // coincidence, producing a stray overlap between two connections that have nothing to do
      // with each other. The single-connection case is the one that matters most here, since
      // most boxes have exactly one input and one output — using the same 0.5 midpoint for both
      // sides (as a naive lo/hi average would) reintroduces the exact coincidence this is meant
      // to avoid, so it gets its own distinct offset instead of the range's midpoint.
      const fracs = isOutSide ? distributeFracs(list.length, 0.08, 0.92, 0.47) : distributeFracs(list.length, 0.12, 0.88, 0.56);
      list.forEach((p, i) => { if (isOutSide) p.m.outFrac = fracs[i]; else p.m.inFrac = fracs[i]; });
    });
  };
  assignFracs(outUsers, true);
  assignFracs(inUsers, false);
  const portY = (m, p, isOut) => p.y + BOX_H * (isOut ? (m.outFrac ?? 0.5) : (m.inFrac ?? 0.5));

  // Correct even when one of the AND-operands is itself a nested OR (e.g. the group behind
  // "(59Q1 OR 59G1) AND NOT SV21T AND 50P1P" must read satisfied when EITHER 59Q1 or 59G1 is
  // true, not both) — evaluates each operand's own real sub-expression via graph.andGroupNodes
  // rather than naively AND-ing every individual flattened leaf together.
  function andGroupSatisfied(gid) {
    const operandNodes = graph.andGroupNodes[gid];
    if (!operandNodes) return false;
    return operandNodes.every(node => llgEvalNode(node, name => currentBitState(name)));
  }
  // Evaluates a single parenthesized sub-expression (e.g. "(59Q1 OR 59G1)") for coloring its
  // fork-join line — true when the sub-expression as a whole is satisfied (either OR member here).
  function subGroupSatisfied(sgid) {
    const node = (graph.subGroupNodes || {})[sgid];
    if (!node) return false;
    return llgEvalNode(node, name => currentBitState(name));
  }
  // A NOT/R_TRIG/F_TRIG modifier used to be a floating text label near the target box — with
  // several lines converging on the same box, it was never clear which specific line a label
  // belonged to. Marking the LINE itself (dashed instead of solid) keeps the indicator glued to
  // the exact connection it describes no matter how many others run alongside it. A plain NOT
  // and an edge-triggered condition (R_TRIG/F_TRIG, possibly combined with NOT) get visibly
  // different dash patterns — see LLG_NOT_DASH/LLG_TRIG_DASH — so the distinction is visible at
  // a glance, not just on hover. A native <title> still gives the exact modifier text on hover —
  // but a bare 1.5px stroke is a genuinely tiny hit target, so a second, invisible, much WIDER
  // copy of the same path (carrying the same title) is drawn first/underneath purely to make
  // that hover easy to land, the same "hit-area padding" technique used for thin SVG lines
  // generally.
  const edgeDash = mod => !mod ? '' : (/TRIG/.test(mod) ? LLG_TRIG_DASH : LLG_NOT_DASH);
  // Every edge gets a real, descriptive hover title — "SOURCE → TARGET", with the modifier
  // (NOT/R_TRIG/F_TRIG) prefixed when present — not just the modified ones as before, and not
  // just the bare modifier text on its own. A wide invisible hit-area copy is drawn under every
  // edge now too (previously only modified edges got one), since a bare 1.5px stroke is a tiny
  // target to actually land a cursor on regardless of whether it's dashed.
  const edgeTitleText = e => `${e && e.mod ? e.mod + ' ' : ''}${e ? e.from : '?'} → ${e ? e.to : '?'}`.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const edgeTitleTag = e => `<title>${edgeTitleText(e)}</title>`;
  const hitArea = (d, e) => `<path d="${d}" fill="none" stroke="transparent" stroke-width="12">${edgeTitleTag(e)}</path>`;
  const edgeLine = (d, color, e) => {
    const dash = edgeDash(e && e.mod);
    return `${hitArea(d, e)}<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"${dash ? ` stroke-dasharray="${dash}"` : ''}>${edgeTitleTag(e)}</path>`;
  };

  // ── Fork-join for parenthesized sub-expressions ──
  // A parenthesized OR sub-expression inside an AND (e.g. the "(59Q1 OR 59G1)" in
  // "(59Q1 OR 59G1) AND NOT SV21T AND 50P1P") is drawn as a fork: each member runs horizontally
  // to a shared vertical bar just left of the target box, they meet at that bar, and ONE line
  // forks out of the bar toward the box — visually mirroring the parentheses. Compute each
  // sub-group's bar geometry from its members' ports first, so the edge loops below can redirect
  // those members to the bar instead of routing them all the way into the box.
  const FORK_OFFSET = 20; // how far left of the box the fork bar sits
  const subGroupBar = {}; // sgid -> { x, top, bot, joinY, targetX }
  {
    const membersBySub = {};
    allMeta.forEach(m => {
      const sg = m.e.subGroup;
      if (!sg) return;
      const b = pos[m.rightLbl];
      if (!b) return;
      (membersBySub[sg] || (membersBySub[sg] = [])).push({ m, y: portY(m, b, false), targetX: b.x });
    });
    Object.entries(membersBySub).forEach(([sg, members]) => {
      if (members.length < 2) return; // single member: nothing to fork
      const ys = members.map(p => p.y);
      const targetX = members[0].targetX;
      subGroupBar[sg] = {
        x: targetX - FORK_OFFSET,
        top: Math.min(...ys),
        bot: Math.max(...ys),
        joinY: (Math.min(...ys) + Math.max(...ys)) / 2,
        targetX,
      };
    });
  }

  let linesHTML = '';
  edgeMeta.forEach(m => {
    const a = pos[m.leftLbl], b = pos[m.rightLbl];
    if (!a || !b) return;
    const x1 = a.x + BOX_W, y1 = portY(m, a, true);
    const bar = m.e.subGroup && subGroupBar[m.e.subGroup];
    // A sub-group member terminates at the fork bar (at its own port height), not the box.
    const x2 = bar ? bar.x : b.x;
    const y2 = bar ? portY(m, b, false) : portY(m, b, false);
    const midX = m.sameCol ? (x1 + x2) / 2 : laneX(m.ciL, m.riser);
    linesHTML += drawEdge(`M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`, m.e);
  });
  skipMeta.forEach(m => {
    const a = pos[m.leftLbl], b = pos[m.rightLbl];
    if (!a || !b) return;
    const x1 = a.x + BOX_W, y1 = portY(m, a, true);
    const bar = m.e.subGroup && subGroupBar[m.e.subGroup];
    const x2 = bar ? bar.x : b.x;
    const y2 = portY(m, b, false);
    const riserFromX = laneX(m.ciL, m.riserIn);
    const riserToX = laneX(m.ciR - 1, m.riserOut);
    // The lane only has to clear the SPECIFIC columns it passes over — routing it relative to
    // the absolute top of the whole diagram (as before) meant a short local hop between two
    // otherwise-short columns still had to travel all the way up to y≈0, even when those columns
    // themselves sit nowhere near the top (every column is vertically centered against the
    // TALLEST column anywhere in the chart, so a short column can easily sit in the middle of a
    // tall diagram). Taking the actual top of ONLY the spanned columns keeps the lane — and the
    // riser reaching it — no taller than this specific connection actually needs.
    let spanTop = Infinity;
    for (let c = m.ciL + 1; c <= m.ciR - 1; c++) spanTop = Math.min(spanTop, colStartY[c]);
    const laneY = spanTop - 5 - m.laneIdx * LANE_H;
    linesHTML += drawEdge(`M ${x1} ${y1} L ${riserFromX} ${y1} L ${riserFromX} ${laneY} L ${riserToX} ${laneY} L ${riserToX} ${y2} L ${x2} ${y2}`, m.e);
  });

  // Draw each sub-group's fork: the vertical bar joining its members, plus the single line
  // forking out from the bar's join point to the target box. Colored by whether the whole
  // parenthesized sub-expression is satisfied.
  Object.entries(subGroupBar).forEach(([sg, bar]) => {
    const color = subGroupSatisfied(sg) ? 'var(--red)' : 'var(--text-muted)';
    linesHTML += `<path d="M ${bar.x} ${bar.top} L ${bar.x} ${bar.bot}" fill="none" stroke="${color}" stroke-width="1.5"/>`;
    linesHTML += `<path d="M ${bar.x} ${bar.joinY} L ${bar.targetX} ${bar.joinY}" fill="none" stroke="${color}" stroke-width="1.5"/>`;
  });

  // ── AND-group brackets ──
  // An AND-group is shown as a small vertical bracket just outside the target box's left edge,
  // spanning from the topmost to the bottommost of the group's own inbound ports, with a "&"
  // marker at its mid-height. This says "these specific inputs are AND-ed together" WITHOUT
  // merging their lines (which produced the hard-to-read parallel runs) — every line still
  // arrives at its own port, perpendicular to the box, and the bracket alone carries the
  // grouping meaning. Colored by whether the group is fully satisfied. Ungrouped inputs (pure
  // OR alternatives) get no bracket at all — their separateness IS the OR indication.
  const groupPorts = {}; // gid -> [{y}], collected from every edge carrying that gid
  const subGroupSeen = {}; // gid -> Set of subGroup ids already counted (a sub-group contributes ONE port, at its fork join)
  allMeta.forEach(m => {
    const gid = m.e.andGroup;
    if (!gid) return;
    const b = pos[m.rightLbl];
    if (!b) return;
    const sg = m.e.subGroup;
    if (sg && subGroupBar[sg]) {
      // A sub-group contributes a SINGLE bracket port, at its fork-join y — not one per member
      // (its members stop at the fork bar, not the box). Count it once.
      (subGroupSeen[gid] || (subGroupSeen[gid] = new Set()));
      if (subGroupSeen[gid].has(sg)) return;
      subGroupSeen[gid].add(sg);
      (groupPorts[gid] || (groupPorts[gid] = [])).push({ y: subGroupBar[sg].joinY, targetX: b.x });
    } else {
      (groupPorts[gid] || (groupPorts[gid] = [])).push({ y: portY(m, b, false), targetX: b.x });
    }
  });
  const BRACKET_GAP = 5;   // horizontal distance the bracket sits outside the box's left edge
  const BRACKET_TICK = 4;  // length of the little horizontal ticks at the bracket's ends
  let bracketsHTML = '';
  Object.entries(groupPorts).forEach(([gid, ports]) => {
    if (ports.length < 2) return; // a "group" of one isn't visibly a group; skip the bracket
    const targetX = ports[0].targetX;
    const ys = ports.map(p => p.y);
    const top = Math.min(...ys), bot = Math.max(...ys);
    const bx = targetX - BRACKET_GAP;
    const color = andGroupSatisfied(gid) ? 'var(--red)' : 'var(--text-muted)';
    // Vertical spine (the AND indicator itself — no separate "&" glyph needed), plus a short
    // tick toward the box at each port height so it visibly "gathers" exactly those ports.
    bracketsHTML += `<path d="M ${bx} ${top} L ${bx} ${bot}" fill="none" stroke="${color}" stroke-width="1.5"><title>These inputs are AND-ed together${andGroupSatisfied(gid) ? ' (condition met)' : ''}</title></path>`;
    ys.forEach(y => { bracketsHTML += `<path d="M ${bx} ${y} L ${targetX} ${y}" fill="none" stroke="${color}" stroke-width="1.5"/>`; });
  });
  linesHTML += bracketsHTML;

  // Feedback edges (an SV gated by its OWN timed output, e.g. "SV09 := ... OR SV09T") are drawn
  // as a small self-loop arc off the box's right edge with a dashed style, rather than a line
  // from a phantom upstream box. The source (SVxxT) usually isn't placed as its own box at all,
  // so there's nothing to route from — but the target box is always present, giving a stable
  // anchor. A <title> names the exact feedback bit.
  const FB_R = 7;
  feedbackEdges.forEach(e => {
    const b = pos[e.to];
    if (!b) return;
    const x = b.x + BOX_W, y = b.y + BOX_H * 0.5;
    const st = currentBitState(e.from);
    const color = (st && st.state) ? 'var(--red)' : 'var(--text-muted)';
    // A little loop that leaves the right edge, arcs out and back — visually "returns to self".
    linesHTML += `<path d="M ${x} ${y} q ${FB_R * 1.6} ${-FB_R}, ${FB_R * 1.6} ${FB_R} q 0 ${FB_R * 1.6}, ${-FB_R * 1.6} ${FB_R * 0.9}" fill="none" stroke="${color}" stroke-width="1.5" stroke-dasharray="${LLG_NOT_DASH}"><title>Feedback: ${e.from}${e.mod ? ' (' + e.mod + ')' : ''} — this bit's own timed output loops back into its logic</title></path>`;
  });

  let boxesHTML = '';
  Object.entries(pos).forEach(([lbl, p]) => {
    const displayLbl = llgDisplayLabel(lbl); // a duplicated fan-out leaf's real bit name
    const st = currentBitState(displayLbl);
    const isTrue = !!st && st.state;
    const isTerm = isTerminalBit(displayLbl, P);
    // Terminal (the final trip/close/ER bit) always reads red, matching the main diagram's
    // final-command box; otherwise red if actually asserted (measured bit or SV logic alike),
    // muted default if false/unknown.
    let stateCls = isTrue ? 'llg-true' : '';
    if (isTerm) stateCls += ' llg-terminal';
    const centerCls = lbl === graph.center ? 'llg-center' : '';
    boxesHTML += `<div class="llg-box ${stateCls} ${centerCls}" style="position:absolute;left:${p.x}px;top:${p.y}px;width:${BOX_W}px;height:${BOX_H}px;display:flex;align-items:center;justify-content:center;overflow:hidden;text-overflow:ellipsis;">${tt(displayLbl, P)}</div>`;
  });

  const innerDiagram = `<div style="position:relative;width:${totalW}px;height:${height}px;">
        <svg width="${totalW}" height="${height}" style="position:absolute;top:0;left:0;overflow:visible;">${linesHTML}</svg>
        ${boxesHTML}
      </div>`;

  // Stash everything the timeline needs to re-render this exact chart at a different time
  // WITHOUT recomputing the whole graph (layout, columns, ports are all time-independent —
  // only the colors change). LLG_CURRENT holds the graph + params; redrawLogicChartInner()
  // rebuilds just the SVG/boxes from it at the current view time.
  LLG_CURRENT = { graph, P, tripFocus };

  return `<div class="llg-diagram-outer" style="margin-top:12px;">
    ${renderLLGHeader('Logic chart — what feeds this bit, and what it feeds into:', tripFocus)}
    ${renderLLGLegend()}
    ${renderLogicTimeline(P)}
    <div class="llg-wrap llg-diagram-body" id="llgSourceBody" style="display:block;">
      <div id="llgInnerDiagram">${innerDiagram}</div>
    </div>
  </div>`;
}