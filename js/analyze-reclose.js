

// ════════════════════════════════════════════════════════════════════════════
// AUTOMATIC RECLOSING (ANSI 79) — SCHEME PARSING
// ════════════════════════════════════════════════════════════════════════════
// A trip record only answers half the operator's question. The other half is
// "and now what — does this thing come back by itself, how many times, how long
// from now, and what has to be true on the line before it will?" Everything the
// relay needs to answer that lives in its own settings block, which is already
// embedded in the CEV. This section reads that block, then (below) evaluates it
// against the digital states this record actually captured.
//
// Naming varies by relay family. The SEL-751 emits the bare names (79RI, 79DTL,
// SH0..SH4, 79LO); the SEL-651R emits three-pole-suffixed names (79RI3P,
// 79DTL3P, SH03P..SH43P, 79LO3P). Every lookup below tries the specific form
// first and falls back to the bare one, so both parse without branching on the
// device string.

// Each entry: key, the setting names to try (most specific first), the SEL name of the
// function, and a plain-English statement of what it does to the reclose sequence.
const RECLOSE_EQ_SPECS = [
  { key: 'RI',   names: ['79RI3P', '79RI'],     title: 'Reclose Initiate',
    what: 'Starts a reclose sequence. When this asserts (and Reclose Initiate Supervision is satisfied), the recloser leaves Reset, increments the shot counter, and begins timing the open interval.' },
  { key: 'RIS',  names: ['79RIS3P', '79RIS'],   title: 'Reclose Initiate Supervision',
    what: 'Gates Reclose Initiate. The initiate is only accepted while this is asserted — factory default is "52A OR 79CY", i.e. the breaker was actually closed (or a sequence is already running).' },
  { key: 'DTL',  names: ['79DTL3P', '79DTL'],   title: 'Drive to Lockout',
    what: 'Forces the recloser straight to Lockout from Reset or Cycle. Nothing after this matters — no automatic close will be issued for this event.' },
  { key: 'DLS',  names: ['79DLS3P', '79DLS'],   title: 'Drive to Last Shot',
    what: 'Jumps the shot counter to the final shot, so any remaining intermediate attempts are skipped and the next trip goes to Lockout.' },
  { key: 'SKP',  names: ['79SKP3P', '79SKP'],   title: 'Skip Shot',
    what: 'Advances the shot counter without issuing a close — the current open interval is skipped and the sequence moves on to the next one.' },
  { key: 'STL',  names: ['79STL3P', '79STL'],   title: 'Stall Open Interval Timing',
    what: 'Holds the open-interval timer while asserted. The countdown to the close is frozen — and therefore so is the close — until this drops out.' },
  { key: 'BRS',  names: ['79BRS3P', '79BRS'],   title: 'Block Reset Timing',
    what: 'Holds the reset timer while asserted, keeping the recloser from returning to Reset (shot counter stays where it is) even though the breaker is closed.' },
  { key: 'CLS',  names: ['79CLS3P', '79CLS'],   title: 'Close Supervision',
    what: 'The final permissive on the automatic close. When the open interval expires the recloser waits here — the close command is not issued until this asserts.' },
  { key: 'SEQ',  names: ['79SEQ3P', '79SEQ'],   title: 'Sequence Coordination',
    what: 'Advances this device’s shot counter in step with a downstream device that cleared the fault, so the two stay coordinated without this one tripping.' },
  { key: 'CL',   names: ['CL3P', 'CL'],         title: 'Close Logic',
    what: 'The relay’s general close equation — the non-79 paths that can also issue a CLOSE (front-panel pushbutton, SCADA close, external contact). Separate from automatic reclosing.' },
  { key: 'ULCL', names: ['ULCL3P', 'ULCL'],     title: 'Unlatch Close',
    what: 'Cancels a close in progress. While asserted the CLOSE output is unlatched, so a close the 79 element wanted to issue is withdrawn.' },
];

function parseRecloseScheme(S, fullText) {
  const R = {
    present: false, settingsFound: false,
    E79raw: null, enabled: null, shots: null,
    openIntervals: [], resetDelay: null, resetFromLockoutDelay: null,
    closeSupLimit: null, closeSupLimitOff: false,
    trueOpenIntervalCount: 0,
    eq: {}, eqName: {},
  };
  if (!S) return R;

  // Single-token value: SEL packs several settings onto one physical line
  // ("79RSD := 60.00   79RSLD := 5.00   79CLSD := OFF"), so a numeric read must stop at
  // the first token or it swallows the neighbours.
  const grabToken = (names) => {
    for (const name of names) {
      const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const x = S.match(new RegExp('(?:^|[^A-Z0-9_])' + safe + '\\s*:=\\s*([A-Za-z0-9._-]+)', 'm'));
      if (x) return { name, value: x[1].trim() };
    }
    return null;
  };
  // Rest-of-line value, for SELogic equations. Safe because SEL always places an equation
  // last on its line — the numeric settings that share a line come before it.
  const grabLine = (names) => {
    for (const name of names) {
      const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const x = S.match(new RegExp('(?:^|[^A-Z0-9_])' + safe + '\\s*:=([^\\r\\n]+)', 'm'));
      if (x) return { name, value: x[1].trim() };
    }
    return null;
  };
  const numOf = (names) => {
    const h = grabToken(names);
    if (!h) return null;
    if (/^(OFF|N|NA|NONE)$/i.test(h.value)) return { off: true, raw: h.value };
    const v = parseFloat(h.value);
    return isNaN(v) ? { off: false, raw: h.value, value: null } : { off: false, raw: h.value, value: v };
  };

  const e79 = grabToken(['E79']);
  if (e79) {
    R.settingsFound = true;
    R.E79raw = e79.value;
    if (/^(N|OFF|NA|0|NONE)$/i.test(e79.value)) { R.enabled = false; R.shots = 0; }
    else if (/^\d+$/.test(e79.value)) { R.shots = parseInt(e79.value, 10); R.enabled = R.shots > 0; }
    else if (/^Y$/i.test(e79.value)) { R.enabled = true; R.shots = null; } // enabled, count implied by however many 79OI settings exist
    else { R.enabled = null; R.shots = null; }
  }

  for (let i = 1; i <= 4; i++) {
    const oi = numOf([`79OI${i}`]);
    R.openIntervals.push(oi && !oi.off && oi.value != null ? oi.value : (oi && oi.off ? 'OFF' : null));
    if (oi) R.settingsFound = true;
  }
  R.trueOpenIntervalCount = R.openIntervals.filter(v => typeof v === 'number').length;
  // A relay that says "enabled" without a shot count (E79 := Y) implies as many shots as it
  // has real open-interval settings.
  if (R.enabled && R.shots == null) R.shots = R.trueOpenIntervalCount || null;

  const rsd = numOf(['79RSD']);   R.resetDelay = rsd && !rsd.off ? rsd.value : null;
  const rsld = numOf(['79RSLD']); R.resetFromLockoutDelay = rsld && !rsld.off ? rsld.value : null;
  const clsd = numOf(['79CLSD']);
  if (clsd) { R.settingsFound = true; R.closeSupLimitOff = !!clsd.off; R.closeSupLimit = clsd.off ? null : clsd.value; }

  RECLOSE_EQ_SPECS.forEach(spec => {
    const hit = grabLine(spec.names);
    if (hit) {
      R.eq[spec.key] = hit.value;
      R.eqName[spec.key] = hit.name;
      if (spec.key !== 'CL' && spec.key !== 'ULCL') R.settingsFound = true;
    } else {
      R.eq[spec.key] = null;
      R.eqName[spec.key] = null;
    }
  });

  R.present = R.settingsFound;
  return R;
}

// ════════════════════════════════════════════════════════════════════════════
// RECLOSE LOGIC EVALUATION HELPERS
// ════════════════════════════════════════════════════════════════════════════

// Renders an AST back to readable SELogic with the minimum parentheses needed to preserve
// meaning — used to label each OR-branch of a reclose equation on its own row.
function rcAstText(n, parentOp) {
  if (!n) return '';
  if (n.op === 'VAR') return n.name;
  if (n.op === 'NOT') return 'NOT ' + rcAstText(n.c, 'NOT');
  if (n.op === 'REDGE') return 'R_TRIG ' + rcAstText(n.c, 'NOT');
  if (n.op === 'FEDGE') return 'F_TRIG ' + rcAstText(n.c, 'NOT');
  if (n.op === 'AND' || n.op === 'OR') {
    const s = rcAstText(n.l, n.op) + ' ' + n.op + ' ' + rcAstText(n.r, n.op);
    const needParen = (n.op === 'OR' && parentOp && parentOp !== 'OR') || (n.op === 'AND' && parentOp === 'NOT');
    return needParen ? '(' + s + ')' : s;
  }
  return '';
}

// Evaluates one reclose SELogic equation against the record's digital states at a given
// analog sample index, and returns not just the answer but the per-branch, per-term
// breakdown the UI needs to say WHICH term decided it.
//
// `known` is false whenever any operand isn't a bit this record carries — in that case the
// boolean is reported but flagged as not trustworthy, rather than being presented as fact.
// R_TRIG/F_TRIG fall back to raw level, matching the simplification the rest of this file
// uses outside the full trip-chain evaluator.
function rcEvalEquation(P, eqText, idx) {
  const clean = (eqText || '').split('#')[0].trim();
  const comment = (eqText || '').includes('#') ? (eqText || '').split('#').slice(1).join('#').trim() : '';
  if (!clean) return null;
  if (/^0$/.test(clean) || /^NA$/i.test(clean)) return { value: false, known: true, literal: true, text: clean, comment, branches: [] };
  if (/^1$/.test(clean)) return { value: true, known: true, literal: true, text: clean, comment, branches: [] };

  let ast;
  try { ast = llgParse(llgTokenize(clean)); } catch (e) { return { value: null, known: false, text: clean, comment, branches: [], parseFailed: true }; }

  let anyUnknown = false;
  const leafState = (name) => {
    if (/^[01]$/.test(name)) return { state: name === '1', known: true };
    const b = bitStateAtAnalogIdx(P, name, idx);
    if (!b.known) anyUnknown = true;
    return { state: b.state, known: b.known };
  };
  const getState = (name) => leafState(name);

  const value = llgEvalNode(ast, getState);
  const branches = llgFlatten(ast, 'OR').map(node => ({
    text: rcAstText(node, null),
    value: llgEvalNode(node, getState),
    leaves: llgCollectLeaves(node).map(l => {
      const b = leafState(l.name);
      const negated = /\bNOT\b/.test(l.mod || '');
      return { name: l.name, mod: l.mod || '', state: b.state, known: b.known, effective: negated ? !b.state : b.state, negated };
    }),
  }));

  // `known` (no unrecognised operand anywhere) is a useful signal but far too strict as a
  // gate on whether the ANSWER can be trusted. Real relay equations routinely OR together a
  // term this record carries with one it doesn't — "52A OR 79CY" on a file that logs 52A but
  // not 79CY. The OR is definitively TRUE the moment 52A is true, regardless of the operand
  // the file is silent about. `definite` captures that properly:
  //   true  → at least one OR-branch is true with every one of its own operands recognised
  //   false → every OR-branch contains a recognised operand that is false, so no unrecognised
  //           bit could rescue it
  // Anything else is genuinely indeterminate and is reported as such rather than guessed.
  const branchAllKnown = (b) => b.leaves.every(l => l.known);
  const branchDefinitelyFalse = (b) => b.leaves.some(l => l.known && !l.effective);
  const definite = value
    ? branches.some(b => b.value && branchAllKnown(b))
    : branches.every(b => branchDefinitelyFalse(b));

  return { value, known: !anyUnknown, definite, text: clean, comment, branches, ast };
}

