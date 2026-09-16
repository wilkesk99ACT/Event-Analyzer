

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

// Walks a close term down through the SVs that feed it and reports what kinds of input the
// whole chain rests on. Latches are NOT walked into: a latch is a mode, and what set the mode
// is reported separately rather than counted as an input to this close.
//
// Depth is capped and visited names are remembered, because SELogic self-holds ("SV08 := … OR
// SV08 AND NOT SV08T") are normal and would otherwise recurse forever.
function ccWalk(P, name, depth, seen, out) {
  depth = depth || 0;
  seen = seen || new Set();
  out = out || { operator: [], external: [], measured: [], latches: [], hardware: [], timers: [], relaystate: [], other: [], selfHold: false };
  if (depth > 4 || seen.has(name)) { if (seen.has(name)) out.selfHold = true; return out; }
  seen.add(name);

  const k = ccClassify(name);
  const sv = (k.cls === 'timer' || k.cls === 'svar') ? ccSvByName(P, name) : null;

  if (sv) {
    if (k.cls === 'timer' && sv.pickupDelay > 0) out.timers.push({ label: sv.label, setting: sv.label + 'PU', raw: sv.pickupDelay });
    ccLeaves(sv.equation).forEach(l => ccWalk(P, l.name, depth + 1, seen, out));
    return out;
  }
  switch (k.cls) {
    case 'operator':   out.operator.push(name); break;
    case 'external':   out.external.push(name); break;
    case 'latch':      out.latches.push(name); break;
    case 'hardware':   out.hardware.push(name); break;
    case 'measured':   out.measured.push(name); break;
    case 'relaystate': out.relaystate.push(name); break;
    default:           out.other.push(name);
  }
  return out;
}

// Milliseconds for an SV timer setting, using the file's own measured evidence for the units
// where the record offers any. `assumed` stays true when it does not, and the caller must
// caveat the number rather than state it.
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

