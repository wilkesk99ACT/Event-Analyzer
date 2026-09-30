// ════════════════════════════════════════════════════════════════════════════
// CLOSE READINESS — WOULD A CLOSE COMMAND SENT NOW SUCCEED?
// ════════════════════════════════════════════════════════════════════════════
// An operator looking at an open recloser wants one answer before sending a close: will it
// work, and if not, what stops it. A TRIG record (a report taken on demand) or any record that
// ends with the breaker open holds the state of every relay-word bit at its last sample. The
// settings in the same file hold every equation. Together they are enough to run the close
// logic forward.
//
// That is what this module does. It takes the state at the last sample as "the present
// conditions", injects one close command (CC, a pushbutton pulse, a remote bit — each way in
// that the close equation offers), and steps the relay's logic forward one processing interval
// (a quarter cycle) at a time:
//
//   * every SV equation, in order, with its pickup and dropout timer
//   * every latch (reset wins over set, as in SEL latches)
//   * the output contacts, evaluated before CLOSE updates in the same interval
//   * CL / ULCL and the CLOSE latch: CLOSE sets on a rising edge of CL when ULCL, TRIP and 52A
//     are all off, and clears on 52A, ULCL, TRIP or when CFD runs out (CF)
//   * the trip equation, so a trip set up by the present conditions is caught
//   * ER, so the tool can say whether the command would leave an event report
//
// The processing order was fitted to PGR SOUTHWICK 10427, where the real relay recorded every
// step of a remote close: CC, CL, CLOSE and ER on the same interval; SV07, SV08 and SV21 on the
// next; SV09 (R_TRIG SV08) one interval after SV08; OUT102 blind to the one-interval CC pulse.
// The simulator reproduces that sequence; test/test-close-readiness.mjs checks it.
//
// The simulated steps are written out as a synthetic record and handed to
// analyzeCloseAttempt(), so the answer — which output would carry the close, what would hold it
// off, which latch holds an output on — comes from the same code that reads a real close.
//
// If the close output would energize, the simulation assumes the breaker closes 3 cycles later
// and runs on for 10 s, evaluating the trip equation, to catch a close that would trip straight
// back out under the present conditions.
//
// What it cannot know, and says so every time:
//   * Anything outside the relay. Contact inputs, remote bits and measured elements are held at
//     their last recorded state. A permissive that another device would send in answer to the
//     close (an RVC controller's "ready" input) is reported as the thing the close waits on,
//     not as a certain failure.
//   * Currents after the close. Elements that need load current stay where they were.
//   * How long a timer that was already running had been running. It is taken as just started.
//   * Whether the breaker mechanism works. The relay can only energize its close contact.

const RS_MAX_COMMANDS = 5;
const RS_POST_CLOSE_MS = 10000;
const RS_BREAKER_CLOSE_MS = 50;

function rsFamilyUnit(P) {
  const id = String(P.device || P.fid || '');
  if (/SEL-751/.test(id)) return 'seconds';
  if (/SEL-651R/.test(id)) return 'cycles';
  return null;
}
// SV timer and CFD units: this record's own evidence first, then the relay family.
function rsUnits(P) {
  const ev = typeof svTimerUnit === 'function' ? svTimerUnit(P) : null;
  if (ev) return { unit: ev, basis: 'measured in this record' };
  const fam = rsFamilyUnit(P);
  if (fam) return { unit: fam, basis: 'assumed from the relay model — this record does not show it' };
  return { unit: 'cycles', basis: 'assumed — this record does not show it' };
}
function rsToMs(v, unit, freq) { return unit === 'seconds' ? v * 1000 : v / freq * 1000; }

// Every command term that can start a close: operator and communications terms in the close
// equation's chain (through SVs and latch SET equations).
function rsCloseStarters(P, clEq) {
  const out = new Map();
  const walk = (eq, depth, seen) => {
    const a = ctAst(eq);
    if (!a.node || depth > 5) return;
    for (const l of llgCollectLeaves(a.node)) {
      if (/\bNOT\b/.test(l.mod || '')) continue;
      const n = l.name;
      if (/^(CC\d?|CC3|PB\d+_PUL|LB\d+|RB\d+)$/.test(n)) out.set(n, ctClassOf(n).what);
      if (seen.has(n)) continue; seen.add(n);
      const sv = ctSv(P, n); if (sv) walk(sv.equation, depth + 1, seen);
      const lt = ctLatch(P, n); if (lt && lt.setEquation) walk(lt.setEquation, depth + 1, seen);
    }
  };
  walk(clEq, 0, new Set());
  // Remote first: that is the command an operator in a control center sends.
  const rank = (n) => /^CC/.test(n) ? 0 : /^RB/.test(n) ? 1 : /^LB/.test(n) ? 2 : 3;
  return Array.from(out.entries()).map(([term, what]) => ({ term, what })).sort((a, b) => rank(a.term) - rank(b.term));
}
function rsCommandText(term) {
  if (/^CC/.test(term)) return `Remote close (${term})`;
  if (/^PB\d+_PUL$/.test(term)) return `Front-panel close (${term})`;
  if (/^RB/.test(term)) return `Remote bit close (${term})`;
  if (/^LB/.test(term)) return `Local bit close (${term})`;
  return `Close via ${term}`;
}

