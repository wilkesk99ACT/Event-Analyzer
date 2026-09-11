// Logic-tree explanation panel: badges, protection/voltage tables, evidence blocks, charted-bit picker.

function badge(asserted, label) {
  const cls = asserted ? 'badge-red' : 'badge-green';
  const text = label || (asserted ? 'ASSERTED' : 'NORMAL');
  return `<span class="badge ${cls}"><span class="badge-dot"></span>${text}</span>`;
}

// Shared row-markup builders for the Protection tab's two tables — used both by the initial
// full render (renderContent) and by refreshProtectionTab's live cursor-driven updates, so the
// two paths can never visually drift apart for the same underlying data.
// Shows, in the Protection tab itself, exactly what unit basis and magnitude scaling every
// number in the table rests on — and what evidence in the file established it. These two
// conventions are the single largest source of silently-wrong pickup comparisons, so they are
// stated up front and made checkable rather than buried as an assumption.
function renderBasisNote(P) {
  const c = P?.basisCalibration;
  if (!c) return '';
  const CTR = P?.settings?.CTR;
  const bits = [];
  bits.push(`Pickups are relay <b>secondary</b> amps; this file's current channels read as <b>${c.isPrimary ? 'primary' : 'secondary'}</b>${c.isPrimary && CTR ? ` (converted using CTR = ${CTR})` : ''}.`);
  bits.push(`Magnitude scaling: <b>x${c.magScale === 1 ? '1 (none)' : c.magScale.toFixed(4)}</b> — ${c.detail}`);
  bits.push(`Calibrated from ${c.source}; confidence: ${c.confidence}.`);
  if (c.observedCurrentRatio != null) bits.push(`Observed ratio vs the relay's own reported fault currents: ${c.observedCurrentRatio}${c.observedVoltageRatio != null ? `; vs VNOM x PTR: ${c.observedVoltageRatio}` : ''}.`);
  return `<div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;line-height:1.5;border-left:2px solid var(--accent);padding-left:8px;">
    <b style="color:var(--text-dim);">Unit basis for this file</b><br>${bits.join('<br>')}
  </div>`;
}

function renderOcTableRows(rows) {
  return rows.map(p => {
    const mColor = parseFloat(p.multiple) >= 1 ? 'var(--red)' : 'var(--green)';
    // Three distinct outcomes, not two: over pickup and free to operate; over pickup but
    // supervised off by torque control (the relay's own element bit stays low, or its timed
    // output is blocked); and simply below pickup. Collapsing the middle case into "ASSERTED"
    // is what makes a table disagree with the relay's own relay-word bits. The full explanation
    // lives in a native tooltip (title attr) rather than as always-visible text under the row,
    // so a torque-controlled element doesn't blow out the row height or column width — hover
    // (or focus, for keyboard/touch) the badge to read it.
    let statusCell;
    if (p.torqueBlocked && p.overPickup) {
      const short = p.blocked ? 'BLOCKED' : 'OUTPUT BLOCKED';
      statusCell = badge(false, short).replace('badge-green', 'badge-yellow')
        .replace('<span class="badge', `<span title="${escapeAttr(p.torqueNote || '')}" class="badge`);
    } else {
      statusCell = badge(p.asserted);
    }
    return `<tr>
      <td style="color:var(--accent);font-weight:700">${p.element}</td><td>${p.type}</td>
      <td>${p.pickup}</td><td>${p.measured}</td>
      <td style="color:${mColor};font-weight:700">${p.multiple}×</td>
      <td>${p.timeDelay}</td><td>${p.operationTime}</td>
      <td>${statusCell}</td>
    </tr>`;
  }).join('');
}
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Classifies a voltage protection row into the group it should be displayed under, so the flat
// list (which for a 651R with both Y/Z terminals fully populated can run past 40 rows) reads as
// a handful of labeled sections instead of one undifferentiated table. `kind` (set on the row in
// analyzeCEV) is the same key used to index into A.cursorData.voltage[term], so it already
// distinguishes phase (A/B/C), phase-to-phase (ab/bc/ca), and sequence (zero/neg/pos) — grouping
// just reads that same distinction rather than re-deriving it from the element name.
function voltGroupOf(v) {
  if (v.kind === 'zero' || v.kind === 'neg' || v.kind === 'pos') return 'Sequence (3V0 / V2 / V1)';
  if (v.kind === 'ab' || v.kind === 'bc' || v.kind === 'ca') return 'Phase-to-Phase';
  const lvl = v.element.match(/(\d)$/)?.[1] || '';
  return `Phase (Level ${lvl || '?'})`;
}
const VOLT_GROUP_ORDER = ['Phase (Level 1)', 'Phase (Level 2)', 'Phase (Level 3)', 'Phase (Level 4)', 'Phase-to-Phase', 'Sequence (3V0 / V2 / V1)'];

