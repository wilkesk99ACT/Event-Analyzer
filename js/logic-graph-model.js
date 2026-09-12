
// Shared definition of "bits relevant to this trip", used by both the SV/Trip Chain Flags
// chart and the Event Timeline's trip-only filter so the two stay consistent: the resolved
// cause chain itself, plus a small set of context bits (close command, Event Report trigger,
// breaker status) when they're actually present in this file and change state somewhere in
// the record.
// Produces a clean, human-oriented description for an SV logic/timer variable, in priority
// order:
//  1. "Blinker" — a self-oscillating SV whose own equation is just "NOT <itself>T" (a classic
//     free-running flasher used to blink a target LED) has no diagnostic content at all; every
//     one of its toggles is just the oscillator running, not something that happened. Also
//     caught by an explicit "BLINKER" in the site's own comment, since that's a stronger and
//     more direct signal than the structural pattern when the two might disagree.
//  2. The site's own equation comment, when present — written by whoever configured this
//     relay, so it's taken as authoritative over anything this tool could infer.
//  3. When there's no comment AND the equation is really just a thin wrapper around ONE
//     underlying protection element (optionally with one simple supervisory AND, e.g.
//     "59G1T AND 52A"), describe using THAT element's own name — "SV18T timer expired" becomes
//     "Timer for <the element 59G1 actually is> expired" instead of a bare SV number that means
//     nothing without opening the settings file.
//  4. A bare fallback for anything else.
function describeSVLogic(sv) {
  const eq = sv.equation.split('#')[0].trim();
  const comment = sv.equation.includes('#') ? sv.equation.split('#')[1].trim() : '';

  const selfNotRe = new RegExp(`^NOT\\s+SV0*${sv.num}T$`, 'i');
  if (selfNotRe.test(eq) || /\bblink/i.test(comment)) {
    return { isBlinker: true };
  }

  if (comment) return { isBlinker: false, comment };

  const toks = (eq.match(/\(|\)|\bAND\b|\bOR\b|\bNOT\b|\bR_TRIGGER\b|\bF_TRIGGER\b|\bR_TRIG\b|\bF_TRIG\b|[A-Za-z0-9_]+/g) || [])
    .filter(t => t !== '(' && t !== ')');
  let referenced = null;
  if (toks.length === 1) {
    referenced = toks[0];
  } else if (toks.length === 3 && toks[1] === 'AND') {
    referenced = /^\d/.test(toks[0]) ? toks[0] : (/^\d/.test(toks[2]) ? toks[2] : null);
  }
  const referencedBase = referenced ? referenced.replace(/T$/, '') : null;
  const referencedName = referencedBase ? (TOOLTIPS[referencedBase] || null) : null;
  return { isBlinker: false, comment: '', referenced, referencedName };
}

// ══════════════════════════════════════════════════════════════════════
// PER-BIT LOCAL LOGIC GRAPH — computed on demand, not precomputed for every bit
// ══════════════════════════════════════════════════════════════════════
// Builds a lightweight index of "which equation-bearing setting references which other bit",
// purely from this file's own settings text. This is intentionally lazy and cached on the
// parsed object (P._equationRefIndex) — built once, the first time ANY bit's logic chart is
// requested, not precomputed for every bit up front. Subsequent clicks on other bits reuse the
// same cached index; only the small per-bit graph walk below runs fresh each time.
// Every label actually recorded in the digital word (initial state + every transition), cached
// on the parsed event itself since this gets consulted a lot (once per candidate bit, on every
// local-logic-graph build) and the underlying data never changes for a given file.
function realBitLabelSet(P) {
  if (P._realBitLabelSet) return P._realBitLabelSet;
  const set = new Set(P.initialDigitalState || []);
  (P.digitalTransitions || []).forEach(t => t.changes.forEach(c => set.add(c.label)));
  P._realBitLabelSet = set;
  return set;
}
function getEquationRefIndex(P) {
  if (P._equationRefIndex) return P._equationRefIndex;

  const eqByLabel = {};
  (P.svSettings || []).forEach(sv => {
    const eq = sv.equation.split('#')[0].trim();
    if (eq && eq !== 'NA' && !/^[01]$/.test(eq)) eqByLabel[sv.label] = eq;
  });
  [
    [P.tripEquationName || 'TR', P.tripEquation],
    ['TR3X', P.tripEquationX], ['TRIP3X', P.tripEquationX],
    [P.erEquationName || 'ER', P.erEquation],
    ['FAULT', P.faultEquation],
    ['79RI3P', P.recloseEquation],
    ['79DTL3P', P.dtlEquation],
  ].forEach(([label, eq]) => { if (eq && !eqByLabel[label]) eqByLabel[label] = eq.split('#')[0].trim(); });

  // Everything else defined with ":=" anywhere in the raw settings text — this is what picks
  // up CL, ULTRIP, ULCL, 52A, 52B, every OUTnnn output, etc. without needing their names
  // enumerated ahead of time. Restricted to RHS values that look like a boolean SELOGIC
  // expression (all-caps identifiers/operators/parens only) so numeric pickups, curve codes,
  // and Y/N flags don't get pulled in as if they were logic.
  if (P.settingsText) {
    const re = /(?:^|[\r\n])([A-Z][A-Z0-9_]*)\s*:=([^\r\n]+)/g;
    let m;
    while ((m = re.exec(P.settingsText)) !== null) {
      const label = m[1];
      if (eqByLabel[label]) continue;
      const rhs = m[2].split('#')[0].trim();
      if (!/^[A-Z][A-Z0-9_ ()]*$/.test(rhs)) continue; // not boolean-looking — skip
      if (/^(Y|N|NA|OFF)$/.test(rhs) || /^[A-Z]\d$/.test(rhs)) continue; // Y/N flags, curve codes (U1, C2, ...)
      // A bare space-separated identifier list with no boolean operator at all (e.g. SER1's
      // list of bits to record for the sequence-of-events report) isn't a SELOGIC equation,
      // even though it superficially matches the pattern above — require a real operator once
      // there's more than one token.
      const wordCount = rhs.split(/\s+/).filter(Boolean).length;
      if (wordCount > 1 && !/\b(AND|OR|NOT|R_TRIG|F_TRIG|R_TRIGGER|F_TRIGGER)\b/.test(rhs)) continue;
      eqByLabel[label] = rhs;
    }
  }

  const refIndex = {}; // referencedLabel -> Set of labels whose equation mentions it directly
  Object.entries(eqByLabel).forEach(([label, eq]) => {
    const toks = (eq.match(/\bAND\b|\bOR\b|\bNOT\b|\bR_TRIGGER\b|\bF_TRIGGER\b|\bR_TRIG\b|\bF_TRIG\b|[A-Za-z0-9_]+/g) || [])
      .filter(t => !SELOGIC_KEYWORDS.has(t) && t !== label);
    toks.forEach(tok => { if (!refIndex[tok]) refIndex[tok] = new Set(); refIndex[tok].add(label); });
  });

  P._equationRefIndex = { eqByLabel, refIndex };
  return P._equationRefIndex;
}

