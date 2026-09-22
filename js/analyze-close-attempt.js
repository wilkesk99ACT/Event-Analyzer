// ════════════════════════════════════════════════════════════════════════════
// CLOSE ATTEMPT TRACE — WHY A CLOSE COMMAND DID OR DID NOT REACH THE BREAKER
// ════════════════════════════════════════════════════════════════════════════
// The close-attempt block in analyzeCEV answers one question: did 52A confirm closed after
// CLOSE asserted? When the answer is "no", it used to say the breaker mechanism, the close coil,
// or an interlock was at fault. That is often wrong, and wrong in the direction that sends a
// technician to the wrong piece of equipment.
//
// Driven by PGR SOUTHWICK (SEL-751, records 10427 and 10428, 9/22/2026). A remote close (CC)
// asserted CLOSE. CLOSE held for the full CFD time and then went to CF. The breaker was never
// told to close: the close contact is not CLOSE by itself, it is
//
//     OUT102 := CLOSE AND (SV10T OR SV11T OR CC)
//     SV10   := IN402 AND SV09T          # TAVRIDA PERMISSIVE CLOSE
//
// and IN402 — a permissive from an external RVC controller — never came on. OUT102 never
// asserted. The fault is upstream of the breaker, in the permissive chain, and the record says
// so plainly once the output equation is read.
//
// This module reads the record in that order:
//
//   1. The close request   — CLOSE, when it started (or that it was carried in), what started it
//                            (CC, a pushbutton, the 79 element, an SV path), and how it ended
//                            (52A, CF, dropped, or still up at the end of the record).
//   2. The close outputs   — every OUTnnn whose equation depends on CLOSE, directly or through
//                            SVs and latches. Did each one operate while CLOSE was up?
//   3. What held them off  — for an output that did not operate, walk its equation down through
//                            SVs, timers and latches to the terms that were never true. Sort
//                            them: a contact input or communications bit (outside this file),
//                            a mode latch set against the path, an operator action that did not
//                            happen, or a measured condition.
//   4. Held-on outputs     — an output that is still on at the end of the record because a latch
//                            holds it. If that output was ALREADY on when the close started, the
//                            device it drives saw no new signal for this close.
//   5. Close failure timing — CFD against the measured CLOSE -> CF time, which also settles the
//                            unit of CFD for this file.
//   6. Event coverage      — which close commands put a record on the relay (ER) and which do
//                            not, and any SV the site labelled as an event trigger that is not
//                            in ER. This is the usual answer to "why is there no event for the
//                            close I sent".
//   7. Clock               — whether the relay clock was synchronized, since the time stamps
//                            are how a reader lines an event up with a SCADA command.
//
// It reports what the record and the settings show. It does not say what to replace.

const CT_CLOSE_BITS = ['CLOSE3P', 'CLOSE'];
const CT_BKR_BITS = ['52A3P', '52A'];
const CT_CF_BITS = ['CF3P', 'CF'];

function ctPick(P, names) { return names.find(n => (P.digitalLabels || []).includes(n)) || null; }

function ctMsPerSample(P) {
  const freq = (P.eventInfo && P.eventInfo.freq) || 60;
  const spc = (P.eventInfo && P.eventInfo.samPerCycA) || 32;
  return 1000 / (freq * spc);
}

