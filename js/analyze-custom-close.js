

// ════════════════════════════════════════════════════════════════════════════
// CUSTOM CLOSE LOGIC — AUTOMATIC CLOSING THAT IS NOT THE ANSI 79 ELEMENT
// ════════════════════════════════════════════════════════════════════════════
// The Reclosing tab answers "will it come back by itself" out of the ANSI 79 settings. On a
// DER interconnection recloser that question has a second answer the 79 block does not hold.
//
// A very common pattern at inverter-based sites: E79 := N — the 79 element is switched off
// entirely — and the automatic return is built by hand in SELogic instead, as a long timer on
// an SV that watches the utility-side voltage and frequency, gated by a latch the site arms
// from the front panel. IEEE 1547-2018 enter-service is exactly this shape: a 300 s window,
// voltage inside a band, frequency inside a band, no fault lockout latched, no hot line tag.
//
// Read only the 79 block, and that device reports as "will NOT auto-close — reclosing is
// disabled". The device then closes itself five minutes later. The statement is true about the
// 79 element and wrong about the recloser, which is the worst kind of wrong this tool can be.
//
// This module answers the question the close equation actually poses: is there a path through
// CL that goes true WITHOUT a person doing anything? It does that by walking each term of the
// close equation down through the SVs and latches that feed it, and classifying what it finds:
//
//   automatic  — the path needs no operator action. A timer and measured conditions run it.
//   operator   — the path needs a pushbutton press or a close command from SCADA.
//   external   — the path needs a contact input or a mirrored bit. What drives that signal is
//                outside this file, so the tool says so instead of guessing.
//
// Deliberate limits, because overstating here is how a tool gets someone hurt:
//   * It reports what the logic ALLOWS. It does not promise a close will happen.
//   * A latch (LT) is treated as a mode switch, not as an operator action. LT02 being armed
//     means the automatic mode is on. It does not mean somebody is standing at the recloser.
//   * Every state it quotes is the state at the last sample of the record. The close itself
//     falls minutes after the record ends, and that is said in the text, every time.

// How a relay-word name is classified when the walk reaches it. Order matters: the first
// pattern that matches wins.
const CC_TERM_CLASSES = [
  { re: /^PB\d+_PUL$/,            cls: 'operator', what: 'front-panel pushbutton press' },
  { re: /^PB\d+_LED$/,            cls: 'status',   what: 'pushbutton lamp' },
  { re: /^PB\d+$/,                cls: 'operator', what: 'front-panel pushbutton' },
  { re: /^LB\d+$/,                cls: 'operator', what: 'local bit — set from the front panel or a communications port' },
  { re: /^(CC|OC)(\d|[ABC])?$/,   cls: 'operator', what: 'close or open command from a port — SCADA or the front port' },
  { re: /^(RB|RMB)\d+[A-D]?$/,    cls: 'external', what: 'bit from another device over communications' },
  { re: /^IN\d{3}$/,              cls: 'external', what: 'contact input — driven by external wiring' },
  { re: /^LT\d+$/,                cls: 'latch',    what: 'latch bit — a mode the site switches on and leaves on' },
  { re: /^SV\d+T$/,               cls: 'timer',    what: 'SELogic timer output' },
  { re: /^SV\d+$/,                cls: 'svar',     what: 'SELogic variable' },
  { re: /^SC\d+/,                 cls: 'counter',  what: 'SELogic counter' },
  { re: /^(TRIP|CLOSE|CF|ULCL|OC3|TRGTR)/, cls: 'relaystate', what: 'relay state' },
  { re: /^79/,                    cls: 'relaystate', what: 'ANSI 79 element state' },
  { re: /^52[AB]/,                cls: 'measured', what: 'interrupter position' },
  { re: /^(TCCAP|CHRGG|DISCHG|DISTST|BTFAIL|DTFAIL|TOSLP|PWR_SRC1)$/, cls: 'hardware', what: 'control hardware status' },
  { re: /^(FREQOK|FREQYOK|FREQZOK|VSELY|VSELZ|SF|SFAST|SSLOW|LOP|GNDSW|DD|SPE|3PO|SPO[ABC]?)$/, cls: 'measured', what: 'measured condition' },
  { re: /^(SAG|SW)[ABC]?$/,       cls: 'measured', what: 'measured voltage sag or swell' },
  { re: /^\d/,                    cls: 'measured', what: 'protection element' },
];