// The set of bits treated as a natural stopping point when tracing forward — the tool's own
// "final command" bits, matching how the main trip-logic diagram terminates.
// Whether `label` (bare SVxx or its SVxxT form) is a self-oscillating blinker — reuses the
// same detection as describeSVLogic, just entered from a label instead of an sv settings
// object, since the local logic graph deals in labels throughout.
function isBlinkerLabel(label, P) {
  const m = label.match(/^SV(\d+)T?$/);
  if (!m) return false;
  const sv = (P.svSettings || []).find(s => s.num === parseInt(m[1]));
  if (!sv) return false;
  return describeSVLogic(sv).isBlinker;
}

function isTerminalBit(label, P) {
  return ['TRIP', 'TRIP3P', 'TRIPA', 'TRIPB', 'TRIPC', 'CLOSE', 'CLOSE3P', 'CLOSEA', 'CLOSEB', 'CLOSEC', 'ER']
    .includes(label) || label === (P.tripEquationName || 'TR') || label === (P.erEquationName || 'ER')
    || (label === 'TR3X' && !!P.tripEquationX);
}

// SEL relays generally have exactly ONE internal trip-logic bit — the equation this tool calls
// "TR" (P.tripEquationName; occasionally the settings name it "TRIP" or "TRIP3P" directly) —
// whose value IS the final recorded trip word bit (TRIP / TRIP3P / TRIPA-C), by fixed relay
// firmware behavior rather than an explicit settings assignment. There's normally no
// "TRIP := TR" line in the settings text for this tool to discover, so without this the
// equation-bearing name never resolves a downstream box (nothing "feeds out of" TR) and the
// recorded terminal name never resolves an equation or backward chain at all (nothing "feeds
// into" TRIP) — even though clicking either one is asking about the exact same physical bit.
const TRIP_TERMINAL_NAMES = ['TRIP', 'TRIP3P', 'TRIPA', 'TRIPB', 'TRIPC'];
function canonicalTripLabel(label, P) {
  const eqName = P.tripEquationName || 'TR';
  if (label === eqName || TRIP_TERMINAL_NAMES.includes(label)) {
    // If this event's resolved cause was actually attributed to TR3X (a separate, usually
    // differently-scoped "unconditional trip" equation — see the sourceEquationName note where
    // it's computed), alias the terminal bit to TR3X instead so its logic chart shows the
    // equation that genuinely drove this trip, not the unrelated TR/TR3P equation.
    const src = (typeof ANALYSIS !== 'undefined' && ANALYSIS?.tripCause?.sourceEquationName) || null;
    if (src === 'TR3X') return 'TR3X';
    return eqName;
  }
  // Clicking "TR3X" or "TRIP3X" directly always means the TR3X equation itself, regardless of
  // which equation actually fired this particular event.
  if (label === 'TR3X' || label === 'TRIP3X') return 'TR3X';
  return label;
}

// Builds the small graph for ONE bit: one column of whatever directly feeds its own equation
// (if it has one), the bit itself, and up to `maxForwardCols` columns of whatever it feeds
// into, one hop at a time, stopping early at a terminal bit. Two relationships are always
// walked even though they're not literally "referenced" in another bit's equation text — an
// SV's own timed output (SVxx -> SVxxT) and the close logic result (CL -> CLOSE) — matching
// how this tool treats those pairs everywhere else.