// ── Compile everything the simulator evaluates ──
function rsCompile(P) {
  const c = (eq) => { const a = ctAst(eq); return { ast: a.node, cmp: a.comparisons || {}, text: String(eq || '').split('#')[0].trim() }; };
  const dl = P.digitalLabels || [];
  const pick = (names) => names.find(n => ctSetting(P, n) != null) || null;
  const clName = pick(['CL3P', 'CL']);
  const ulName = pick(['ULCL3P', 'ULCL']);
  const closeBit = ctPick(P, CT_CLOSE_BITS) || (clName === 'CL3P' ? 'CLOSE3P' : 'CLOSE');
  const cfBit = ctPick(P, CT_CF_BITS) || (clName === 'CL3P' ? 'CF3P' : 'CF');
  const bkrBit = ctPick(P, CT_BKR_BITS);
  const tripBit = ['TRIP3P', 'TRIP'].find(n => dl.includes(n)) || 'TRIP';
  // "52A := IN102" / "52A_3P := IN201": the breaker status comes from an input.
  const bkrSrc = (ctSetting(P, '52A') || ctSetting(P, '52A_3P') || ctSetting(P, '52A3P') || '').split('#')[0].trim();
  const cfdRaw = ctSetting(P, 'CFD3P') || ctSetting(P, 'CFD');
  return {
    clName, ulName, closeBit, cfBit, bkrBit, tripBit,
    // "52A := IN301 OR IN303 OR IN305" (one input per pole): all of them close together.
    bkrInputs: (bkrSrc.match(/\bIN\d{3}\b/g) || []).filter(n => !new RegExp('NOT\\s+' + n).test(bkrSrc)),
    cl: clName ? c(ctSetting(P, clName)) : null,
    ul: ulName ? c(ctSetting(P, ulName)) : null,
    tr: P.tripEquation ? c(P.tripEquation) : null,
    trName: P.tripEquationName || 'TR',
    er: P.settings && P.settings.EReq ? c(P.settings.EReq) : null,
    cfd: cfdRaw != null ? parseFloat(cfdRaw) : null,
    svs: (P.svSettings || []).map(sv => ({ label: sv.label, tLabel: sv.label + 'T', pu: sv.pickupDelay || 0, dro: sv.dropoutDelay || 0, ...c(sv.equation), comment: ctComment(sv.equation) })),
    lts: (P.latchSettings || []).map(lt => ({ label: lt.label, set: c(lt.setEquation), rst: c(lt.resetEquation) })),
    outs: ctSettingEquations(P, /^OUT\d{3}$/).filter(o => o.eq && !/^[01]$/.test(o.eq.split('#')[0].trim())).map(o => ({ label: o.name, raw: o.eq, ...c(o.eq) })),
  };
}

// Boolean evaluation against the simulator's state. R_TRIG/F_TRIG compare the last two
// completed intervals, which is what reproduces the one-interval lag the relay records.
function rsEval(node, S, P1, P2, cmp, fit) {
  if (!node) return false;
  switch (node.op) {
    case 'VAR': {
      const n = node.name;
      if (cmp && cmp[n]) return !!(fit && fit[n]);
      if (n === '1') return true;
      if (n === '0') return false;
      return !!S.get(n);
    }
    case 'NOT': return !rsEval(node.c, S, P1, P2, cmp, fit);
    case 'REDGE': return rsEval(node.c, P1, P1, P2, cmp, fit) && !rsEval(node.c, P2, P2, P2, cmp, fit);
    case 'FEDGE': return !rsEval(node.c, P1, P1, P2, cmp, fit) && rsEval(node.c, P2, P2, P2, cmp, fit);
    case 'AND': return rsEval(node.l, S, P1, P2, cmp, fit) && rsEval(node.r, S, P1, P2, cmp, fit);
    case 'OR': return rsEval(node.l, S, P1, P2, cmp, fit) || rsEval(node.r, S, P1, P2, cmp, fit);
    default: return false;
  }
}