function renderVoltTableRows(rows) {
  // Group by terminal first (Y then Z), then by the category above, each preceded by a
  // shaded header row spanning the table — cheap to build (no colgroup/rowspan gymnastics) and
  // keeps every row's cells identical in shape, so the existing column widths still line up.
  const terminals = [...new Set(rows.map(r => r.terminal))].sort(); // 'Y' before 'Z'
  let out = '';
  for (const term of terminals) {
    const inTerm = rows.filter(r => r.terminal === term);
    const groups = new Map();
    inTerm.forEach(v => { const g = voltGroupOf(v); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(v); });
    const orderedGroups = [...groups.keys()].sort((a, b) => VOLT_GROUP_ORDER.indexOf(a) - VOLT_GROUP_ORDER.indexOf(b));
    for (const g of orderedGroups) {
      out += `<tr class="group-row"><td colspan="6">${term}-Terminal — ${g}</td></tr>`;
      out += groups.get(g).map(v => `<tr>
        <td style="color:var(--accent);font-weight:700">${v.element}</td>
        <td>${v.terminal}</td><td>${v.type}</td>
        <td>${v.pickup}</td><td>${v.measured}</td>
        <td>${badge(v.asserted)}</td>
      </tr>`).join('');
    }
  }
  return out;
}

// Picks the sample index the Protection tab should show when no explicit index is given —
// the resolved trip-transition instant if one was found, else the record's trigger sample,
// else the CEV analysis's own fallback default (already computed as A.cursorData's basis).
function defaultProtectionIdx(P, A) {
  const tripIdx = A?.tripCause?.tripTransition?.analogSampleIdx;
  if (tripIdx != null) return tripIdx;
  if (P?.triggerSampleIndex != null && P.triggerSampleIndex > 0) return P.triggerSampleIndex;
  return A?.cursorData ? A.cursorData.length - 1 : 0;
}

// Re-evaluates every Protection tab row at a specific full-record sample index and swaps the
// two table bodies in place (no full tab re-render) — called once right after the initial
// render to sync from the generic analysis-time default up to the real trip instant, and again
// on every cursor move/drag/playback frame via setCursorAll. Passing null falls back to
// defaultProtectionIdx (trip instant, or trigger, or end of record).
function refreshProtectionTab(idxFull) {
  if (!PARSED || !ANALYSIS || !ANALYSIS.cursorData) return;
  const idx = idxFull != null ? idxFull : defaultProtectionIdx(PARSED, ANALYSIS);
  ANALYSIS.protectionStatus = ANALYSIS.protectionRows.map(row => evalOcRowAtIdx(ANALYSIS, row, idx));
  ANALYSIS.voltageStatus = ANALYSIS.voltageRows.map(row => evalVoltRowAtIdx(ANALYSIS, row, idx));

  const ocBody = document.getElementById('ocProtectionTbody');
  if (ocBody) ocBody.innerHTML = renderOcTableRows(ANALYSIS.protectionStatus);
  const voltBody = document.getElementById('voltProtectionTbody');
  if (voltBody) voltBody.innerHTML = renderVoltTableRows(ANALYSIS.voltageStatus);

  const label = document.getElementById('protectionInstantLabel');
  if (label) {
    const cyc = PARSED.eventInfo.samPerCycA || 32;
    const msPerSample = 1000 / ((PARSED.eventInfo.freq || 60) * cyc);
    const trigIdx = PARSED.triggerSampleIndex || 0;
    const relMs = (idx - trigIdx) * msPerSample;
    const isCursor = idxFull != null && idxFull === CURSOR_IDX && CURSOR_IDX != null;
    const isDefaultTrip = idxFull == null;
    label.textContent = isCursor
      ? `Showing values at cursor — t = ${relMs.toFixed(1)} ms from trigger`
      : isDefaultTrip
        ? `Showing values at trip instant — t = ${relMs.toFixed(1)} ms from trigger`
        : `Showing values at t = ${relMs.toFixed(1)} ms from trigger`;
  }
}

// ══════════════════════════════════════════════════════════════════════
// BRANCHING LOGIC TREE — renders A.tripCause.logicTree (built in analyzeCEV)
// ══════════════════════════════════════════════════════════════════════
// Left-to-right causal diagram: the earliest/deepest leaf conditions sit at the left, AND/OR
// groups converge rightward through brace+line connectors (no box of their own — only real
// signals get boxes), continuing through any nested SV logic, and terminating in the final
// trip box on the right. This replaces the old stack of disconnected per-step cards.
let LOGIC_COL_W = 190, LOGIC_ROW_H = 40, LOGIC_BOX_W = 152, LOGIC_BOX_H = 28, LOGIC_MARGIN = 18;

// Strip NOT/R_TRIG/F_TRIG wrapper nodes out of the tree shape entirely, folding them into a
// `.modifiers` label list attached to the real node underneath (VAR/SVNODE/AND/OR). This keeps
// the layout engine simple — it only ever has to deal with 4 node shapes — while still
// preserving the modifier as a small badge drawn on the resulting box.
function unwrapLogicModifiers(node) {
  if (!node) return node;
  const mods = [];
  let n = node;
  while (n.op === 'NOT' || n.op === 'REDGE' || n.op === 'FEDGE') {
    mods.push(n.op === 'NOT' ? 'NOT' : n.op === 'REDGE' ? '\u2191 R_TRIG' : '\u2193 F_TRIG');
    n = n.child;
  }
  const result = Object.assign({}, n, { value: node.value, modifiers: mods });
  if (result.op === 'AND' || result.op === 'OR') {
    result.children = result.children.map(unwrapLogicModifiers);
  } else if (result.op === 'SVNODE' || result.op === 'TIMERNODE') {
    result.child = unwrapLogicModifiers(result.child);
  }
  return result;
}