// Finds how `token` is actually gated inside `eq` — e.g. "NOT", "R_TRIG", or a combination
// like "NOT R_TRIG" — by tokenizing the equation the same way everywhere else in this file and
// walking backward from the token's first occurrence over any immediately-preceding modifier
// keywords. Returns '' when the token appears completely bare (or `eq` is empty/undefined —
// covers the auto-inferred SVxx→SVxxT and CL→CLOSE edges, which aren't derived from scanning
// an equation at all and so never have a modifier).
// A standalone recursive-descent SELogic parser — deliberately separate from the similar one
// used for fault-chain tracing elsewhere in this file, since that one lives inside a different
// function's closure and isn't reachable from here. Used to recover the top-level AND/OR
// STRUCTURE of a bit's own inputs (which of them are AND-ed together vs which are alternative
// OR branches), not to evaluate the equation against live data.
const LLG_EDGE_OPS = new Set(['R_TRIG', 'F_TRIG', 'R_TRIGGER', 'F_TRIGGER']);
function llgTokenize(eq) {
  return eq.match(/\(|\)|\bAND\b|\bOR\b|\bNOT\b|\bR_TRIGGER\b|\bF_TRIGGER\b|\bR_TRIG\b|\bF_TRIG\b|[A-Za-z0-9_]+/g) || [];
}
function llgParse(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  function parseExpr() {
    let node = parseTerm();
    while (peek() === 'OR') { next(); node = { op: 'OR', l: node, r: parseTerm() }; }
    return node;
  }
  function parseTerm() {
    let node = parseFactor();
    while (peek() === 'AND') { next(); node = { op: 'AND', l: node, r: parseFactor() }; }
    return node;
  }
  function parseFactor() {
    const t = peek();
    if (t === undefined) return { op: 'VAR', name: '__EMPTY__' };
    if (t === 'NOT') { next(); return { op: 'NOT', c: parseFactor() }; }
    if (LLG_EDGE_OPS.has(t)) { next(); return { op: (t === 'F_TRIG' || t === 'F_TRIGGER') ? 'FEDGE' : 'REDGE', c: parseFactor() }; }
    if (t === '(') { next(); const e = parseExpr(); if (peek() === ')') next(); return e; }
    next(); return { op: 'VAR', name: t };
  }
  return parseExpr();
}
// Flattens a left-associative chain of the SAME binary operator into a flat array of operand
// nodes — e.g. "A AND B AND C" parses as AND(AND(A,B),C); flattening with op='AND' recovers
// [A,B,C]. A subtree using a DIFFERENT operator is treated as one opaque operand (not flattened).
function llgFlatten(node, op) {
  if (node && node.op === op) return [...llgFlatten(node.l, op), ...llgFlatten(node.r, op)];
  return [node];
}
// Recursively collects EVERY variable leaf under a node, regardless of how deeply it's nested
// inside further AND/OR combinations — e.g. "(59Q1 OR 59G1) AND NOT SV21T" must still surface
// 59Q1 and 59G1 as real inputs even though they sit inside a parenthesized OR that's itself one
// operand of an outer AND. An earlier version only recognized a bare variable (optionally
// wrapped in a single NOT/R_TRIG/F_TRIG) as a "leaf" and silently DROPPED anything more deeply
// nested — not just mis-grouping it, losing it from the chart entirely. NOT/R_TRIG/F_TRIG
// wrapping a compound sub-expression (rare in practice — this firmware almost always applies
// them to a single bit) propagates its tag onto every leaf found inside, which isn't strictly
// correct De Morgan's-law behavior for a NOT over AND/OR, but is a reasonable, non-crashing
// approximation for the genuinely rare case where it happens.
function llgCollectLeaves(node) {
  if (!node) return [];
  if (node.op === 'VAR') return (node.name && node.name !== '__EMPTY__') ? [{ name: node.name, mod: '' }] : [];
  if (node.op === 'NOT' || node.op === 'REDGE' || node.op === 'FEDGE') {
    const tag = node.op === 'NOT' ? 'NOT' : (node.op === 'REDGE' ? 'R_TRIG' : 'F_TRIG');
    return llgCollectLeaves(node.c).map(leaf => ({ name: leaf.name, mod: (tag + (leaf.mod ? ' ' + leaf.mod : '')).trim() }));
  }
  if (node.op === 'AND' || node.op === 'OR') return [...llgCollectLeaves(node.l), ...llgCollectLeaves(node.r)];
  return [];
}
// Evaluates a (sub-)expression's real boolean value against live bit states — used to decide
// whether an AND-group's bracket should read as satisfied, respecting whatever OR/AND
// nesting the operand actually has (e.g. "(59Q1 OR 59G1)" is satisfied by EITHER one being true,
// not both) rather than naively requiring every individual leaf under it to be true.
// R_TRIG/F_TRIG have no reliable instantaneous "did the edge just occur" derivation available
// here, so they fall back to the raw current state, same simplification used everywhere else in
// this file that isn't the full fault-chain evaluator.
function llgEvalNode(node, getState) {
  if (!node) return false;
  switch (node.op) {
    case 'VAR': { const st = getState(node.name); return !!(st && st.state); }
    case 'NOT': return !llgEvalNode(node.c, getState);
    case 'REDGE': case 'FEDGE': return llgEvalNode(node.c, getState);
    case 'AND': return llgEvalNode(node.l, getState) && llgEvalNode(node.r, getState);
    case 'OR': return llgEvalNode(node.l, getState) || llgEvalNode(node.r, getState);
    default: return false;
  }
}
// Returns the top-level input structure of an equation as an array of OR-branches. Each branch
// has `leaves` (every {name, mod} variable feeding it, flattened regardless of nesting depth —
// what actually gets drawn as edges) and `operandNodes` (the top-level AND-operands' own AST
// nodes, kept around so the branch's true/false can be evaluated correctly later even though
// one operand might itself be a nested OR). "A AND B OR C" (AND binds tighter, so this is
// "(A AND B) OR C") returns two branches; a bare single input with no AND/OR at all comes back
// as one branch with one leaf and one trivial operand.
function getInputGroups(eq) {
  if (!eq) return [];
  const ast = llgParse(llgTokenize(eq));
  return llgFlatten(ast, 'OR').map(branch => {
    const operandNodes = llgFlatten(branch, 'AND');
    const leaves = [];
    operandNodes.forEach(n => leaves.push(...llgCollectLeaves(n)));
    return { leaves, operandNodes };
  });
}