// ── The simulator ──
// base: Map of every recorded bit at the "present" sample. command: the term pulsed at step 1.
// Returns the steps as transitions, plus what happened to CL, CLOSE, CF, ER, TR.
function rsSimulate(P, K, base, command, opts) {
  const freq = (P.eventInfo && P.eventInfo.freq) || 60;
  const dt = 1000 / (freq * 4);
  const unit = opts.unit;
  const cfdMs = K.cfd != null ? rsToMs(K.cfd, opts.cfdUnit || unit, freq) : 60000;
  const maxSteps = Math.ceil((Math.min(cfdMs, 600000) + 2000) / dt);

  const S = new Map(base);
  const recorded = new Set(P.digitalLabels || []);
  const notes = [];
  const frozen = new Set();
  const fit = {};

  // Consistency: each equation, evaluated on the present state, must reproduce what the relay
  // recorded for it. If it does not (an analog comparison, a math variable, a bit this file
  // does not carry), that bit is held at its recorded value instead of recomputed.
  const fitCheck = (label, eq) => {
    if (!eq || !eq.ast || !recorded.has(label)) return;
    const want = !!base.get(label);
    const cmpKeys = Object.keys(eq.cmp || {});
    if (rsEval(eq.ast, S, S, S, eq.cmp, fit) === want) return;
    if (cmpKeys.length) {
      cmpKeys.forEach(k => { fit[k] = true; });
      if (rsEval(eq.ast, S, S, S, eq.cmp, fit) === want) return;
      cmpKeys.forEach(k => { delete fit[k]; });
    }
    frozen.add(label);
    notes.push(`${label} does not follow from its equation with the recorded bits (${eq.text}). It is held at its recorded state (${want ? 'on' : 'off'}).`);
  };
  K.svs.forEach(sv => fitCheck(sv.label, sv));
  if (K.tr && K.tr.ast && !base.get(K.tripBit) && rsEval(K.tr.ast, S, S, S, K.tr.cmp, fit)) {
    frozen.add(K.tripBit);
    notes.push(`${K.trName} reads true from the recorded bits, but ${K.tripBit} is off. ${K.tripBit} is held off.`);
  }
  K.outs.forEach(o => fitCheck(o.label, o));

  // Timer state. A timer whose input is on but whose output is not yet on was part-way
  // through its delay; how far is not in the record. It is taken as just started.
  const tm = new Map();
  for (const sv of K.svs) {
    const inOn = !!S.get(sv.label), outOn = !!S.get(sv.tLabel);
    tm.set(sv.label, { on: inOn ? (sv.pu > 0 ? 0 : Infinity) : 0, off: !inOn && outOn ? 0 : Infinity });
    const blinker = sv.ast && llgCollectLeaves(sv.ast).some(l => l.name === sv.tLabel);
    if (inOn && !outOn && sv.pu > 0 && recorded.has(sv.tLabel) && !blinker) notes.push(`${sv.label} is on and ${sv.tLabel} is not yet on. The record does not show how long ${sv.label} has been on, so its ${sv.pu} pickup delay is counted from now.`);
  }

  const trans = [];
  const labels = new Set(recorded);
  const record = (step, before) => {
    const changes = [];
    for (const [k, v] of S) if (!!v !== !!before.get(k)) { changes.push({ label: k, asserted: !!v }); labels.add(k); }
    if (changes.length) trans.push({ analogSampleIdx: step, changes });
  };

  let closeOn = !!S.get(K.closeBit);
  let closeMs = 0;
  let P1 = new Map(S), P2 = new Map(S);
  const res = { clRose: null, closeRose: null, closeFell: null, cf: null, er: null, erTerm: null, bkrClosed: null, tripAt: null, tripBranch: null, closeOutAt: null, steps: 0 };
  let bkrCloseDue = null;
  let stopAt = maxSteps;
  const closeOuts = new Set(K.outs.filter(o => o.ast && ctDependsOn(P, o.text, [K.closeBit])
    && ctOutputRole(P, { name: o.label, eq: o.raw }, ctDirectlyNames(o.text, [K.closeBit])) === 'close').map(o => o.label));

  for (let step = 1; step <= stopAt; step++) {
    const before = new Map(S);
    const tMs = step * dt;
    // The command: one processing interval.
    S.set(command, step === 1);
    // What-if: bits forced to a value from the command onward (an input the operator expects
    // another device to supply, for example).
    if (opts.hold) for (const [k, v] of Object.entries(opts.hold)) S.set(k, !!v);
    // Breaker closing, if the close output energized.
    if (bkrCloseDue != null && step >= bkrCloseDue && !S.get(K.bkrBit)) {
      S.set(K.bkrBit, true); if (recorded.has('52B')) S.set('52B', false);
      for (const n of K.bkrInputs) S.set(n, true);
      res.bkrClosed = step;
      stopAt = Math.min(stopAt, step + Math.ceil(RS_POST_CLOSE_MS / dt));
    }
    // SVs, in order, each with its timer.
    for (const sv of K.svs) {
      if (!frozen.has(sv.label) && sv.ast) S.set(sv.label, rsEval(sv.ast, S, P1, P2, sv.cmp, fit));
      const t = tm.get(sv.label), inOn = !!S.get(sv.label);
      if (inOn) { t.on = (t.on === Infinity ? Infinity : t.on + dt); t.off = 0; } else { t.off = (t.off === Infinity ? Infinity : t.off + dt); t.on = 0; }
      const puMs = rsToMs(sv.pu, unit, freq), doMs = rsToMs(sv.dro, unit, freq);
      let out = !!S.get(sv.tLabel);
      if (inOn && (sv.pu === 0 || t.on >= puMs)) out = true;
      if (!inOn && (sv.dro === 0 || t.off >= doMs)) out = false;
      S.set(sv.tLabel, out);
    }
    // Latches: reset wins.
    for (const lt of K.lts) {
      const r = lt.rst.ast && rsEval(lt.rst.ast, S, P1, P2, lt.rst.cmp, fit);
      const s = lt.set.ast && rsEval(lt.set.ast, S, P1, P2, lt.set.cmp, fit);
      if (r) S.set(lt.label, false); else if (s) S.set(lt.label, true);
    }
    // Trip equation (TRIP follows TR here; TDURD is not modelled).
    if (K.tr && K.tr.ast) {
      const tr = rsEval(K.tr.ast, S, P1, P2, K.tr.cmp, fit);
      if (tr && !frozen.has(K.tripBit)) {
        S.set(K.tripBit, true);
        if (res.tripAt == null && res.bkrClosed != null) {
          res.tripAt = step;
          const br = llgFlatten(K.tr.ast, 'OR').find(b => rsEval(b, S, P1, P2, K.tr.cmp, fit));
          res.tripBranch = br ? rcAstText(br, null) : null;
          res.tripDrivers = br ? rsTrueDrivers(br, S, K, 0, new Set()) : [];
          stopAt = Math.min(stopAt, step + 4);
        }
      } else if (!frozen.has(K.tripBit)) S.set(K.tripBit, false);
    }
    // Outputs: before CLOSE updates in this interval.
    for (const o of K.outs) if (!frozen.has(o.label) && o.ast) S.set(o.label, rsEval(o.ast, S, P1, P2, o.cmp, fit));
    if (res.closeOutAt == null && [...closeOuts].some(n => S.get(n))) {
      res.closeOutAt = step;
      if (K.bkrBit) bkrCloseDue = step + Math.ceil(RS_BREAKER_CLOSE_MS / dt);
    }
    // Close logic.
    const cl = K.cl && K.cl.ast ? rsEval(K.cl.ast, S, P1, P2, K.cl.cmp, fit) : false;
    const ul = K.ul && K.ul.ast ? rsEval(K.ul.ast, S, P1, P2, K.ul.cmp, fit) : false;
    const clRise = cl && !P1.get(K.clName);
    if (K.clName) S.set(K.clName, cl);
    if (K.ulName) S.set(K.ulName, ul);
    if (cl && res.clRose == null) res.clRose = step;
    let cfPulse = false;
    if (!closeOn && clRise && !ul && !S.get(K.tripBit) && !S.get(K.bkrBit)) { closeOn = true; closeMs = 0; if (res.closeRose == null) res.closeRose = step; }
    else if (closeOn) {
      closeMs += dt;
      if (S.get(K.bkrBit) || ul || S.get(K.tripBit)) { closeOn = false; if (res.closeFell == null) res.closeFell = { step, why: S.get(K.bkrBit) ? '52A' : ul ? K.ulName : K.tripBit }; }
      else if (closeMs >= cfdMs) { closeOn = false; cfPulse = true; if (res.cf == null) res.cf = step; if (res.closeFell == null) res.closeFell = { step, why: K.cfBit }; }
    }
    S.set(K.closeBit, closeOn);
    S.set(K.cfBit, cfPulse);
    // Event report.
    if (K.er && K.er.ast && res.er == null && rsEval(K.er.ast, S, P1, P2, K.er.cmp, fit)) {
      res.er = step;
      const br = llgFlatten(K.er.ast, 'OR').find(b => rsEval(b, S, P1, P2, K.er.cmp, fit));
      res.erTerm = br ? rcAstText(br, null) : null;
    }
    record(step, before);
    P2 = P1; P1 = new Map(S);
    res.steps = step;
    // Nothing left to happen: the close request is over and nothing is timing.
    if (!closeOn && res.closeRose != null && res.bkrClosed == null && bkrCloseDue == null && step > (res.closeFell ? res.closeFell.step + 8 : 0)) break;
    if (res.clRose == null && step > 4 && res.closeRose == null && bkrCloseDue == null) {
      // CL never came on in the first intervals. Run on only while a timer that could still
      // bring it on is counting.
      const counting = K.svs.some(sv => { const t = tm.get(sv.label); return S.get(sv.label) && !S.get(sv.tLabel) && t.on < rsToMs(sv.pu, unit, freq); });
      if (!counting) break;
    }
  }
  // A synthetic record the close-attempt trace can read.
  const n = res.steps + 1;
  const synth = {
    ...P,
    digitalLabels: Array.from(labels),
    initialDigitalState: Array.from(base.entries()).filter(([, v]) => v).map(([k]) => k),
    digitalTransitions: trans,
    analogData: new Array(n).fill(0).map(() => ({})),
    eventInfo: { ...(P.eventInfo || {}), samPerCycA: 4 },
    timestamp: null, triggerArrowIdx: 0, triggerSampleIndex: 0,
    _svTimerUnit: unit,
  };
  return { res, synth, notes, dt, cfdMs };
}