function logicCollectFlat(node, op) {
  if (node.op === op) return [...logicCollectFlat(node.children[0], op), ...logicCollectFlat(node.children[1], op)];
  return [node];
}

function logicAssignDepth(node, depth, maxRef) {
  node.depth = depth;
  maxRef.v = Math.max(maxRef.v, depth);
  if (node.op === 'SVNODE' || node.op === 'TIMERNODE') { logicAssignDepth(node.child, depth + 1, maxRef); return; }
  if (node.op === 'AND' || node.op === 'OR') {
    const flat = logicCollectFlat(node, node.op);
    node._flat = flat;
    flat.forEach(c => logicAssignDepth(c, depth + 1, maxRef));
  }
}

function logicAssignRows(node, counter) {
  if (node.op === 'VAR') { node.row = counter.v++; return; }
  if (node.op === 'SVNODE' || node.op === 'TIMERNODE') { logicAssignRows(node.child, counter); node.row = node.child.row; return; }
  if (node.op === 'AND' || node.op === 'OR') {
    const flat = node._flat || logicCollectFlat(node, node.op);
    flat.forEach(c => logicAssignRows(c, counter));
    node.row = flat.reduce((s, c) => s + c.row, 0) / flat.length;
  }
}

// Refreshes every node's .value in an already-baked (and possibly pruned) logic tree from the
// CURRENT bit state — via currentBitState(), which respects whatever LLG_VIEW_SAMPLE_IDX is
// currently set (the same override the popup logic chart's timeline uses) — instead of the
// frozen trip-moment snapshot the tree was originally baked with. Only .value fields change;
// the tree's shape (which branches survived pruning) is left exactly as-is, since re-deriving
// which branches WOULD have been pruned at a different instant would require the original,
// closure-private baking machinery this file doesn't expose here. Returns a fresh object tree
// (does not mutate the input) so the canonical trip-moment tree used elsewhere is never disturbed.
function reEvaluateLogicTree(node) {
  if (!node) return node;
  switch (node.op) {
    case 'VAR': {
      const st = currentBitState(node.name);
      return Object.assign({}, node, { value: !!(st && st.state) });
    }
    case 'SVNODE': {
      const child = reEvaluateLogicTree(node.child);
      // refName is the exact bit name (e.g. "SV13T", not the bare "SV13" label) that was
      // actually checked when this tree was first baked — added specifically so re-evaluation
      // later queries the SAME bit, not a guessed variant. Older trees baked before this field
      // existed fall back to the bare label, which is usually — but not always — the right bit.
      const checkName = node.refName || node.label;
      const st = currentBitState(checkName);
      return Object.assign({}, node, { value: !!(st && st.state), child });
    }
    case 'TIMERNODE': {
      const child = reEvaluateLogicTree(node.child);
      const checkName = node.refName || node.label;
      const st = currentBitState(checkName);
      return Object.assign({}, node, { value: !!(st && st.state), child });
    }
    case 'NOT': {
      const child = reEvaluateLogicTree(node.child);
      return Object.assign({}, node, { value: !child.value, child });
    }
    case 'REDGE': case 'FEDGE': {
      const child = reEvaluateLogicTree(node.child);
      return Object.assign({}, node, { value: child.value, child });
    }
    case 'AND': {
      const children = node.children.map(reEvaluateLogicTree);
      return Object.assign({}, node, { value: children.every(c => c.value), children });
    }
    case 'OR': {
      const children = node.children.map(reEvaluateLogicTree);
      return Object.assign({}, node, { value: children.some(c => c.value), children });
    }
    default: return node;
  }
}