function buildLocalLogicGraph(P, label, maxForwardCols, maxBackwardCols, scoped) {
  maxForwardCols = maxForwardCols || 6;
  maxBackwardCols = maxBackwardCols || 10;
  label = canonicalTripLabel(label, P); // TR and TRIP/TRIP3P/etc are the same physical bit — see canonicalTripLabel
  const { eqByLabel, refIndex } = getEquationRefIndex(P);
  const edges = []; // {from, to} — from feeds into to; drawn as an actual connector, not inferred from column position

  // A label may only ever occupy ONE column. Backward and forward used to keep separate "seen"
  // sets, which let a bit that's simultaneously "an input of the center bit" AND "a bit whose
  // own equation references the center bit" (a genuine two-way relationship — e.g. an SVxx that
  // both drives its own SVxxT timer and is itself gated by "NOT SVxxT") get placed TWICE: once
  // in a backward column, then silently relocated to a forward column by whichever pass ran
  // last, since column/position lookups are a plain object keyed by label. Edges recorded
  // against the earlier (backward) placement then had to route across every column in between
  // to reach the bit's new (forward) position — that's what produced the tangled, crossing
  // connectors when charting a bit like this. Sharing one `placed` set across both passes means
  // whichever pass discovers a label FIRST keeps it — the other pass still records its edge
  // (so the real dependency isn't lost) but never relocates the box.
  const placed = new Set([label]);
  const andGroupNodes = {}; // andGroup id -> that branch's top-level AND-operand AST nodes (for correct evaluation, respecting nested OR)
  const subGroupNodes = {}; // subGroup id -> the single parenthesized operand's AST node (for fork-join satisfied-state coloring)

  // Adds ALL of `target`'s direct inputs as edges (grouped by AND/OR structure — see
  // getInputGroups), at most once per target regardless of which direction discovers it first.
  // This matters more than it might look: the forward walk used to only ever record the ONE
  // input relationship that caused a target to be discovered (e.g. "IN304 feeds SV13") without
  // pulling in the target's OTHER direct inputs (e.g. SV13's own "AND 52A") — so a bit reached
  // via forward discovery would silently show only PART of its own equation, with the rest of
  // its inputs simply never appearing anywhere in the chart. Returns the newly-discovered
  // (not-yet-placed) input labels, for the caller to fold into its own frontier/column.
  const inputsAddedFor = new Set();
  let andGroupSeq = 0;
  // Processes one or more OR-branches of `target`'s equation (each `{leaves, operandNodes}` from
  // getInputGroups), pushing edges/AND-group/subGroup bookkeeping exactly as before — shared by
  // both addInputsFor (ALL branches) and addInputsForBranchThrough (just the one branch relevant
  // to a specific forward relationship) so the AND/OR/feedback logic isn't duplicated.
  function processGroups(target, groups) {
    const discovered = [];
    groups.forEach(({ leaves, operandNodes }) => {
      const realLeaves = leaves.filter(leaf => leaf.name && leaf.name !== target && leaf.name !== '__EMPTY__');
      const gid = realLeaves.length > 1 ? `g${andGroupSeq++}` : null; // only a REAL multi-input AND branch needs a shared group id
      if (gid) andGroupNodes[gid] = operandNodes;
      // Within this AND branch, an operand that is ITSELF a multi-leaf sub-expression (e.g. the
      // parenthesized "(59Q1 OR 59G1)") gets its own subGroup id, so the renderer can fork-join
      // just those leaves into a single line before it joins the rest of the AND — matching how
      // the equation parenthesizes them. A single-leaf operand (e.g. "NOT SV21T", "50P1P") gets
      // no subGroup: it's already one line. Built by walking each operand node's own leaves via
      // the same collector used for the branch as a whole.
      const subGroupOf = {}; // leaf name -> subGroup id (only for names inside a multi-leaf operand)
      if (gid) {
        operandNodes.forEach((opNode, opi) => {
          const opLeaves = llgCollectLeaves(opNode).filter(l => l.name && l.name !== target && l.name !== '__EMPTY__');
          if (opLeaves.length > 1) {
            const sgid = `${gid}s${opi}`;
            subGroupNodes[sgid] = opNode;
            opLeaves.forEach(l => { subGroupOf[l.name] = sgid; });
          }
        });
      }
      realLeaves.forEach(({ name, mod }) => {
        // An SV whose own equation references its OWN timed output (e.g. SV09 := ... OR SV09T)
        // is a genuine feedback loop — SV09T is DOWNSTREAM of SV09 (SV09 drives its own pickup
        // timer), so it should NOT be pulled leftward into an upstream input column, which is
        // what produced the confusing lines running right-to-left back into the box. Mark the
        // edge as feedback and DON'T report SV09T as a newly-discovered upstream node, so it
        // isn't placed in a backward column; the renderer draws it as a distinct short loop.
        const selfTimerM = target.match(/^SV(\d+)$/);
        const isSelfFeedback = selfTimerM && name === `SV${selfTimerM[1]}T`;
        edges.push({ from: name, to: target, mod, andGroup: gid, subGroup: subGroupOf[name] || null, feedback: !!isSelfFeedback });
        if (!isSelfFeedback && !placed.has(name)) discovered.push(name);
      });
    });
    return discovered;
  }
  // Adds ALL of `target`'s direct inputs as edges (every OR-branch, every AND-group), at most
  // once per target regardless of which direction discovers it first. This is the right behavior
  // when `target` is the bit actually being examined (backward from the clicked/focal label) —
  // its own FULL equation is exactly what belongs in the chart. Returns the newly-discovered
  // (not-yet-placed) input labels, for the caller to fold into its own frontier/column.
  function addInputsFor(target) {
    if (inputsAddedFor.has(target)) return [];
    inputsAddedFor.add(target);
    const svtM = target.match(/^SV(\d+)T$/);
    if (svtM) {
      const inp = `SV${svtM[1]}`;
      edges.push({ from: inp, to: target, mod: '', andGroup: null, priority: true });
      return (!placed.has(inp)) ? [inp] : [];
    }
    if (target === 'CLOSE') {
      edges.push({ from: 'CL', to: target, mod: '', andGroup: null });
      return (!placed.has('CL')) ? ['CL'] : [];
    }
    // A protection-element timed output (59G1T, 51P1T, and the like) has no SELOGIC equation of
    // its own — it's a fixed firmware relationship between the element's own raw pickup/level bit
    // (59G1, 51P1 — an actual protection element, not a settings-defined variable) and its
    // coordinated timed output, exactly like SVxx -> SVxxT above just for hardware protection
    // elements rather than user SV points. Only applies when `target` doesn't already have a real
    // equation of its own (a genuinely SELOGIC-defined bit that happens to end in "T" should show
    // its actual equation instead, not be treated as an implicit timer). The base doesn't have to
    // be separately RECORDED in this file's digital word — many relays only wire the coordinated
    // output to a report point and never the raw element itself, but the raw element is still the
    // true upstream source and worth showing (its box will just read as "unknown state" rather
    // than asserted/not, honestly reflecting that this file never recorded it). What guards
    // against firing on some unrelated name that simply happens to end in "T": ANSI protection
    // element numbers always start with a digit (50, 51, 59, 67, 81, 27, 32…), which ordinary
    // named contacts/inputs/outputs essentially never do.
    if (!eqByLabel[target] && target.length > 2 && target.endsWith('T')) {
      const base = target.slice(0, -1);
      if (/^\d/.test(base)) {
        edges.push({ from: base, to: target, mod: '', andGroup: null, priority: true });
        return (!placed.has(base)) ? [base] : [];
      }
    }
    return processGroups(target, getInputGroups(eqByLabel[target]));
  }
  // Adds ONLY the one OR-branch of `target`'s equation that contains `throughLabel`, plus that
  // branch's OTHER AND-group siblings if any (e.g. reaching TR "through" SV06, where TR's branch
  // is "SV06 AND 52A", pulls in 52A alongside it) — but none of `target`'s OTHER, unrelated
  // OR-alternatives. This is the key difference from addInputsFor when FORWARD-walking INTO a
  // large equation like TR/TR3X (dozens of independent OR'd conditions): arriving via one
  // specific input should show that input's own AND-group context, not the entire equation —
  // otherwise every other alternative anywhere in TR (most of them false and unrelated to the
  // bit actually being examined) gets pulled in too, which is what made non-focal bits' charts
  // balloon into "basically every SV in the settings".
  function addInputsForBranchThrough(target, throughLabel) {
    const groups = getInputGroups(eqByLabel[target]);
    const branch = groups.find(g => g.leaves.some(l => l.name === throughLabel));
    if (!branch) return [];
    // Guard against re-adding the exact same branch twice (e.g. two different upstream bits
    // both forward-reaching the same AND-group in the same walk) — track by target+branch
    // identity via the branch's own operandNodes reference.
    const key = target + '\u0000' + groups.indexOf(branch);
    if (inputsAddedFor.has(key)) return [];
    inputsAddedFor.add(key);
    return processGroups(target, [branch]);
  }

  // ── Backward (leftward): walk multiple hops, not just one, so the chain actually reaches ──
  // all the way back to a real measured/protection element (a bit with no further equation of
  // its own) rather than stopping at whatever's immediately behind the clicked bit. Built
  // nearest-to-center first, then reversed so the deepest (most upstream) column ends up
  // leftmost when rendered.
  const backward = [];
  {
    const CLOSE_FAMILY = new Set(['CLOSE', 'CLOSE3P', 'CLOSEA', 'CLOSEB', 'CLOSEC']);
    let frontier = new Set([label]);
    for (let i = 0; i < maxBackwardCols && frontier.size; i++) {
      const nextFrontier = new Set();
      frontier.forEach(l => {
        // A CLOSE-family bit's OWN upstream chain (the close circuit's control logic — CL,
        // SV10/SV11, every raw contact feeding those) is a separate concern from trip logic.
        // Expand it only when it's the bit actually being charted (l === label, i.e. the user
        // clicked CLOSE/CLOSE3P/etc directly) — when it merely shows up as someone else's input
        // (e.g. SV21 := CLOSE, or a "NOT SV21T" security interlock referenced deep inside an
        // unrelated SV), stop there instead of pulling in its whole backstory.
        if (CLOSE_FAMILY.has(l) && l !== label) return;
        addInputsFor(l).forEach(inp => nextFrontier.add(inp));
      });
      if (!nextFrontier.size) break;
      nextFrontier.forEach(l => placed.add(l));
      backward.push([...nextFrontier]);
      frontier = nextFrontier;
    }
    backward.reverse();
  }

  // ── Forward (rightward) ──
  // Seeded with just the center label, not the backward columns too — a bit already placed
  // backward can still legitimately gain a forward EDGE (see `placed` note above), it just
  // won't be re-added as a new box.
  const forward = [];
  {
    // TR's (and TR3X's) own name is never referenced by anything else in the settings text (see
    // canonicalTripLabel above) — but each IS, in effect, feeding the actual recorded terminal
    // trip bit, by fixed relay firmware behavior rather than something spelled out anywhere in
    // the settings. Seed that connection explicitly whenever TR or TR3X shows up as a node in
    // this chart — whether it's the bit that was clicked directly, or one reached several hops
    // into a longer forward walk from some upstream element — so the chain always continues all
    // the way to the physical terminal bit instead of dead-ending at the bare equation name.
    const eqNameMain = P.tripEquationName || 'TR';
    function seedTerminalEdge(nodeLabel) {
      const isMain = nodeLabel === eqNameMain && !!P.tripEquation;
      const isX = nodeLabel === 'TR3X' && !!P.tripEquationX;
      if (!isMain && !isX) return null;
      const terminalLabel = (typeof ANALYSIS !== 'undefined' && ANALYSIS?.tripCause?.finalLabel) || 'TRIP3P';
      if (terminalLabel === nodeLabel || placed.has(terminalLabel)) return null;
      edges.push({ from: nodeLabel, to: terminalLabel, mod: '', andGroup: null });
      placed.add(terminalLabel);
      return terminalLabel;
    }
    const seededAtStart = seedTerminalEdge(label);
    if (seededAtStart) forward.push([seededAtStart]);
    let frontier = new Set([label]);
    // The column array holding the CURRENT frontier's members, so a newly-discovered consumer's
    // own sibling inputs can be placed alongside whatever triggered their discovery (the correct
    // depth for them) rather than alongside the consumer itself. null for hop 0, since the
    // frontier there is just the center label, which isn't a shared column of its own — sibling
    // discoveries made directly off the center fall back to sharing the consumer's column, same
    // as before, since there's nowhere earlier to put them.
    let priorColumnArr = null;
    for (let i = 0; i < maxForwardCols && frontier.size; i++) {
      const nextFrontier = new Set();
      frontier.forEach(l => {
        const svM = l.match(/^SV(\d+)$/);
        if (svM) {
          const t = `SV${svM[1]}T`;
          edges.push({ from: l, to: t, mod: '', andGroup: null, priority: true });
          if (!placed.has(t)) nextFrontier.add(t);
        } else {
          // Generalized version of the SV rule above, for hardware protection-element timed
          // outputs (59G1 -> 59G1T, 51P1 -> 51P1T, etc.) rather than user SV points — only when
          // the timed form is actually a recorded bit in THIS file (unlike SVxxT, a protection
          // element's timed output isn't guaranteed to exist just because the element itself
          // does) and isn't itself a real SELOGIC-defined equation.
          const timedVariant = `${l}T`;
          if (!eqByLabel[timedVariant] && realBitLabelSet(P).has(timedVariant)) {
            edges.push({ from: l, to: timedVariant, mod: '', andGroup: null, priority: true });
            if (!placed.has(timedVariant)) nextFrontier.add(timedVariant);
          }
        }
        if (l === 'CL') { edges.push({ from: l, to: 'CLOSE', mod: '', andGroup: null }); if (!placed.has('CLOSE')) nextFrontier.add('CLOSE'); }
        (refIndex[l] || []).forEach(ref => {
          if (!placed.has(ref)) nextFrontier.add(ref);
          // The edge from `l` into `ref` is created INSIDE this call (via processGroups, using
          // l's real mod/andGroup identity) — it has to run even when ref is terminal, or the
          // terminal bit ends up with no incoming edge at all (disconnected, as TR/ER were after
          // an earlier version of this fix skipped the call entirely). Scoped mode only pulls in
          // the ONE branch/AND-group that actually connects through `l` (see
          // addInputsForBranchThrough) — full mode pulls in ref's entire equation (see
          // addInputsFor's own comment).
          const siblings = scoped ? addInputsForBranchThrough(ref, l) : addInputsFor(ref);
          // A terminal bit (TR, TR3X, TRIP/TRIP3P/etc, CLOSE-family, ER) reached this way is
          // purely a WAYPOINT on the way to the trip — its OWN full equation (every other
          // unrelated OR-alternative TR happens to also contain, or everything ER's separate
          // event-report equation references) has nothing to do with explaining how the
          // ORIGINALLY clicked bit connects to the trip. The edge into it (above) is kept; its
          // OTHER inputs are discarded here rather than turned into new boxes/columns — that's
          // what previously ballooned a chart like SV17T's into showing TR's entire sibling list
          // plus ER's entire equation beyond it.
          if (isTerminalBit(ref, P)) return;
          siblings.forEach(d => {
            if (placed.has(d)) return;
            placed.add(d);
            if (priorColumnArr) priorColumnArr.push(d);
            else nextFrontier.add(d); // hop 0: no earlier column exists yet to share
          });
        });
      });
      // If this hop just discovered TR or TR3X itself, seed its edge to the physical terminal
      // bit too — but the terminal bit belongs in its OWN column one step further right, not
      // merged into TR/TR3X's own column (which would need another same-column edge, the exact
      // defect being fixed here). Collect it separately and flush it as an extra column push.
      const pendingTerminalSeeds = new Set();
      [...nextFrontier].forEach(l => { const t = seedTerminalEdge(l); if (t) pendingTerminalSeeds.add(t); });
      if (!nextFrontier.size) break;
      nextFrontier.forEach(l => placed.add(l));
      forward.push([...nextFrontier]);
      priorColumnArr = forward[forward.length - 1];
      // A branch that reaches a terminal bit (e.g. ER) stops expanding from there — but that
      // must not cut off OTHER branches produced in this same hop that haven't reached one yet
      // (e.g. SV15T, still one hop short of TR). Only terminal labels drop out of the frontier;
      // everything else keeps going.
      frontier = new Set([...nextFrontier].filter(l => !isTerminalBit(l, P)));
      if (pendingTerminalSeeds.size) {
        forward.push([...pendingTerminalSeeds]);
        priorColumnArr = forward[forward.length - 1];
        // The terminal bit itself needs no further forward expansion.
      }
    }

    // ── Topological correction pass ──
    // The discovery loop above places each label in whichever column it was FIRST reached at —
    // usually correct, but two labels can legitimately be reached at the exact same hop despite
    // one genuinely feeding the other (e.g. TR gets discovered via SV17T's own reference to it,
    // in the very same hop that SV18T is auto-derived from SV18 — even though SV18T is ALSO one
    // of TR's direct inputs). Whenever that happens, the edge between them has no sane column-
    // to-column path to draw and comes out as a same-column (near-vertical) connector — exactly
    // the defect being fixed here. This pass finds every forward edge whose source's column
    // index is not strictly less than its target's, and bumps the target into a fresh column
    // immediately after the source's, repeating until every edge strictly moves left-to-right.
    {
      const colOfF = {};
      forward.forEach((col, i) => col.forEach(l => { colOfF[l] = i; }));
      let changed = true, guard = 0;
      while (changed && guard++ < forward.length + edges.length + 5) {
        changed = false;
        edges.forEach(e => {
          if (e.feedback) return;
          const cf = colOfF[e.from], ct = colOfF[e.to];
          if (cf == null || ct == null || cf < ct) return; // both must be forward-placed, and already correctly ordered otherwise
          const oldCol = forward[ct];
          const idx = oldCol ? oldCol.indexOf(e.to) : -1;
          if (idx === -1) return;
          oldCol.splice(idx, 1);
          const newIdx = cf + 1;
          if (!forward[newIdx]) forward[newIdx] = [];
          forward[newIdx].push(e.to);
          colOfF[e.to] = newIdx;
          changed = true;
        });
      }
      for (let i = forward.length - 1; i >= 0; i--) if (!forward[i] || !forward[i].length) forward.splice(i, 1);
    }
  }

  // A true two-way relationship (SVxx feeds SVxxT; SVxxT is itself referenced back inside
  // SVxx's own equation) gets discovered from BOTH directions above, producing a pair of edges
  // that are exact reverses of one another between the same two boxes. Drawing both as separate
  // routed lines is what caused the visual tangle — the two lines connect the same pair of
  // points but get independently assigned crossing port offsets. Since this local graph doesn't
  // draw arrowheads (direction is implied by column order, and the underlying equation text is
  // always shown alongside), keeping just one direction per pair is sufficient and removes the
  // duplicate line entirely.
  const keptByPair = new Map(); // 'from\u0000to' -> the kept edge object, so a later-seen reverse duplicate can still contribute its modifier
  const dedupedEdges = [];
  edges.forEach(e => {
    if (e.from === e.to) return;
    const revKey = e.to + '\u0000' + e.from;
    const existing = keptByPair.get(revKey);
    if (existing) {
      // Same pair, opposite direction already kept — don't add a second line, but if THIS
      // direction is the one that actually carries the real NOT/R_TRIG gating (e.g. the
      // auto-inferred SVxx→SVxxT pickup edge has no modifier, while the reverse "NOT SVxxT"
      // discovered from SVxx's own equation does), transfer that modifier onto the kept edge
      // rather than silently losing it.
      if (e.mod && !existing.mod) existing.mod = e.mod;
      return;
    }
    keptByPair.set(e.from + '\u0000' + e.to, e);
    dedupedEdges.push(e);
  });

  // ── Fan-out leaf duplication ──
  // A raw leaf bit — one with no equation of its own (a measured/status point like 52A, IN304,
  // 52B) — that's referenced by MANY targets gets placed in a single column wherever it was
  // first discovered, forcing long edges that fan out across the whole chart to reach every
  // consumer. When a consumer sits well to that leaf's LEFT, its edge runs backward (right to
  // left), which reads as a stray vertical line cutting through columns and is easy to miss
  // entirely. Standard schematic practice for a high-fan-out signal is to REPLICATE it — give
  // each consumer its own local copy right beside it — rather than route one shared node's
  // lines everywhere. Here: any leaf feeding 2+ targets is replaced by per-consumer duplicates,
  // each a distinct node id ("52A#dup3") placed in the column immediately left of its consumer,
  // displaying the original label. Only leaves (no equation) are duplicated — replicating an SV
  // with its own upstream logic would mean duplicating that whole subtree, which isn't wanted.
  {
    const isRawLeaf = lbl => !eqByLabel[lbl] && !/^SV\d+T?$/.test(lbl) && !isTerminalBit(lbl, P);
    const consumersByLeaf = {};
    dedupedEdges.forEach(e => { if (isRawLeaf(e.from)) (consumersByLeaf[e.from] || (consumersByLeaf[e.from] = [])).push(e); });

    const colIndexOf = {};
    const allCols = [...backward, [label], ...forward];
    allCols.forEach((col, ci) => col.forEach(l => { colIndexOf[l] = ci; }));

    const dupBoxesByCol = {}; // column index -> [dup node ids] to append
    let dupSeq = 0;
    Object.entries(consumersByLeaf).forEach(([leaf, consumerEdges]) => {
      if (consumerEdges.length < 2) return; // single consumer: leave the shared node as-is
      const leafCol = colIndexOf[leaf];
      consumerEdges.forEach(e => {
        const consumerCol = colIndexOf[e.to];
        if (consumerCol == null) return;
        const dupCol = consumerCol - 1; // the input column just left of the consumer
        // If the shared leaf already happens to sit exactly one column to this consumer's left,
        // its edge is already a clean adjacent hop — no need to duplicate for this consumer.
        if (leafCol === dupCol) return;
        const dupId = `${leaf}\u0001dup${dupSeq++}`;
        e.from = dupId; // redirect this consumer's edge to its private copy
        (dupBoxesByCol[dupCol] || (dupBoxesByCol[dupCol] = [])).push(dupId);
      });
    });

    // Insert the duplicate node ids into their target columns. A dupCol of -1 (consumer is in
    // the leftmost column) means we need a new leftmost column.
    Object.entries(dupBoxesByCol).forEach(([ci, ids]) => {
      ci = parseInt(ci);
      if (ci < 0) { backward.unshift(ids); }
      else {
        const col = allCols[ci];
        if (col) col.push(...ids);
      }
    });

    // Prune the original shared leaf if EVERY one of its edges got redirected to a duplicate
    // (i.e. it no longer has any real consumer), so it doesn't linger as an orphan box.
    Object.keys(consumersByLeaf).forEach(leaf => {
      const stillUsed = dedupedEdges.some(e => e.from === leaf);
      if (!stillUsed) {
        [backward, forward].forEach(group => group.forEach(col => {
          const idx = col.indexOf(leaf);
          if (idx !== -1) col.splice(idx, 1);
        }));
      }
    });
    // Drop any now-empty columns created by pruning.
    for (let i = backward.length - 1; i >= 0; i--) if (!backward[i].length) backward.splice(i, 1);
    for (let i = forward.length - 1; i >= 0; i--) if (!forward[i].length) forward.splice(i, 1);
  }

  const finalGraph = { center: label, backward, forward, edges: dedupedEdges, andGroupNodes, subGroupNodes };
  return finalGraph;
}