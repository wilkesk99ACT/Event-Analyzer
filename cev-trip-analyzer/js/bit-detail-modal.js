// Bit-detail modal: click-through explanation of a single logic bit.

function showBitDetail(label) {
  const modal = document.getElementById('bitModal');
  const titleEl = document.getElementById('bitModalTitle');
  const bodyEl = document.getElementById('bitModalBody');
  if (!modal || !bodyEl) return;
  // Fresh chart: stop any running playback and clear the timeline view override so state colors
  // reflect the default (trip moment) until the scrubber is touched.
  if (typeof stopLogicChartPlay === 'function') stopLogicChartPlay();
  setLogicChartViewIdx(null);
  // Same mutual-exclusivity as toggleHelp: if the Help modal happens to be open (e.g. this bit
  // was clicked from a link inside it), close it first so only one overlay is ever stacked.
  const helpModal = document.getElementById('helpModal');
  if (helpModal) helpModal.style.display = 'none';
  titleEl.textContent = label;

  const freq = PARSED?.eventInfo?.freq || 60;
  const elInfo = PARSED ? explainElementBit(label, PARSED, freq) : null;
  const desc = elInfo ? elInfo.short : (getSVTooltip(label, PARSED)
    || `This bit isn't in the tool's built-in reference. Its meaning will need to be checked against the relay's settings/logic documentation.`);
  const svMatch = label.match(/^SV(\d+)(T?)$/);
  const sv = svMatch && PARSED ? (PARSED.svSettings || []).find(s => s.num === parseInt(svMatch[1])) : null;
  const state = currentBitState(label);

  // Is this bit part of the logic that actually produced the resolved trip/event? Check both
  // the flattened cause chain and the full baked logic tree (an AND/OR operand not singled out
  // in the chain summary can still appear in the tree).
  function treeHasLabel(node, target) {
    if (!node) return false;
    if (node.op === 'VAR' && node.name === target) return true;
    if (node.op === 'SVNODE' && node.label === target) return true;
    if (node.child) return treeHasLabel(node.child, target);
    if (node.children) return node.children.some(c => treeHasLabel(c, target));
    return false;
  }
  const inChain = !!(ANALYSIS?.tripCause?.causeChain?.some(c => c.label === label)
    || treeHasLabel(ANALYSIS?.tripCause?.logicTree, label));

  // Does this bit involve a sequence quantity (negative-sequence or zero-sequence V/I)? If so,
  // point to the plain-language explainer rather than repeating it in every popup. This needs to
  // catch three shapes: (1) the element bit itself — any 50/51/59/67/27/47-family element whose
  // designator is G (ground/residual — a zero-sequence-derived quantity), N (neutral — measured
  // via a physical neutral CT, functionally the same 3I0/3V0 residual family in a wye system),
  // or Q (SEL's negative-sequence designator) — regardless of whether a level digit follows
  // (e.g. "50G1P" and the level-less "51QP" both need to match); (2) a bare mention of a raw
  // sequence quantity (3V0, 3I0, V2, I2); or (3) an SV logic variable whose OWN equation is
  // built from one of those — e.g. "SV17 := 59G1T" is a sequence-derived timer even though
  // "SV17" itself carries no element-like name.
  const svForSeq = svMatch && PARSED ? (PARSED.svSettings || []).find(s => s.num === parseInt(svMatch[1])) : null;
  const seqElementRe = /^(50|51|59|67|27|47)[A-Z]*[GNQ]\d?/;
  const seqQuantityRe = /3V0|3I0|\bV2\b|\bI2\b|ZERO.?SEQ|NEG.?SEQ|SEQUENCE/i;
  const svEquationIsSeq = sv => !!sv && (seqQuantityRe.test(sv.equation)
    || (sv.equation.match(/\b[0-9][A-Z0-9]*\b/g) || []).some(tok => seqElementRe.test(tok)));
  const isSequenceRelated = seqElementRe.test(label) || seqQuantityRe.test(label) || svEquationIsSeq(svForSeq);
  const seqLink = isSequenceRelated
    ? `<div style="margin-top:10px;"><span class="zoom-badge" onclick="toggleHelp(true,'seq');">What is sequence voltage/current? →</span></div>`
    : '';

  let html = `<p style="line-height:1.6;">${linkifyBitMentions(desc, PARSED).replace(/\n/g, '<br>')}</p>${seqLink}`;
  if (elInfo) {
    html += `<div style="background:var(--bg2);border-radius:6px;padding:10px 12px;margin-top:12px;font-size:12.5px;line-height:1.6;">
      <div><b style="color:var(--green);">When asserted (ON):</b> ${linkifyBitMentions(elInfo.on, PARSED)}</div>
      <div style="margin-top:8px;"><b style="color:var(--text-muted);">When de-asserted (OFF):</b> ${linkifyBitMentions(elInfo.off, PARSED)}</div>
    </div>`;
  } else {
    html += `<div style="background:var(--bg2);border-radius:6px;padding:10px 12px;margin-top:12px;font-size:12.5px;line-height:1.6;">
      <div><b style="color:var(--green);">When asserted (ON):</b> the condition described above is present/true.</div>
      <div style="margin-top:4px;"><b style="color:var(--text-muted);">When de-asserted (OFF):</b> that condition is not currently present — this is simply the absence of the described state, not a separate event on its own.</div>
    </div>`;
  }
  if (sv) {
    const eqClean = sv.equation.split('#')[0].trim();
    html += `<div style="margin-top:12px;font-size:12px;">
      <div style="color:var(--text-dim);margin-bottom:4px;">Equation (${sv.label}):</div>
      <div style="font-family:var(--mono);background:var(--bg2);border-radius:6px;padding:8px 10px;word-break:break-word;">${linkifyEquationBits(eqClean, PARSED)}</div>
      <div style="color:var(--text-muted);margin-top:4px;">Pickup: ${sv.pickupDelay} cycles (${(sv.pickupDelay/(PARSED.eventInfo?.freq||60)*1000).toFixed(0)} ms) &nbsp;|&nbsp; Dropout: ${sv.dropoutDelay} cycles</div>
    </div>`;
  } else if (PARSED) {
    // Non-SV bits (TR, ER, CL, output-mapped relay words like 52A, etc.) can have an equation
    // too — this used to only ever get shown for SVs, silently dropping it for everything else.
    // Goes through the TR/TRIP alias so clicking a recorded terminal bit (TRIP, TRIP3P, ...)
    // still surfaces the equation that's actually defined under the internal trip-logic name.
    const { eqByLabel } = getEquationRefIndex(PARSED);
    const canonicalLabel = canonicalTripLabel(label, PARSED);
    const genericEq = eqByLabel[canonicalLabel];
    if (genericEq) {
      html += `<div style="margin-top:12px;font-size:12px;">
        <div style="color:var(--text-dim);margin-bottom:4px;">Equation (${canonicalLabel}):</div>
        <div style="font-family:var(--mono);background:var(--bg2);border-radius:6px;padding:8px 10px;word-break:break-word;">${linkifyEquationBits(genericEq, PARSED)}</div>
      </div>`;
    }
  }
  if (state) {
    html += `<div style="margin-top:12px;font-size:12px;color:var(--text-dim);">
      In this event: <b style="color:${state.state ? 'var(--green)' : 'var(--text-muted)'};">${state.state ? 'ASSERTED' : 'de-asserted'}</b> ${state.asOf}.
    </div>`;
  }
  if (inChain) {
    html += `<div style="margin-top:10px;font-size:12px;color:var(--red);font-weight:600;">⚡ Part of the logic chain that produced this event's resolved cause.</div>`;
  }
  if (PARSED) {
    // TR itself, and anything wired directly into it, gets the full chain rather than the
    // usual handful of hops — that's the one case where seeing the whole picture (all the way
    // back to raw elements, and forward through every SV hop to the final trip command) is
    // worth more than the compact default.
    const tripFocus = isTripFocusLabel(label, PARSED);
    // Non-focal bits: several backward hops (not just this bit's own direct equation) so the
    // chain keeps walking through intermediate SVs and actually reaches a real measured/status
    // element — previously capped at one hop, which stopped right at the first upstream SV
    // instead of continuing back to an actual sensor/contact/measuring device. The walk still
    // naturally stops on its own once a hop discovers nothing new (a genuine leaf), so this cap
    // is a safety ceiling, not a target depth. Forward stays in SCOPED mode so each hop only
    // pulls in the specific AND-group it actually connects through (e.g. "52A" alongside SV06 in
    // TR's "SV06 AND 52A") rather than that consumer's entire other, unrelated logic — which is
    // what made these charts balloon into showing nearly every SV in the settings.
    const graph = buildLocalLogicGraph(PARSED, label, tripFocus ? 25 : 20, tripFocus ? 25 : 14, !tripFocus);
    html += renderLocalLogicGraph(graph, PARSED, tripFocus);
  }
  bodyEl.innerHTML = html;
  modal.style.display = 'flex';

  // If the fullscreen chart overlay is open, clicking a bit inside it re-renders THIS popup's
  // chart (above) but the fullscreen copy is a separate cloned DOM tree, so it wouldn't
  // otherwise reflect the newly-clicked bit — refresh it to match instead of leaving it stale.
  if (document.getElementById('llgFullscreenOverlay')) {
    expandLogicChart();
  }
  // Initialize the timeline's time readout to its starting (trip-moment) position.
  const scrubber = document.querySelector('.llgScrubber');
  if (scrubber) updateLlgTimeReadout(parseInt(scrubber.value, 10));
  updateLlgMarkerPositions();
}
function hideBitDetail() {
  if (typeof stopLogicChartPlay === 'function') stopLogicChartPlay();
  setLogicChartViewIdx(null);
  const modal = document.getElementById('bitModal');
  if (modal) modal.style.display = 'none';
}

function resetApp() {
  if (typeof stopMainPlay === 'function') stopMainPlay();
  ALL_EVENTS = [];
  PARSED = null;
  ANALYSIS = null;
  CURRENT_IDX = 0;
  document.getElementById('upload-screen').style.display = '';
  document.getElementById('analysis-screen').style.display = 'none';
  document.getElementById('eventSelector').style.display = 'none';
  document.getElementById('fileInput').value = '';
}

// File input handling