function ccClassify(name) {
  for (const c of CC_TERM_CLASSES) if (c.re.test(name)) return c;
  return { cls: 'other', what: 'relay word bit' };
}

// A term is "operator-driven" when a person has to act for it to go true, right now, for this
// close. A latch is not operator-driven: it was armed at some earlier time and stays armed.
function ccIsOperator(name) { return ccClassify(name).cls === 'operator'; }
function ccIsExternal(name) { return ccClassify(name).cls === 'external'; }

function ccSvByName(P, name) {
  const m = /^SV(\d+)T?$/.exec(name || '');
  if (!m) return null;
  return (P.svSettings || []).find(s => s.num === parseInt(m[1], 10)) || null;
}
function ccLatchByName(P, name) {
  const m = /^LT(\d+)$/.exec(name || '');
  if (!m) return null;
  return (P.latchSettings || []).find(l => l.num === parseInt(m[1], 10)) || null;
}

function ccLeaves(eq) {
  const clean = String(eq || '').split('#')[0].trim();
  if (!clean || /^[01]$/.test(clean) || /^NA$/i.test(clean)) return [];
  try { return llgCollectLeaves(llgParse(llgTokenize(clean))); } catch (e) { return []; }
}
function ccComment(eq) {
  const s = String(eq || '');
  return s.includes('#') ? s.split('#').slice(1).join('#').trim() : '';
}
// ════════════════════════════════════════════════════════════════════════════
// READING THE EQUATION
// ════════════════════════════════════════════════════════════════════════════
// SELogic equations also carry analog comparisons: "VAY >= 6840.00". The Boolean tokenizer
// does not know the comparison operators, so it stops at the first one and silently drops the
// rest of the line — which on one real file threw away the latch that selects automatic mode.
// Each comparison is therefore folded into a single placeholder term before the parse, and its
// original text is carried along so the reader still sees the condition as the site wrote it.
// The tool does not evaluate these from the record. It shows them and says it did not.
let CC_CMP_SEQ = 0;
function ccPrepEquation(eq) {
  const clean = String(eq || '').split('#')[0].trim();
  const comparisons = {};
  // The placeholder has to be unique across every equation in the file. Numbering from 1 in
  // each equation gives two different comparisons the same name, and the second one then
  // displays as the first.
  const text = clean.replace(/\b([A-Z][A-Z0-9_]*)\s*(>=|<=|<>|!=|>|<|=)\s*(-?\d+(?:\.\d+)?)/g,
    (m) => { const tok = `CCCMP${++CC_CMP_SEQ}`; comparisons[tok] = m.replace(/\s+/g, ' ').trim(); return tok; });
  return { text, comparisons };
}
function ccAst(eq) {
  const prep = ccPrepEquation(eq);
  if (!prep.text || /^[01]$/.test(prep.text) || /^NA$/i.test(prep.text)) return { node: null, comparisons: prep.comparisons, empty: true, raw: prep.text };
  try { return { node: llgParse(llgTokenize(prep.text)), comparisons: prep.comparisons, raw: prep.text }; }
  catch (e) { return { node: null, comparisons: prep.comparisons, failed: true, raw: prep.text }; }
}
function ccLeaves(eq) {
  const a = ccAst(eq);
  return a.node ? llgCollectLeaves(a.node) : [];
}
function ccComment(eq) {
  const s = String(eq || '');
  return s.includes('#') ? s.split('#').slice(1).join('#').trim() : '';
}

// ════════════════════════════════════════════════════════════════════════════
// BRANCH EXPANSION — EVERY SEPARATE WAY IN
// ════════════════════════════════════════════════════════════════════════════
// Classifying a whole chain at once gives the wrong answer whenever the operator path and the
// automatic path share it. One real close equation reads, in part:
//
//   SV01 := … AND ((PB11_PUL OR F_TRIG SV12T) AND LT02 OR SV11T) AND SV26T AND NOT LT04
//
// A pushbutton appears in that chain, so a chain-wide test calls the whole thing operator-run.
// It is not. The inner OR holds three separate ways in, and the third — SV11T, a six-minute
// window on healthy voltage — needs nobody. The trip report has to say so.
//
// So the equation is expanded into its OR branches instead, following each one down through
// the SELogic variables that feed it. Each branch that comes back is one complete way the
// device can close: its own trigger, its own timers, its own permissives. Then each branch is
// judged on its own.
//
// Three rules keep the expansion honest and finite:
//   * A negated term is never expanded. "NOT LT04" is a condition on the close, and pushing De
//     Morgan through it would turn one block into a list of imaginary ways in.
//   * A term already seen on this branch is a seal-in, not a new way in. "SV08 := (…) OR SV08
//     AND NOT SV08T" holds itself up; it cannot start anything. Those branches are marked and
//     kept out of the automatic/manual decision.
//   * Depth and branch count are capped. When the cap bites, the branch is flagged as cut
//     short rather than quietly presented as complete.
const CC_MAX_DEPTH = 5;
const CC_MAX_BRANCHES = 48;