// One term of an equation, with what it was doing at a given sample. `satisfied` accounts for
// NOT: a term written "NOT LT04" is satisfied when LT04 is low.
function ccEvalLeaf(P, leaf, idx) {
  const b = bitStateAtAnalogIdx(P, leaf.name, idx);
  const negated = /\bNOT\b/.test(leaf.mod || '');
  return {
    name: leaf.name, mod: leaf.mod || '', negated,
    state: b.state, known: b.known,
    satisfied: b.known ? (negated ? !b.state : b.state) : null,
    cls: ccClassify(leaf.name).cls,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN ANALYSIS
// ════════════════════════════════════════════════════════════════════════════
function analyzeCustomClose(P, A) {
  const sch = (P && P.reclose) || { eq: {}, eqName: {} };
  const out = {
    present: false, closeName: null, closeEq: null, closeComment: '',
    unlatchName: sch.eqName ? sch.eqName.ULCL : null, unlatchEq: sch.eq ? sch.eq.ULCL : null,
    e79raw: sch.E79raw != null ? sch.E79raw : null,
    enabled79: sch.enabled,
    paths: [], permissives: [], notes: [],
    hasAutomatic: false, hasOperator: false, hasExternal: false,
    custom: false, verdict: null,
  };

  const closeEq = sch.eq ? sch.eq.CL : null;
  if (!closeEq) return out;
  const clean = String(closeEq).split('#')[0].trim();
  if (!clean || /^0$/.test(clean) || /^NA$/i.test(clean)) {
    out.closeName = sch.eqName.CL;
    out.closeEq = closeEq;
    out.notes.push(`${sch.eqName.CL || 'CL'} := ${clean || 'empty'}. The relay has no close equation. It cannot close from its own logic.`);
    return out;
  }

  out.present = true;
  out.closeName = sch.eqName.CL || 'CL';
  out.closeEq = closeEq;
  out.closeComment = ccComment(closeEq);

  const nSamples = (P.analogData || []).length;
  const endIdx = Math.max(0, nSamples - 1);
  out.endIdx = endIdx;

  const leaves = ccLeaves(closeEq);
  // De-duplicate: a term repeated in two places is one condition, not two.
  const uniq = [];
  leaves.forEach(l => { if (!uniq.some(u => u.name === l.name && u.mod === l.mod)) uniq.push(l); });

  // ── Which terms START a close, and which only PERMIT one ────────────────────
  // A permissive is a condition the close waits on — voltage in band, capacitor charged, no
  // hot line tag. An initiator is the term that goes true and makes the close happen. Timers,
  // SELogic variables, operator commands and 79 states can initiate; a measured element or a
  // hardware status, on its own, cannot — it is the thing being waited for.
  //
  // An SV needs a further test, because SELogic is used for both jobs. "SV11 := 27ZA3 AND
  // 27ZB3 AND 27ZC3" is a voltage-window check written as a variable for readability — a
  // permissive with a different name. "SV09 := … " with an 18000-count pickup is a window that
  // expires and lets the close through — an initiator. What separates them is a timer, a
  // seal-in, or a command somewhere in the chain. Without that test every named permissive is
  // reported as a separate automatic close path, which reads as several ways in where there is
  // only one.
  const initiatorKinds = new Set(['timer', 'svar', 'operator', 'external', 'relaystate', 'counter']);
  const ccIsInitiator = (name) => {
    const cls = ccClassify(name).cls;
    if (!initiatorKinds.has(cls)) return false;
    if (cls !== 'timer' && cls !== 'svar') return true;
    const sv = ccSvByName(P, name);
    if (!sv) return false;
    if (/T$/.test(name) && sv.pickupDelay > 0) return true;     // the timed output of a real timer
    const chain = ccWalk(P, name);
    return sv.pickupDelay > 0 || chain.selfHold || chain.operator.length > 0 || chain.external.length > 0;
  };
  const initiators = uniq.filter(l => !/\bNOT\b/.test(l.mod || '') && ccIsInitiator(l.name)
                                      && !/^(TRIP|CF|ULCL)/.test(l.name));
  const permissives = uniq.filter(l => !initiators.includes(l));

  out.permissives = permissives.map(l => {
    const ev = ccEvalLeaf(P, l, endIdx);
    ev.what = ccClassify(l.name).what;
    ev.latch = ccLatchByName(P, l.name);
    // A permissive written as an SV is opaque under its own name. Carry its equation and the
    // site's comment with it so the reader does not have to go and look the variable up.
    const sv = ccSvByName(P, l.name);
    if (sv) {
      ev.equation = String(sv.equation).split('#')[0].trim();
      ev.what = ccComment(sv.equation) || ev.what;
    }
    if (ev.latch && ev.latch.comment) ev.what = ev.latch.comment;
    return ev;
  });

  // ── Classify every initiating path ──────────────────────────────────────────
  initiators.forEach(l => {
    const chain = ccWalk(P, l.name);
    const sv = ccSvByName(P, l.name);
    const kind = chain.operator.length ? 'operator'
      : (chain.external.length ? 'external'
        : ((chain.measured.length || chain.timers.length || chain.hardware.length) ? 'automatic' : 'unclear'));

    // The delay the path runs on is the longest timer in its chain. A shorter timer nested
    // under it has already expired by the time the long one does, so quoting the longest is
    // the honest single number; the full list is kept for the detail table.
    const timers = chain.timers.slice().sort((a, b) => b.raw - a.raw);
    const lead = timers[0] || null;
    const delay = lead ? Object.assign({ setting: lead.setting, raw: lead.raw, label: lead.label }, ccDelayMs(P, lead.raw)) : null;

    const conds = sv ? ccLeaves(sv.equation).map(x => {
      const ev = ccEvalLeaf(P, x, endIdx);
      ev.what = ccClassify(x.name).what;
      ev.latch = ccLatchByName(P, x.name);
      ev.selfHold = ev.name === sv.label;
      return ev;
    }) : [];

    out.paths.push({
      name: l.name, kind, sv: sv ? sv.label : null,
      equation: sv ? String(sv.equation).split('#')[0].trim() : null,
      comment: sv ? ccComment(sv.equation) : '',
      delay, timers, chain, conditions: conds,
      operatorTerms: chain.operator.filter((v, i, a) => a.indexOf(v) === i),
      externalTerms: chain.external.filter((v, i, a) => a.indexOf(v) === i),
      latchTerms: chain.latches.filter((v, i, a) => a.indexOf(v) === i),
      stateAtEnd: ccEvalLeaf(P, l, endIdx),
    });
  });

  // A close equation with no initiating term at all is itself a scheme: the relay closes
  // whenever the measured conditions are met. Report it as automatic, and say plainly that no
  // timer was found rather than inventing one.
  if (!out.paths.length && permissives.length) {
    const anyMeasured = permissives.some(p => p.cls === 'measured');
    if (anyMeasured) {
      out.paths.push({
        name: out.closeName, kind: 'automatic', sv: null, equation: clean, comment: out.closeComment,
        delay: null, timers: [], chain: null, conditions: out.permissives,
        operatorTerms: [], externalTerms: [], latchTerms: [], stateAtEnd: null, wholeEquation: true,
      });
    }
  }

  out.hasAutomatic = out.paths.some(p => p.kind === 'automatic');
  out.hasOperator = out.paths.some(p => p.kind === 'operator');
  out.hasExternal = out.paths.some(p => p.kind === 'external');
  // "Custom" means: this device can close itself, and the ANSI 79 element is not what does it.
  out.custom = out.hasAutomatic;

  // ── Is the automatic path ready, as of the last sample? ─────────────────────
  // Not "will it close" — the close falls after the record ends. Only "what was standing in
  // the way when the recording stopped".
  const auto = out.paths.find(p => p.kind === 'automatic');
  if (auto) {
    const all = (auto.conditions || []).concat(out.permissives)
      .filter(c => !c.selfHold)
      .filter((v, i, a) => a.findIndex(x => x.name === v.name && x.negated === v.negated) === i);
    out.blockingAtEnd = all.filter(c => c.satisfied === false);
    out.unknownAtEnd = all.filter(c => c.satisfied === null);
    // "NOT TRIP3P" reads as a block on almost every trip record, and it is not one. The relay
    // holds its own trip output for a fixed minimum time (TDURD), which is longer than a short
    // capture — so the term is still asserted at the last sample of nearly every record, and it
    // clears by itself a fraction of a second later. Reporting that as the thing keeping the
    // device open would bury a real block on a line condition, which is what the reader needs.
    const transient = (n) => /^(TRIP|CLOSE|CF)/.test(n || '');
    out.blockingTransient = out.blockingAtEnd.filter(c => transient(c.name));
    out.blockingDurable = out.blockingAtEnd.filter(c => !transient(c.name));
    out.readyAtEnd = out.blockingDurable.length === 0 && out.unknownAtEnd.length === 0 ? true
      : (out.blockingDurable.length ? false : null);
    out.autoPathName = auto.name;
    out.autoDelay = auto.delay;
  }

  // ── Unlatch close ───────────────────────────────────────────────────────────
  // ULCL cancels a close after it is issued. It matters to an automatic path in the same way
  // it matters to a 79 close, so it is evaluated here too when the 79 tab is not doing it.
  if (out.unlatchEq && typeof rcEvalEquation === 'function') {
    const u = rcEvalEquation(P, out.unlatchEq, endIdx);
    if (u && u.value === true) {
      out.notes.push(`${out.unlatchName} is asserted at the end of the record. While it stays asserted, a close command is cancelled as soon as the relay gives it.`);
    }
    out.unlatchAtEnd = u;
  }

  out.verdict = ccBuildVerdict(out, P);
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// VERDICT
// ════════════════════════════════════════════════════════════════════════════
// Written in short sentences, active voice, one idea per sentence — the same rules the rest
// of the operator-facing text in this tool follows.
function ccBuildVerdict(cc, P) {
  const V = (kind, tone, headline, detail) => ({ kind, tone, headline, detail });
  if (!cc.present) return null;

  const auto = cc.paths.find(p => p.kind === 'automatic');
  const opPaths = cc.paths.filter(p => p.kind === 'operator');
  const extPaths = cc.paths.filter(p => p.kind === 'external');
  const off79 = cc.enabled79 === false;

  const delayText = (p) => {
    if (!p || !p.delay) return '';
    const star = p.delay.assumed ? '*' : '';
    return ` The delay is ${ccFormatMs(p.delay.ms)}${star} (${p.delay.setting} = ${p.delay.raw}).`;
  };
  const unitsNote = (p) => (p && p.delay && p.delay.assumed)
    ? ' * No timer ran in this record, so the tool cannot confirm the units of the setting. It shows the value read as cycles.'
    : '';

  if (auto && off79) {
    return V('custom-auto', 'warn',
      'This device can close by itself. Custom logic does it, not the 79 element.',
      `E79 := ${cc.e79raw}. The ANSI 79 reclosing element is off, so the Reclosing tab above has no sequence to show. `
      + `The close equation ${cc.closeName} has a path that needs no operator action: ${auto.name}`
      + (auto.comment ? ` (${auto.comment.toLowerCase()})` : '') + '.'
      + delayText(auto)
      + ` The close still waits for the permissive conditions listed below.`
      + (cc.readyAtEnd === false
        ? ` At the last sample of the record, ${cc.blockingDurable.map(b => `${b.negated ? 'NOT ' : ''}${b.name}`).join(' and ')} held the close back.`
        : (cc.readyAtEnd === true ? ` At the last sample of the record, every one of those conditions was met.` : ''))
      + ((cc.blockingTransient && cc.blockingTransient.length)
        ? ` ${cc.blockingTransient.map(b => b.name).join(' and ')} was still asserted when the record ended. The relay holds its trip output for a set minimum time, so that clears by itself.`
        : '')
      + ` This record ends long before the close is due, so the tool cannot say if the close happened.`
      + unitsNote(auto));
  }
  if (auto && cc.enabled79 === true) {
    return V('custom-plus-79', 'warn',
      'This device has two automatic close paths.',
      `The ANSI 79 element is on (E79 := ${cc.e79raw}). The close equation ${cc.closeName} also has a path that needs no operator action: ${auto.name}`
      + (auto.comment ? ` (${auto.comment.toLowerCase()})` : '') + '.'
      + delayText(auto)
      + ` Read the two together. A device can close from the custom path after the 79 element has gone to lockout.`
      + unitsNote(auto));
  }
  if (auto) {
    return V('custom-auto-unknown79', 'warn',
      'This device can close by itself through custom logic.',
      `This file has no E79 setting, so the tool cannot say if the 79 element is used. The close equation ${cc.closeName} has a path that needs no operator action: ${auto.name}.`
      + delayText(auto) + unitsNote(auto));
  }
  if (extPaths.length && off79) {
    return V('external', 'unknown',
      'An external signal can close this device.',
      `E79 := ${cc.e79raw}. The 79 element is off. The close equation ${cc.closeName} can be started by ${extPaths.map(p => p.externalTerms.join(', ')).join(', ')}. `
      + `What drives that signal is outside this file, so the tool cannot say if the close is automatic or manual.`);
  }
  if (opPaths.length && off79) {
    return V('manual-only', 'bad',
      'Only an operator can close this device.',
      `E79 := ${cc.e79raw}. The 79 element is off. Every path in the close equation ${cc.closeName} needs an operator action: `
      + `${opPaths.map(p => `${p.name} needs ${p.operatorTerms.join(' or ')}`).join('; ')}. `
      + `The device stays open until a person closes it.`);
  }
  if (off79) {
    return V('manual-only', 'bad',
      'The tool found no automatic close path.',
      `E79 := ${cc.e79raw}. The 79 element is off, and no path in the close equation ${cc.closeName} goes true without an operator action or an external signal.`);
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
  automatic: { text: 'AUTOMATIC — no operator action', color: 'var(--yellow)', bg: 'var(--yellow-dim)', border: '#5c4506' },
  operator:  { text: 'OPERATOR — needs a person',      color: 'var(--accent)', bg: 'var(--accent-dim)', border: '#123a5c' },
  external:  { text: 'EXTERNAL — source not in file',  color: 'var(--text-dim)', bg: 'transparent',     border: 'var(--card-border)' },
  unclear:   { text: 'UNCLEAR',                        color: 'var(--text-dim)', bg: 'transparent',     border: 'var(--card-border)' },
};

function ccTermChip(t, P) {
  const color = t.satisfied == null ? 'var(--text-muted)' : (t.satisfied ? 'var(--green)' : 'var(--red)');
  const bg = t.satisfied == null ? 'transparent' : (t.satisfied ? 'var(--green-dim)' : 'var(--red-dim)');
  const mark = t.satisfied == null ? '?' : (t.satisfied ? '✓' : '✕');
  const title = `${t.name} — ${t.what || 'relay word bit'}. `
    + (t.equation ? `${t.name} := ${t.equation}. ` : '')
    + (t.known ? `It is ${t.state ? 'asserted' : 'not asserted'} at the end of the record.` : 'This record does not carry this bit.')
    + (t.negated ? ' The equation uses NOT, so the close needs this bit low.' : '');
  const label = typeof tt === 'function' ? tt(t.name, P) : t.name;
  return `<span title="${typeof escapeAttr === 'function' ? escapeAttr(title) : title}"
    style="display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:4px;font-family:var(--mono);font-size:11px;color:${color};background:${bg};border:1px solid ${color}33;margin:2px 4px 2px 0;">
    ${t.negated ? '<span style="opacity:0.75">NOT</span> ' : ''}${label} <span style="font-weight:700">${mark}</span></span>`;
}

function ccPathBlock(p, P) {
  const k = CC_KIND_LABEL[p.kind] || CC_KIND_LABEL.unclear;
  const eq = p.equation
    ? (typeof linkifyEquationBits === 'function' ? linkifyEquationBits(p.equation, P) : p.equation)
    : '';
  const delay = p.delay
    ? `<div class="timing-chip"><span class="label">Delay:</span> <span class="value">${ccFormatMs(p.delay.ms)}${p.delay.assumed ? '*' : ''} (${p.delay.setting} = ${p.delay.raw})</span></div>` : '';
  const needs = p.kind === 'operator'
    ? `<div class="timing-chip"><span class="label">Needs:</span> <span class="value">${p.operatorTerms.join(', ')}</span></div>`
    : (p.kind === 'external'
      ? `<div class="timing-chip"><span class="label">Needs:</span> <span class="value">${p.externalTerms.join(', ')}</span></div>` : '');
  const arm = p.latchTerms.length
    ? `<div class="timing-chip"><span class="label">Mode switches:</span> <span class="value">${p.latchTerms.join(', ')}</span></div>` : '';

  return `<div style="background:${k.bg};border:1px solid ${k.border};border-radius:6px;padding:11px 13px;margin-bottom:9px;">
    <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:5px;">
      <span style="font-family:var(--mono);font-size:13px;font-weight:700;color:${k.color};">${p.name}</span>
      <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:0.06em;color:${k.color};border:1px solid ${k.color}55;">${k.text}</span>
    </div>
    ${p.comment ? `<div style="font-size:12px;color:var(--text-dim);margin-bottom:6px;">Site comment: ${p.comment}</div>` : ''}
    ${eq ? `<div class="code-block" style="margin:4px 0 7px;font-size:11px;padding:6px 9px;">${p.sv || p.name} := ${eq}</div>` : ''}
    ${(delay || needs || arm) ? `<div class="trip-timing" style="margin:0 0 7px;">${delay}${needs}${arm}</div>` : ''}
    ${(p.conditions && p.conditions.length) ? `<div style="font-size:11.5px;color:var(--text-muted);margin-bottom:3px;">Conditions, as recorded at the last sample:</div>
      <div>${p.conditions.filter(c => !c.selfHold).map(c => ccTermChip(c, P)).join('')}</div>` : ''}
  </div>`;
}

function buildCustomCloseCard(P, A) {
  const cc = A && A.customClose;
  if (!cc || !cc.present) return '';
  // Nothing to add when the device has a normal 79 scheme and no separate automatic path —
  // the Reclosing tab above already tells that story.
  if (!cc.custom && cc.enabled79 !== false) return '';

  const v = cc.verdict || {};
  const tone = CC_TONE[v.tone] || CC_TONE.unknown;
  const closeEqHTML = typeof linkifyEquationBits === 'function'
    ? linkifyEquationBits(String(cc.closeEq).split('#')[0].trim(), P)
    : String(cc.closeEq).split('#')[0].trim();

  const permis = cc.permissives.filter(p => p.cls !== 'latch' || true);

  return `<div class="card" style="border-top:3px solid ${tone.color};">
    <div class="card-header">🧩 Close Logic Outside the 79 Element</div>
    <div style="display:flex;align-items:flex-start;gap:12px;">
      <div style="font-size:26px;line-height:1;">${tone.icon}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:16px;font-weight:700;color:${tone.color};line-height:1.35;">${v.headline || ''}</div>
        <p style="font-size:13px;color:var(--text-dim);line-height:1.65;margin-top:8px;">${v.detail || ''}</p>
      </div>
    </div>

    <div style="margin-top:14px;font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--text);margin-bottom:6px;">Close equation</div>
    <div class="code-block" style="font-size:11.5px;padding:8px 10px;">${cc.closeName} := ${closeEqHTML}</div>
    ${cc.closeComment ? `<div style="font-size:11.5px;color:var(--text-muted);margin-top:5px;">Site comment: ${cc.closeComment}</div>` : ''}

    ${cc.paths.length ? `<div style="margin-top:16px;font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--text);margin-bottom:8px;">Paths that can start a close</div>
      ${cc.paths.map(p => ccPathBlock(p, P)).join('')}` : ''}

    ${permis.length ? `<div style="margin-top:4px;font-size:12px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;color:var(--text);margin-bottom:6px;">Conditions every close must meet</div>
      <div style="background:var(--card-bg-2, transparent);border:1px solid var(--card-border);border-radius:6px;padding:10px 12px;">
        <div>${permis.map(t => ccTermChip(t, P)).join('')}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:7px;line-height:1.5;">
          Green = the term was satisfied at the last sample of this record. Red = it was not. A grey term is not recorded in this file.
          The close falls after this record ends, so these states show the conditions at that moment only.
        </div>
      </div>` : ''}

    ${cc.notes.length ? cc.notes.map(n => `<div style="margin-top:12px;padding:10px 12px;background:var(--yellow-dim);border:1px solid #5c4506;border-radius:6px;font-size:12px;color:var(--text-dim);line-height:1.55;">${n}</div>`).join('') : ''}

    <div style="margin-top:12px;font-size:11px;color:var(--text-muted);line-height:1.5;">
      The tool reads this from the close equation and the SELogic that feeds it. It reports what the logic permits. It does not predict a close.
      A latch bit (LT) is read as a mode switch, not as an operator action.
    </div>
  </div>`;
}