// ════════════════════════════════════════════════════════════════════════════
// AUTOMATIC RECLOSING — BEHAVIOURAL ANALYSIS
// ════════════════════════════════════════════════════════════════════════════
// Produces the full picture of what the recloser is going to do next: whether a sequence
// was initiated at all, how many attempts remain, when each one lands, what has to be true
// on the line before each close is actually issued, and every path that ends in lockout.
//
// A guiding constraint runs through all of it: an event record is a second or two long, and
// open intervals are measured in tens or hundreds of seconds. So most of the sequence
// happens AFTER the last sample in the file. This function is careful to separate what the
// record actually settles ("this trip drove the recloser to lockout — here's the term") from
// what it merely indicates ("close supervision wants five seconds of good line voltage; it
// was not satisfied when the record ended, and the record ends long before the close is
// due"). Overstating the second kind as the first would be the easiest way for this tab to
// mislead someone, so the status vocabulary keeps them apart:
//
//   settled  — the record answers this outright
//   blocked  — the record shows this condition failing, and that failure decides the outcome
//   pending  — evaluated after the record ends; current state shown as an indication only
//   unknown  — the equation references bits this file doesn't carry
function analyzeReclose(P, A) {
  const sch = P.reclose || { present: false, eq: {} };
  const dLabels = P.digitalLabels || [];
  const freq = (P.eventInfo && P.eventInfo.freq) || 60;
  const spc = (P.eventInfo && P.eventInfo.samPerCycA) || 32;
  const msPerSample = 1000 / (freq * spc);
  const nSamples = (P.analogData || []).length;

  const pick = (...names) => names.find(n => dLabels.includes(n)) || null;
  const bits = {
    LO: pick('79LO3P', '79LO'),
    CY: pick('79CY3P', '79CY'),
    RS: pick('79RS3P', '79RS'),
    CLOSE: pick('CLOSE3P', 'CLOSE'),
    CF: pick('CF3P', 'CF'),
    RCSF: pick('RCSF3P', 'RCSF'),
    ULCL: pick('ULCL3P', 'ULCL'),
    BKR: pick('52A3P', '52A'),
    SHOT: [0, 1, 2, 3, 4].map(i => pick(`SH${i}3P`, `SH${i}`)),
  };
  const anyRecloseBits = !!(bits.LO || bits.CY || bits.RS || bits.SHOT.some(Boolean));

  const out = {
    scheme: sch, bits, anyRecloseBits,
    available: !!(sch.present || anyRecloseBits),
    gates: [], plan: [], observed: [], lockoutPaths: [], notes: [],
    verdict: null,
  };
  if (!out.available) {
    out.verdict = {
      kind: 'no-data', tone: 'unknown', headline: 'No reclosing information in this file',
      detail: 'This record carries neither ANSI 79 settings nor any 79 relay-word bits, so nothing can be said about automatic reclosing from it. Either the device has no reclosing element, or the settings block in this CEV was truncated before the reclose section.',
    };
    return out;
  }

  // ── Reference instants ─────────────────────────────────────────────────────
  // The trip is the anchor: reclose initiate, drive-to-lockout and initiate supervision are
  // all decided around it. States only change at recorded transitions, so equations are
  // evaluated at exactly those indices rather than at every sample.
  const trips = P.digitalTransitions || [];
  const tripIdx = (A && A.tripCause && A.tripCause.tripTransition && A.tripCause.tripTransition.analogSampleIdx != null)
    ? A.tripCause.tripTransition.analogSampleIdx
    : (P.triggerSampleIndex != null && P.triggerSampleIndex >= 0 ? P.triggerSampleIndex : 0);
  const endIdx = Math.max(0, nSamples - 1);
  const evalPoints = [0, ...trips.map(t => t.analogSampleIdx)].filter((v, i, a) => a.indexOf(v) === i).sort((x, y) => x - y);
  const pointsFromTrip = evalPoints.filter(i => i >= tripIdx);
  // Does this record actually contain a trip at all? A CEV set routinely mixes TRIP records
  // with records triggered by something else entirely (a supervision bit in the ER list). On
  // those, `tripIdx` above has silently fallen back to the trigger sample, and every phrase
  // built around "at the trip" is then describing an instant where no trip happened. That
  // produced a hard "this trip does not initiate a reclose" verdict on a record whose own
  // observed state said a reclose cycle was already running. Establish it once, here.
  // When the record carries a trip bit, that bit IS the answer — a resolved `tripCause` can
  // still be populated on a record where the trip bit never moves (the cause analysis will
  // happily explain what the elements were doing), so it must not be allowed to manufacture a
  // trip that the relay word says did not happen.
  const tripLbl = pick('TRIP3P', 'TRIP', 'TRIPA');
  out.hasTrip = tripLbl
    ? trips.some(t => t.changes.some(c => c.label === tripLbl && c.asserted))
    : !!(A && A.tripCause && A.tripCause.tripTransition);
  out.tripLabel = tripLbl;
  out.tripIdx = tripIdx;
  out.endIdx = endIdx;
  out.msPerSample = msPerSample;
  out.recordEndMsAfterTrip = (endIdx - tripIdx) * msPerSample;

  const evalAt = (eq, idx) => rcEvalEquation(P, eq, idx);
  // "Did this equation hold true at any recorded instant from the trip onward?" — the right
  // question for momentary conditions like Reclose Initiate, which rides a pulsed TRIP bit
  // and may well be false again by the last sample.
  const firstTrueFromTrip = (eq) => {
    if (!eq) return null;
    for (const i of pointsFromTrip) {
      const r = evalAt(eq, i);
      if (r && r.value === true) return { idx: i, result: r, ms: (i - tripIdx) * msPerSample };
    }
    return null;
  };
  const stateAt = (label, idx) => (label ? bitStateAtAnalogIdx(P, label, idx) : { state: false, known: false });
  // `bitStateAtAnalogIdx` is INCLUSIVE of a transition landing exactly on `idx`, which is the
  // right reading almost everywhere — but not for the question "what was true going INTO this
  // trip". A relay that drives itself to lockout does so on the same digital sample as the trip
  // bit, so sampling at `tripIdx` returns the post-trip state and the tab reports the effect of
  // the trip as a condition that pre-dated it ("already in lockout before this trip", on a
  // record whose own initial state shows the recloser mid-cycle). Sampling one analog sample
  // earlier is strictly before the trip: digital samples are 8-32 analog samples apart, so
  // idx-1 can never skip a different transition, and idx-1 < 0 correctly falls through to the
  // record's initial state.
  const stateBeforeTrip = (label) => (label ? bitStateAtAnalogIdx(P, label, tripIdx - 1) : { state: false, known: false });
  const assertsAfterTrip = (label) => label
    ? trips.some(t => t.analogSampleIdx >= tripIdx && t.changes.some(c => c.label === label && c.asserted))
    : false;
  // Asserted on the trip's own digital sample — i.e. the trip caused it, rather than merely
  // preceding it. The distinction between this and `stateBeforeTrip` is the whole difference
  // between "went to lockout because of this trip" and "was already locked out".
  const assertsAtTripSample = (label) => label
    ? trips.some(t => t.analogSampleIdx === tripIdx && t.changes.some(c => c.label === label && c.asserted))
    : false;

  // ── Where in the sequence was this device when it tripped? ─────────────────
  // SH0..SH4 are mutually exclusive: SH0 means "in reset, no attempts used", SH2 means
  // "two reclose attempts already made". That index picks which open interval the NEXT
  // close uses and how many attempts are left.
  const shotAt = (idx) => {
    for (let i = bits.SHOT.length - 1; i >= 0; i--) {
      const lbl = bits.SHOT[i];
      if (lbl && stateAt(lbl, idx).state) return i;
    }
    return null;
  };
  const shotBeforeTrip = () => {
    for (let i = bits.SHOT.length - 1; i >= 0; i--) {
      const lbl = bits.SHOT[i];
      if (lbl && stateBeforeTrip(lbl).state) return i;
    }
    return null;
  };
  // All four of these answer "what was the recloser doing when this trip arrived", so all four
  // must be sampled strictly before it. Sampled at tripIdx they answer a different question.
  out.shotAtTrip = shotBeforeTrip();
  out.shotAtEnd = shotAt(endIdx);
  out.inLockoutAtTrip = bits.LO ? stateBeforeTrip(bits.LO).state : null;
  out.inLockoutAtEnd = bits.LO ? stateAt(bits.LO, endIdx).state : null;
  out.cyclingAtTrip = bits.CY ? stateBeforeTrip(bits.CY).state : null;
  out.cyclingAtEnd = bits.CY ? stateAt(bits.CY, endIdx).state : null;
  out.resetAtTrip = bits.RS ? stateBeforeTrip(bits.RS).state : null;
  out.lockoutAssertedAfterTrip = assertsAfterTrip(bits.LO);
  // Lockout on the trip's own sample, with the recloser demonstrably mid-cycle beforehand:
  // this trip is what ended the sequence. Reported separately so the verdict can say so
  // instead of mistaking it for a pre-existing lockout.
  out.lockoutCausedByThisTrip = assertsAtTripSample(bits.LO) && out.inLockoutAtTrip === false;
  out.cycleStartedAfterTrip = assertsAfterTrip(bits.CY);
  out.closedInRecord = assertsAfterTrip(bits.CLOSE);
  out.closeFailInRecord = assertsAfterTrip(bits.CF);

  // E79 states how many shots the element ALLOWS; the 79OI settings state how many it can
  // actually run. Those disagree whenever intervals past the first are set to OFF — a very
  // common way to write a one-shot scheme on a relay whose E79 was left at 4. Taking E79 at
  // face value reports "4 attempts remaining of 4" on a device that gets exactly one, and
  // lists shots 2-4 in the schedule with blank intervals as though they were still coming.
  // The sequence stops at the first interval that isn't a real number, so count contiguously
  // from the first and treat reaching an OFF interval as a lockout path, not as a shot.
  const declaredShots = (typeof sch.shots === 'number' && sch.shots > 0) ? sch.shots : null;
  const anyOISeen = sch.openIntervals.some(v => v !== null);
  let contiguousOIs = 0;
  for (let i = 0; i < sch.openIntervals.length; i++) {
    if (typeof sch.openIntervals[i] === 'number') contiguousOIs++; else break;
  }
  const shots = (anyOISeen && contiguousOIs > 0 && declaredShots != null && contiguousOIs < declaredShots)
    ? contiguousOIs
    : (declaredShots != null ? declaredShots : (sch.trueOpenIntervalCount || null));
  const enabled = sch.enabled === false ? false
    : (sch.enabled === true ? true : (shots ? true : null));
  out.shots = shots;
  out.declaredShots = declaredShots;
  out.usableShots = anyOISeen ? contiguousOIs : null;
  out.shotsCappedByOI = !!(declaredShots != null && anyOISeen && contiguousOIs > 0 && contiguousOIs < declaredShots);
  out.enabled = enabled;

  // ── Gate-by-gate evaluation ────────────────────────────────────────────────
  const addGate = (g) => { out.gates.push(g); return g; };
  const specOf = (key) => RECLOSE_EQ_SPECS.find(s => s.key === key);

  // Gate 1 — is the element switched on at all? Everything downstream is moot if not.
  addGate({
    key: 'E79', title: 'Reclosing element enabled', sel: 'E79',
    what: 'Master enable for automatic reclosing, and the number of reclose attempts (shots) the sequence is allowed.',
    equation: null,
    status: enabled === false ? 'blocked' : (enabled === true ? 'settled' : 'unknown'),
    pass: enabled === true,
    summary: enabled === false
      ? `E79 := ${sch.E79raw} — automatic reclosing is switched OFF on this device.`
      : (enabled === true
        ? (out.shotsCappedByOI
          ? `E79 := ${sch.E79raw} allows ${declaredShots} attempts, but only ${contiguousOIs} open interval${contiguousOIs === 1 ? ' is' : 's are'} actually set (79OI${contiguousOIs + 1} := OFF). This is a ${contiguousOIs}-shot scheme: reaching shot ${contiguousOIs + 1} has no interval to time and goes to lockout.`
          : `E79 := ${sch.E79raw != null ? sch.E79raw : 'enabled'} — ${shots ? shots : 'an unstated number of'} reclose attempt${shots === 1 ? '' : 's'} allowed.`)
        : 'No E79 setting found in this file’s settings block.'),
  });

  const gateSpecs = [
    { key: 'RI',  when: 'trip',  role: 'required' },
    { key: 'RIS', when: 'trip',  role: 'required' },
    { key: 'DTL', when: 'trip',  role: 'blocking' },
    { key: 'DLS', when: 'trip',  role: 'blocking-soft' },
    { key: 'SKP', when: 'trip',  role: 'modifier' },
    { key: 'STL', when: 'later', role: 'blocking-soft' },
    { key: 'CLS', when: 'later', role: 'required' },
    { key: 'ULCL', when: 'later', role: 'blocking' },
    { key: 'BRS', when: 'later', role: 'modifier' },
  ];

  const gateResults = {};
  gateSpecs.forEach(gs => {
    const spec = specOf(gs.key);
    const eq = sch.eq ? sch.eq[gs.key] : null;
    if (!eq) {
      gateResults[gs.key] = null;
      return;
    }
    const atTrip = evalAt(eq, tripIdx);
    const anywhere = firstTrueFromTrip(eq);
    const atEnd = evalAt(eq, endIdx);
    const res = { spec, sel: sch.eqName[gs.key] || spec.names[0], eq, atTrip, anywhere, atEnd, role: gs.role, when: gs.when };
    gateResults[gs.key] = res;
  });

  // Human-readable "which term did it" for a given evaluation result.
  const decidingBranch = (r) => {
    if (!r || !r.branches || !r.branches.length) return null;
    const t = r.branches.find(b => b.value);
    return t || null;
  };
  const failingLeaves = (r) => {
    if (!r || !r.branches) return [];
    const bad = [];
    r.branches.forEach(b => b.leaves.forEach(l => { if (!l.effective) bad.push(l); }));
    return bad;
  };

  // Gate 2 — Reclose Initiate. Evaluated across the whole post-trip window because the
  // trip bit it usually keys off is a pulse, not a level.
  if (gateResults.RI) {
    const r = gateResults.RI;
    const hit = r.anywhere;
    const chosen = hit ? hit.result : r.atTrip;
    const branch = hit ? decidingBranch(hit.result) : null;
    addGate({
      key: 'RI', title: 'Reclose initiated by this trip', sel: r.sel, what: r.spec.what,
      equation: r.eq, evaluation: chosen,
      status: hit ? 'settled' : (chosen && chosen.definite ? 'blocked' : 'unknown'),
      pass: !!hit,
      summary: hit
        ? `Satisfied ${hit.ms <= 0 ? 'at the trip' : `${hit.ms.toFixed(0)} ms after the trip`}${branch ? ` via ${rcGlossText(P, branch.text)}` : ''} — a reclose sequence is initiated by this event.`
        : (chosen && chosen.definite
          ? `Never satisfied anywhere between the trip and the end of the record — this trip does not start a reclose sequence. ${describeWhyFalse(chosen)}`
          : 'Could not be evaluated — the equation references bits this record does not carry.'),
    });
  } else if (enabled) {
    addGate({
      key: 'RI', title: 'Reclose initiated by this trip', sel: '79RI', what: specOf('RI').what,
      equation: null, status: 'unknown', pass: null,
      summary: 'No Reclose Initiate equation found in this file. On SEL relays the factory default initiates on the relay’s own trip, so a trip would normally start a sequence — but that cannot be confirmed from this record.',
    });
  }

  // Gate 3 — Reclose Initiate Supervision, evaluated at the instant the initiate actually
  // landed (not at some arbitrary later point where 52A has already dropped out).
  if (gateResults.RIS) {
    const r = gateResults.RIS;
    const riHit = gateResults.RI && gateResults.RI.anywhere;
    // Supervision is a permissive on the initiate, so it has to be read from the state the
    // relay was in when the initiate arrived — one sample before it, not on it. A typical
    // equation is "52A OR 79CY", and both of those terms are things the initiate itself
    // changes: 52A drops as the interrupter opens, and 79CY drops on the exact sample a
    // re-trip mid-cycle sends the recloser to lockout. Reading them at the initiate sample
    // makes a supervision that plainly passed look rejected, and buries the real outcome
    // under "initiate supervision rejected it".
    const evalIdx = Math.max(0, (riHit ? riHit.idx : tripIdx) - 1);
    const res = evalAt(r.eq, evalIdx);
    const branch = decidingBranch(res);
    addGate({
      key: 'RIS', title: 'Initiate supervision satisfied', sel: r.sel, what: r.spec.what,
      equation: r.eq, evaluation: res,
      status: res && res.definite ? (res.value ? 'settled' : 'blocked') : 'unknown',
      pass: res && res.definite ? res.value : null,
      summary: res && res.value
        ? `Satisfied at the moment of initiate${branch ? ` via ${rcGlossText(P, branch.text)}` : ''} — the initiate is accepted.`
        : (res && res.definite
          ? `Not satisfied at the moment of initiate — the reclose initiate is rejected and no sequence starts. ${describeWhyFalse(res)}`
          : 'Could not be evaluated from this record.'),
    });
  }

  // Gate 4 — Drive to Lockout. The single most decisive gate: if this asserts anywhere
  // between the trip and the end of the record, there is no automatic close, full stop.
  if (gateResults.DTL) {
    const r = gateResults.DTL;
    const hit = r.anywhere;
    const branch = hit ? decidingBranch(hit.result) : null;
    addGate({
      key: 'DTL', title: 'Driven to lockout', sel: r.sel, what: r.spec.what,
      equation: r.eq, evaluation: hit ? hit.result : r.atTrip,
      status: hit ? 'blocked' : ((r.atTrip && r.atTrip.definite) ? 'settled' : 'unknown'),
      pass: !hit,
      inverted: true,
      summary: hit
        ? `ASSERTED ${hit.ms <= 0 ? 'at the trip' : `${hit.ms.toFixed(0)} ms after the trip`}${branch ? ` via ${rcGlossText(P, branch.text)}` : ''} — the recloser is driven straight to lockout. No automatic close will be issued.`
        : ((r.atTrip && r.atTrip.definite)
          ? 'Not asserted at any point from the trip to the end of the record — nothing in this event forces lockout.'
          : 'Could not be evaluated from this record.'),
    });
  }

  // Gate 5 — Drive to Last Shot. Doesn't stop this close, but collapses the attempts after it.
  // A very common template writes "79DLS := 79LO", which just mirrors the lockout bit back at
  // itself. Reporting that as an independent blocking condition would be circular noise — once
  // the device is in lockout, "and also it's at the last shot" tells the reader nothing — so
  // that shape is called out for what it is instead of flagged.
  if (gateResults.DLS) {
    const r = gateResults.DLS;
    const hit = r.anywhere;
    const loLabels = ['79LO', '79LO3P'];
    const echoesLockout = (r.eq || '').split('#')[0].trim().split(/\s+/).every(t => loLabels.includes(t) || /^(OR|AND)$/.test(t));
    if (echoesLockout) {
      addGate({
        key: 'DLS', title: 'Driven to last shot', sel: r.sel, what: r.spec.what,
        equation: r.eq, evaluation: null, status: 'settled', pass: true, soft: true,
        summary: `Set to mirror ${loLabels.slice().sort((a, b) => b.length - a.length).find(l => (r.eq || '').includes(l)) || '79LO'}, so it simply follows the lockout state rather than acting as a separate condition — it does not independently shorten the sequence.`,
      });
      gateResults.DLS = null;
    } else addGate({
      key: 'DLS', title: 'Driven to last shot', sel: r.sel, what: r.spec.what,
      equation: r.eq, evaluation: hit ? hit.result : r.atTrip,
      status: hit ? 'blocked' : 'settled', pass: !hit, inverted: true, soft: true,
      summary: hit
        ? `Asserted ${hit.ms <= 0 ? 'at the trip' : `${hit.ms.toFixed(0)} ms after the trip`} — the shot counter jumps to the final shot, so intermediate attempts are skipped and the next trip locks out.`
        : 'Not asserted — the sequence runs its full shot count.',
    });
  }

  // Gate 6 — Skip Shot.
  if (gateResults.SKP && !/^0$/.test((gateResults.SKP.eq || '').split('#')[0].trim())) {
    const r = gateResults.SKP;
    const hit = r.anywhere;
    addGate({
      key: 'SKP', title: 'Shot skipped', sel: r.sel, what: r.spec.what,
      equation: r.eq, evaluation: hit ? hit.result : r.atTrip,
      status: hit ? 'blocked' : 'settled', pass: !hit, inverted: true, soft: true,
      summary: hit ? 'Asserted — this open interval is skipped and the sequence advances without closing.' : 'Not asserted — no shots are skipped.',
    });
  }

  // Gate 7 — Stall Open Interval Timing. Evaluated at record end and flagged as pending,
  // because what matters is whether it's still asserted tens of seconds from now.
  if (gateResults.STL && !/^0$/.test((gateResults.STL.eq || '').split('#')[0].trim())) {
    const r = gateResults.STL;
    const now = r.atEnd;
    addGate({
      key: 'STL', title: 'Open-interval timer stalled', sel: r.sel, what: r.spec.what,
      equation: r.eq, evaluation: now,
      status: 'pending', pass: now ? !now.value : null, inverted: true, soft: true,
      summary: now && now.value
        ? `Asserted at the end of the record${(() => {
          const hold = (now.branches || []).filter(b => b.value)
            .flatMap(b => b.leaves.filter(l => l.effective && l.known).map(l => `${l.negated ? 'NOT ' : ''}${rcGloss(P, l.name)}`))
            .filter((v, i, a) => a.indexOf(v) === i);
          const deep = (now.branches || []).filter(b => b.value)
            .flatMap(b => b.leaves.filter(l => l.effective && l.known).map(l => rcResolveTermText(P, A, l.name, endIdx)))
            .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('; ');
          return (hold.length ? ` via ${hold.join(' and ')}` : '') + (deep ? ` — ${deep}` : '');
        })()}. While it stays asserted the open-interval countdown is frozen, so the close is not postponed by a known amount — it is not being timed at all.`
        : 'Not asserted at the end of the record — the open-interval timer runs normally unless this picks up later.',
    });
  }

  // Gate 8 — Close Supervision. The permissive the close actually waits on, and the one
  // most likely to be the real answer to "why hasn't it come back yet".
  if (gateResults.CLS && !/^1$/.test((gateResults.CLS.eq || '').split('#')[0].trim())) {
    const r = gateResults.CLS;
    const now = r.atEnd;
    const bad = now ? failingLeaves(now) : [];
    addGate({
      key: 'CLS', title: 'Close supervision satisfied', sel: r.sel, what: r.spec.what,
      equation: r.eq, evaluation: now,
      status: 'pending', pass: (now && now.definite) ? now.value : null,
      summary: now && now.value
        ? 'Satisfied as of the last sample in this record. It is re-checked when the open interval expires, well after this record ends — if it still holds then, the close is issued.'
        : (now && now.definite
          ? `NOT satisfied as of the last sample in this record. Until it is, the close is held even after the open interval expires. ${describeWhyFalse(now)}`
          : 'Could not be evaluated from this record.'),
      supervisionTerms: bad,
      heldBy: (now && !now.value && now.definite) ? bad.filter(l => l.known).map(l => ({ name: l.name, negated: l.negated })) : [],
    });
  } else if (enabled && !gateResults.CLS) {
    addGate({
      key: 'CLS', title: 'Close supervision satisfied', sel: '79CLS', what: specOf('CLS').what,
      equation: null, status: 'settled', pass: true,
      summary: 'No close-supervision equation is configured, so the close is issued as soon as the open interval expires — there is no line-condition permissive to wait on.',
    });
  }

  // Gate 9 — Unlatch Close.
  if (gateResults.ULCL && !/^0$/.test((gateResults.ULCL.eq || '').split('#')[0].trim())) {
    const r = gateResults.ULCL;
    const now = r.atEnd;
    addGate({
      key: 'ULCL', title: 'Close unlatched', sel: r.sel, what: r.spec.what,
      equation: r.eq, evaluation: now,
      status: 'pending', pass: now ? !now.value : null, inverted: true,
      summary: now && now.value
        ? `Asserted at the end of the record — while this holds, a close command is withdrawn as soon as it is issued. ${describeWhyTrue(now)}`
        : 'Not asserted at the end of the record — nothing is currently withdrawing the close.',
    });
  }

  // ── Shot-by-shot plan ──────────────────────────────────────────────────────
  // Everything the operator wants for "how will it behave coming back in": which attempt is
  // next, how long each open interval is, when each close lands on the clock, and what
  // happens at the end of the line.
  const startShot = (out.shotAtTrip != null) ? out.shotAtTrip : 0;
  const shotKnown = out.shotAtTrip != null;
  const totalShots = shots || 0;
  const tripClockMs = eventClockMsAtTrip(P, tripIdx, msPerSample);
  // Is the open-interval timer actually running when the record ends? Every clock time in the
  // plan below is trip-time + open-interval, and that arithmetic is only meaningful if the
  // countdown is counting. 79STL freezes it — and 79STL is very often not a relay-word bit at
  // all (it is absent from the SEL-651R word), so the ONLY way to know is to evaluate the
  // equation. Computed here, before the plan, so a stalled timer suppresses the projection
  // rather than being mentioned three cards further down while the banner still promises a
  // close at a specific wall-clock time.
  const stlEnd = gateResults.STL && gateResults.STL.atEnd;
  out.stalledAtEnd = !!(stlEnd && stlEnd.value && stlEnd.definite);
  out.stallHolders = out.stalledAtEnd
    ? (stlEnd.branches || []).filter(b => b.value)
      .flatMap(b => b.leaves.filter(l => l.effective && l.known).map(l => ({ name: l.name, negated: l.negated })))
      .filter((v, i, a) => a.findIndex(x => x.name === v.name && x.negated === v.negated) === i)
    : [];
  // A stall term that is the trip bit itself clears on its own the moment TRIP drops out
  // (TDURD, tens of ms). A stall term driven by a measured line condition does not. Only the
  // second kind means "this close is not coming", so they must not be reported alike.
  const tripLikeStall = (n) => !!(out.tripLabel && n === out.tripLabel) || /^TRIP/.test(n || '');
  out.stallHoldersDurable = out.stallHolders.filter(h => !tripLikeStall(h.name));
  // Only a durable stall invalidates the schedule. TRIP3P is in most 79STL equations and is
  // still asserted at the end of a short record purely because TDURD outlasts the capture —
  // suppressing every clock time on that basis would be its own kind of wrong.
  out.stallBlocksSchedule = out.stalledAtEnd && out.stallHoldersDurable.length > 0;
  out.breakerOpenBeforeTrip = bits.BKR ? (stateBeforeTrip(bits.BKR).known ? !stateBeforeTrip(bits.BKR).state : null) : null;
  let cum = 0;
  if (enabled && totalShots > 0) {
    for (let k = startShot + 1; k <= totalShots; k++) {
      const oi = sch.openIntervals[k - 1];
      const oiSec = (typeof oi === 'number') ? oi : null;
      cum += (oiSec != null ? oiSec : 0);
      out.plan.push({
        shot: k,
        setting: `79OI${k}`,
        openIntervalSec: oiSec,
        openIntervalRaw: oi,
        cumulativeSec: oiSec != null ? cum : null,
        clock: (oiSec != null && tripClockMs != null && !out.stallBlocksSchedule) ? formatClockOffset(tripClockMs, cum * 1000) : null,
        clockSuppressedByStall: !!(oiSec != null && tripClockMs != null && out.stallBlocksSchedule),
        supervised: !!(gateResults.CLS && gateResults.CLS.eq && !/^1$/.test(gateResults.CLS.eq.split('#')[0].trim())),
        isLast: k === totalShots,
      });
    }
  }
  out.startShot = startShot;
  out.shotKnown = shotKnown;
  out.attemptsRemaining = enabled && totalShots > 0 ? Math.max(0, totalShots - startShot) : 0;
  out.tripClockMs = tripClockMs;

  // ── Lockout paths — every documented way this sequence ends open ──────────
  if (enabled && totalShots > 0) {
    if (gateResults.DTL && gateResults.DTL.eq) {
      out.lockoutPaths.push({
        title: `Drive to Lockout (${gateResults.DTL.sel}) asserts`,
        detail: `Any term of "${gateResults.DTL.eq.split('#')[0].trim()}" going true sends the recloser straight to lockout from Reset or Cycle — immediately, without waiting out an open interval.`,
      });
    }
    out.lockoutPaths.push({
      title: `Final shot used and the fault persists`,
      detail: `After reclose attempt ${totalShots} of ${totalShots}, another trip with the shot counter already at SH${totalShots} takes the recloser to lockout. There is no attempt ${totalShots + 1}.`,
    });
    if (out.shotsCappedByOI) {
      out.lockoutPaths.push({
        title: `Shot counter reaches SH${totalShots + 1} with 79OI${totalShots + 1} := OFF`,
        detail: `E79 := ${sch.E79raw} nominally allows ${out.declaredShots} attempts, but 79OI${totalShots + 1} is OFF, so shot ${totalShots + 1} has no open interval to time. Anything that advances the counter to SH${totalShots + 1} — including a trip that arrives while the breaker is already open during an open interval — lands in lockout immediately rather than starting another countdown.`,
      });
    }
    if (sch.closeSupLimit != null) {
      out.lockoutPaths.push({
        title: `Close supervision times out (79CLSD = ${sch.closeSupLimit} s)`,
        detail: `Once an open interval expires, the recloser waits for close supervision. If it is not satisfied within ${sch.closeSupLimit} s, the recloser gives up and goes to lockout instead of closing.`,
      });
    } else if (sch.closeSupLimitOff && gateResults.CLS && gateResults.CLS.eq) {
      out.notes.push(`79CLSD := OFF — there is no time limit on waiting for close supervision. If the supervising condition never comes back, the recloser waits indefinitely with the breaker open rather than locking out. It will simply sit there, neither closed nor locked out.`);
    }
    if (bits.CF) {
      out.lockoutPaths.push({
        title: 'Close failure (CF)',
        detail: 'A close command issued with no breaker-closed confirmation within the close-failure time asserts CF, which normally drives the recloser to lockout rather than retrying.',
      });
    }
  }

  // ── Reset behaviour ────────────────────────────────────────────────────────
  out.reset = {
    fromCycleSec: sch.resetDelay,
    fromLockoutSec: sch.resetFromLockoutDelay,
    blockedBy: gateResults.BRS && gateResults.BRS.eq && !/^0$/.test(gateResults.BRS.eq.split('#')[0].trim()) ? gateResults.BRS : null,
  };

  // ── Why does this record exist at all? ─────────────────────────────────────
  // On a record with no trip in it, this is the reader's actual first question. The answer is
  // in the ER trigger equation: exactly one of its terms asserted, and finding which one
  // turns an unexplained file into a named condition.
  out.recordTrigger = rcIdentifyRecordTrigger(P, out.hasTrip);

  // ── What the record itself observed ────────────────────────────────────────
  const obs = out.observed;
  const atTripLabel = out.hasTrip ? 'at the trip' : 'at the start of the record';
  if (!out.hasTrip) {
    obs.push({ k: 'Trip in this record', v: `none — ${out.tripLabel || 'the trip bit'} never asserts. The 79 states below are carried in from a previous record, not produced by this one.` });
    if (out.recordTrigger && out.recordTrigger.term) {
      obs.push({ k: 'Record triggered by', v: `${rcGloss(P, out.recordTrigger.term)} — a term of the ER equation, ${out.recordTrigger.msAfterStart != null ? `asserting ${out.recordTrigger.msAfterStart.toFixed(0)} ms into the record` : 'asserted in this record'}. Not a trip and not a close.` });
    }
  }
  if (out.shotAtTrip != null) obs.push({ k: `Shot counter ${atTripLabel}`, v: `SH${out.shotAtTrip}${out.shotAtTrip === 0 ? ' — in reset, no reclose attempts used yet' : ` — ${out.shotAtTrip} reclose attempt${out.shotAtTrip === 1 ? '' : 's'} already used`}` });
  if (out.shotAtEnd != null && out.shotAtEnd !== out.shotAtTrip) obs.push({ k: 'Shot counter at end of record', v: `SH${out.shotAtEnd} — the counter advanced during this record` });
  if (out.inLockoutAtTrip != null) obs.push({ k: `${bits.LO} ${atTripLabel}`, v: out.inLockoutAtTrip ? (out.hasTrip ? 'ASSERTED — already locked out before this trip' : 'ASSERTED — carried in already locked out') : 'not asserted' });
  if (out.lockoutCausedByThisTrip) obs.push({ k: `${bits.LO} after the trip`, v: `ASSERTED on the trip's own digital sample — this trip is what took the recloser to lockout. It was ${out.cyclingAtTrip ? 'mid-reclose-cycle' : 'not in lockout'} immediately before.` });
  else if (out.lockoutAssertedAfterTrip) obs.push({ k: `${bits.LO} after the trip`, v: 'ASSERTED — the recloser went to lockout within this record' });
  if (out.cycleStartedAfterTrip) obs.push({ k: `${bits.CY} after the trip`, v: out.lockoutAssertedAfterTrip
    ? 'ASSERTED — a reclose cycle did start, then collapsed to lockout inside this same record before any open interval could run'
    : 'ASSERTED — a reclose cycle started within this record; the open-interval timer is running' });
  else if (bits.CY && out.cyclingAtEnd) obs.push({ k: `${bits.CY} at end of record`, v: 'ASSERTED — a reclose cycle is in progress' });
  if (out.closedInRecord) obs.push({ k: `${bits.CLOSE} after the trip`, v: 'ASSERTED — a close command was actually issued inside this record' });
  else if (bits.CLOSE) obs.push({ k: `${bits.CLOSE} in this record`, v: `never asserts${bits.RCSF ? ` (nor does ${bits.RCSF})` : ''} — no close was issued or attempted anywhere in this record. Useful as negative evidence: a record that looks like a reclose is not one unless this bit moves.` });
  if (out.closeFailInRecord) obs.push({ k: `${bits.CF} after the trip`, v: 'ASSERTED — close failure' });
  if (bits.BKR) obs.push({ k: `${bits.BKR} at end of record`, v: stateAt(bits.BKR, endIdx).state ? 'closed' : 'open' });

  // ── Verdict ────────────────────────────────────────────────────────────────
  out.verdict = buildRecloseVerdict(out, gateResults, sch, P, A);
  // The shot schedule means two different things depending on the verdict: it's either what
  // is about to happen, or it's the sequence this device is capable of running that this
  // particular event isn't going to reach. The UI has to say which — a countdown to a close
  // that will never be issued is worse than no countdown at all.
  out.planIsLive = out.verdict.tone !== 'bad';
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// RESOLVING A HOLDING TERM DOWN TO WHAT WAS MEASURED
// ══════════════════════════════════════════════════════════════════════
// "Held by SV22T" names a bit. "Held by SV22T — 59YA3 is picked up because VAY measures
// 93.4 V sec (110.0% of VNOM), above its 91.72 V (108.0%) pickup" names the condition, and
// only the second tells anyone whether the hold is about to clear on its own. Resolution
// goes at most two levels deep — the term itself if it is a protection element, otherwise
// the SV it names, expanded to whichever of that SV's own terms are actually true. Deeper
// than that and the sentence stops being readable.

const RC_KIND_LABEL = {
  A: 'phase A', B: 'phase B', C: 'phase C',
  ab: 'Vab', bc: 'Vbc', ca: 'Vca',
  zero: '3V0 (zero-seq)', neg: 'V2 (neg-seq)', pos: 'V1 (pos-seq)',
  minPhase: 'lowest phase', maxPhase: 'highest phase', minPP: 'lowest phase-to-phase', maxPP: 'highest phase-to-phase',
};

// One protection element, evaluated at `idx` against the same per-sample series the waveform
// charts draw, with its pickup converted into the same secondary-volt basis.
function rcMeasuredForElement(P, A, element, idx) {
  const row = ((A && A.voltageRows) || []).find(r => r.element === element);
  const cd = A && A.cursorData;
  if (!row || !cd || !cd.voltage) return null;
  const term = row.term === 'Y' ? 'yTerminal' : 'zTerminal';
  const arr = cd.voltage[term] && cd.voltage[term][row.kind];
  if (!arr || !arr.length) return null;
  const i = Math.max(0, Math.min(arr.length - 1, idx | 0));
  const raw = arr[i] || 0;
  const secV = rawToSecondaryV(cd, raw, row.term === 'Y' ? cd.PTRY : cd.PTRZ);
  const vnom = cd.VNOM || 0;
  return {
    kind: 'element', element, term: row.term, quantity: RC_KIND_LABEL[row.kind] || row.kind,
    type: row.type, pickupSec: row.pickup, measuredSec: secV,
    pickupPct: vnom ? row.pickup / vnom * 100 : null,
    measuredPct: vnom ? secV / vnom * 100 : null,
    asserted: row.type === 'UV' ? secV < row.pickup : secV > row.pickup,
  };
}

// SELogic math comparisons ("(FREQ >= MV04) AND (FREQ <= MV05)") are not relay-word bits, so
// the boolean evaluator can only report them as unknown. They are, however, the most
// directly readable condition in the whole equation once the MV settings are substituted.
function rcMeasuredComparisons(P, A, equation, idx) {
  const out = [];
  const re = /([A-Z][A-Z0-9_]*)\s*(>=|<=|<>|>|<|=)\s*([A-Z0-9_.]+)/g;
  let m;
  while ((m = re.exec(String(equation || '').split('#')[0])) !== null) {
    const [, lhs, op, rhs] = m;
    let rhsVal = /^[\d.]+$/.test(rhs) ? parseFloat(rhs) : getSettingNum(P, [rhs]);
    if (rhsVal == null) continue;
    let measured = null, unit = '';
    if (lhs === 'FREQ') {
      const rows = P.analogData || [];
      const i = Math.max(0, Math.min(rows.length - 1, idx | 0));
      measured = rows[i] ? rows[i].FREQ : null;
      unit = ' Hz';
    }
    if (measured == null) continue;
    const holds = op === '>=' ? measured >= rhsVal : op === '<=' ? measured <= rhsVal
      : op === '>' ? measured > rhsVal : op === '<' ? measured < rhsVal
        : op === '=' ? measured === rhsVal : measured !== rhsVal;
    out.push({ kind: 'compare', text: `${lhs} ${op} ${rhs}`, lhs, op, rhs, rhsVal, measured, unit, holds });
  }
  return out;
}

// Expand one term of a reclose equation into the measured facts underneath it.
function rcResolveTerm(P, A, name, idx) {
  const direct = rcMeasuredForElement(P, A, name, idx);
  if (direct) return [direct];
  const m = /^SV(\d+)T?$/.exec(name || '');
  if (!m) return [];
  const sv = (P.svSettings || []).find(x => x.num === parseInt(m[1], 10));
  if (!sv || !sv.equation) return [];
  const found = [];
  const r = rcEvalEquation(P, sv.equation, idx);
  if (r && r.branches) {
    r.branches.forEach(b => {
      if (!b.value) return;
      b.leaves.forEach(l => {
        if (!l.effective || !l.known) return;
        const meas = rcMeasuredForElement(P, A, l.name, idx);
        if (meas) found.push(meas);
      });
    });
  }
  rcMeasuredComparisons(P, A, sv.equation, idx).forEach(c => found.push(c));
  // Dedupe — a three-phase element set reports one row per phase and they are all the same story.
  const seen = new Set();
  return found.filter(f => {
    const key = f.kind === 'element' ? f.element : f.text;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rcResolveTermText(P, A, name, idx) {
  const parts = rcResolveTerm(P, A, name, idx);
  if (!parts.length) return '';
  const say = (p) => {
    if (p.kind === 'compare') {
      return `${p.lhs} measures ${p.measured.toFixed(2)}${p.unit}, ${p.holds ? 'inside' : 'outside'} the ${p.op} ${p.rhs} (${p.rhsVal}${p.unit}) limit`;
    }
    const pct = p.measuredPct != null ? ` (${p.measuredPct.toFixed(1)}% of VNOM)` : '';
    const ppct = p.pickupPct != null ? ` (${p.pickupPct.toFixed(1)}%)` : '';
    return `${p.element} ${p.asserted ? 'is picked up' : 'is not picked up'} — ${p.term}-terminal ${p.quantity} measures ${p.measuredSec.toFixed(2)} V sec${pct}, ${p.asserted ? (p.type === 'UV' ? 'below' : 'above') : (p.type === 'UV' ? 'at or above' : 'at or below')} its ${p.pickupSec.toFixed(2)} V${ppct} pickup`;
  };
  // Asserted terms first — those are the ones doing the holding.
  const ordered = parts.slice().sort((a, b) => (b.asserted === true || b.holds === false ? 1 : 0) - (a.asserted === true || a.holds === false ? 1 : 0));
  return ordered.slice(0, 3).map(say).join('; ');
}

// Which term of the ER trigger equation put this record on the relay? On a device whose ER
// list carries supervision bits, the answer is routinely "none of the protection elements" —
// and saying so explicitly is what stops a supervision report being read as a reclose.
function rcIdentifyRecordTrigger(P, hasTrip) {
  const eq = P.settings && P.settings.EReq;
  if (!eq) return null;
  const clean = String(eq).split('#')[0].trim();
  const terms = (clean.match(/[A-Z][A-Z0-9_]*/g) || [])
    .filter(t => !/^(AND|OR|NOT|R_TRIG|F_TRIG)$/.test(t))
    .filter((v, i, a) => a.indexOf(v) === i);
  const known = terms.filter(t => (P.digitalLabels || []).includes(t));
  // The trigger is whichever ER term asserts inside the record. Prefer the earliest such
  // assertion; a record usually contains exactly one.
  let best = null;
  for (const tr of (P.digitalTransitions || [])) {
    for (const c of (tr.changes || [])) {
      if (!c.asserted || !known.includes(c.label)) continue;
      if (!best || tr.analogSampleIdx < best.idx) best = { term: c.label, idx: tr.analogSampleIdx };
    }
  }
  const freq = (P.eventInfo && P.eventInfo.freq) || 60;
  const spc = (P.eventInfo && P.eventInfo.samPerCycA) || 32;
  return {
    equation: clean,
    terms: known,
    term: best ? best.term : null,
    msAfterStart: best ? best.idx * (1000 / (freq * spc)) : null,
    isTrip: !!(best && /^TRIP/.test(best.term)) || hasTrip,
  };
}

// The site's own words for an SV, when they wrote any — "SV06T" means nothing to a reader,
// "SV06T (OPEN TAVRIDA)" means everything. Falls back to the bare name.
function rcGloss(P, name) {
  const m = /^SV(\d+)T?$/.exec(name || '');
  if (!m) return name;
  const sv = (P.svSettings || []).find(x => x.num === parseInt(m[1], 10));
  if (!sv || !sv.equation || !sv.equation.includes('#')) return name;
  const c = sv.equation.split('#').slice(1).join('#').trim();
  return c ? `${name} (${c.toLowerCase()})` : name;
}
// Same, applied to every SV name inside a rendered branch expression.
function rcGlossText(P, text) {
  return (text || '').replace(/\bSV\d+T?\b/g, m => rcGloss(P, m));
}

// Explains, in one sentence, why an equation came out false — naming the terms rather than
// making the reader diff the equation against the bit list themselves.
function describeWhyFalse(res) {
  if (!res || !res.branches || !res.branches.length) return '';
  // For a single-branch (pure AND) equation, name the operands that are not satisfied.
  if (res.branches.length === 1) {
    const bad = res.branches[0].leaves.filter(l => !l.effective);
    if (!bad.length) return '';
    return `Held down by ${bad.map(l => `${l.negated ? 'NOT ' : ''}${l.name}${l.negated ? ' (it IS asserted)' : ' (not asserted)'}`).join(' and ')}.`;
  }
  // For an OR of branches, none of them is true — say so compactly.
  return `None of its ${res.branches.length} alternative terms is satisfied.`;
}

function describeWhyTrue(res) {
  if (!res || !res.branches || !res.branches.length) return '';
  const t = res.branches.find(b => b.value);
  return t ? `Satisfied via ${t.text}.` : '';
}

// Absolute wall-clock of the trip instant, so projected close times can be given as real
// times of day rather than only as "+60 s". Returns null when the record has no timestamp.
function eventClockMsAtTrip(P, tripIdx, msPerSample) {
  const ts = P.timestamp || P.eventTimestamp || (P.eventInfo && P.eventInfo.timestamp) || null;
  if (!ts) return null;
  const base = getTimestampMs(ts);
  if (base == null || isNaN(base)) return null;
  const trigIdx = (P.triggerSampleIndex != null && P.triggerSampleIndex >= 0) ? P.triggerSampleIndex : 0;
  return base + (tripIdx - trigIdx) * msPerSample;
}

function formatClockOffset(baseMs, offsetMs) {
  try {
    const d = new Date(baseMs + offsetMs);
    if (isNaN(d.getTime())) return null;
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch (e) { return null; }
}

function formatDuration(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${sec % 1 === 0 ? sec : sec.toFixed(2)} s`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${sec % 1 === 0 ? sec : sec.toFixed(1)} s (${m} min${s ? ` ${s} s` : ''})`;
}

// Collapses the gate-by-gate result into the single sentence that goes at the top of the tab
// and in the banner. Ordered by decisiveness: an element that's switched off beats a blocked
// initiate, which beats a lockout drive, which beats a pending supervision.
function buildRecloseVerdict(out, gr, sch, P, A) {
  const V = (kind, tone, headline, detail, extra) => Object.assign({ kind, tone, headline, detail }, extra || {});

  if (out.enabled === false) {
    return V('disabled', 'bad', 'Will NOT auto-close — reclosing is disabled',
      `The reclosing element is switched off on this device (E79 := ${sch.E79raw}). No automatic close will be attempted after this trip, or after any trip. The recloser stays open until somebody closes it — front-panel pushbutton, SCADA, or a field visit.`);
  }

  const recoveryNote = sch.resetFromLockoutDelay != null
    ? ` Automatic reclosing does not resume until the device is closed manually and stays closed for ${formatDuration(sch.resetFromLockoutDelay)} (79RSLD).`
    : ' Automatic reclosing does not resume until the device is closed manually.';

  // No trip in this record at all. Everything the 79 element is doing here was decided by an
  // EARLIER record, and the gates below — all of which are phrased around "this trip" — are
  // answering a question this file does not pose. Report the carried-in state instead, and
  // say what actually put the record on the relay.
  if (out.hasTrip === false) {
    const trg = out.recordTrigger;
    const why = trg && trg.term
      ? ` This record was triggered by ${rcGloss(P, trg.term)} out of the ER equation${trg.msAfterStart != null ? `, ${trg.msAfterStart.toFixed(0)} ms in` : ''} — a supervision/status term, not a trip and not a close.`
      : '';
    const closeNote = out.bits.CLOSE && !out.closedInRecord
      ? ` ${out.bits.CLOSE} never asserts anywhere in this record, so no close was issued or attempted here.`
      : '';
    if (out.inLockoutAtEnd) {
      return V('carried-lockout', 'bad', 'No trip in this record — the recloser is in lockout, carried in from an earlier event',
        `${out.bits.LO} is asserted for the whole record and nothing in this file changes it.${recoveryNote}${why}${closeNote}`);
    }
    if (out.cyclingAtEnd) {
      const stallNote = out.stalledAtEnd && out.stallHoldersDurable.length
        ? ` The open-interval timer is stalled: ${out.gates.find(g => g.key === 'STL')?.sel || '79STL'} is held up by ${out.stallHoldersDurable.map(h => `${h.negated ? 'NOT ' : ''}${rcGloss(P, h.name)}`).join(' and ')}, so the countdown to the close is frozen rather than running.`
        : '';
      return V('carried-cycle', 'warn', 'No trip in this record — a reclose cycle started by an earlier event is still running',
        `${out.bits.CY} is asserted throughout, with the shot counter at SH${out.shotAtEnd != null ? out.shotAtEnd : out.shotAtTrip}. The sequence was initiated before this record begins, so nothing here starts or stops it.${stallNote}${why}${closeNote}`);
    }
    return V('carried-state', 'unknown', 'No trip in this record — nothing here starts or ends a reclose sequence',
      `${out.tripLabel || 'The trip bit'} never asserts in this file, so the 79 states shown are carried in from a previous event.${why}${closeNote}`);
  }

  if (out.inLockoutAtTrip) {
    return V('already-lockout', 'bad', 'Will NOT auto-close — already in lockout before this trip',
      `${out.bits.LO} was already asserted on the digital sample before this trip, so the recloser was in lockout going in.${recoveryNote}`);
  }

  const recovery = sch.resetFromLockoutDelay != null
    ? ` Once it is closed manually, the breaker has to stay closed for ${formatDuration(sch.resetFromLockoutDelay)} (79RSLD) before automatic reclosing is armed again.`
    : '';

  const dtl = out.gates.find(g => g.key === 'DTL');
  if (dtl && dtl.status === 'blocked') {
    return V('lockout', 'bad', 'Will NOT auto-close — this trip drives it to lockout',
      `${dtl.summary} The breaker stays open until it is closed manually.${recovery}`);
  }

  if (out.lockoutAssertedAfterTrip) {
    // Distinguish "this trip did it" from "it happened somewhere in the record", and, when the
    // shot counter moved at the same time with no drive-to-lockout term asserted, say which
    // structural limit was hit. A trip arriving while the breaker is ALREADY open — during an
    // open interval — advances the counter without any close having been issued, and on a
    // scheme whose next open interval is OFF that single step is the whole lockout.
    const advanced = out.shotAtEnd != null && out.shotAtTrip != null && out.shotAtEnd > out.shotAtTrip;
    const bkrWasOpen = out.breakerOpenBeforeTrip === true;
    let mechanism = '';
    if (advanced && dtl && dtl.status !== 'blocked') {
      mechanism = ` The shot counter stepped SH${out.shotAtTrip} → SH${out.shotAtEnd} on the same event without any close being issued`
        + (bkrWasOpen ? ', because the trip arrived while the interrupter was already open — mid open interval, so there was no close for the counter to be counting' : '')
        + '. '
        + (out.shotsCappedByOI
          ? `With 79OI${out.shotAtEnd + 1} := OFF there is no open interval for shot ${out.shotAtEnd + 1} to time, so the step lands directly in lockout. ${out.gates.find(g => g.key === 'DTL')?.sel || '79DTL'} did not assert — this is the sequence running out, not a drive-to-lockout.`
          : `${out.gates.find(g => g.key === 'DTL')?.sel || '79DTL'} did not assert, so this is the sequence advancing to its end rather than a drive-to-lockout.`);
    }
    return V('lockout', 'bad',
      out.lockoutCausedByThisTrip
        ? 'Will NOT auto-close — this trip took the recloser to lockout'
        : 'Will NOT auto-close — the recloser went to lockout in this record',
      `${out.bits.LO} asserts ${out.lockoutCausedByThisTrip ? 'on the trip’s own digital sample' : 'after the trip'} inside this record${out.cyclingAtTrip ? `, out of an in-progress reclose cycle (${out.bits.CY} was asserted going in)` : ''}.${mechanism} Whatever the settings allow in principle, this particular event ended in lockout.${recovery}`);
  }

  const ri = out.gates.find(g => g.key === 'RI');
  if (ri && ri.status === 'blocked') {
    return V('no-initiate', 'bad', 'Will NOT auto-close — this trip does not initiate a reclose',
      `${ri.summary} The reclose element stays in Reset with the breaker open; it is not counting toward a close.`);
  }
  const ris = out.gates.find(g => g.key === 'RIS');
  if (ris && ris.status === 'blocked') {
    return V('no-initiate', 'bad', 'Will NOT auto-close — initiate supervision rejected it',
      ris.summary);
  }

  if (out.attemptsRemaining === 0 && out.shotKnown && out.shots) {
    return V('exhausted', 'bad', 'Will NOT auto-close — all reclose attempts already used',
      `The shot counter was already at SH${out.shotAtTrip} of ${out.shots} when this trip occurred, so there is no attempt left in the sequence. This trip takes the recloser to lockout.`);
  }

  // The open-interval timer is frozen. Everything downstream — the shot schedule, the clock
  // time the banner would otherwise quote — assumes a countdown that is not counting. This
  // branch has to sit ahead of the close-supervision branches: supervision decides whether a
  // close goes out WHEN the interval expires, and a stalled interval never expires, so
  // reporting the supervision state as the headline answer buries the real one.
  if (out.stallBlocksSchedule) {
    const stl = out.gates.find(g => g.key === 'STL');
    const holders = out.stallHoldersDurable.map(h => `${h.negated ? 'NOT ' : ''}${rcGloss(P, h.name)}`).join(' and ');
    const resolved = out.stallHoldersDurable
      .map(h => rcResolveTermText(P, A, h.name, out.endIdx))
      .filter(Boolean).join('; ');
    const oi = out.plan[0];
    return V('stalled', 'warn', 'Will NOT auto-close on schedule — the open-interval timer is stalled',
      `${stl ? stl.sel : '79STL'} is asserted at the end of the record via ${holders}, which freezes the open-interval countdown. `
      + (oi && oi.openIntervalSec != null
        ? `${oi.setting} = ${formatDuration(oi.openIntervalSec)}, but that clock is not running — the close is not "due" at any particular time, and no wall-clock estimate is quoted for it. `
        : '')
      + (resolved ? `What is holding it: ${resolved}. ` : '')
      + `The recloser sits in ${out.bits.CY || '79CY'} with the interrupter open for as long as this holds`
      + (sch.closeSupLimitOff ? ' — and with 79CLSD := OFF there is no time limit that would eventually convert the wait into a lockout.' : '.')
      + (out.stallHoldersDurable.length && out.recordTrigger && out.recordTrigger.isTrip
        ? ' If the same condition also caused the trip, expect the stall to persist as long as the trip cause does.' : ''));
  }

  // From here the sequence is running. The only question left is what the close waits on.
  const cls = out.gates.find(g => g.key === 'CLS');
  const next = out.plan[0];
  const whenText = next
    ? `Attempt ${next.shot} of ${out.shots} is due ${next.openIntervalSec != null ? `${formatDuration(next.openIntervalSec)} after the trip${next.clock ? ` — about ${next.clock}` : ''}` : 'after its open interval'} (${next.setting}).`
    : '';
  const remainText = out.attemptsRemaining
    ? `${out.attemptsRemaining} attempt${out.attemptsRemaining === 1 ? '' : 's'} remaining of ${out.shots}.`
    : '';

  if (cls && cls.pass === false) {
    const resolvedHold = (cls.heldBy || [])
      .map(l => rcResolveTermText(P, A, l.name, out.endIdx))
      .filter(Boolean).join('; ');
    const held = (cls.heldBy || []).length
      ? ` It is currently held down by ${cls.heldBy.map(l => `${l.negated ? 'NOT ' : ''}${rcGloss(P, l.name)}`).join(' and ')}.${resolvedHold ? ` Underneath that: ${resolvedHold}.` : ''}`
      : '';
    return V('armed-held', 'warn', 'Will attempt to auto-close — but the close is currently held by supervision',
      `${whenText} ${remainText} Close supervision (${cls.sel}) was not satisfied when this record ended, and the close is not issued until it is — the open interval expiring is not enough on its own.${held} Whether the close actually goes out depends on line conditions after this record, which it cannot see.`);
  }
  if (cls && cls.pass === true && cls.equation) {
    return V('armed', 'ok', 'Will auto-close',
      `${whenText} ${remainText} Close supervision (${cls.sel}) was satisfied at the end of this record; assuming line conditions hold, the close goes out when the open interval expires.`);
  }
  if (cls && cls.pass === true && !cls.equation) {
    return V('armed', 'ok', 'Will auto-close',
      `${whenText} ${remainText} No close-supervision permissive is configured, so the close is issued the moment the open interval expires — there is no line condition for it to wait on.`);
  }
  if (out.enabled === true) {
    return V('armed', 'ok', 'Will auto-close',
      `${whenText} ${remainText} No close-supervision permissive stands in the way.`);
  }
  return V('unknown', 'unknown', 'Reclose behaviour could not be determined',
    'This file does not carry enough of the reclosing settings block to say what the recloser will do next.');
}

// ══════════════════════════════════════════════════════════════════════
// RECLOSING TAB — RENDERING
// ══════════════════════════════════════════════════════════════════════
// Answers, in order: will it come back by itself, when, how many times, and what has to be
// true on the line before each attempt actually closes. The ordering is deliberate — the
// verdict first, because that's the only thing some readers need, then the conditions that
// produced it, then the schedule, then the reference material.

const RC_TONE = {
  bad:     { color: 'var(--red)',    bg: 'var(--red-dim)',    border: '#5c1414', icon: '⛔' },
  warn:    { color: 'var(--yellow)', bg: 'var(--yellow-dim)', border: '#5c4506', icon: '⏳' },
  ok:      { color: 'var(--green)',  bg: 'var(--green-dim)',  border: '#0a3d2a', icon: '🔄' },
  unknown: { color: 'var(--accent)', bg: 'var(--accent-dim)', border: '#123a5c', icon: '❔' },
};

const RC_STATUS = {
  settled: { label: 'MET',      color: 'var(--green)',     bg: 'var(--green-dim)',  border: '#0a3d2a' },
  blocked: { label: 'BLOCKING', color: 'var(--red)',       bg: 'var(--red-dim)',    border: '#5c1414' },
  pending: { label: 'PENDING',  color: 'var(--yellow)',    bg: 'var(--yellow-dim)', border: '#5c4506' },
  unknown: { label: 'UNKNOWN',  color: 'var(--text-dim)',  bg: 'transparent',       border: 'var(--card-border)' },
};

function rcStatusPill(status) {
  const s = RC_STATUS[status] || RC_STATUS.unknown;
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:0.06em;color:${s.color};background:${s.bg};border:1px solid ${s.border};white-space:nowrap;">${s.label}</span>`;
}

// One live term of a reclose equation: name, whether it's used inverted, and what it was
// actually doing in this record. Green = this term is helping the equation be true.
function rcLeafChip(leaf, P) {
  const good = leaf.effective;
  const color = !leaf.known ? 'var(--text-muted)' : (good ? 'var(--green)' : 'var(--red)');
  const bg = !leaf.known ? 'transparent' : (good ? 'var(--green-dim)' : 'var(--red-dim)');
  const mark = !leaf.known ? '?' : (good ? '✓' : '✕');
  const stateWord = !leaf.known ? 'not in this record' : (leaf.state ? 'asserted' : 'not asserted');
  return `<span title="${escapeAttr(`${leaf.name} is ${stateWord}${leaf.negated ? ' — and this term uses NOT, so it needs the bit LOW' : ''}`)}"
    style="display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:4px;font-family:var(--mono);font-size:11px;color:${color};background:${bg};border:1px solid ${color}33;margin:2px 4px 2px 0;">
    ${leaf.negated ? '<span style="opacity:0.75">NOT</span> ' : ''}${leaf.name} <span style="font-weight:700">${mark}</span></span>`;
}

function buildRecloseGateRows(RC, P) {
  return RC.gates.map(g => {
    const ev = g.evaluation;
    const leaves = [];
    if (ev && ev.branches) ev.branches.forEach(b => b.leaves.forEach(l => leaves.push(l)));
    // De-duplicate: the same bit can appear in more than one branch and only needs showing once.
    const seen = new Set();
    const uniqLeaves = leaves.filter(l => { const k = l.name + '|' + l.negated; if (seen.has(k)) return false; seen.add(k); return true; });
    return `<tr>
      <td style="white-space:nowrap;vertical-align:top;padding-top:12px;">${rcStatusPill(g.status)}</td>
      <td style="vertical-align:top;">
        <div style="font-weight:700;color:var(--text);font-size:12.5px;">${g.title}
          ${g.sel ? `<span style="font-family:var(--mono);font-size:11px;color:var(--accent);font-weight:500;margin-left:6px;">${g.sel}</span>` : ''}</div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-top:3px;line-height:1.5;">${g.what || ''}</div>
        ${g.equation ? `<div class="code-block" style="margin-top:7px;font-size:11px;padding:7px 10px;">${linkifyEquationBits(g.equation.split('#')[0].trim(), P)}${g.equation.includes('#') ? ` <span class="sv-comment" style="color:var(--text-muted)"># ${g.equation.split('#').slice(1).join('#').trim()}</span>` : ''}</div>` : ''}
        <div style="font-size:12px;color:var(--text-dim);margin-top:7px;line-height:1.55;">${g.summary || ''}</div>
        ${uniqLeaves.length ? `<div style="margin-top:6px;">${uniqLeaves.map(l => rcLeafChip(l, P)).join('')}</div>` : ''}
      </td>
    </tr>`;
  }).join('');
}

function buildReclosePlanTable(RC, P) {
  if (!RC.plan.length) return '';
  const rows = RC.plan.map(s => `<tr>
    <td style="font-weight:700;color:var(--text);white-space:nowrap;">Attempt ${s.shot}<span style="color:var(--text-muted);font-weight:400"> of ${RC.shots}</span></td>
    <td style="font-family:var(--mono);color:var(--accent);white-space:nowrap;">${s.setting}</td>
    <td style="white-space:nowrap;">${s.openIntervalSec != null ? formatDuration(s.openIntervalSec) : (s.openIntervalRaw === 'OFF' ? 'OFF' : '—')}</td>
    <td style="white-space:nowrap;">${s.cumulativeSec != null ? formatDuration(s.cumulativeSec) : '—'}</td>
    <td style="white-space:nowrap;font-family:var(--mono);">${s.clock || '—'}</td>
    <td>${s.supervised ? `held until ${RC.gates.find(g => g.key === 'CLS')?.sel || '79CLS'} is satisfied` : 'issued as soon as the interval expires'}</td>
  </tr>`).join('');
  const live = RC.planIsLive;
  return `<div class="card ${live ? 'blue-accent' : ''}"><div class="card-header">📅 ${live ? 'Reclose Sequence — What Happens Next' : 'Reclose Sequence as Configured — Not Running for This Event'}</div>
    ${live ? '' : `<div style="background:var(--red-dim);border:1px solid #5c1414;border-radius:6px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:var(--text-dim);line-height:1.55;">
      <b style="color:var(--red)">None of the attempts below will be made for this trip.</b> ${RC.verdict.headline.replace(/^Will NOT auto-close — /, 'Reason: ')}. The schedule is shown because it is what this device would do on a trip that <em>does</em> initiate a reclose — useful for judging whether the block was the right outcome.
    </div>`}
    <p style="font-size:12px;color:var(--text-dim);margin-bottom:12px;line-height:1.6;">
      ${RC.shotKnown
        ? `The shot counter was at <b style="color:var(--text)">SH${RC.shotAtTrip}</b> when this trip occurred, so the sequence resumes at attempt ${RC.startShot + 1}.`
        : `No shot-counter bit (SH0…SH4) is carried in this record, so the sequence below is shown from the start — if the recloser had already used attempts before this trip, the remaining count is smaller than shown.`}
      "Time after trip" is cumulative and assumes the worst case: every close is followed immediately by another trip, so the intervals stack. If any close holds, the sequence stops there and the reset timer takes over.
    </p>
    <div class="table-scroll"><table class="data-table"><thead><tr>
      <th>Attempt</th><th>Setting</th><th>Open interval</th><th>Time after trip</th><th>Approx. clock</th><th>Close is…</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
    <div style="margin-top:10px;padding:10px 12px;background:var(--red-dim);border:1px solid #5c1414;border-radius:6px;font-size:12px;color:var(--text-dim);line-height:1.55;">
      <b style="color:var(--red)">After attempt ${RC.shots}:</b> if the fault is still there and the device trips again, the shot counter is exhausted and the recloser goes to <b style="color:var(--red)">lockout</b> — it stays open until somebody closes it.
    </div>
    ${RC.tripClockMs != null ? `<div style="margin-top:8px;font-size:11px;color:var(--text-muted)">Clock times are derived from this record's own timestamp plus the open intervals, so they're approximate — anything that stalls the open-interval timer or holds close supervision pushes them later.</div>` : ''}
  </div>`;
}

function buildRecloseSchemeCard(RC, P) {
  const sch = RC.scheme;
  const rows = [];
  rows.push(['E79', sch.E79raw ?? '—', 'Reclosing enable / number of shots']);
  sch.openIntervals.forEach((v, i) => {
    if (v == null) return;
    rows.push([`79OI${i + 1}`, typeof v === 'number' ? formatDuration(v) : String(v), `Open interval before reclose attempt ${i + 1}`]);
  });
  if (sch.resetDelay != null) rows.push(['79RSD', formatDuration(sch.resetDelay), 'Reset time from Cycle — how long the breaker must stay closed after a reclose before the shot counter clears back to zero']);
  if (sch.resetFromLockoutDelay != null) rows.push(['79RSLD', formatDuration(sch.resetFromLockoutDelay), 'Reset time from Lockout — how long the breaker must stay closed after a manual close before automatic reclosing is armed again']);
  if (sch.closeSupLimitOff) rows.push(['79CLSD', 'OFF', 'Close supervision limit — OFF, so the recloser waits indefinitely for close supervision instead of locking out']);
  else if (sch.closeSupLimit != null) rows.push(['79CLSD', formatDuration(sch.closeSupLimit), 'Close supervision limit — if supervision is not satisfied within this time after the open interval expires, the recloser goes to lockout']);

  const eqRows = RECLOSE_EQ_SPECS.filter(s => sch.eq && sch.eq[s.key]).map(s => `<tr>
      <td style="font-family:var(--mono);color:var(--accent);white-space:nowrap;vertical-align:top;">${sch.eqName[s.key]}</td>
      <td style="vertical-align:top;">
        <div style="font-weight:600;color:var(--text);font-size:12px;">${s.title}</div>
        <div class="code-block" style="margin:5px 0 0;font-size:11px;padding:6px 9px;">${linkifyEquationBits(sch.eq[s.key].split('#')[0].trim(), P)}${sch.eq[s.key].includes('#') ? ` <span style="color:var(--text-muted)"># ${sch.eq[s.key].split('#').slice(1).join('#').trim()}</span>` : ''}</div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-top:5px;line-height:1.5;">${s.what}</div>
      </td></tr>`).join('');

  return `<div class="card"><div class="card-header">⚙️ Reclosing Scheme as Configured</div>
    <p style="font-size:12px;color:var(--text-dim);margin-bottom:12px;">Decoded from this file's own settings block — the complete ANSI 79 configuration on this device, independent of what happened in this particular event.</p>
    ${rows.length ? `<table class="data-table"><thead><tr><th>Setting</th><th>Value</th><th>What it controls</th></tr></thead><tbody>
      ${rows.map(([k, v, d]) => `<tr><td style="color:var(--accent);font-family:var(--mono);white-space:nowrap;">${k}</td><td style="white-space:nowrap;font-weight:600;">${v}</td><td style="font-family:var(--sans);color:var(--text-dim)">${d}</td></tr>`).join('')}
    </tbody></table>` : '<p style="color:var(--text-dim);font-size:12.5px;">No numeric 79 settings found in this file.</p>'}
    ${eqRows ? `<div style="margin-top:18px;font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--text);margin-bottom:8px;">Reclose Control Equations</div>
      <table class="data-table"><tbody>${eqRows}</tbody></table>` : ''}
  </div>`;
}

function buildRecloseEndCard(RC, P) {
  const reset = RC.reset || {};
  const hasReset = reset.fromCycleSec != null || reset.fromLockoutSec != null || reset.blockedBy;
  if (!RC.lockoutPaths.length && !hasReset && !RC.notes.length) return '';
  return `<div class="card yellow-accent"><div class="card-header">🔚 How the Sequence Ends</div>
    ${RC.lockoutPaths.length ? `<div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--red);margin-bottom:8px;">Every path to lockout</div>
      ${RC.lockoutPaths.map(p => `<div style="background:var(--red-dim);border:1px solid #5c1414;border-radius:6px;padding:10px 12px;margin-bottom:7px;">
        <div style="font-size:12.5px;font-weight:700;color:var(--red);margin-bottom:3px;">${p.title}</div>
        <div style="font-size:12px;color:var(--text-dim);line-height:1.55;">${p.detail}</div></div>`).join('')}` : ''}
    ${hasReset ? `<div style="font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--green);margin:16px 0 8px;">Returning to normal</div>
      <div style="background:var(--green-dim);border:1px solid #0a3d2a;border-radius:6px;padding:10px 12px;font-size:12px;color:var(--text-dim);line-height:1.6;">
        ${reset.fromCycleSec != null ? `<div><b style="color:var(--green)">After a successful reclose:</b> the breaker must stay closed for <b style="color:var(--text)">${formatDuration(reset.fromCycleSec)}</b> (79RSD) before the shot counter clears back to SH0 and the full set of attempts is available again. A trip inside that window continues the same sequence at the next shot instead of starting over.</div>` : ''}
        ${reset.fromLockoutSec != null ? `<div style="margin-top:7px;"><b style="color:var(--green)">After a manual close out of lockout:</b> the breaker must stay closed for <b style="color:var(--text)">${formatDuration(reset.fromLockoutSec)}</b> (79RSLD) before automatic reclosing is armed again.</div>` : ''}
        ${reset.blockedBy ? `<div style="margin-top:7px;"><b style="color:var(--yellow)">Reset can be held off:</b> <span style="font-family:var(--mono)">${reset.blockedBy.sel}</span> := <span style="font-family:var(--mono)">${reset.blockedBy.eq.split('#')[0].trim()}</span> blocks the reset timer while asserted, keeping the shot counter where it is.</div>` : ''}
      </div>` : ''}
    ${RC.notes.length ? RC.notes.map(n => `<div style="margin-top:12px;padding:10px 12px;background:var(--yellow-dim);border:1px solid #5c4506;border-radius:6px;font-size:12px;color:var(--text-dim);line-height:1.55;">${n}</div>`).join('') : ''}
  </div>`;
}

function buildRecloseObservedCard(RC, P) {
  if (!RC.observed.length) return '';
  return `<div class="card"><div class="card-header">👁️ What This Record Actually Shows</div>
    <p style="font-size:12px;color:var(--text-dim);margin-bottom:10px;">The 79 relay-word bits as recorded — the device's own account of where it was in the sequence, as distinct from what the settings say it should do.</p>
    <table class="data-table"><tbody>
      ${RC.observed.map(o => `<tr><td style="font-weight:600;color:var(--text);white-space:nowrap;font-family:var(--mono);font-size:11.5px;">${o.k}</td><td>${o.v}</td></tr>`).join('')}
    </tbody></table>
    <div style="margin-top:10px;font-size:11px;color:var(--text-muted);line-height:1.5;">
      This record covers ${(RC.recordEndMsAfterTrip / 1000).toFixed(2)} s after the trip. Open intervals on this device are measured in tens to hundreds of seconds, so the close itself happens long after the last sample here — the sequence above is projected from the settings, not observed.
    </div>
  </div>`;
}

function buildRecloseTabHTML(P, A) {
  const RC = A && A.reclose;
  if (!RC) return `<div class="card"><div class="card-header">🔄 Automatic Reclosing</div>
    <p style="color:var(--text-dim);font-size:13px;">No reclosing analysis available for this record.</p></div>`;

  const v = RC.verdict || {};
  const tone = RC_TONE[v.tone] || RC_TONE.unknown;

  const glance = [];
  if (RC.enabled === true && RC.shots) glance.push(['Shots configured', `${RC.shots}`]);
  if (RC.enabled === false) glance.push(['Reclosing', 'Disabled (E79 off)']);
  if (RC.shotKnown) glance.push(['Shot at trip', `SH${RC.shotAtTrip}`]);
  if (RC.enabled === true) glance.push([RC.planIsLive ? 'Attempts remaining' : 'Attempts this event', RC.planIsLive ? `${RC.attemptsRemaining}` : '0']);
  if (RC.stallBlocksSchedule) glance.push(['Open-interval timer', 'STALLED — not counting']);
  else if (RC.planIsLive && RC.plan.length && RC.plan[0].openIntervalSec != null) glance.push(['Next attempt in', formatDuration(RC.plan[0].openIntervalSec)]);
  if (RC.shotsCappedByOI) glance.push(['E79 vs 79OI', `E79 := ${RC.scheme?.E79raw} but only ${RC.usableShots} interval${RC.usableShots === 1 ? '' : 's'} set`]);
  const totalSec = RC.plan.length ? RC.plan[RC.plan.length - 1].cumulativeSec : null;
  if (totalSec != null && RC.plan.length > 1) glance.push([RC.planIsLive ? 'Full sequence spans' : 'Configured sequence spans', formatDuration(totalSec)]);

  const verdictCard = `<div class="card" style="border-top:3px solid ${tone.color};">
    <div style="display:flex;align-items:flex-start;gap:12px;">
      <div style="font-size:26px;line-height:1;">${tone.icon}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--text-muted);margin-bottom:4px;">Automatic Reclosing — Verdict</div>
        <div style="font-size:17px;font-weight:700;color:${tone.color};line-height:1.35;">${v.headline || ''}</div>
        <p style="font-size:13px;color:var(--text-dim);line-height:1.65;margin-top:8px;">${v.detail || ''}</p>
      </div>
    </div>
    ${glance.length ? `<div class="trip-timing" style="margin-top:14px;">${glance.map(([k, val]) =>
      `<div class="timing-chip"><span class="label">${k}:</span> <span class="value">${val}</span></div>`).join('')}</div>` : ''}
  </div>`;

  const gateCard = RC.gates.length ? `<div class="card red-accent"><div class="card-header">✅ Conditions That Decide the Auto-Close</div>
    <p style="font-size:12px;color:var(--text-dim);margin-bottom:6px;line-height:1.6;">
      Every gate the relay's own reclose logic puts between this trip and a close command, evaluated against the digital states in this record.
    </p>
    <div class="tab-legend" style="margin-bottom:12px;">
      <span>${rcStatusPill('settled')} decided by this record — condition satisfied</span>
      <span>${rcStatusPill('blocked')} decided by this record — this is what stops the close</span>
      <span>${rcStatusPill('pending')} checked after the record ends; the state shown is an indication, not the answer</span>
      <span>${rcStatusPill('unknown')} references bits this file doesn't carry</span>
    </div>
    <table class="data-table"><tbody>${buildRecloseGateRows(RC, P)}</tbody></table>
  </div>` : '';

  return verdictCard + buildRecloseSequenceCard() + gateCard + buildReclosePlanTable(RC, P) + buildRecloseEndCard(RC, P)
    + buildRecloseObservedCard(RC, P) + buildRecloseSchemeCard(RC, P);
}

// ══════════════════════════════════════════════════════════════════════
// CROSS-EVENT RECLOSE SEQUENCE
// ══════════════════════════════════════════════════════════════════════
// A reclose sequence is measured in minutes and an event record lasts half a second, so the
// interesting part of the sequence happens BETWEEN records — and every per-record card in
// this tab is, by construction, blind to it. Three questions can only be answered by looking
// at the loaded set as a set, and all three came up on a real investigation:
//
//   1. "Why is there no event for the reclose?" — answerable only if you can prove no record
//      is MISSING. Relay event numbers are consecutive, so a gap-free run of REF_NUMs is
//      positive evidence that the relay generated nothing in between, as opposed to something
//      having been generated and not downloaded.
//   2. "What happened to the close that was due?" — the previous record's open interval lands
//      somewhere in the gap before the next record, so the two have to be read together.
//   3. "These are hours apart, but the file names say otherwise." — file-name stamps are
//      collection times. Reasoning about reclose timing from them gives wrong answers, and
//      the discrepancy is invisible unless the two are put side by side.

function rcFileNameStampMs(fileName) {
  // "…TRIP 8_24_2026 17_17_17 …" — tolerant of the run-together form the download produces.
  const m = /(\d{1,2})_(\d{1,2})_(\d{4})[^0-9]{0,3}(\d{1,2})_(\d{2})_(\d{2})/.exec(fileName || '');
  if (!m) return null;
  const [, mo, d, y, h, mi, s] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23) return null;
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

function rcFmtGap(ms) {
  if (ms == null) return '—';
  const s = Math.abs(ms) / 1000;
  if (s < 1) return `${Math.round(Math.abs(ms))} ms`;
  if (s < 90) return `${s.toFixed(3)} s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.round(s % 60);
  return h ? `${h} h ${m} m ${sec} s` : `${m} m ${sec} s`;
}

function buildRecloseSequenceCard() {
  const evts = (typeof ALL_EVENTS !== 'undefined' ? ALL_EVENTS : []).filter(e => e && e.analysis && e.analysis.reclose);
  if (evts.length < 2) return '';

  const rows = evts.map((e, i) => {
    const P = e.parsed, RC = e.analysis.reclose;
    const ts = P.timestamp;
    const ms = getTimestampMs(ts);
    const st = (b) => (b ? 'yes' : '');
    const shotIn = RC.shotAtTrip, shotOut = RC.shotAtEnd != null ? RC.shotAtEnd : RC.shotAtTrip;
    const stateOut = RC.inLockoutAtEnd ? 'LOCKOUT' : (RC.cyclingAtEnd ? 'CYCLE' : (RC.resetAtTrip ? 'RESET' : '—'));
    return {
      i, idx: i, fileName: e.fileName,
      ref: (P.eventInfo && P.eventInfo.refNum) || '—',
      type: (P.eventInfo && P.eventInfo.eventType) || '—',
      ms,
      clock: ts ? `${String(ts.hour).padStart(2, '0')}:${String(ts.min).padStart(2, '0')}:${String(ts.sec).padStart(2, '0')}.${String(ts.msec).padStart(3, '0')}` : '—',
      fileMs: rcFileNameStampMs(e.fileName),
      hasTrip: RC.hasTrip,
      trigger: RC.recordTrigger && RC.recordTrigger.term,
      shotIn, shotOut, stateOut,
      closed: RC.closedInRecord,
      openInterval: RC.plan && RC.plan[0] ? RC.plan[0].openIntervalSec : null,
      stalled: RC.stallBlocksSchedule,
      verdictKind: RC.verdict && RC.verdict.kind,
      verdictTone: RC.verdict && RC.verdict.tone,
      RC, P, st,
    };
  }).sort((a, b) => (a.ms || 0) - (b.ms || 0));

  // ── REF_NUM continuity ──
  const refs = rows.map(r => parseInt(r.ref, 10)).filter(n => Number.isFinite(n));
  let continuityNote = '';
  if (refs.length === rows.length && refs.length > 1) {
    const sorted = refs.slice().sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] > 1) gaps.push([sorted[i - 1], sorted[i]]);
    }
    continuityNote = gaps.length
      ? `<div class="evt-pattern-note" style="border-left-color:var(--warn,#d79b28);">⚠ Event numbers are <b>not</b> consecutive: ${gaps.map(([a, b]) => `${b - a - 1} record${b - a - 1 === 1 ? '' : 's'} missing between ${a} and ${b}`).join('; ')}. Anything that happened in those gaps — including a close — is not represented here, so absence of evidence is not evidence of absence.</div>`
      : `<div class="evt-pattern-note">✔ Event numbers ${sorted[0]}–${sorted[sorted.length - 1]} are <b>consecutive with no gaps</b>. The relay generated no other event report in this window, so nothing is missing from the download: where these records show nothing happening, nothing happened.</div>`;
  }

  // ── Did the close that was due actually arrive? ──
  const reconcile = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    if (a.stateOut !== 'CYCLE') continue;
    const gapMs = (a.ms != null && b.ms != null) ? b.ms - a.ms : null;
    const oi = a.openInterval;
    if (a.stalled) {
      reconcile.push(`Record <b>${a.ref}</b> ends mid-reclose-cycle with its open-interval timer <b>stalled</b>, so its ${oi != null ? formatDuration(oi) + ' ' : ''}interval never begins counting. The next record (<b>${b.ref}</b>, ${rcFmtGap(gapMs)} later) shows ${b.closed ? 'a close command' : `no close — ${b.RC.bits && b.RC.bits.CLOSE ? b.RC.bits.CLOSE : 'CLOSE'} never asserts`}, which is what a stalled interval predicts.`);
    } else if (oi != null && gapMs != null) {
      const due = gapMs >= oi * 1000;
      reconcile.push(`Record <b>${a.ref}</b> ends mid-reclose-cycle with ${formatDuration(oi)} to run. The next record is ${rcFmtGap(gapMs)} later — ${due ? 'past' : 'before'} the close was due — and ${b.closed ? 'does show a close command' : 'shows no close command'}.${due && !b.closed ? ' A close that was due and did not appear is the thing to chase: either something held the open interval or the close supervision, or a record is missing.' : ''}`);
    }
  }

  // ── Relay clock vs file-name stamp ──
  let clockNote = '';
  const withBoth = rows.filter(r => r.ms != null && r.fileMs != null);
  if (withBoth.length >= 2) {
    const relaySpan = withBoth[withBoth.length - 1].ms - withBoth[0].ms;
    const fileSpan = withBoth[withBoth.length - 1].fileMs - withBoth[0].fileMs;
    if (Math.abs(relaySpan - fileSpan) > 60000) {
      clockNote = `<div class="evt-pattern-note" style="border-left-color:var(--warn,#d79b28);">⚠ The file-name timestamps span <b>${rcFmtGap(fileSpan)}</b> but the relay clock spans <b>${rcFmtGap(relaySpan)}</b>. The names are collection/download stamps, not event times${(() => {
        const off = getSettingNum(withBoth[0].P, ['UTC_OFF']);
        return off != null ? `, and this relay's clock is set to UTC_OFF := ${off}` : '';
      })()}. Reclose intervals must be reasoned about from the relay clock column — the file names will give the wrong answer.</div>`;
    }
  }

  const body = rows.map((r, i) => {
    const prev = i > 0 ? rows[i - 1] : null;
    const gap = prev && r.ms != null && prev.ms != null ? r.ms - prev.ms : null;
    const what = r.hasTrip
      ? `TRIP${r.RC.lockoutCausedByThisTrip ? ' → lockout' : (r.RC.cycleStartedAfterTrip ? ' → reclose cycle' : '')}`
      : `no trip — ${r.trigger ? `ER via ${r.trigger}` : 'ER trigger'}`;
    const toneColor = (RC_TONE[r.verdictTone] || RC_TONE.unknown).color;
    return `<tr${r.idx === CURRENT_IDX ? ' style="background:rgba(127,127,127,0.10);"' : ''}>
      <td style="white-space:nowrap;"><a href="#" onclick="selectEvent(${r.idx});return false;" style="color:var(--accent,#6aa9ff);text-decoration:none;font-weight:600;">${r.ref}</a></td>
      <td>${r.type}</td>
      <td style="white-space:nowrap;font-variant-numeric:tabular-nums;">${r.clock}</td>
      <td style="white-space:nowrap;color:var(--text-muted);">${gap == null ? '—' : '+' + rcFmtGap(gap)}</td>
      <td style="color:${toneColor};">${what}</td>
      <td style="white-space:nowrap;">${r.shotIn != null ? 'SH' + r.shotIn : '—'}${r.shotOut != null && r.shotOut !== r.shotIn ? ' → SH' + r.shotOut : ''}</td>
      <td style="white-space:nowrap;font-weight:600;">${r.stateOut}${r.stalled && r.stateOut === 'CYCLE' ? ' <span style="font-weight:400;color:var(--text-muted);">(timer stalled)</span>' : ''}</td>
      <td>${r.closed ? 'CLOSE issued' : '—'}</td>
    </tr>`;
  }).join('');

  return `<div class="card"><div class="card-header">🧭 Reclose Sequence Across the Loaded Records</div>
    <p style="font-size:12px;color:var(--text-dim);margin-bottom:10px;line-height:1.6;">
      The 79 element carries its state from one record to the next, and the open intervals are
      long enough that a whole reclose sequence happens in the gaps between them. Read down this
      table, not across a single record.
    </p>
    <div style="overflow-x:auto;"><table class="data-table">
      <thead><tr>
        <th>Event</th><th>Type</th><th>Relay clock</th><th>Since prev</th>
        <th>What this record is</th><th>Shot</th><th>79 state at end</th><th>Close</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${continuityNote}
    ${reconcile.length ? `<div class="evt-pattern-note">${reconcile.map(t => `<div style="margin:4px 0;">${t}</div>`).join('')}</div>` : ''}
    ${clockNote}
  </div>`;
}

// Compact verdict strip for the top banner — one line, so the "does it come back?" question
// is answered without leaving the summary view. Silent when the file carries no 79 data at
// all, so non-recloser relays don't get an empty block.
function buildRecloseBannerBlock(P, A) {
  const RC = A && A.reclose;
  if (!RC || !RC.available || !RC.verdict || RC.verdict.kind === 'no-data') return '';
  const v = RC.verdict;
  const tone = RC_TONE[v.tone] || RC_TONE.unknown;
  const next = RC.plan && RC.plan[0];
  const bits = [];
  // Only advertise a countdown when a close is actually coming. On a blocked verdict the same
  // numbers would read as a promise the relay isn't going to keep.
  if (RC.planIsLive) {
    if (RC.enabled === true && RC.shots) bits.push(`${RC.attemptsRemaining} of ${RC.shots} attempt${RC.shots === 1 ? '' : 's'} left`);
    // A stalled open interval must never be rendered as a countdown here. This one-line strip
    // is the part of the report most likely to be read on its own, so it is the worst place
    // to quote a due-time for a timer that is not running.
    if (RC.stallBlocksSchedule) bits.push(`open interval ${formatDuration(next && next.openIntervalSec)} — STALLED, not counting`);
    else if (next && next.openIntervalSec != null) bits.push(`next in ${formatDuration(next.openIntervalSec)}${next.clock ? ` (~${next.clock})` : ''}`);
  } else if (RC.enabled === true && RC.shots) {
    bits.push(`${RC.shots}-shot scheme, not being run for this event`);
  }
  return `<div style="margin-top:14px;background:${tone.bg};border:1px solid ${tone.border};border-radius:8px;padding:12px 14px;">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
      <span style="font-size:15px;">${tone.icon}</span>
      <span style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-muted);">Auto-Reclose</span>
      <span style="font-size:12.5px;font-weight:700;color:${tone.color};">${v.headline}</span>
      ${bits.length ? `<span style="font-size:11.5px;color:var(--text-dim);">— ${bits.join(' · ')}</span>` : ''}
      <span style="margin-left:auto;font-size:11px;color:var(--text-muted);cursor:pointer;" onclick="openRecloseTab()">Full reclose analysis →</span>
    </div>
  </div>`;
}

function openRecloseTab() {
  const btn = document.querySelector('.tab-btn[data-tab="reclose"]');
  if (btn) { btn.click(); btn.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}