function buildLogicTreeSection(P, A) {
  const rawTree = A?.tripCause?.logicTree;
  if (!rawTree) return '';
  const root = unwrapLogicModifiers(rawTree);
  const maxRef = { v: 0 };
  logicAssignDepth(root, 0, maxRef);
  logicAssignRows(root, { v: 0 });
  const maxDepth = maxRef.v;

  // x/y helpers — "final" (synthetic trip box) sits one column to the right of depth 0.
  const xOf = d => LOGIC_MARGIN + (maxDepth - d) * LOGIC_COL_W;
  const yOf = row => LOGIC_MARGIN + 22 + row * LOGIC_ROW_H;
  const finalX = xOf(-1), finalY = yOf(root.row);

  let boxesHTML = '', linesHTML = '';
  const trueColor = 'var(--green)', falseColor = 'var(--text-muted)';

  function modifierBadge(node, x, y) {
    if (!node.modifiers || !node.modifiers.length) return '';
    return `<div class="logic-modifier-badge" style="left:${x}px;top:${y - 15}px;">${node.modifiers.join(' · ')}</div>`;
  }

  // Matches the tooltip logic chart's own convention for a NOT/R_TRIG/F_TRIG connection: the
  // LINE itself goes dashed (a longer dash for a plain NOT, a tighter dotted pattern for an
  // edge-triggered condition — see LLG_NOT_DASH/LLG_TRIG_DASH), colored red when the condition
  // is actually contributing to a true result right now and muted when it isn't. An unmodified
  // connection keeps this diagram's own existing green/false-color scheme untouched.
  function edgeStyleFor(node) {
    const mods = node && node.modifiers;
    if (mods && mods.length) {
      const dash = mods.some(m => /TRIG/.test(m)) ? LLG_TRIG_DASH : LLG_NOT_DASH;
      const color = node.value ? 'var(--red)' : 'var(--text-muted)';
      return { color, dash };
    }
    return { color: node && node.value ? trueColor : falseColor, dash: '' };
  }
  const dashAttr = d => d ? ` stroke-dasharray="${d}"` : '';

  // A short, readable summary of any node for use in an edge's hover title — a plain leaf/SV/
  // timer just gives its own name; a compound AND/OR group (e.g. the "(59Q1 OR 59G1)" fork
  // feeding into a bigger AND) spells out its members so the title still means something even
  // when the edge's actual source is a whole sub-expression, not a single bit.
  function describeLogicNode(node) {
    if (!node) return '?';
    const prefix = (node.modifiers && node.modifiers.length) ? node.modifiers.join(' ') + ' ' : '';
    if (node.op === 'VAR') return prefix + node.name;
    if (node.op === 'SVNODE' || node.op === 'TIMERNODE') return prefix + node.label;
    if (node.op === 'AND' || node.op === 'OR') {
      const parts = (node._flat || []).map(describeLogicNode);
      return prefix + '(' + parts.join(node.op === 'AND' ? ' AND ' : ' OR ') + ')';
    }
    return '?';
  }
  // Draws one edge as a titled, hoverable line: a wide transparent copy underneath (a bare
  // 1.5-2px stroke is a tiny hit target) carrying the SAME <title> as the visible line on top of
  // it, so hovering anywhere near the connection — not just exactly on its pixel-thin path —
  // shows what it actually represents. Matches the tooltip logic chart's own hit-area technique.
  function titledEdge(x1, y1, x2, y2, color, dash, titleText, strokeWidth) {
    const sw = strokeWidth || 1.5;
    const esc = String(titleText).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const title = `<title>${esc}</title>`;
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="transparent" stroke-width="10">${title}</line>` +
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${sw}"${dashAttr(dash)}>${title}</line>`;
  }

  function renderNode(node, consumerLabel) {
    const x = xOf(node.depth), y = yOf(node.row);
    const prefix = (node.modifiers && node.modifiers.length) ? node.modifiers.join(' ') + ' ' : '';
    if (node.op === 'VAR') {
      boxesHTML += `<div class="logic-box logic-leaf-box ${node.value ? 'is-true' : ''}" style="left:${x}px;top:${y}px;width:${LOGIC_BOX_W}px;height:${LOGIC_BOX_H}px;">${prefix}${tt(node.name, P)}</div>`;
      return;
    }
    if (node.op === 'SVNODE') {
      if (!isMultiPortAnd(node.child)) {
        const cx = xOf(node.child.depth) + LOGIC_BOX_W, cy = yOf(node.child.row) + LOGIC_BOX_H / 2;
        const ny = y + LOGIC_BOX_H / 2;
        const es = edgeStyleFor(node.child);
        linesHTML += titledEdge(cx, cy, x, ny, es.color, es.dash, `${describeLogicNode(node.child)} → ${node.label}`);
      }
      boxesHTML += `<div class="logic-box logic-sv-box ${node.value ? 'is-true' : ''}" style="left:${x}px;top:${y}px;width:${LOGIC_BOX_W}px;height:${LOGIC_BOX_H}px;">${prefix}${tt(node.label, P)}</div>`;
      renderNode(node.child, node.label);
      return;
    }
    if (node.op === 'TIMERNODE') {
      // A genuine pickup timer between an SV's own combinational result and its downstream
      // timed reference — drawn as its own hop (dashed connector + delay readout) rather than
      // silently folding SVxx and SVxxT into a single point, so the timer is visible on the
      // diagram exactly where it sits in the real logic.
      const cx = xOf(node.child.depth) + LOGIC_BOX_W, cy = yOf(node.child.row) + LOGIC_BOX_H / 2;
      const ny = y + LOGIC_BOX_H / 2;
      const freqForDelay = (typeof PARSED !== 'undefined' && PARSED?.eventInfo?.freq) || 60;
      const delayMs = Math.round((node.pickupDelay / freqForDelay) * 1000);
      linesHTML += titledEdge(cx, cy, x, ny, node.value ? trueColor : falseColor, '2,3',
        `${node.child.label} → ${node.label} (${node.pickupDelay} cyc / ${delayMs} ms pickup timer)`);
      const midX = (cx + x) / 2 - 16;
      boxesHTML += `<div class="logic-timer-label" style="left:${midX}px;top:${ny - 16}px;" title="Pickup delay: ${node.pickupDelay} cyc (${delayMs} ms)">⏱ ${delayMs}ms</div>`;
      boxesHTML += `<div class="logic-box logic-sv-box logic-timer-box ${node.value ? 'is-true' : ''}" style="left:${x}px;top:${y}px;width:${LOGIC_BOX_W}px;height:${LOGIC_BOX_H}px;">${prefix}${tt(node.label, P)}</div>`;
      renderNode(node.child, node.label);
      return;
    }
    if (node.op === 'AND' || node.op === 'OR') {
      const flat = node._flat;
      const childX = xOf(node.depth + 1);
      const BRACKET_GAP = 14;
      const bracketX = Math.max(childX + LOGIC_BOX_W + 6, x - BRACKET_GAP);
      const isAndGroup = node.op === 'AND' && flat.length > 1;
      if (isAndGroup) {
        // AND: every input keeps its own SEPARATE line reaching all the way into the actual
        // consuming box (whatever's one column to the right — an SV's own labeled box via its
        // SVNODE wrapper, or the final trip box at the true root; either way that box sits at
        // x+LOGIC_COL_W and shares this node's own row, since SVNODE/finalY both copy the
        // child's row directly). Ports are spread across a small band around the box's own
        // vertical center — nothing merges into one shared line. The vertical bracket line
        // crossing all of them is purely a visual "these are AND-ed" marker, carrying no data of
        // its own, drawn LAST so it visibly overlays every line at its junction — matching the
        // tooltip logic chart's real semantics (every AND input visibly enters the gate) rather
        // than the old "merge to one line first" behavior, which is only correct for OR.
        const consumerX = x + LOGIC_COL_W, consumerY = y + LOGIC_BOX_H / 2;
        const n = flat.length;
        const PORT_SPACING = 7;
        const portYs = flat.map((c, i) => consumerY + (i - (n - 1) / 2) * PORT_SPACING);
        // The crossing line must sit at an x strictly BETWEEN the elbow point (bracketX, where
        // each input first jogs to its own port height) and the box's own edge (consumerX) — only
        // there does it actually cross each input's final horizontal run on the way into the box,
        // rather than sitting exactly on top of the elbow jogs themselves (which is why it read
        // as invisible: same x as lines already drawn, nothing left to visibly cross).
        let crossX = consumerX - 10;
        if (crossX <= bracketX) crossX = (bracketX + consumerX) / 2;
        flat.forEach((c, i) => {
          const cy = yOf(c.row) + LOGIC_BOX_H / 2;
          const py = portYs[i];
          const es = edgeStyleFor(c);
          const edgeTitle = `${describeLogicNode(c)} → ${consumerLabel}`;
          linesHTML += titledEdge(xOf(c.depth) + LOGIC_BOX_W, cy, bracketX, cy, es.color, es.dash, edgeTitle);
          linesHTML += titledEdge(bracketX, cy, bracketX, py, es.color, es.dash, edgeTitle);
          linesHTML += titledEdge(bracketX, py, consumerX, py, es.color, es.dash, edgeTitle);
        });
        const topY = Math.min(...portYs), botY = Math.max(...portYs);
        linesHTML += `<line x1="${crossX}" y1="${topY}" x2="${crossX}" y2="${botY}" stroke="${node.value ? trueColor : falseColor}" stroke-width="1.5"><title>All inputs AND-ed together</title></line>`;
      } else {
        // OR (or a degenerate single-input group): inputs merge into ONE shared line before
        // continuing on — unchanged fork-join behavior, correct for "any one of these suffices".
        const outX = x + LOGIC_BOX_W, outY = y + LOGIC_BOX_H / 2;
        const ys = flat.map(c => yOf(c.row) + LOGIC_BOX_H / 2);
        const topY = Math.min(...ys), botY = Math.max(...ys);
        flat.forEach(c => {
          const cy = yOf(c.row) + LOGIC_BOX_H / 2;
          const es = edgeStyleFor(c);
          linesHTML += titledEdge(xOf(c.depth) + LOGIC_BOX_W, cy, bracketX, cy, es.color, es.dash, `${describeLogicNode(c)} → ${consumerLabel}`);
        });
        linesHTML += `<line x1="${bracketX}" y1="${outY}" x2="${outX}" y2="${outY}" stroke="${node.value ? trueColor : falseColor}" stroke-width="1.5"><title>Any one of these is enough (OR)</title></line>`;
        if (flat.length > 1) linesHTML += `<line x1="${bracketX}" y1="${topY}" x2="${bracketX}" y2="${botY}" stroke="${node.value ? trueColor : falseColor}" stroke-width="1.5"><title>Any one of these is enough (OR)</title></line>`;
      }
      boxesHTML += modifierBadge(node, x, y);
      flat.forEach(c => renderNode(c, consumerLabel));
      return;
    }
  }

  // Whether `node` is a multi-input AND group — such a node routes its OWN lines all the way
  // into whatever box consumes it (see isAndGroup above), so the CONSUMER must skip drawing its
  // usual single connecting line for this child; drawing both would duplicate/conflict.
  function isMultiPortAnd(node) {
    return node && node.op === 'AND' && node._flat && node._flat.length > 1;
  }

  const finalLabel = A.tripCause.finalLabel || 'TRIP';
  renderNode(root, finalLabel);

  // Final synthetic "trip" box, one column right of the root — unless the root itself is a
  // multi-input AND, which has already routed each of its own inputs directly into this box's
  // position itself (see isAndGroup above); drawing this single connector too would duplicate it.
  if (!isMultiPortAnd(root)) {
    const rootOutX = xOf(root.depth) + LOGIC_BOX_W, rootOutY = yOf(root.row) + LOGIC_BOX_H / 2;
    const rootEs = edgeStyleFor(root);
    linesHTML += titledEdge(rootOutX, rootOutY, finalX, finalY + LOGIC_BOX_H / 2, rootEs.color, rootEs.dash, `${describeLogicNode(root)} → ${finalLabel}`, 2);
  }
  // The terminal TRIP/TR3P/etc. box must reflect whether it's ACTUALLY asserted at the instant
  // being shown (root.value, refreshed on every frame by reEvaluateLogicTree) — previously this
  // box's own CSS class was unconditionally styled red/"asserted", so it looked permanently
  // tripped no matter what point in the event playback was selected.
  boxesHTML += `<div class="logic-box logic-final-box${root.value ? '' : ' final-off'}" style="left:${finalX}px;top:${finalY}px;width:${LOGIC_BOX_W}px;height:${LOGIC_BOX_H}px;">${tt(finalLabel, P)}</div>`;

  const otherCount = A.tripCause.logicTreeOtherBranchCount || 0;
  const totalW = finalX + LOGIC_BOX_W + LOGIC_MARGIN;
  // Compute actual height from the max row assigned across the tree (rows are set during
  // logicAssignRows; internal AND/OR nodes get the AVERAGE of their children, which can be
  // fractional and less than a deep child's row, so walk the tree for the true max).
  const maxRowSeen = Math.max(root.row, (function findMaxRow(n){ if(n.op==='VAR') return n.row; if(n.op==='SVNODE'||n.op==='TIMERNODE') return Math.max(n.row, findMaxRow(n.child)); if(n.op==='AND'||n.op==='OR') return Math.max(n.row, ...n._flat.map(findMaxRow)); return n.row; })(root));
  const totalHeight = yOf(maxRowSeen) + LOGIC_BOX_H + LOGIC_MARGIN + 16;

  return `
    <div class="logic-tree-block">
      <div class="logic-tree-wrap" style="height:${totalHeight}px;">
        <div class="logic-tree-canvas" id="mainLogicTreeCanvas" style="width:${totalW}px;height:${totalHeight}px;">
          <svg width="${totalW}" height="${totalHeight}" style="position:absolute;left:0;top:0;">${linesHTML}</svg>
          ${boxesHTML}
        </div>
      </div>
      ${otherCount ? `<div class="logic-tree-other">+ ${otherCount} other independent trip condition${otherCount === 1 ? '' : 's'} in this same equation, unrelated to this event (not shown)</div>` : ''}
    </div>`;
}