function ccNewBranch() { return { terms: [], timers: [], route: [], sealIn: false }; }
function ccMergeBranch(a, b) {
  const out = ccNewBranch();
  out.terms = a.terms.concat(b.terms);
  out.timers = a.timers.concat(b.timers);
  out.route = a.route.concat(b.route.filter(r => !a.route.includes(r)));
  out.sealIn = a.sealIn || b.sealIn;
  // The text of any analog comparison has to travel with the branch. Without this the terms
  // reach the display as bare placeholders.
  if (a.comparisons || b.comparisons) out.comparisons = Object.assign({}, a.comparisons, b.comparisons);
  if (a.edge || b.edge) out.edge = a.edge || b.edge;
  return out;
}
function ccCross(A, B, state) {
  const out = [];
  for (const x of A) for (const y of B) {
    if (out.length >= CC_MAX_BRANCHES) { state.truncated = true; return out; }
    out.push(ccMergeBranch(x, y));
  }
  return out;
}

function ccExpand(P, node, depth, seen, state) {
  if (!node) return [ccNewBranch()];
  if (node.op === 'OR') {
    const l = ccExpand(P, node.l, depth, seen, state);
    const r = ccExpand(P, node.r, depth, seen, state);
    const all = l.concat(r);
    if (all.length > CC_MAX_BRANCHES) { state.truncated = true; return all.slice(0, CC_MAX_BRANCHES); }
    return all;
  }
  if (node.op === 'AND') {
    return ccCross(ccExpand(P, node.l, depth, seen, state), ccExpand(P, node.r, depth, seen, state), state);
  }
  if (node.op === 'NOT') {
    // Kept whole, never expanded. Every leaf under it becomes a negated condition.
    const b = ccNewBranch();
    b.terms = llgCollectLeaves(node.c).map(x => ({ name: x.name, mod: ('NOT ' + (x.mod || '')).trim(), negated: true }));
    return [b];
  }
  if (node.op === 'REDGE' || node.op === 'FEDGE') {
    const tag = node.op === 'REDGE' ? 'R_TRIG' : 'F_TRIG';
    const sub = ccExpand(P, node.c, depth, seen, state);
    // The edge is a property of the trigger, not of the conditions behind it. Mark the branch
    // so the text can say "on the falling edge of …" rather than implying a level.
    sub.forEach(b => { b.edge = tag; if (b.terms[0]) b.terms[0] = Object.assign({}, b.terms[0], { mod: (tag + ' ' + (b.terms[0].mod || '')).trim() }); });
    return sub;
  }
  if (node.op === 'VAR') {
    const name = node.name;
    if (!name || name === '__EMPTY__') return [ccNewBranch()];
    const b = ccNewBranch();
    if (seen.has(name)) { b.terms = [{ name, mod: '', negated: false, sealIn: true }]; b.sealIn = true; return [b]; }
    const sv = ccSvByName(P, name);
    if (sv && sv.equation && depth < CC_MAX_DEPTH) {
      const ast = ccAst(sv.equation);
      if (ast.node) {
        const nextSeen = new Set(seen); nextSeen.add(name); nextSeen.add(sv.label); nextSeen.add(sv.label + 'T');
        const sub = ccExpand(P, ast.node, depth + 1, nextSeen, state);
        sub.forEach(x => {
          x.route = [name].concat(x.route);
          if (sv.pickupDelay > 0) x.timers = [{ label: sv.label, setting: sv.label + 'PU', raw: sv.pickupDelay, comment: ccComment(sv.equation) }].concat(x.timers);
          Object.assign(x.comparisons = x.comparisons || {}, ast.comparisons);
        });
        return sub;
      }
    }
    b.terms = [{ name, mod: '', negated: false, unresolved: !!(sv === null && /^SV\d+T?$/.test(name)) }];
    return [b];
  }
  return [ccNewBranch()];
}