// Relay-clock time of an analog sample. The CEV time stamp is the trigger sample.
function ctClockMs(P, idx) {
  if (!P.timestamp || P.timestamp.year == null || typeof getTimestampMs !== 'function') return null;
  const trig = P.triggerArrowIdx != null ? P.triggerArrowIdx
    : (P.triggerSampleIndex != null && P.triggerSampleIndex >= 0 ? P.triggerSampleIndex : 0);
  return getTimestampMs(P.timestamp) + (idx - trig) * ctMsPerSample(P);
}
function ctFmtClock(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function ctFmtMs(ms) {
  if (ms == null) return '—';
  if (typeof ccFormatMs === 'function') return ccFormatMs(ms);
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// Every `NAME := equation` line of the settings text, for names matching `re`.
function ctSettingEquations(P, re) {
  const out = [];
  for (const line of String(P.settingsText || '').split(/\r?\n/)) {
    // Several settings can share a line ("OUT101FS:= Y       OUT101  := HALARM ..."). Each
    // value runs to the next "NAME :=" on the same line, or to the end of the line.
    const heads = [];
    const hr = /(?:^|\s)([A-Z][A-Z0-9_]*)\s*:=/g;
    let h;
    while ((h = hr.exec(line)) !== null) heads.push({ name: h[1], start: h.index, valStart: h.index + h[0].length });
    heads.forEach((hd, i) => {
      if (!re.test(hd.name)) return;
      const end = i + 1 < heads.length ? heads[i + 1].start : line.length;
      out.push({ name: hd.name, eq: line.slice(hd.valStart, end).trim() });
    });
  }
  return out;
}
function ctSetting(P, name) {
  const hit = ctSettingEquations(P, new RegExp('^' + name + '$'));
  return hit.length ? hit[0].eq : null;
}
function ctComment(eq) { const s = String(eq || ''); return s.includes('#') ? s.split('#').slice(1).join('#').trim() : ''; }

// AST of an equation, with analog comparisons folded out (they would stop the tokenizer).
function ctAst(eq) {
  if (typeof ccAst === 'function') {
    const a = ccAst(eq);
    return { node: a.node, comparisons: a.comparisons || {}, empty: !!a.empty };
  }
  const clean = String(eq || '').split('#')[0].trim();
  if (!clean || /^[01]$/.test(clean) || /^NA$/i.test(clean)) return { node: null, comparisons: {}, empty: true };
  try { return { node: llgParse(llgTokenize(clean)), comparisons: {} }; } catch (e) { return { node: null, comparisons: {} }; }
}

function ctSv(P, name) {
  const m = /^SV(\d+)T?$/.exec(name || '');
  return m ? (P.svSettings || []).find(s => s.num === parseInt(m[1], 10)) || null : null;
}
function ctLatch(P, name) {
  const m = /^LT(\d+)$/.exec(name || '');
  return m ? (P.latchSettings || []).find(l => l.num === parseInt(m[1], 10)) || null : null;
}
function ctClassOf(name) {
  if (typeof ccClassify === 'function') return ccClassify(name);
  if (/^IN\d{3}$/.test(name)) return { cls: 'external', what: 'contact input — driven by external wiring' };
  if (/^PB\d+_PUL$/.test(name)) return { cls: 'operator', what: 'front-panel pushbutton press' };
  if (/^LT\d+$/.test(name)) return { cls: 'latch', what: 'latch bit' };
  return { cls: 'other', what: 'relay word bit' };
}

// The instants at which the record can change: the window start plus every digital transition
// inside the window. Evaluating at these points covers every state the record passed through.
function ctSamplePoints(P, i0, i1) {
  const pts = [i0];
  for (const t of (P.digitalTransitions || [])) {
    if (t.analogSampleIdx > i0 && t.analogSampleIdx <= i1) pts.push(t.analogSampleIdx);
  }
  return Array.from(new Set(pts)).sort((a, b) => a - b);
}
function ctState(P, name, idx) {
  if (/^[01]$/.test(name)) return { state: name === '1', known: true };
  return bitStateAtAnalogIdx(P, name, idx);
}
function ctRecorded(P, name) { return (P.digitalLabels || []).includes(name); }

// Value of a node at one instant. A bit the record does not carry but that an SV or latch
// setting defines is computed from its own equation, so a chain through an unrecorded SV still
// resolves. Anything else unknown reads false and is marked unknown.
function ctEvalAt(P, node, idx, comparisons, depth = 0) {
  if (!node) return { v: false, known: false };
  switch (node.op) {
    case 'VAR': {
      const n = node.name;
      if (comparisons && comparisons[n]) return { v: false, known: false };
      if (/^[01]$/.test(n)) return { v: n === '1', known: true };
      if (ctRecorded(P, n)) return { v: bitStateAtAnalogIdx(P, n, idx).state, known: true };
      const sv = ctSv(P, n);
      if (sv && depth < 6 && !/T$/.test(n)) {
        const a = ctAst(sv.equation);
        return a.node ? ctEvalAt(P, a.node, idx, a.comparisons, depth + 1) : { v: false, known: false };
      }
      return { v: false, known: false };
    }
    case 'NOT': { const r = ctEvalAt(P, node.c, idx, comparisons, depth); return { v: !r.v, known: r.known }; }
    case 'REDGE': case 'FEDGE': return ctEvalAt(P, node.c, idx, comparisons, depth);
    case 'AND': case 'OR': {
      const a = ctEvalAt(P, node.l, idx, comparisons, depth);
      const b = ctEvalAt(P, node.r, idx, comparisons, depth);
      return { v: node.op === 'AND' ? (a.v && b.v) : (a.v || b.v), known: a.known && b.known };
    }
    default: return { v: false, known: false };
  }
}
function ctNodeText(node) { return typeof rcAstText === 'function' ? rcAstText(node, null) : ''; }

// ── The walk: why was this node never true at any of these instants? ──
// Returns a tree of steps. Each step names a term, the state it was in, and — for SVs, timers
// and latches — the step below it. Leaves are the root blockers.
function ctWhyNeverTrue(P, node, pts, comparisons, depth, seen) {
  if (!node) return null;
  const everTrue = pts.some(i => ctEvalAt(P, node, i, comparisons).v);
  if (everTrue) return null;

  if (node.op === 'AND') {
    const kids = llgFlatten(node, 'AND');
    const failing = kids.map(k => ctWhyNeverTrue(P, k, pts, comparisons, depth, seen)).filter(Boolean);
    if (failing.length) return { kind: 'and', text: ctNodeText(node), children: failing };
    // Each operand was true at some point, just never all at the same time.
    return { kind: 'not-together', text: ctNodeText(node), terms: kids.map(k => ctNodeText(k)) };
  }
  if (node.op === 'OR') {
    const alts = llgFlatten(node, 'OR');
    return { kind: 'or', text: ctNodeText(node), children: alts.map(k => ctWhyNeverTrue(P, k, pts, comparisons, depth, seen)).filter(Boolean) };
  }
  if (node.op === 'REDGE' || node.op === 'FEDGE') return ctWhyNeverTrue(P, node.c, pts, comparisons, depth, seen);
  if (node.op === 'NOT') {
    // NOT X was never true: X was true for the whole window.
    const inner = node.c;
    if (inner && inner.op === 'VAR') {
      const name = inner.name;
      const step = { kind: 'leaf', name, negated: true, state: true, cls: ctClassOf(name) };
      const lt = ctLatch(P, name);
      if (lt) step.latch = { set: lt.setEquation, reset: lt.resetEquation, comment: lt.comment };
      const sv = ctSv(P, name);
      if (sv) step.comment = ctComment(sv.equation);
      return step;
    }
    return { kind: 'leaf', name: ctNodeText(node), negated: true, state: true, cls: { cls: 'other', what: 'expression' } };
  }
  if (node.op !== 'VAR') return null;

  const name = node.name;
  if (comparisons && comparisons[name]) {
    return { kind: 'leaf', name: comparisons[name], state: null, cls: { cls: 'analog', what: 'analog comparison — not evaluated from the record' } };
  }
  const recorded = ctRecorded(P, name);
  const step = { kind: 'leaf', name, negated: false, state: false, recorded, cls: ctClassOf(name) };

  if (depth >= 6 || seen.has(name)) return step;
  const seen2 = new Set(seen); seen2.add(name);

  // A timer output: was its input ever on? If yes, the timer did not run out in the window.
  const svT = /^SV(\d+)T$/.exec(name);
  if (svT) {
    const sv = ctSv(P, name);
    if (sv) {
      const inputName = `SV${svT[1]}`;
      step.comment = ctComment(sv.equation);
      step.pickup = sv.pickupDelay; step.dropout = sv.dropoutDelay;
      const inAst = ctAst(sv.equation);
      const inputEver = pts.some(i => (ctRecorded(P, inputName) ? bitStateAtAnalogIdx(P, inputName, i).state : ctEvalAt(P, inAst.node, i, inAst.comparisons).v));
      if (inputEver) {
        step.kind = 'timer-not-expired';
        step.note = `${inputName} was on, but ${name} did not time out inside the window (SV${svT[1]}PU = ${sv.pickupDelay}).`;
        return step;
      }
      step.kind = 'sv';
      step.eq = sv.equation;
      step.child = ctWhyNeverTrue(P, inAst.node, pts, inAst.comparisons, depth + 1, seen2);
      return step;
    }
  }
  const sv = /^SV\d+$/.test(name) ? ctSv(P, name) : null;
  if (sv) {
    const a = ctAst(sv.equation);
    step.kind = 'sv'; step.eq = sv.equation; step.comment = ctComment(sv.equation);
    step.child = ctWhyNeverTrue(P, a.node, pts, a.comparisons, depth + 1, seen2);
    return step;
  }
  const lt = ctLatch(P, name);
  if (lt) {
    step.kind = 'latch-not-set';
    step.latch = { set: lt.setEquation, reset: lt.resetEquation, comment: lt.comment };
    return step;
  }
  return step;
}

// Flatten a why-tree to its root blockers, keeping the route taken to reach each one.
function ctRootBlockers(tree, route = []) {
  if (!tree) return [];
  if (tree.kind === 'and') return tree.children.flatMap(c => ctRootBlockers(c, route));
  if (tree.kind === 'or') return tree.children.flatMap(c => ctRootBlockers(c, route));
  if (tree.kind === 'sv' && tree.child) return ctRootBlockers(tree.child, route.concat([tree.name]));
  return [{ ...tree, route }];
}

// The OR-alternatives of a why-tree, each with its own root blockers and a rank that says
// which alternative is the path the relay was actually waiting on:
//   0 — held only by a contact input, a communications bit, a measured condition or a timer.
//       Nothing in the file is set against it. This is the path waiting on the outside world.
//   1 — held by an operator action that did not happen (a pushbutton that was not pressed).
//   2 — held by a mode latch that is set against it — the site switched that path off.
function ctAlternatives(tree) {
  const expand = (t) => {
    if (!t) return [];
    if (t.kind === 'or') return t.children.flatMap(expand);
    // "CLOSE AND (SV10T OR SV11T OR CC)" — CLOSE was on, so the AND fails on its one OR operand.
    // The alternatives of that OR are the separate ways in.
    if (t.kind === 'and' && t.children.length === 1) return expand(t.children[0]);
    if (t.kind === 'sv' && t.child && (t.child.kind === 'or' || (t.child.kind === 'and' && t.child.children.length === 1 && t.child.children[0].kind === 'or'))) {
      return expand(t.child).map(a => ({ ...a, route: [t.name].concat(a.route) }));
    }
    return [{ tree: t, route: t.kind === 'sv' ? [t.name] : [], blockers: ctRootBlockers(t) }];
  };
  return expand(tree).map(a => {
    const b = a.blockers;
    const latchAgainst = b.some(x => x.cls && x.cls.cls === 'latch' && (x.negated ? x.state === true : x.state === false));
    const operatorOnly = b.some(x => x.cls && x.cls.cls === 'operator');
    const rank = latchAgainst ? 2 : (operatorOnly ? 1 : 0);
    return { ...a, rank };
  }).sort((x, y) => x.rank - y.rank);
}

// Does equation `eq` depend on `target` (directly, or through SVs and latches it names)?
function ctDependsOn(P, eq, targets, depth = 0, seen = new Set()) {
  const a = ctAst(eq);
  if (!a.node) return false;
  for (const l of llgCollectLeaves(a.node)) {
    if (/\bNOT\b/.test(l.mod || '')) continue;
    if (targets.includes(l.name)) return true;
    if (depth >= 4 || seen.has(l.name)) continue;
    seen.add(l.name);
    const sv = ctSv(P, l.name);
    if (sv && ctDependsOn(P, sv.equation, targets, depth + 1, seen)) return true;
    const lt = ctLatch(P, l.name);
    if (lt && lt.setEquation && ctDependsOn(P, lt.setEquation, targets, depth + 1, seen)) return true;
  }
  return false;
}
function ctDirectlyNames(eq, targets) {
  const a = ctAst(eq);
  return !!a.node && llgCollectLeaves(a.node).some(l => targets.includes(l.name) && !/\bNOT\b/.test(l.mod || ''));
}

// Is this bit on at any of these instants?
function ctEverOn(P, name, pts) { return pts.some(i => bitStateAtAnalogIdx(P, name, i).state); }
function ctFirstOn(P, name, i0, i1) {
  if (bitStateAtAnalogIdx(P, name, i0).state) return i0;
  for (const t of (P.digitalTransitions || [])) {
    if (t.analogSampleIdx <= i0 || t.analogSampleIdx > i1) continue;
    if (t.changes.some(c => c.label === name && c.asserted)) return t.analogSampleIdx;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
function analyzeCloseAttempt(P, A, prevEvent) {
  if (!P || !P.digitalTransitions) return null;
  const closeBit = ctPick(P, CT_CLOSE_BITS);
  if (!closeBit) return null;
  const bkrBit = ctPick(P, CT_BKR_BITS);
  const cfBit = ctPick(P, CT_CF_BITS);
  const msps = ctMsPerSample(P);
  const lastIdx = Math.max(0, (P.analogData || []).length - 1);
  const trans = P.digitalTransitions || [];

  const closeAtStart = (P.initialDigitalState || []).includes(closeBit);
  const closeRise = trans.find(t => t.changes.some(c => c.label === closeBit && c.asserted));
  const cfRise = cfBit ? trans.find(t => t.changes.some(c => c.label === cfBit && c.asserted)) : null;
  if (!closeAtStart && !closeRise && !cfRise) return null;

  const startIdx = closeAtStart ? 0 : (closeRise ? closeRise.analogSampleIdx : cfRise.analogSampleIdx);
  const closeFall = trans.find(t => t.analogSampleIdx > startIdx && t.changes.some(c => c.label === closeBit && !c.asserted));
  const endIdx = closeFall ? closeFall.analogSampleIdx : lastIdx;
  const bkrAtStart = bkrBit ? bitStateAtAnalogIdx(P, bkrBit, startIdx).state : null;
  const bkrRise = bkrBit ? trans.find(t => t.analogSampleIdx >= startIdx && t.changes.some(c => c.label === bkrBit && c.asserted)) : null;

  const out = {
    closeBit, bkrBit, cfBit,
    carried: closeAtStart,
    startIdx, startMs: startIdx * msps, startClock: ctClockMs(P, startIdx),
    endIdx, endMs: endIdx * msps,
    endReason: null,
    bkrConfirmed: !!bkrRise, bkrConfirmMs: bkrRise ? (bkrRise.analogSampleIdx - startIdx) * msps : null,
    bkrClosedAlready: bkrAtStart === true,
    source: null, outputs: [], closeOutputs: [], auxOutputs: [],
    cf: null, er: null, clock: null, timers: [], notes: [],
  };

  // ── 1. How the close request ended ──
  if (cfRise && cfRise.analogSampleIdx >= startIdx) out.endReason = 'cf';
  else if (bkrRise && (!closeFall || bkrRise.analogSampleIdx <= closeFall.analogSampleIdx)) out.endReason = 'closed';
  else if (closeFall) out.endReason = 'dropped';
  else out.endReason = 'record-end';

  // ── 1b. What started it ──
  const clEqName = ['CL3P', 'CL'].find(n => ctSetting(P, n) != null) || null;
  const clEq = clEqName ? ctSetting(P, clEqName) : null;
  out.clEqName = clEqName; out.clEq = clEq;
  if (closeAtStart) {
    out.source = { type: 'carried', text: `${closeBit} was already on when this record started. The close began in an earlier record.` };
    if (prevEvent && prevEvent.analysis && prevEvent.analysis.closeTrace) {
      const pt = prevEvent.analysis.closeTrace;
      if (!pt.carried && pt.startClock != null) out.source.prev = { ref: prevEvent.parsed.eventInfo && prevEvent.parsed.eventInfo.refNum, clock: pt.startClock, source: pt.source };
    }
  } else if (closeRise) {
    const bundle = closeRise.changes.filter(c => c.asserted).map(c => c.label);
    const onAt = (n) => bundle.includes(n) || bitStateAtAnalogIdx(P, n, closeRise.analogSampleIdx).state;
    let branch = null;
    if (clEq && typeof rcEvalEquation === 'function') {
      const r = rcEvalEquation(P, clEq, closeRise.analogSampleIdx);
      branch = r && r.branches ? r.branches.find(b => b.value) : null;
    }
    const pb = bundle.find(l => /^PB\d+_PUL$/.test(l));
    if (/^CC/.test((branch && branch.text) || '') || onAt('CC') || onAt('CC3')) out.source = { type: 'remote', term: onAt('CC3') ? 'CC3' : 'CC', text: 'a close command from a communications port (CC) — SCADA or a CLO command' };
    else if (pb) out.source = { type: 'pushbutton', term: pb, text: `a front-panel pushbutton (${pb})` };
    else if (bundle.some(l => /^79CY/.test(l)) || (ctPick(P, ['79CY3P', '79CY']) && bitStateAtAnalogIdx(P, ctPick(P, ['79CY3P', '79CY']), closeRise.analogSampleIdx).state)) out.source = { type: 'reclose', text: 'the 79 reclosing element' };
    else if (branch) out.source = { type: 'logic', term: branch.text, text: `the close equation branch ${branch.text}` };
    else out.source = { type: 'unknown', text: 'not determinable from this record' };
    if (clEqName) out.source.clBranch = branch ? branch.text : null;
  } else {
    out.source = { type: 'unknown', text: `${closeBit} does not show in this record, only ${cfBit}.` };
  }

  // ── 2. The close outputs ──
  const window = ctSamplePoints(P, startIdx, Math.max(startIdx, out.endReason === 'cf' ? cfRise.analogSampleIdx : endIdx));
  const outEqs = ctSettingEquations(P, /^OUT\d{3}$/).filter(o => o.eq && !/^0$/.test(o.eq.split('#')[0].trim()));
  for (const o of outEqs) {
    const direct = ctDirectlyNames(o.eq, [closeBit]);
    const indirect = !direct && ctDependsOn(P, o.eq, [closeBit]);
    if (!direct && !indirect) continue;
    const rec = ctRecorded(P, o.name);
    const a = ctAst(o.eq);
    const evalAt = (i) => rec ? bitStateAtAnalogIdx(P, o.name, i).state : ctEvalAt(P, a.node, i, a.comparisons).v;
    const onAtStart = evalAt(startIdx);
    const onAtEnd = evalAt(lastIdx);
    const firstOn = rec ? ctFirstOn(P, o.name, startIdx, window[window.length - 1]) : window.find(i => evalAt(i));
    const everOn = firstOn != null;
    const item = {
      name: o.name, eq: o.eq.split('#')[0].trim(), comment: ctComment(o.eq),
      role: direct ? 'close' : 'aux', recorded: rec,
      onAtStart, onAtEnd, everOn, firstOnMs: firstOn != null ? (firstOn - startIdx) * msps : null,
    };

    // Equation reads true from the recorded bits at an instant where the output did NOT
    // operate. That happens when a term is only on for one processing interval (a CC pulse)
    // and the output is processed before it. That term cannot close the breaker by itself.
    if (rec && !everOn) {
      const momentary = window.filter(i => ctEvalAt(P, a.node, i, a.comparisons).v);
      if (momentary.length) {
        item.momentary = momentary.map(i => (i - startIdx) * msps);
        const pulsed = llgCollectLeaves(a.node).map(l => l.name)
          .filter(n => ctRecorded(P, n) && momentary.some(i => bitStateAtAnalogIdx(P, n, i).state)
            && window.filter(i => bitStateAtAnalogIdx(P, n, i).state).length <= momentary.length);
        item.momentaryTerms = Array.from(new Set(pulsed.filter(n => n !== closeBit)));
      }
    }

    // ── 3. What held it off ──
    if (!everOn && a.node) {
      const pts = window.filter(i => !(item.momentary || []).includes((i - startIdx) * msps));
      const why = ctWhyNeverTrue(P, a.node, pts.length ? pts : window, a.comparisons, 0, new Set([o.name]));
      // A leaf that was on in the full window but only at the excluded instants was a pulse.
      const mark = (t) => {
        if (!t) return;
        if (t.children) t.children.forEach(mark);
        if (t.child) mark(t.child);
        if (t.kind === 'leaf' && !t.negated && t.recorded && ctEverOn(P, t.name, window)) t.kind = 'pulse-only';
      };
      mark(why);
      item.why = why;
      item.alternatives = ctAlternatives(why);
      item.rootBlockers = ctRootBlockers(why);
    }

    // ── 4. Held on at the end by a latch ──
    if (onAtEnd && a.node) {
      const holders = llgCollectLeaves(a.node)
        .filter(l => !/\bNOT\b/.test(l.mod || '') && /^LT\d+$/.test(l.name) && bitStateAtAnalogIdx(P, l.name, lastIdx).state)
        .map(l => { const lt = ctLatch(P, l.name); return { name: l.name, reset: lt ? lt.resetEquation : null, set: lt ? lt.setEquation : null, comment: lt ? lt.comment : '', onAtStart: bitStateAtAnalogIdx(P, l.name, startIdx).state }; });
      if (holders.length) item.heldBy = holders;
    }
    out.outputs.push(item);
  }
  out.closeOutputs = out.outputs.filter(o => o.role === 'close');
  out.auxOutputs = out.outputs.filter(o => o.role === 'aux');

  // Timers with a dropout window inside the chain of a close output: these are the "you have
  // N seconds to answer" windows an external device has to meet.
  const seenT = new Set();
  const walkTimers = (eq, depth) => {
    const a = ctAst(eq);
    if (!a.node || depth > 5) return;
    for (const l of llgCollectLeaves(a.node)) {
      const sv = ctSv(P, l.name);
      if (!sv || seenT.has(sv.label)) continue;
      seenT.add(sv.label);
      if (sv.pickupDelay > 0 || sv.dropoutDelay > 0) {
        const pu = typeof ccDelayMs === 'function' ? ccDelayMs(P, sv.pickupDelay) : null;
        const dro = typeof ccDelayMs === 'function' ? ccDelayMs(P, sv.dropoutDelay) : null;
        out.timers.push({ label: sv.label, comment: ctComment(sv.equation), pickup: sv.pickupDelay, dropout: sv.dropoutDelay,
          pickupMs: pu && pu.ms, dropoutMs: dro && dro.ms, assumed: !!((pu && pu.assumed) || (dro && dro.assumed)) });
      }
      walkTimers(sv.equation, depth + 1);
    }
  };
  out.closeOutputs.forEach(o => walkTimers(o.eq, 0));

  // ── 5. Close failure timing ──
  const cfdRaw = ctSetting(P, 'CFD3P') || ctSetting(P, 'CFD');
  const cfd = cfdRaw != null ? parseFloat(cfdRaw) : null;
  if (cfBit || cfd != null) {
    const cf = { setting: cfd, asserted: !!cfRise, unit: null, measuredMs: null, heldMs: null };
    if (cfRise && !closeAtStart && closeRise) cf.measuredMs = (cfRise.analogSampleIdx - closeRise.analogSampleIdx) * msps;
    if (cfRise && closeAtStart && out.source.prev && out.source.prev.clock != null) {
      const cfClock = ctClockMs(P, cfRise.analogSampleIdx);
      if (cfClock != null) { cf.measuredMs = cfClock - out.source.prev.clock; cf.crossRecord = true; }
    }
    if (!cfRise && !closeFall && closeRise) cf.heldMs = (lastIdx - closeRise.analogSampleIdx) * msps;
    const freq = (P.eventInfo && P.eventInfo.freq) || 60;
    if (cfd != null) {
      const asSec = cfd * 1000, asCyc = cfd / freq * 1000;
      if (cf.measuredMs != null) {
        cf.unit = Math.abs(Math.log(cf.measuredMs / asSec)) < Math.abs(Math.log(cf.measuredMs / asCyc)) ? 'seconds' : 'cycles';
        cf.unitBasis = 'measured';
      } else if (cf.heldMs != null && cf.heldMs > asCyc * 1.2) {
        cf.unit = 'seconds'; cf.unitBasis = 'held';
      }
      cf.settingMs = cf.unit === 'cycles' ? asCyc : (cf.unit === 'seconds' ? asSec : null);
    }
    out.cf = cf;
  }

  // ── 6. Event report coverage ──
  const erEq = P.settings && P.settings.EReq ? String(P.settings.EReq).split('#')[0].trim() : null;
  if (erEq) {
    const erTerms = new Set((erEq.match(/[A-Z][A-Z0-9_]*/g) || []).filter(t => !/^(AND|OR|NOT|R_TRIG|F_TRIG)$/.test(t)));
    // Commands that can start a close: operator and communications terms anywhere in the close
    // equation's chain, and in the chains of the outputs that carry the close.
    const starters = new Map();
    const collect = (eq, depth, seen) => {
      const a = ctAst(eq);
      if (!a.node || depth > 5) return;
      for (const l of llgCollectLeaves(a.node)) {
        if (/\bNOT\b/.test(l.mod || '')) continue;
        const c = ctClassOf(l.name);
        if (c.cls === 'operator' || (c.cls === 'external' && /^(RB|RMB)/.test(l.name))) starters.set(l.name, c.what);
        if (seen.has(l.name)) continue; seen.add(l.name);
        const sv = ctSv(P, l.name); if (sv) collect(sv.equation, depth + 1, seen);
        const lt = ctLatch(P, l.name); if (lt && lt.setEquation) collect(lt.setEquation, depth + 1, seen);
      }
    };
    // The close equation is where a close starts. Output chains are read only when the file
    // has no close equation, since they also carry unrelated pushbuttons (lamp and aux logic).
    if (clEq) collect(clEq, 0, new Set());
    else out.outputs.forEach(o => collect(o.eq, 0, new Set()));
    const sources = Array.from(starters.entries()).map(([term, what]) => ({ term, what, inER: erTerms.has(term) }));
    const orphans = (P.svSettings || [])
      .filter(sv => /EVENT|TRIGGER|\bER\b/i.test(ctComment(sv.equation)))
      .filter(sv => !erTerms.has(sv.label) && !erTerms.has(sv.label + 'T'))
      .map(sv => ({ label: sv.label, comment: ctComment(sv.equation), eq: sv.equation.split('#')[0].trim() }));
    // Does ER catch the outcome of a close? A breaker that closes is caught by R_TRIG 52A (or a
    // bare 52A / CLOSE term); one that fails is caught by CF. F_TRIG 52A only catches an open.
    const erTok = erEq.match(/\(|\)|[A-Z0-9_]+/g) || [];
    const erHasRise = (bit) => !!bit && erTok.some((t, i) => t === bit && erTok[i - 1] !== 'F_TRIG' && erTok[i - 1] !== 'NOT');
    out.er = {
      eq: erEq, sources, orphans,
      closedInER: erHasRise(bkrBit) || erHasRise(closeBit),
      closeInER: erTerms.has(closeBit),
      cfInER: cfBit ? erTerms.has(cfBit) : false,
      ccInER: erTerms.has('CC') || erTerms.has('CC3'),
    };
  }

  // ── 7. Clock ──
  const syncBits = ['TSOK', 'IRIGOK'].filter(b => ctRecorded(P, b));
  if (syncBits.length) {
    const offBits = syncBits.filter(b => !ctEverOn(P, b, ctSamplePoints(P, 0, lastIdx)));
    out.clock = { bits: syncBits, offBits, synced: offBits.length === 0, source: ctSetting(P, 'TIME_SRC') };
  }

  out.verdict = ctBuildVerdict(out, P);
  return out;
}

function ctBlockerPhrase(b, P) {
  const g = typeof rcGloss === 'function' ? rcGloss(P, b.name) : b.name;
  if (b.kind === 'pulse-only') return `${g} was on for only one processing interval, and ${'the output'} did not respond to it`;
  if (b.kind === 'timer-not-expired') return `${g} did not time out (its input came on, but not for long enough)`;
  if (b.kind === 'latch-not-set') return `${g} is not set${b.latch && b.latch.comment ? ` ("${b.latch.comment}")` : ''}`;
  if (b.kind === 'not-together') return `the terms of ${b.text} were never on at the same time`;
  if (b.cls && b.cls.cls === 'analog') return `${b.name} (an analog comparison the tool does not evaluate)`;
  if (b.negated) return `${g} is on, and the path needs it off${b.latch && b.latch.comment ? ` — "${b.latch.comment}"` : ''}`;
  return `${g} never came on${b.cls && b.cls.cls !== 'other' ? ` (${b.cls.what})` : ''}`;
}

function ctBuildVerdict(o, P) {
  const V = (kind, tone, headline, detail) => ({ kind, tone, headline, detail });
  const closeOuts = o.closeOutputs;
  const anyCloseOut = closeOuts.some(x => x.everOn);
  const lead = o.carried
    ? `A close request (${o.closeBit}) was already in progress when this record started.`
    : `${o.closeBit} asserted at t=${o.startMs.toFixed(0)} ms, started by ${o.source ? o.source.text : 'an unknown source'}.`;

  if (o.bkrClosedAlready) return V('already-closed', 'info', 'Close request with the breaker already closed', `${lead} ${o.bkrBit} was already on, so there was nothing to close.`);
  if (o.bkrConfirmed) return V('closed', 'good', 'The breaker closed', `${lead} ${o.bkrBit} confirmed closed ${ctFmtMs(o.bkrConfirmMs)} later.`);

  const endTxt = o.endReason === 'cf' ? `The relay declared close failure (${o.cfBit})${o.cf && o.cf.measuredMs != null ? ` ${ctFmtMs(o.cf.measuredMs)} after the close started` : ''}.`
    : o.endReason === 'dropped' ? `${o.closeBit} dropped out at t=${o.endMs.toFixed(0)} ms without a close.`
    : `${o.closeBit} was still on at the end of the record.`;

  if (!closeOuts.length) {
    return V('no-output-found', 'warn', 'Close requested — no close output found in the settings',
      `${lead} ${endTxt} No OUTnnn equation in this file references ${o.closeBit}, so the tool cannot tell whether the breaker was told to close.`);
  }
  if (anyCloseOut) {
    const on = closeOuts.filter(x => x.everOn).map(x => x.name).join(', ');
    return V('output-no-breaker', 'bad', 'The relay energized its close output — the breaker did not close',
      `${lead} ${on} operated. ${o.bkrBit || '52A'} never confirmed closed. ${endTxt} The relay did its part. Look at the close circuit wiring, the close coil, the mechanism, and the 52A auxiliary contact.`);
  }

  // No close output operated. Name what it was waiting on.
  const main = closeOuts[0];
  const alt = (main.alternatives || [])[0];
  const blockers = alt ? alt.blockers : (main.rootBlockers || []);
  const external = blockers.filter(b => b.cls && b.cls.cls === 'external' && !b.negated);
  const waitTxt = blockers.length ? ` It was waiting on: ${blockers.map(b => ctBlockerPhrase(b, P)).join('; ')}.` : '';
  const routeTxt = alt && alt.route && alt.route.length ? ` (path ${[main.name].concat(alt.route).map(n => typeof rcGloss === 'function' ? rcGloss(P, n) : n).join(' → ')})` : '';
  const headline = external.length
    ? `Close blocked — ${main.name} never operated, waiting on ${external.map(b => b.name).join(', ')}`
    : `Close blocked — the relay never energized its close output (${main.name})`;
  const stuck = o.auxOutputs.filter(x => x.onAtStart && x.heldBy && x.heldBy.some(h => h.onAtStart));
  const stuckTxt = stuck.length
    ? ` ${stuck.map(x => `${x.name}${x.comment ? ` ("${x.comment}")` : ''} was already on when this close started, held by ${x.heldBy.map(h => h.name).join(', ')}`).join('; ')}. The device it drives saw no new signal for this close.`
    : '';
  return V('blocked', 'bad', headline,
    `${lead} ${main.name} (${main.eq}) never operated${routeTxt}.${waitTxt} ${endTxt}${stuckTxt} The breaker was never told to close, so this is not a breaker mechanism problem.`);
}

// ════════════════════════════════════════════════════════════════════════════
// RENDERING
// ════════════════════════════════════════════════════════════════════════════
function ctEsc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function ctTone(t) { return { good: 'var(--green)', bad: 'var(--red)', warn: 'var(--yellow)', info: 'var(--accent)' }[t] || 'var(--text)'; }

function ctRenderWhy(step, P, depth = 0) {
  if (!step) return '';
  const pad = `margin-left:${depth * 16}px;`;
  const g = (n) => ctEsc(typeof rcGloss === 'function' ? rcGloss(P, n) : n);
  if (step.kind === 'and') return step.children.map(c => ctRenderWhy(c, P, depth)).join('');
  if (step.kind === 'or') {
    return `<div style="${pad}font-size:11px;color:var(--text-muted);margin:4px 0 2px;">None of these alternatives came on:</div>`
      + step.children.map(c => ctRenderWhy(c, P, depth + 1)).join('');
  }
  if (step.kind === 'sv') {
    return `<div style="${pad}font-size:12px;margin:3px 0;"><span style="color:var(--red)">✕</span> <b>${g(step.name)}</b> never came on <span style="color:var(--text-muted)">— ${ctEsc(step.eq ? step.eq.split('#')[0].trim() : '')}</span></div>`
      + ctRenderWhy(step.child, P, depth + 1);
  }
  let txt = ctBlockerPhrase(step, P);
  if (step.latch && step.negated && step.latch.reset) txt += ` <span style="color:var(--text-muted)">(RST: ${ctEsc(step.latch.reset.split('#')[0].trim())})</span>`;
  if (step.latch && !step.negated && step.latch.set) txt += ` <span style="color:var(--text-muted)">(SET: ${ctEsc(step.latch.set.split('#')[0].trim())})</span>`;
  const mark = (step.cls && step.cls.cls === 'external') ? '<span style="color:var(--yellow)">⚠</span>' : '<span style="color:var(--red)">✕</span>';
  return `<div style="${pad}font-size:12px;margin:3px 0;">${mark} ${txt}</div>`;
}

function buildCloseTraceSections(P, A) {
  const o = A && A.closeTrace;
  if (!o) return '';
  const rows = [];
  const row = (k, v) => rows.push(`<tr><td style="font-weight:600;color:var(--text);white-space:nowrap;vertical-align:top;">${k}</td><td>${v}</td></tr>`);

  row('Close request', o.carried
    ? `${o.closeBit} on at record start${o.source && o.source.prev ? ` — started at ${ctFmtClock(o.source.prev.clock)} in record ${ctEsc(o.source.prev.ref || 'before this one')}${o.source.prev.source ? `, by ${ctEsc(o.source.prev.source.text)}` : ''}` : ' — started in an earlier record'}`
    : `${o.closeBit} at t=${o.startMs.toFixed(0)} ms (relay clock ${ctFmtClock(o.startClock)}), started by ${ctEsc(o.source ? o.source.text : '—')}`);
  if (o.clEq) row(o.clEqName, `<code>${ctEsc(o.clEq.split('#')[0].trim())}</code>${o.source && o.source.clBranch ? ` — true via <b>${ctEsc(o.source.clBranch)}</b>` : ''}`);
  const endMap = { cf: `Close failure (${o.cfBit})`, closed: `${o.bkrBit} confirmed closed`, dropped: `${o.closeBit} dropped out`, 'record-end': `${o.closeBit} still on at end of record` };
  row('How it ended', endMap[o.endReason] || '—');

  let html = `<table class="data-table"><tbody>${rows.join('')}</tbody></table>`;

  // Outputs
  if (o.outputs.length) {
    html += `<div style="margin-top:14px;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--text-muted);">Outputs that carry the close</div>
      <div class="table-scroll"><table class="data-table"><thead><tr><th>Output</th><th>Equation</th><th>Role</th><th>At start</th><th>Operated</th><th>At end</th></tr></thead><tbody>
      ${o.outputs.map(x => `<tr>
        <td><b>${ctEsc(x.name)}</b>${x.comment ? `<div style="font-size:10.5px;color:var(--text-muted)">${ctEsc(x.comment)}</div>` : ''}</td>
        <td><code>${ctEsc(x.eq)}</code></td>
        <td>${x.role === 'close' ? 'Close contact (names ' + ctEsc(o.closeBit) + ')' : 'Follows ' + ctEsc(o.closeBit) + ' through SV/latch logic'}</td>
        <td>${x.onAtStart ? 'ON' : 'off'}</td>
        <td style="color:${x.everOn ? (x.onAtStart ? 'var(--yellow)' : 'var(--green)') : 'var(--red)'};font-weight:600">${x.everOn ? (x.onAtStart ? 'already on' : `yes, +${ctFmtMs(x.firstOnMs)}`) : 'NO'}</td>
        <td>${x.onAtEnd ? 'ON' : 'off'}${x.recorded ? '' : ' <span title="Not recorded in this file — computed from its equation">*</span>'}</td>
      </tr>`).join('')}
      </tbody></table></div>`;
  }

  // Why the close output did not operate
  for (const x of o.closeOutputs.filter(x => !x.everOn)) {
    html += `<div style="margin-top:14px;padding:10px 12px;border:1px solid #5c1414;border-radius:8px;background:var(--red-dim);">
      <div style="font-size:12.5px;font-weight:700;color:var(--red);margin-bottom:6px;">Why ${ctEsc(x.name)} did not operate</div>`;
    if (x.momentary && x.momentary.length) {
      html += `<div style="font-size:12px;margin-bottom:6px;">The equation reads true from the recorded bits for ${x.momentary.length} sample${x.momentary.length > 1 ? 's' : ''}${x.momentaryTerms && x.momentaryTerms.length ? `, while ${ctEsc(x.momentaryTerms.join(', '))} was on` : ''}. ${ctEsc(x.name)} did not operate at that instant. A term that is on for only one processing interval cannot close the breaker by itself.</div>`;
    }
    const alts = x.alternatives || [];
    if (alts.length > 1) {
      html += alts.map((a, i) => `<div style="margin:6px 0 2px;font-size:11.5px;font-weight:700;color:${a.rank === 0 ? 'var(--yellow)' : 'var(--text-dim)'}">
          ${i === 0 ? '▶ Path the relay was waiting on' : (a.rank === 2 ? 'Path switched off by a mode latch' : a.rank === 1 ? 'Path that needs an operator action' : 'Other path')}${a.route && a.route.length ? ': ' + ctEsc(a.route.map(n => typeof rcGloss === 'function' ? rcGloss(P, n) : n).join(' → ')) : ''}</div>
          ${ctRenderWhy(a.tree, P, 1)}`).join('');
    } else {
      html += ctRenderWhy(x.why, P, 0);
    }
    html += `</div>`;
  }

  // Held-on outputs
  const held = o.outputs.filter(x => x.heldBy && x.heldBy.length);
  if (held.length) {
    html += `<div style="margin-top:14px;padding:10px 12px;border:1px solid #5c4506;border-radius:8px;background:var(--yellow-dim);">
      <div style="font-size:12.5px;font-weight:700;color:var(--yellow);margin-bottom:6px;">Outputs held on by a latch</div>
      ${held.map(x => x.heldBy.map(h => `<div style="font-size:12px;margin:3px 0;">
        <b>${ctEsc(x.name)}</b> is on at the end of the record, held by <b>${ctEsc(h.name)}</b>${h.comment ? ` ("${ctEsc(h.comment)}")` : ''}.
        ${h.reset ? ` ${ctEsc(h.name)} resets only on <code>${ctEsc(h.reset.split('#')[0].trim())}</code>.` : ''}
        ${x.onAtStart ? ` <b>${ctEsc(x.name)} was already on when this close started.</b> The device it drives saw no new change of state for this close. If that device starts on a change of state, it will not start again until ${ctEsc(h.name)} resets.` : ` A later close command will not make ${ctEsc(x.name)} change state again until ${ctEsc(h.name)} resets.`}
      </div>`).join('')).join('')}
    </div>`;
  }

  // Timers
  if (o.timers.length) {
    html += `<div style="margin-top:14px;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--text-muted);">Timers in the close path</div>
      <table class="data-table"><thead><tr><th>Timer</th><th>Pickup</th><th>Dropout</th><th>Purpose</th></tr></thead><tbody>
      ${o.timers.map(t => `<tr><td>${ctEsc(t.label)}</td><td>${t.pickup}${t.pickupMs != null ? ` (${ctFmtMs(t.pickupMs)}${t.assumed ? '*' : ''})` : ''}</td><td>${t.dropout}${t.dropoutMs != null ? ` (${ctFmtMs(t.dropoutMs)}${t.assumed ? '*' : ''})` : ''}</td><td>${ctEsc(t.comment || '')}</td></tr>`).join('')}
      </tbody></table>
      ${o.timers.some(t => t.assumed) ? '<div style="font-size:10.5px;color:var(--text-muted)">* This record does not confirm whether these settings are in cycles or seconds.</div>' : ''}`;
  }

  // CF
  if (o.cf && o.cf.setting != null) {
    const c = o.cf;
    let t = `CFD = ${c.setting}`;
    if (c.unit) t += ` ${c.unit} (${ctFmtMs(c.settingMs)})`;
    else t += ' (this record does not show whether this is cycles or seconds)';
    if (c.measuredMs != null) t += ` — measured ${o.closeBit} → ${o.cfBit} ${ctFmtMs(c.measuredMs)}${c.crossRecord ? ' across records' : ''}`;
    else if (c.heldMs != null) t += ` — ${o.closeBit} held ${ctFmtMs(c.heldMs)} to the end of this record with no ${o.cfBit}${c.unit === 'seconds' ? ', so CFD is in seconds' : ''}`;
    const gate = o.timers.find(tm => tm.dropoutMs && c.settingMs && tm.dropoutMs > c.settingMs);
    if (gate) t += `. <b>Note:</b> ${ctEsc(gate.label)}${gate.comment ? ` ("${ctEsc(gate.comment)}")` : ''} holds its window open for ${ctFmtMs(gate.dropoutMs)}, longer than CFD. A permissive that arrives after ${ctFmtMs(c.settingMs)} comes after this close request has already failed (${ctEsc(o.cfBit || 'CF')}). A close after that needs a new close request.`;
    html += `<div style="margin-top:14px;font-size:12px;"><b>Close failure time:</b> ${t}</div>`;
  }

  // ER coverage
  if (o.er) {
    const e = o.er;
    const lines = [];
    const outcome = e.closedInER && e.cfInER ? 'it still makes an event report when the breaker closes or when the close fails (CF)'
      : e.closedInER ? `it makes an event report only if the breaker closes. A close that fails makes no event report (${ctEsc(o.cfBit || 'CF')} is not in ER)`
      : e.cfInER ? `it makes an event report only if the close fails (${ctEsc(o.cfBit || 'CF')}). A close that succeeds makes no event report`
      : 'it makes no event report at all, whether the breaker closes or not';
    for (const s of e.sources) lines.push(`<div style="font-size:12px;margin:2px 0;">${s.inER ? '<span style="color:var(--green)">✓</span>' : '<span style="color:var(--red)">✕</span>'} <b>${ctEsc(s.term)}</b> (${ctEsc(s.what)}) — ${s.inER ? 'in ER. It makes an event report every time it asserts.' : `not in ER. For a close started this way, ${outcome}.`}</div>`);
    if (e.cfInER) lines.push(`<div style="font-size:12px;margin:2px 0;"><span style="color:var(--green)">✓</span> <b>${ctEsc(o.cfBit)}</b> is in ER. Every failed close makes a second record, CFD after the first.</div>`);
    else if (o.cfBit) lines.push(`<div style="font-size:12px;margin:2px 0;"><span style="color:var(--yellow)">⚠</span> <b>${ctEsc(o.cfBit)}</b> is not in ER. A failed close leaves no record of its own.</div>`);
    for (const x of e.orphans) lines.push(`<div style="font-size:12px;margin:2px 0;"><span style="color:var(--yellow)">⚠</span> <b>${ctEsc(x.label)}</b> is labelled "${ctEsc(x.comment)}" but is <b>not in ER</b>. It cannot trigger an event report. (<code>${ctEsc(x.eq)}</code>)</div>`);
    html += `<div style="margin-top:14px;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--text-muted);">Which close commands make an event report</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">ER := <code>${ctEsc(e.eq)}</code></div>${lines.join('')}`;
  }

  // Clock
  if (o.clock && !o.clock.synced) {
    html += `<div style="margin-top:14px;font-size:12px;"><span style="color:var(--yellow)">⚠</span> <b>Relay clock not synchronized:</b> ${ctEsc(o.clock.offBits.join(' and '))} off for the whole record${o.clock.source ? ` (TIME_SRC := ${ctEsc(o.clock.source)})` : ''}. Event times can be far from the SCADA time of the command. Match events by event number, not by time.</div>`;
  }
  return html;
}

function buildCloseTraceCard(P, A) {
  const o = A && A.closeTrace;
  if (!o) return '';
  return `<div class="card yellow-accent"><div class="card-header">🔌 Close Attempt</div>
    <div style="font-size:13px;font-weight:700;color:${ctTone(o.verdict.tone)};margin-bottom:6px;">${ctEsc(o.verdict.headline)}</div>
    <div style="font-size:12px;color:var(--text-dim);line-height:1.55;margin-bottom:12px;">${ctEsc(o.verdict.detail)}</div>
    ${buildCloseTraceSections(P, A)}
  </div>`;
}