// ══════════════════════════════════════════════════════════════════════
// DETERMINATION EVIDENCE — the checkable proof behind the headline cause
// ══════════════════════════════════════════════════════════════════════
// Answers "how do we know it was X and not Y" directly from the record: per contributing
// element, when it asserted relative to the trip and how far past its own pickup the measured
// quantity was; which element's assertion completed the logic; and — the specific misreading
// this exists to prevent — an explicit statement when undervoltage elements picked up during
// the event but the relay's own trip logic never consulted them.
function buildEvidenceBlock(P, cause) {
  const ev = cause?.evidence;
  if (!ev || !ev.items?.length) return '';
  const rows = ev.items.map(it => {
    const timing = it.assertMs != null
      ? (Math.abs(it.assertMs) < 0.5 ? 'asserted at the trip instant' : `asserted ${Math.abs(it.assertMs).toFixed(0)} ms before the trip`)
      : (it.initiallyOn ? 'already asserted at record start' : 'assertion time not captured in this record');
    const meas = it.measured && it.pickup
      ? ` — measured <b>${it.measured}</b> vs. pickup <b>${it.pickup}</b>${it.multiple ? ` (<b>${it.multiple}×</b> pickup)` : ''}`
      : '';
    const completed = ev.completedBy === it.el
      ? ` <span style="color:var(--red);font-weight:700;">— last to assert, completing the trip logic</span>`
      : '';
    return `<li style="margin-bottom:5px;"><span style="font-family:var(--mono);color:var(--text);">${tt(it.el, P)}</span> ${timing}${meas}${completed}</li>`;
  }).join('');
  const uvNote = ev.uninvolvedUV?.length
    ? `<p style="font-size:12px;color:var(--text-dim);line-height:1.6;margin-top:8px;">
        Phase voltage${ev.uninvolvedUV.length > 1 ? 's' : ''} also dipped during this event, and undervoltage
        element${ev.uninvolvedUV.length > 1 ? 's' : ''} <span style="font-family:var(--mono);">${ev.uninvolvedUV.join(', ')}</span>
        picked up — but ${ev.uninvolvedUV.length > 1 ? "they aren't referenced" : "it isn't referenced"} in the resolved
        trip equation above. That's consistent with the dip being a downstream effect of the fault current rather than
        a separate input the relay acted on here, though it's worth a look at the diagram and Equations tab to confirm
        for this specific relay's logic.</p>`
    : '';
  return `<div style="background:var(--card);border:1px solid var(--card-border);border-radius:8px;padding:12px 16px;margin-bottom:16px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--text-dim);margin-bottom:8px;">Why this determination — evidence from this record</div>
    <ul style="font-size:12px;color:var(--text-dim);line-height:1.6;padding-left:18px;margin:0;">${rows}</ul>
    ${uvNote}
  </div>`;
}