// The measured elements behind a true branch: walk true leaves, through SV timers to their SV
// equations, and keep the protection elements (names that start with a digit).
function rsTrueDrivers(node, S, K, depth, seen) {
  const out = [];
  for (const l of llgCollectLeaves(node)) {
    if (/\bNOT\b/.test(l.mod || '') || !S.get(l.name) || seen.has(l.name)) continue;
    seen.add(l.name);
    if (/^52[AB]/.test(l.name)) continue;
    if (/^\d/.test(l.name)) { out.push(l.name); continue; }
    const m = /^(SV\d+)T?$/.exec(l.name);
    const sv = m && K.svs.find(x => x.label === m[1]);
    if (sv && sv.ast && depth < 5) out.push(...rsTrueDrivers(sv.ast, S, K, depth + 1, seen));
  }
  return Array.from(new Set(out));
}

function rsBaseState(P, idx) {
  const S = new Map();
  for (const l of (P.digitalLabels || [])) S.set(l, bitStateAtAnalogIdx(P, l, idx).state);
  return S;
}

// ════════════════════════════════════════════════════════════════════════════
// Outputs that follow the close through SV or latch logic but are not the close contact — a
// start signal to an outside controller (an RVC, a recloser control), for example. That device
// can close the breaker by a path this relay does not control, so a close contact that waits on
// a permissive is not always the only way the breaker closes.
//   started: off now, and the command would turn it on (a new start signal)
//   held:    already on now, held by a latch — a new close would not change its state
function rsAuxOutputs(P, K, base, synth) {
  const res = { started: [], held: [] };
  if (!K.closeBit || typeof ctSettingEquations !== 'function') return res;
  const outs = ctSettingEquations(P, /^OUT\d{3}$/).filter(o => o.eq && !/^0$/.test(o.eq.split('#')[0].trim()));
  const rose = new Map();
  for (const t of (synth && synth.digitalTransitions) || []) for (const c of t.changes) if (c.asserted && !rose.has(c.label)) rose.set(c.label, t.analogSampleIdx);
  const dt = 1000 / (((P.eventInfo && P.eventInfo.freq) || 60) * 4);
  for (const o of outs) {
    const direct = ctDirectlyNames(o.eq, [K.closeBit]);
    if (!direct && !ctDependsOn(P, o.eq, [K.closeBit])) continue;
    if (ctOutputRole(P, o, direct) !== 'aux') continue;
    const eq = o.eq.split('#')[0].trim();
    if (K.tripBit && ctDirectlyNames(eq, [K.tripBit])) continue;
    const item = { name: o.name, eq, comment: ctComment(o.eq) };
    if (base.get(o.name)) {
      const a = ctAst(o.eq);
      item.heldBy = (a.node ? llgCollectLeaves(a.node) : [])
        .filter(l => !/\bNOT\b/.test(l.mod || '') && /^LT\d+$/.test(l.name) && base.get(l.name))
        .map(l => { const lt = ctLatch(P, l.name); return { name: l.name, reset: lt ? String(lt.resetEquation || '').split('#')[0].trim() : null }; });
      res.held.push(item);
    } else if (rose.has(o.name)) {
      item.atMs = rose.get(o.name) * dt;
      res.started.push(item);
    }
  }
  return res;
}