// What kind of way in this branch is. Only a term that is NOT negated can start a close: the
// difference between "a person pressed close" and "the switch is open" is the NOT.
function ccBranchKind(branch) {
  if (branch.sealIn) return 'seal-in';
  const live = branch.terms.filter(t => !t.negated);
  if (live.some(t => ccClassify(t.name).cls === 'operator')) return 'operator';
  if (live.some(t => ccClassify(t.name).cls === 'external')) return 'external';
  if (branch.timers.length) return 'automatic';
  if (live.some(t => ['measured', 'relaystate', 'hardware'].includes(ccClassify(t.name).cls) || /^CCCMP\d+$/.test(t.name))) return 'automatic';
  return 'unclear';
}

function ccDelayMs(P, raw) {
  const freq = (P.eventInfo && P.eventInfo.freq) || 60;
  if (typeof svDelayMs === 'function') return svDelayMs(P, raw, freq);
  return { ms: raw / freq * 1000, unit: 'cycles', assumed: true };
}
function ccFormatMs(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s % 1 === 0 ? s : s.toFixed(2)} s`;
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return `${s.toFixed(0)} s (${m} min${r ? ` ${r} s` : ''})`;
}

function ccEvalTerm(P, t, idx, comparisons) {
  const cmp = comparisons && comparisons[t.name];
  const cls = cmp ? 'measured' : ccClassify(t.name).cls;
  const base = { name: cmp || t.name, mod: t.mod || '', negated: !!t.negated, cls, sealIn: !!t.sealIn, unresolved: !!t.unresolved };
  if (cmp) {
    // An analog comparison. The tool shows it and does not pretend to evaluate it: the setting
    // is in relay units, the record is in another, and guessing between them is how a tool
    // reports a close as ready when it is not.
    return Object.assign(base, { state: null, known: false, satisfied: null, what: 'analog comparison — not evaluated from this record', analog: true });
  }
  const b = bitStateAtAnalogIdx(P, t.name, idx);
  const sv = ccSvByName(P, t.name);
  const latch = ccLatchByName(P, t.name);
  return Object.assign(base, {
    state: b.state, known: b.known,
    satisfied: b.known ? (t.negated ? !b.state : b.state) : null,
    what: (latch && latch.comment) || (sv && ccComment(sv.equation)) || ccClassify(t.name).what,
    equation: sv ? String(sv.equation).split('#')[0].trim() : null,
    latch,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN ANALYSIS
// ════════════════════════════════════════════════════════════════════════════
function analyzeCustomClose(P, A) {
  const sch = (P && P.reclose) || {};
  const out = {
    present: false, equations: [], paths: [], notes: [],
    e79raw: sch.E79raw != null ? sch.E79raw : null, enabled79: sch.enabled,
    hasAutomatic: false, hasOperator: false, hasExternal: false, custom: false,
    truncated: false, verdict: null,
  };

  // Every spelling of the close equation this relay uses. CL3P on a standard recloser; CLA and
  // CLB on an independent-pole recloser or on a control that pulses two switches in turn.
  let closes = sch.closeEquations || [];
  if (!closes.length && sch.eq && sch.eq.CL) closes = [{ name: sch.eqName.CL || 'CL', eq: sch.eq.CL }];
  if (!closes.length) {
    out.notes.push('This file carries no close equation (CL3P, CL, CLA, CLB or CLC), so the tool cannot say how this device closes.');
    return out;
  }

  const nSamples = (P.analogData || []).length;
  const endIdx = Math.max(0, nSamples - 1);
  out.endIdx = endIdx;

  closes.forEach(ce => {
    const ast = ccAst(ce.eq);
    if (ast.empty) {
      out.equations.push({ name: ce.name, eq: ce.eq, raw: ast.raw, disabled: true, branches: [] });
      return;
    }
    if (!ast.node) {
      out.equations.push({ name: ce.name, eq: ce.eq, raw: ast.raw, unreadable: true, branches: [] });
      out.notes.push(`${ce.name} could not be read as a Boolean equation, so it is shown as written and not analysed.`);
      return;
    }
    const state = { truncated: false };
    let branches = ccExpand(P, ast.node, 0, new Set([ce.name]), state);
    out.truncated = out.truncated || state.truncated;

    // Two branches with the same terms are one way in written twice.
    const seenSig = new Set();
    branches = branches.filter(b => {
      const sig = b.terms.map(t => (t.negated ? '!' : '') + t.name).sort().join('|');
      if (seenSig.has(sig)) return false;
      seenSig.add(sig); return true;
    });

    const comparisons = Object.assign({}, ast.comparisons);
    branches.forEach(b => Object.assign(comparisons, b.comparisons || {}));

    const built = branches.map(b => {
      const kind = ccBranchKind(b);
      const timers = b.timers.slice().sort((x, y) => y.raw - x.raw);
      const lead = timers[0] || null;
      const delay = lead ? Object.assign({ setting: lead.setting, raw: lead.raw, label: lead.label, comment: lead.comment }, ccDelayMs(P, lead.raw)) : null;
      // One condition can be reached twice on the same path — once from the close equation and
      // again from an SV under it. It is still one condition, and listing it twice makes a
      // clean path look busy and a blocking term look like two.
      const seenTerm = new Set();
      const terms = b.terms.filter(t => {
        const sig = (t.negated ? '!' : '') + t.name;
        if (seenTerm.has(sig)) return false;
        seenTerm.add(sig); return true;
      }).map(t => ccEvalTerm(P, t, endIdx, comparisons));
      const live = terms.filter(t => !t.negated);
      const trigger = kind === 'operator' ? live.filter(t => t.cls === 'operator')
        : kind === 'external' ? live.filter(t => t.cls === 'external')
          : (lead ? [{ name: lead.label + 'T', what: lead.comment, cls: 'timer' }] : live.filter(t => t.cls === 'measured'));
      const blocking = terms.filter(t => t.satisfied === false);
      return {
        eqName: ce.name, kind, terms, timers, delay, trigger,
        route: b.route, edge: b.edge || null, sealIn: b.sealIn, truncated: state.truncated,
        blocking, unknown: terms.filter(t => t.satisfied === null),
        ready: blocking.length === 0 ? (terms.some(t => t.satisfied === null) ? null : true) : false,
      };
    });

    out.equations.push({ name: ce.name, eq: ce.eq, comment: ccComment(ce.eq), branches: built, comparisons });
    out.paths = out.paths.concat(built);
  });

  out.present = out.equations.some(e => e.branches.length || e.disabled || e.unreadable);
  const real = out.paths.filter(p => p.kind !== 'seal-in');
  out.hasAutomatic = real.some(p => p.kind === 'automatic');
  out.hasOperator = real.some(p => p.kind === 'operator');
  out.hasExternal = real.some(p => p.kind === 'external');
  out.custom = out.hasAutomatic;

  // The automatic path that matters most is the one with the longest delay on it — that is the
  // enter-service window, the number an operator needs.
  const autos = real.filter(p => p.kind === 'automatic');
  const lead = autos.slice().sort((a, b) => ((b.delay && b.delay.ms) || 0) - ((a.delay && a.delay.ms) || 0))[0] || null;
  if (lead) {
    out.autoPathName = (lead.trigger[0] && lead.trigger[0].name) || lead.eqName;
    out.autoDelay = lead.delay;
    out.autoPath = lead;
    // "NOT TRIP3P" reads as a block on almost every trip record, and it is not one. The relay
    // holds its own trip output for a fixed minimum time, longer than a short capture, so the
    // term is still asserted at the last sample of nearly every record and clears by itself.
    const transient = (n) => /^(TRIP|CLOSE|CF)/.test(n || '');
    out.blockingTransient = lead.blocking.filter(t => transient(t.name));
    out.blockingDurable = lead.blocking.filter(t => !transient(t.name));
    out.readyAtEnd = out.blockingDurable.length ? false : (lead.unknown.length ? null : true);
  }

  if (out.truncated) out.notes.push('This close equation has more branches than the tool expands. The paths below are part of the picture, not all of it.');

  const unresolved = out.paths.flatMap(p => p.terms).filter(t => t.unresolved).map(t => t.name);
  if (unresolved.length) {
    out.notes.push(`These terms are used in the close logic but their equations are not in this file: ${[...new Set(unresolved)].join(', ')}. The tool cannot say what drives them.`);
  }

  // ULCL cancels a close after the relay issues it.
  const unlatches = sch.unlatchEquations || [];
  unlatches.forEach(u => {
    if (typeof rcEvalEquation !== 'function') return;
    const r = rcEvalEquation(P, u.eq, endIdx);
    if (r && r.value === true) out.notes.push(`${u.name} is asserted at the end of the record. While it stays asserted, the relay cancels a close as soon as it gives it.`);
  });

  out.verdict = ccBuildVerdict(out, P);
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// VERDICT
// ════════════════════════════════════════════════════════════════════════════
function ccBuildVerdict(cc, P) {
  const V = (kind, tone, headline, detail) => ({ kind, tone, headline, detail });
  if (!cc.present) return null;

  const off79 = cc.enabled79 === false;
  const lead = cc.autoPath;
  // Name only the equations that hold a path. An equation set to 0 is reported separately
  // rather than folded into a list that implies it does something.
  const live = cc.equations.filter(e => e.branches.length).map(e => e.name);
  const names = live.length > 1 ? live.slice(0, -1).join(', ') + ' and ' + live[live.length - 1] : (live[0] || '—');

  const delayText = () => {
    if (!lead || !lead.delay) return '';
    const star = lead.delay.assumed ? '*' : '';
    return ` The longest timer on that path is ${ccFormatMs(lead.delay.ms)}${star} (${lead.delay.setting} = ${lead.delay.raw}).`;
  };
  const unitsNote = () => (lead && lead.delay && lead.delay.assumed)
    ? ' * No timer ran inside this record, so the tool cannot confirm the units of the setting. It reads the value as cycles.' : '';
  const stateText = () => {
    let s = '';
    if (cc.readyAtEnd === false) {
      const names = [...new Set(cc.blockingDurable.map(b => `${b.negated ? 'NOT ' : ''}${b.name}`))];
      const shown = names.slice(0, 3).join(', ');
      s += ` At the last sample of the record, ${shown}${names.length > 3 ? ` and ${names.length - 3} more condition(s)` : ''} held the close back.`;
    }
    else if (cc.readyAtEnd === true) s += ' At the last sample of the record, every condition on that path was met.';
    if (cc.blockingTransient && cc.blockingTransient.length) s += ` ${cc.blockingTransient.map(b => b.name).join(' and ')} was still asserted when the record ended. The relay holds its trip output for a set minimum time, so that clears by itself.`;
    return s;
  };

  if (lead && off79) {
    return V('custom-auto', 'warn',
      'This device can close by itself. Custom logic does it, not the 79 element.',
      `E79 := ${cc.e79raw}. The ANSI 79 reclosing element is off, so the Reclosing tab above has no sequence to show. `
      + `The close equation ${names} has a path that needs no operator action. ${(lead.trigger[0] && lead.trigger[0].name) || lead.eqName} starts it.`
      + (lead.delay && lead.delay.comment ? ` The site comment on that timer reads: ${lead.delay.comment}.` : '')
      + delayText() + ' The close still waits for the conditions listed below.' + stateText()
      + ' This record ends long before the close is due, so the tool cannot say if the close happened.' + unitsNote());
  }
  if (lead && cc.enabled79 === true) {
    return V('custom-plus-79', 'warn',
      'This device has two automatic close paths.',
      `The ANSI 79 element is on (E79 := ${cc.e79raw}). The close equation ${names} also has a path that needs no operator action. ${(lead.trigger[0] && lead.trigger[0].name) || lead.eqName} starts it.`
      + delayText() + ' Read the two together. A device can close from the custom path after the 79 element has gone to lockout.' + unitsNote());
  }
  if (lead) {
    return V('custom-auto-unknown79', 'warn',
      'This device can close by itself through custom logic.',
      `This file has no E79 setting, so the tool cannot say if the 79 element is used. The close equation ${names} has a path that needs no operator action. ${(lead.trigger[0] && lead.trigger[0].name) || lead.eqName} starts it.`
      + delayText() + unitsNote());
  }
  if (cc.hasExternal && off79) {
    const ext = cc.paths.filter(p => p.kind === 'external').flatMap(p => p.trigger.map(t => t.name));
    return V('external', 'unknown',
      'An external signal can close this device.',
      `E79 := ${cc.e79raw}. The 79 element is off. The close equation ${names} can be started by ${[...new Set(ext)].join(', ')}. `
      + 'What drives that signal is outside this file, so the tool cannot say if the close is automatic or manual.');
  }
  if (cc.hasOperator && off79) {
    const ops = cc.paths.filter(p => p.kind === 'operator').flatMap(p => p.trigger.map(t => t.name));
    return V('manual-only', 'bad',
      'Only an operator can close this device.',
      `E79 := ${cc.e79raw}. The 79 element is off. Every path in the close equation ${names} needs an operator action: ${[...new Set(ops)].join(', ')}. `
      + 'The device stays open until a person closes it.');
  }
  if (off79) {
    return V('manual-only', 'bad',
      'The tool found no automatic close path.',
      `E79 := ${cc.e79raw}. The 79 element is off, and no path in the close equation ${names} goes true without an operator action or an external signal.`);
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// RENDERING — CUSTOM CLOSE CARD
// ════════════════════════════════════════════════════════════════════════════
const CC_TONE = {
  warn:    { color: 'var(--yellow)', bg: 'var(--yellow-dim)', border: '#5c4506', icon: '⏱️' },
  bad:     { color: 'var(--red)',    bg: 'var(--red-dim)',    border: '#5c1414', icon: '⛔' },
  ok:      { color: 'var(--green)',  bg: 'var(--green-dim)',  border: '#0a3d2a', icon: '🔄' },
  unknown: { color: 'var(--accent)', bg: 'var(--accent-dim)', border: '#123a5c', icon: '❔' },
};
const CC_KIND_LABEL = {
  automatic: { text: 'AUTOMATIC — no operator action', color: 'var(--yellow)',   bg: 'var(--yellow-dim)', border: '#5c4506' },
  operator:  { text: 'OPERATOR — needs a person',      color: 'var(--accent)',   bg: 'var(--accent-dim)', border: '#123a5c' },
  external:  { text: 'EXTERNAL — source not in file',  color: 'var(--text-dim)', bg: 'transparent',       border: 'var(--card-border)' },
  'seal-in': { text: 'SEAL-IN — holds, cannot start',  color: 'var(--text-muted)', bg: 'transparent',     border: 'var(--card-border)' },
  unclear:   { text: 'UNCLEAR',                        color: 'var(--text-dim)', bg: 'transparent',       border: 'var(--card-border)' },
};

function ccTermChip(t, P) {
  const color = t.satisfied == null ? 'var(--text-muted)' : (t.satisfied ? 'var(--green)' : 'var(--red)');
  const bg = t.satisfied == null ? 'transparent' : (t.satisfied ? 'var(--green-dim)' : 'var(--red-dim)');
  const mark = t.satisfied == null ? '?' : (t.satisfied ? '✓' : '✕');
  const title = `${t.name} — ${t.what || 'relay word bit'}. `
    + (t.equation ? `${t.name} := ${t.equation}. ` : '')
    + (t.analog ? 'The tool does not evaluate analog comparisons from the record.'
      : (t.known ? `It is ${t.state ? 'asserted' : 'not asserted'} at the end of the record.` : 'This record does not carry this bit.'))
    + (t.negated ? ' The equation uses NOT, so the close needs this bit low.' : '');
  const label = (!t.analog && typeof tt === 'function') ? tt(t.name, P) : t.name;
  return `<span title="${typeof escapeAttr === 'function' ? escapeAttr(title) : title}"
    style="display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:4px;font-family:var(--mono);font-size:11px;color:${color};background:${bg};border:1px solid ${color}33;margin:2px 4px 2px 0;">
    ${t.negated ? '<span style="opacity:0.75">NOT</span> ' : ''}${label} <span style="font-weight:700">${mark}</span></span>`;
}

function ccBranchBlock(b, P) {
  const k = CC_KIND_LABEL[b.kind] || CC_KIND_LABEL.unclear;
  const trig = b.trigger.map(t => t.name).join(', ');
  const chips = [];
  if (b.delay) chips.push(`<div class="timing-chip"><span class="label">Longest timer:</span> <span class="value">${ccFormatMs(b.delay.ms)}${b.delay.assumed ? '*' : ''} (${b.delay.setting} = ${b.delay.raw})</span></div>`);
  if (trig) chips.push(`<div class="timing-chip"><span class="label">Started by:</span> <span class="value">${b.edge ? b.edge + ' ' : ''}${trig}</span></div>`);
  if (b.route.length > 1) chips.push(`<div class="timing-chip"><span class="label">Route:</span> <span class="value">${b.eqName} → ${b.route.join(' → ')}</span></div>`);
  const ready = b.kind === 'seal-in' ? ''
    : `<div class="timing-chip"><span class="label">At the end of the record:</span> <span class="value">${b.ready === true ? 'every condition met' : (b.ready === false ? b.blocking.length + ' condition(s) not met' : 'not all conditions are recorded')}</span></div>`;

  return `<div style="background:${k.bg};border:1px solid ${k.border};border-radius:6px;padding:11px 13px;margin-bottom:9px;">
    <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:6px;">
      <span style="font-family:var(--mono);font-size:13px;font-weight:700;color:${k.color};">${b.eqName}${b.route.length ? ' ← ' + b.route[b.route.length - 1] : ''}</span>
      <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:0.06em;color:${k.color};border:1px solid ${k.color}55;">${k.text}</span>
    </div>
    ${b.delay && b.delay.comment ? `<div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">Site comment on the timer: ${b.delay.comment}</div>` : ''}
    <div class="trip-timing" style="margin:0 0 7px;">${chips.join('')}${ready}</div>
    <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:3px;">Conditions on this path, as recorded at the last sample:</div>
    <div>${b.terms.map(t => ccTermChip(t, P)).join('')}</div>
  </div>`;
}

function buildCustomCloseCard(P, A) {
  const cc = A && A.customClose;
  if (!cc || !cc.present) return '';
  // A device with a normal, enabled 79 scheme and no separate automatic path is already fully
  // described by the Reclosing tab above.
  if (!cc.custom && cc.enabled79 !== false) return '';

  const v = cc.verdict || {};
  const tone = CC_TONE[v.tone] || CC_TONE.unknown;

  const eqBlocks = cc.equations.map(e => {
    const eqHTML = typeof linkifyEquationBits === 'function'
      ? linkifyEquationBits(String(e.eq).split('#')[0].trim(), P) : String(e.eq).split('#')[0].trim();
    // Order the ways in so the one that matters reads first.
    const rank = { automatic: 0, external: 1, operator: 2, unclear: 3, 'seal-in': 4 };
    const branches = e.branches.slice().sort((a, b) => rank[a.kind] - rank[b.kind]).slice(0, 8);
    return `<div style="margin-top:14px;">
      <div class="code-block" style="font-size:11.5px;padding:8px 10px;">${e.name} := ${eqHTML}</div>
      ${e.comment ? `<div style="font-size:11.5px;color:var(--text-muted);margin:5px 0 8px;">Site comment: ${e.comment}</div>` : '<div style="height:8px"></div>'}
      ${e.disabled ? `<div style="font-size:12px;color:var(--text-dim);">This equation is set to ${e.raw}. It cannot close the device.</div>` : ''}
      ${e.unreadable ? `<div style="font-size:12px;color:var(--text-dim);">The tool could not read this equation. It is shown above as the file writes it.</div>` : ''}
      ${branches.map(b => ccBranchBlock(b, P)).join('')}
      ${e.branches.length > 8 ? `<div style="font-size:11px;color:var(--text-muted);">${e.branches.length - 8} more path(s) are not shown.</div>` : ''}
    </div>`;
  }).join('');

  return `<div class="card" style="border-top:3px solid ${tone.color};">
    <div class="card-header">🧩 Close Logic Outside the 79 Element</div>
    <div style="display:flex;align-items:flex-start;gap:12px;">
      <div style="font-size:26px;line-height:1;">${tone.icon}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:16px;font-weight:700;color:${tone.color};line-height:1.35;">${v.headline || ''}</div>
        <p style="font-size:13px;color:var(--text-dim);line-height:1.65;margin-top:8px;">${v.detail || ''}</p>
      </div>
    </div>
    ${eqBlocks}
    <div style="margin-top:12px;padding:10px 12px;border:1px solid var(--card-border);border-radius:6px;font-size:11px;color:var(--text-muted);line-height:1.55;">
      Green = the condition was met at the last sample of this record. Red = it was not. Grey = the record does not carry it, or it is an analog comparison the tool does not evaluate.
      The close falls after this record ends, so these states show that moment only.
      The tool reports what the close logic permits. It does not predict a close. A latch bit (LT) is read as a mode switch, not as an operator action.
    </div>
    ${cc.notes.map(n => `<div style="margin-top:10px;padding:10px 12px;background:var(--yellow-dim);border:1px solid #5c4506;border-radius:6px;font-size:12px;color:var(--text-dim);line-height:1.55;">${n}</div>`).join('')}
  </div>`;
}