// ══════════════════════════════════════════════════════════════════════
// "LOGIC BIT CHARTED" PICKER — lets the main-page charted-logic slot show any bit's
// diagram, not just the resolved trip cause; see CHARTED_BIT/CHARTED_FILTER_RELEVANT above.
// ══════════════════════════════════════════════════════════════════════
function getDefaultChartedBitLabel(P, A) {
  return (A && A.tripCause && A.tripCause.finalLabel) || (P && P.tripEquationName) || 'TR';
}
function currentChartedBitLabel() {
  if (!PARSED) return '';
  return CHARTED_BIT || getDefaultChartedBitLabel(PARSED, ANALYSIS);
}
// Every real bit worth searching for: everything actually recorded in the digital word (initial
// state + every transition), every SV (bare and timed form), and every named top-level equation
// this file defines — with the resolved trip/ER cause (or else TR) always pinned first.
function getAllChartableBitLabels(P, A) {
  const set = new Set();
  (P.initialDigitalState || []).forEach(l => set.add(l));
  (P.digitalTransitions || []).forEach(t => t.changes.forEach(c => set.add(c.label)));
  (P.svSettings || []).forEach(sv => { set.add(`SV${sv.num}`); set.add(`SV${sv.num}T`); });
  set.add(P.tripEquationName || 'TR');
  if (P.tripEquationX) set.add('TR3X');
  if (P.erEquation) set.add(P.erEquationName || 'ER');
  if (P.faultEquation) set.add('FAULT');
  if (P.recloseEquation) set.add('79RI3P');
  if (P.dtlEquation) set.add('79DTL3P');
  const pinned = getDefaultChartedBitLabel(P, A);
  set.add(pinned);
  const rest = [...set].filter(l => l !== pinned).sort((a, b) => a.localeCompare(b));
  return [pinned, ...rest];
}
// Resolves the { logicTree, finalLabel, logicTreeOtherBranchCount }-shaped object for whichever
// bit is currently charted, in "Filter relevant?" (pruned/causal) mode — the default bit reuses
// the already-resolved trip cause exactly as before; any other bit gets a freshly baked tree
// rooted at its own equation via ANALYSIS._buildTreeForBit (see analyzeCEV). Returns null if
// nothing can be built, so callers can fall back gracefully.
function getCurrentChartedCauseForTree() {
  if (!PARSED || !ANALYSIS) return null;
  const label = currentChartedBitLabel();
  const isDefault = !CHARTED_BIT || CHARTED_BIT === getDefaultChartedBitLabel(PARSED, ANALYSIS);
  if (isDefault) return (ANALYSIS.tripCause && ANALYSIS.tripCause.logicTree) ? ANALYSIS.tripCause : null;
  return (typeof ANALYSIS._buildTreeForBit === 'function') ? ANALYSIS._buildTreeForBit(label) : null;
}
// Builds a READ-ONLY embed of the same local logic graph the per-bit tooltip popup shows (the
// fuller, unpruned "what feeds this bit, and what it feeds into" chart), for "Filter relevant?"
// unchecked mode. Safe to show alongside an actual bit-detail popup elsewhere on the page: it
// saves/restores LLG_CURRENT (which renderLocalLogicGraph always overwrites as a side effect for
// the popup's own timeline/GIF/export buttons) and strips the popup's fixed element ids so the
// two never collide.
function buildChartedLocalGraphHTML(label) {
  if (!PARSED || !label) return '';
  if (isBlinkerLabel(label, PARSED)) return renderBlinkerPair(label, PARSED);
  const savedLLGCurrent = LLG_CURRENT;
  let fullHTML = '';
  try {
    const tripFocus = isTripFocusLabel(label, PARSED);
    const graph = buildLocalLogicGraph(PARSED, label, tripFocus ? 25 : 20, tripFocus ? 25 : 14, !tripFocus);
    fullHTML = renderLocalLogicGraph(graph, PARSED, tripFocus);
  } catch (e) {
    fullHTML = '';
  } finally {
    LLG_CURRENT = savedLLGCurrent;
  }
  if (!fullHTML) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = fullHTML;
  const innerDiagram = tmp.querySelector('#llgInnerDiagram');
  if (!innerDiagram) return '';
  const legendHTML = renderLLGLegend().replace(/\sid="llgSourceLegend"/, '');
  return `<div class="llg-diagram-outer main-charted-local-graph" style="margin-top:12px;">
    <div style="font-size:11px;color:var(--text-dim);margin-bottom:2px;">Full logic chart — what feeds ${tt(label, PARSED)}, and what it feeds into:</div>
    ${legendHTML}
    <div class="llg-wrap" id="mainChartedLocalBody">
      <div id="mainChartedLocalInner">${innerDiagram.innerHTML}</div>
    </div>
  </div>`;
}
// Decides what belongs in the main charted-logic slot right now (pruned tree vs. local graph,
// for whichever bit is selected) and renders it in full — called on initial banner render, and
// whenever the picker's bit or "Filter relevant?" checkbox changes.
function renderChartedLogicSlot() {
  const slot = document.getElementById('mainChartedLogicSlot');
  if (!slot || !PARSED || !ANALYSIS) return;
  const label = currentChartedBitLabel();
  const isDefault = !CHARTED_BIT || CHARTED_BIT === getDefaultChartedBitLabel(PARSED, ANALYSIS);

  if (CHARTED_FILTER_RELEVANT) {
    const causeForTree = getCurrentChartedCauseForTree();
    if (causeForTree && causeForTree.logicTree) {
      const patchedAnalysis = Object.assign({}, ANALYSIS, { tripCause: causeForTree });
      const html = buildLogicTreeSection(PARSED, patchedAnalysis);
      if (html) { slot.innerHTML = html; return; }
    }
    slot.innerHTML = isDefault ? LAST_SEQ_HTML
      : `<div style="color:var(--text-dim);font-size:12px;padding:8px 2px;">No equation-based logic tree available for ${tt(label, PARSED)} — try unchecking "Filter relevant?" to see its full local logic graph instead.</div>`;
    return;
  }

  slot.innerHTML = buildChartedLocalGraphHTML(label) ||
    `<div style="color:var(--text-dim);font-size:12px;padding:8px 2px;">Nothing to show for ${tt(label, PARSED)}.</div>`;
}
function renderChartedBitChipHTML(P, A) {
  if (!P || !A) return '';
  const current = currentChartedBitLabel();
  return `<div class="timing-chip charted-bit-chip" id="chartedBitChip">
    <span class="label">Logic Bit Charted:</span>
    <button type="button" class="charted-bit-btn" onclick="event.stopPropagation(); toggleChartedBitDropdown();">${current} ▾</button>
    <div class="charted-bit-dropdown" id="chartedBitDropdown" style="display:none;">
      <label class="charted-bit-filter-row">
        <input type="checkbox" ${CHARTED_FILTER_RELEVANT ? 'checked' : ''} onchange="setChartedFilterRelevant(this.checked)">
        Filter relevant?
      </label>
      <input type="text" class="charted-bit-search" id="chartedBitSearch" placeholder="Search bits…" oninput="renderChartedBitOptions(this.value)">
      <div class="charted-bit-list" id="chartedBitList"></div>
    </div>
  </div>`;
}
function toggleChartedBitDropdown() {
  const dd = document.getElementById('chartedBitDropdown');
  if (!dd) return;
  const opening = dd.style.display === 'none';
  dd.style.display = opening ? 'block' : 'none';
  if (opening) {
    renderChartedBitOptions('');
    const search = document.getElementById('chartedBitSearch');
    if (search) { search.value = ''; search.focus(); }
  }
}
function renderChartedBitOptions(filterText) {
  const list = document.getElementById('chartedBitList');
  if (!list || !PARSED) return;
  const all = getAllChartableBitLabels(PARSED, ANALYSIS);
  const q = (filterText || '').trim().toUpperCase();
  const filtered = q ? all.filter(l => l.toUpperCase().includes(q)) : all;
  const current = currentChartedBitLabel();
  list.innerHTML = filtered.slice(0, 300).map(l =>
    `<div class="charted-bit-option ${l === current ? 'active' : ''}" onclick="selectChartedBit('${l.replace(/'/g, "\\'")}')">${l}</div>`
  ).join('') || `<div class="charted-bit-option-empty">No matching bits</div>`;
}
function selectChartedBit(label) {
  CHARTED_BIT = label;
  const dd = document.getElementById('chartedBitDropdown');
  if (dd) dd.style.display = 'none';
  const btn = document.querySelector('#chartedBitChip .charted-bit-btn');
  if (btn) btn.textContent = label + ' ▾';
  renderChartedLogicSlot();
}
function setChartedFilterRelevant(checked) {
  CHARTED_FILTER_RELEVANT = !!checked;
  renderChartedLogicSlot();
}
// Close the bit-picker dropdown when clicking anywhere outside it.
document.addEventListener('click', (e) => {
  const dd = document.getElementById('chartedBitDropdown');
  if (!dd || dd.style.display === 'none') return;
  const chip = document.getElementById('chartedBitChip');
  if (chip && !chip.contains(e.target)) dd.style.display = 'none';
});