function analyzeCloseReadiness(P, A) {
  if (!P || !P.digitalLabels || !P.analogData || !P.analogData.length) return null;
  const K = rsCompile(P);
  if (!K.bkrBit) return null;
  const last = P.analogData.length - 1;
  const base = rsBaseState(P, last);
  if (base.get(K.bkrBit)) return null;                  // breaker closed: nothing to close
  if (base.get(K.closeBit)) return null;                // a close is already in progress — the trace covers it
  const out = {
    eventType: (P.eventInfo && (P.eventInfo.eventType || P.eventInfo.event)) || '',
    clName: K.clName, clEq: K.cl ? K.cl.text : null,
    commands: [], general: [], notes: [], verdict: null,
  };
  const U = rsUnits(P);
  out.units = U;
  if (!K.cl) { out.verdict = { kind: 'no-cl', tone: 'warn', headline: 'No close equation in this file', detail: 'The file has no CL or CL3P setting, so the tool cannot tell how a close is issued.' }; return out; }

  const starters = rsCloseStarters(P, K.cl.text).slice(0, RS_MAX_COMMANDS);
  if (!starters.length) {
    out.verdict = { kind: 'no-command', tone: 'warn', headline: 'No operator close command in the close equation',
      detail: `${K.clName} := ${K.cl.text}. No CC, pushbutton, local bit or remote bit starts it, so a close command has no path into the close logic.` };
    return out;
  }
  const freq = (P.eventInfo && P.eventInfo.freq) || 60;
  for (const st of starters) {
    let sim;
    try { sim = rsSimulate(P, K, base, st.term, { unit: U.unit }); } catch (e) { console.warn('close readiness sim failed', e); continue; }
    const r = sim.res;
    let trace = null;
    try { trace = analyzeCloseAttempt(sim.synth, {}, null); } catch (e) { console.warn('readiness trace failed', e); }
    const cmd = { term: st.term, what: st.what, label: rsCommandText(st.term), res: r, trace, notes: sim.notes, dtMs: sim.dt, cfdMs: sim.cfdMs };
    const ms = (step) => step == null ? null : step * sim.dt;
    cmd.times = { cl: ms(r.clRose), close: ms(r.closeRose), out: ms(r.closeOutAt), trip: r.tripAt != null && r.bkrClosed != null ? ms(r.tripAt - r.bkrClosed) : null, cf: ms(r.cf) };

    if (r.clRose == null) {
      const pts = ctSamplePoints(sim.synth, 0, sim.synth.analogData.length - 1);
      const why = ctWhyNeverTrue(sim.synth, K.cl.ast, pts, K.cl.cmp, 0, new Set([K.clName]));
      cmd.clAlternatives = ctAlternatives(why);
      // The command's own branch is the one that matters; other branches are other commands.
      const headOf = (a) => a.route[0] || (a.tree && a.tree.name);
      const own = cmd.clAlternatives.find(a => headOf(a) === st.term)
        || cmd.clAlternatives.find(a => { const sv = ctSv(P, headOf(a)); return sv && ctDependsOn(P, sv.equation, [st.term]); })
        || cmd.clAlternatives[0];
      cmd.ownRoute = own ? own.route : [];
      cmd.clBlockers = own ? own.blockers.filter(b => b.name !== st.term) : [];
      // Another way into CL that waits only on an outside signal (an RVC permissive, say).
      const extAlt = cmd.clAlternatives.find(a => a !== own && a.rank === 0 && a.blockers.length && a.blockers.every(b => b.cls && b.cls.cls === 'external'));
      cmd.clExternalAlt = extAlt ? { route: extAlt.route, names: extAlt.blockers.map(b => b.name) } : null;
      cmd.outcome = cmd.clBlockers.length && cmd.clBlockers.every(b => b.cls && b.cls.cls === 'external' && !b.negated)
        ? 'cl-waits-external' : 'rejected';
    } else if (r.closeRose == null) {
      cmd.outcome = 'close-blocked';
      cmd.closeBlock = base.get(K.tripBit) || sim.synth.digitalTransitions.some(t => t.changes.some(c => c.label === K.tripBit && c.asserted)) ? K.tripBit
        : (K.ulName && sim.synth.digitalTransitions.some(t => t.changes.some(c => c.label === K.ulName && c.asserted))) || base.get(K.ulName) ? K.ulName : null;
    } else if (r.closeOutAt != null) {
      cmd.outcome = r.tripAt != null ? 'closes-then-trips' : 'energizes';
    } else {
      const alt = trace && trace.closeOutputs[0] && (trace.closeOutputs[0].alternatives || [])[0];
      const bl = alt ? alt.blockers : [];
      cmd.outBlockers = bl;
      cmd.outcome = bl.length && bl.every(b => b.cls && (b.cls.cls === 'external' || b.cls.cls === 'measured')) ? 'waits-external' : 'output-blocked';
    }
    // What-if: the outside signal arrives. Does the close then go through, and does it hold?
    const extNames = (cmd.outcome === 'waits-external' ? (cmd.outBlockers || []) : cmd.outcome === 'cl-waits-external' ? cmd.clBlockers : [])
      .filter(b => b.cls && b.cls.cls === 'external' && !b.negated).map(b => b.name);
    if (extNames.length) {
      try {
        const w = rsSimulate(P, K, base, st.term, { unit: U.unit, hold: Object.fromEntries(extNames.map(n => [n, true])) }).res;
        cmd.whatIf = {
          names: extNames,
          energizes: w.closeOutAt != null,
          outMs: w.closeOutAt != null ? w.closeOutAt * sim.dt : null,
          trips: w.tripAt != null, tripBranch: w.tripBranch,
          tripMs: w.tripAt != null && w.bkrClosed != null ? (w.tripAt - w.bkrClosed) * sim.dt : null,
        };
      } catch (e) { /* what-if is best effort */ }
    }
    cmd.aux = rsAuxOutputs(P, K, base, sim.synth);
    cmd.verdict = rsCommandVerdict(cmd, K, P, trace);
    out.commands.push(cmd);
  }
  if (!out.commands.length) return null;

  // What could still prevent it, beyond the logic.
  const main = out.commands[0];
  const t = main.trace;
  if (t) {
    for (const x of t.auxOutputs.filter(x => x.onAtStart && x.heldBy && x.heldBy.some(h => h.onAtStart))) {
      out.general.push({ sev: 'bad', text: `${x.name}${x.comment ? ` ("${x.comment}")` : ''} is already on, held by ${x.heldBy.map(h => `${h.name} (resets on ${String(h.reset || '—').split('#')[0].trim()})`).join(', ')}. A new close will not change its state. If the device it drives starts on a change of state, it will not start. Reset ${x.heldBy.map(h => h.name).join(', ')} first.` });
    }
    const gate = t.timers.find(tm => tm.dropoutMs && main.cfdMs && tm.dropoutMs > main.cfdMs && /permiss|control|window|rvc/i.test(tm.comment || ''));
    if (main.outcome === 'waits-external' && main.cfdMs) {
      const handoff = main.aux && main.aux.started.length;
      out.general.push({ sev: 'warn', text: `${handoff ? `If the breaker closes only through the relay's own close contact, the` : 'The'} external permissive must arrive within CFD (${ctFmtMs(main.cfdMs)}) of the command, or the relay declares ${K.cfBit}.${gate ? ` ${gate.label} ("${gate.comment}") holds its window for ${ctFmtMs(gate.dropoutMs)}, longer than CFD.` : ''}${handoff ? ` If the outside device closes the breaker itself, the relay sees ${K.bkrBit} come on and ${K.closeBit} drops out without ${K.cfBit}.` : ''}` });
    }
    if (t.er) {
      out.general.push(main.res.er != null
        ? { sev: 'good', text: `This command would make an event report (ER via ${main.res.erTerm || '—'}).` }
        : { sev: 'warn', text: `This command would not make an event report on its own. The close outcome ${t.er.closedInER ? 'is recorded if the breaker closes' : t.er.cfInER ? 'is recorded only if it fails (CF)' : 'is not recorded at all'}.` });
    }
    if (t.clock && !t.clock.synced) out.general.push({ sev: 'warn', text: `The relay clock is not synchronized (${t.clock.offBits.join(', ')} off). Match the resulting event by event number, not by time.` });
  }
  const lo = ['79LO3P', '79LO'].find(n => base.get(n));
  if (lo) out.general.push({ sev: 'info', text: `${lo} is on (reclosing locked out). A manual or remote close is still allowed through ${K.clName}; the lockout resets after the breaker stays closed for 79RSLD.` });
  for (const hw of ['TCCAP', 'BTFAIL', 'DTFAIL', 'CHRGG', 'PWR_SRC1']) {
    if (!base.has(hw)) continue;
    const on = base.get(hw);
    if ((hw === 'TCCAP' || hw === 'PWR_SRC1') && !on) out.general.push({ sev: 'bad', text: `${hw} is off — ${hw === 'TCCAP' ? 'trip/close capacitor not charged' : 'control power source not present'}.` });
    if ((hw === 'BTFAIL' || hw === 'DTFAIL') && on) out.general.push({ sev: 'bad', text: `${hw} is on — ${hw === 'BTFAIL' ? 'battery test failed' : 'battery discharge test failed'}.` });
  }
  out.general.push({ sev: 'info', text: 'Outside what the relay can see: the close circuit wiring, the close coil or actuator, the mechanism, and the 52A auxiliary contact. The relay can only energize its close output.' });
  out.notes = Array.from(new Set(out.commands.flatMap(c => c.notes)));
  out.verdict = main.verdict;
  return out;
}

// The close contact waits on an outside permissive, but the close also drives a start output to
// an outside controller. Two cases:
//   started — the command gives that device a new start. It may close the breaker on its own,
//             so "would not close" is not a fair prediction.
//   held    — the start output is already held on by a latch. The device sees no new start.
//             At PGR SOUTHWICK this was the difference between a failed close (10427, OUT301
//             held by LT07) and one that closed with IN402 never on (10430, OUT301 new).
function rsHandoffText(cmd, K, ext, where) {
  const aux = cmd.aux || { started: [], held: [] };
  const nm = (x) => `${x.name}${x.comment ? ` ("${x.comment}")` : ''}`;
  const own = where === 'cl' ? `the relay's own close logic (${K.clName})` : `the relay's own close contact`;
  if (aux.held.length && !aux.started.length) {
    const h = aux.held;
    return {
      kind: 'handoff-held', tone: 'bad',
      headline: `would likely fail — ${h.map(x => x.name).join(', ')} is already on, so the outside device gets no new start, and ${where === 'cl' ? K.clName : 'the relay close contact'} waits on ${ext}`,
      detail: `${h.map(x => `${nm(x)} is already on${x.heldBy && x.heldBy.length ? `, held by ${x.heldBy.map(l => `${l.name} (resets on ${l.reset || '—'})`).join(', ')}` : ''}`).join('; ')}. A new close does not change its state, so a device that starts on a change of state does not start. ${own[0].toUpperCase() + own.slice(1)} waits on ${ext}.`,
    };
  }
  if (!aux.started.length) return null;
  const s = aux.started;
  return {
    kind: 'handoff', tone: 'info',
    headline: `would start the outside device through ${s.map(x => x.name).join(', ')}; ${where === 'cl' ? K.clName : 'the relay close contact'} waits on ${ext}`,
    detail: `${s.map(x => `${nm(x)} would operate at +${ctFmtMs(x.atMs)}`).join('; ')}. That is a new start signal to the device it drives. If that device closes the breaker by its own path, the close does not need ${ext}. If the breaker closes only through ${own}, ${ext} must come on${cmd.cfdMs && where === 'out' ? ` within CFD (${ctFmtMs(cmd.cfdMs)})` : ''}. The settings alone cannot tell which.`,
  };
}

function rsCommandVerdict(cmd, K, P, trace) {
  const V = (kind, tone, headline, detail) => ({ kind, tone, headline, detail });
  const phrase = (b) => ctBlockerPhrase(b, P);
  const L = cmd.label;
  switch (cmd.outcome) {
    case 'rejected':
      return V('rejected', 'bad', `${L} would be rejected — ${K.clName} would not assert`,
        `${K.clName} := ${K.cl.text}.${cmd.ownRoute && cmd.ownRoute.length ? ` This command reaches ${K.clName} through ${cmd.ownRoute.map(n => rcGloss(P, n)).join(' → ')}.` : ''}${cmd.clBlockers && cmd.clBlockers.length ? ` With the present conditions: ${cmd.clBlockers.map(phrase).join('; ')}.` : ''} No close would be issued by this command.${cmd.clExternalAlt ? ` ${K.clName} can also come on through ${cmd.clExternalAlt.route.join(' → ') || 'another branch'} when ${cmd.clExternalAlt.names.join(', ')} comes on from outside the relay.` : ''}`);
    case 'cl-waits-external': {
      const ext = cmd.clBlockers.map(b => b.name).join(', ');
      const ho = rsHandoffText(cmd, K, ext, 'cl');
      if (ho) return V(ho.kind, ho.tone, `${L} ${ho.headline}`, `${cmd.ownRoute.length ? `This command reaches ${K.clName} through ${cmd.ownRoute.map(n => rcGloss(P, n)).join(' → ')}.` : ''} ${ho.detail} ${K.clName} waits on ${ext}: ${cmd.clBlockers.map(phrase).join('; ')}.`.trim());
      return V('cl-waits-external', 'warn', `${L} would not close unless ${ext} comes on`,
        `${cmd.ownRoute.length ? `This command reaches ${K.clName} through ${cmd.ownRoute.map(n => rcGloss(P, n)).join(' → ')}.` : `This command feeds ${K.clName} directly (${K.clName} := ${K.cl.text}).`} ${K.clName} would wait on ${ext}: ${cmd.clBlockers.map(phrase).join('; ')}. That signal comes from outside this relay, so the record cannot say whether it would arrive. Until it does, no close is issued.`);
    }
    case 'close-blocked':
      return V('close-blocked', 'bad', `${L} would be rejected — ${K.closeBit} would not latch`,
        `${K.clName} would assert, but ${cmd.closeBlock ? `${cmd.closeBlock} is on, which blocks ${K.closeBit}` : `${K.closeBit} would not latch`}. No close would be issued.`);
    case 'energizes':
      return V('energizes', 'good', `${L} would energize the close output`,
        `${K.closeBit} would latch at +${ctFmtMs(cmd.times.close)} and the close contact would operate at +${ctFmtMs(cmd.times.out)}. With the breaker assumed closed 3 cycles later, ${K.trName} did not assert in the next ${ctFmtMs(RS_POST_CLOSE_MS)} with the present conditions. The close should succeed if the breaker and its close circuit work.`);
    case 'closes-then-trips': {
      const drv = cmd.res.tripDrivers || [];
      const volt = drv.filter(d => /^(27|59|81|3P27|3P59)/.test(d));
      const drvTxt = drv.length ? ` The trip is driven by ${drv.join(', ')}, which ${drv.length > 1 ? 'are' : 'is'} on now.` : '';
      const caveat = volt.length
        ? ` Caution: ${volt.join(', ')} ${volt.length > 1 ? 'are' : 'is'} a voltage or frequency element, held at its present state. If the VTs are on the side this close would energize, the voltage comes back when the breaker closes and this trip would not happen. If the VTs see the source side, the source is not healthy and the trip would happen.`
        : '';
      return V('closes-then-trips', volt.length ? 'warn' : 'bad', `${L} would close, then trip — ${cmd.res.tripBranch || K.trName}`,
        `The close output would operate at +${ctFmtMs(cmd.times.out)}. With the breaker closed, ${K.trName} would assert ${ctFmtMs(cmd.times.trip)} later via ${cmd.res.tripBranch || '—'}, under the present conditions.${drvTxt}${caveat}`);
    }
    case 'waits-external': {
      const ext = (cmd.outBlockers || []).map(b => b.name).join(', ');
      const ho = rsHandoffText(cmd, K, ext, 'out');
      if (ho) return V(ho.kind, ho.tone, `${L} ${ho.headline}`, `${K.closeBit} would latch. ${ho.detail} ${(cmd.outBlockers || []).map(phrase).join('; ')}.`);
      const started = trace ? trace.auxOutputs.filter(x => x.everOn && !x.onAtStart) : [];
      const startTxt = started.length ? ` ${started.map(x => `${x.name}${x.comment ? ` ("${x.comment}")` : ''} would operate at +${ctFmtMs(x.firstOnMs)}`).join('; ')}, so the device it drives gets its start signal.` : '';
      return V('waits-external', 'warn', `${L} would not close unless ${ext} comes on`,
        `${K.closeBit} would latch, but the close contact would wait on ${ext}.${startTxt} ${(cmd.outBlockers || []).map(phrase).join('; ')}. That signal comes from outside this relay, so the record cannot say whether it would arrive. If it does not arrive within CFD (${ctFmtMs(cmd.cfdMs)}), the relay declares ${K.cfBit}.`);
    }
    default:
      return V('output-blocked', 'bad', `${L} would fail — the close output would not operate`,
        `${K.closeBit} would latch, but the close contact would be held off: ${(cmd.outBlockers || []).map(phrase).join('; ') || 'see the trace'}. The relay would declare ${K.cfBit} after ${ctFmtMs(cmd.cfdMs)}.`);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// RENDERING
// ════════════════════════════════════════════════════════════════════════════
function buildCloseReadinessCard(P, A) {
  const R = A && A.closeReadiness;
  if (!R || !R.verdict) return '';
  const sev = { good: ['var(--green)', '✓'], bad: ['var(--red)', '✕'], warn: ['var(--yellow)', '⚠'], info: ['var(--accent)', 'ℹ'] };
  const cmds = (R.commands || []).map((c, i) => {
    const tone = ctTone(c.verdict.tone);
    let body = `<div style="font-size:12px;color:var(--text-dim);line-height:1.55;margin:4px 0 8px;">${ctEsc(c.verdict.detail)}</div>`;
    const tl = [];
    if (c.times.cl != null) tl.push(`${ctEsc(R.clName)} +${ctFmtMs(c.times.cl)}`);
    if (c.times.close != null) tl.push(`CLOSE +${ctFmtMs(c.times.close)}`);
    if (c.times.out != null) tl.push(`close output +${ctFmtMs(c.times.out)}`);
    if (c.times.trip != null) tl.push(`trip ${ctFmtMs(c.times.trip)} after closing`);
    if (c.times.cf != null) tl.push(`CF +${ctFmtMs(c.times.cf)}`);
    if (tl.length) body += `<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">Simulated sequence: ${tl.join(' → ')}</div>`;
    if (c.whatIf) {
      const w = c.whatIf;
      const txt = !w.energizes ? `the close output would still not operate. Something else also holds it off.`
        : w.trips ? `the close output would operate at +${ctFmtMs(w.outMs)}, but the recloser would trip again ${ctFmtMs(w.tripMs)} after closing via ${ctEsc(w.tripBranch || '—')}.`
        : `the close output would operate at +${ctFmtMs(w.outMs)}, and no trip would follow in the next ${ctFmtMs(RS_POST_CLOSE_MS)} under the present conditions.`;
      body += `<div style="font-size:12px;margin:4px 0 6px;padding:6px 10px;border-left:3px solid ${w.energizes && !w.trips ? 'var(--green)' : 'var(--red)'};"><b>If ${ctEsc(w.names.join(' and '))} ${w.names.length > 1 ? 'come' : 'comes'} on:</b> ${txt}</div>`;
    }
    if ((c.outcome === 'rejected' || c.outcome === 'cl-waits-external') && c.clAlternatives) {
      body += `<div style="font-size:11.5px;font-weight:700;margin:6px 0 2px;">Why ${ctEsc(R.clName)} would not assert</div>` + c.clAlternatives.map(a => ctRenderWhy(a.tree, P, 1)).join('');
    }
    if (i === 0 && c.trace && c.res.closeRose != null) {
      body += `<details style="margin-top:6px;"><summary style="cursor:pointer;font-size:11.5px;color:var(--accent);">Show the simulated close path (outputs, blockers, timers)</summary><div style="margin-top:8px;">${buildCloseTraceSections(P, { closeTrace: c.trace })}</div></details>`;
    }
    return `<div style="border:1px solid var(--border, #243042);border-radius:8px;padding:10px 12px;margin-top:10px;">
      <div style="font-size:12.5px;font-weight:700;color:${tone};">${ctEsc(c.verdict.headline)}</div>${body}</div>`;
  }).join('');
  const gen = R.general.map(g => `<div style="font-size:12px;margin:3px 0;"><span style="color:${sev[g.sev][0]}">${sev[g.sev][1]}</span> ${ctEsc(g.text)}</div>`).join('');
  const notes = R.notes.length ? `<details style="margin-top:10px;"><summary style="cursor:pointer;font-size:11px;color:var(--text-muted);">Assumptions made from this record (${R.notes.length})</summary>${R.notes.map(n => `<div style="font-size:11px;color:var(--text-muted);margin:2px 0;">• ${ctEsc(n)}</div>`).join('')}</details>` : '';
  return `<div class="card yellow-accent"><div class="card-header">🔮 Close Readiness — if a close were sent now</div>
    <div style="font-size:13px;font-weight:700;color:${ctTone(R.verdict.tone)};margin-bottom:4px;">${ctEsc(R.verdict.headline)}</div>
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">The relay logic is run forward from the last sample of this record, with inputs and measured elements held where they are. Timer units: ${ctEsc(R.units.unit)} (${ctEsc(R.units.basis)}).</div>
    ${cmds}
    <div style="margin-top:14px;font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--text-muted);">What else could stop the close</div>
    ${gen}
    ${notes}
  </div>`;
}

function buildCloseReadinessBannerBlock(P, A) {
  const R = A && A.closeReadiness;
  if (!R || !R.verdict) return '';
  const c = ctTone(R.verdict.tone);
  return `<div style="margin-top:14px;border:1px solid ${c};border-radius:8px;padding:10px 14px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--text-muted);">🔮 If a close were sent now</div>
    <div style="font-size:13px;font-weight:700;color:${c};margin-top:4px;">${ctEsc(R.verdict.headline)}</div>
    <div style="font-size:11.5px;color:var(--text-dim);margin-top:4px;">See the Close Readiness card in the Diagnostics tab.</div>
  </div>`;
}
