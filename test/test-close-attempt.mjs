// Close attempt trace.
//
// Run:  node test/test-close-attempt.mjs [folder-of-CEV-files]
//
// What it protects:
//   1. A close output that names CLOSE but is gated by a permissive must be read as the close
//      contact, and a permissive that never arrives must be named as the blocker. Calling that
//      a breaker mechanism failure sends a technician to the wrong equipment.
//   2. The alternatives of the gate must be ranked: the path waiting on an input first, then a
//      path that needs an operator, then a path a mode latch has switched off.
//   3. A term on for one processing interval (a CC pulse) must not be reported as the path that
//      closes the breaker.
//   4. An output held on by a latch from an earlier close must be flagged — the device it
//      drives saw no new signal.
//   5. A close request carried in from an earlier record (the CF record) must still be traced,
//      and CF timing must be linked to the record that started the close.
//   6. ER coverage must say which close commands make an event report, and an SV labelled as
//      an event trigger that is not in ER must be named.
//   7. Several settings on one line must be split correctly ("OUT101FS:= Y   OUT101 := ...").
//   8. Timer units must be settled from dropout evidence when no pickup timer runs.
//
// Items 1–6 and 8 need the PGR SOUTHWICK 10427/10428 records in the folder. They are skipped
// when the files are not there. Item 7 needs no files.

import fs from 'fs';
import path from 'path';
import vm from 'vm';

const R = new URL('../js/', import.meta.url).pathname;
const ctx = {
  console, TextDecoder, DataView, Uint8Array, Math, Date, JSON, parseFloat, parseInt,
  Number, String, Array, Object, Set, Map, RegExp, isNaN, Infinity,
};
vm.createContext(ctx);
vm.runInContext(`
  function getTimestampMs(ts){return new Date(ts.year,ts.month-1,ts.day,ts.hour,ts.min,ts.sec,ts.msec).getTime();}
  function isFilteredQuarterCycle(spc){return spc===4;}
  function formatTimestamp(ts){return ts.month+'/'+ts.day+'/'+ts.year;}
`, ctx);
for (const f of ['signal-processing.js', 'parse-cev.js', 'analyze-cev.js', 'logic-graph-model.js', 'tooltips.js',
                 'analyze-reclose.js', 'analyze-custom-close.js', 'analyze-close-attempt.js']) {
  vm.runInContext(fs.readFileSync(R + f, 'utf8'), ctx, { filename: f });
}

let fails = 0;
const ok = (n, d = '') => console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`);
const bad = (n, d = '') => { fails++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const check = (cond, n, d) => (cond ? ok(n, d) : bad(n, d));

// ══ 7. Settings line splitting — no files needed ══
console.log('\n[7] Several settings on one line');
{
  const P = { settingsText: 'OUT101FS:= Y       OUT101  := HALARM OR SALARM\nOUT102FS:= N       OUT102  := CLOSE AND (SV10T OR CC) # TAVRIDA CLOSE\nCFD     := 20.0\n' };
  const outs = ctx.ctSettingEquations(P, /^OUT\d{3}$/);
  check(outs.length === 2, 'two OUT equations found', outs.map(o => o.name).join(','));
  check(outs[1] && outs[1].eq === 'CLOSE AND (SV10T OR CC) # TAVRIDA CLOSE', 'OUT102 value intact', outs[1] && outs[1].eq);
  check(ctx.ctSetting(P, 'CFD') === '20.0', 'CFD read', ctx.ctSetting(P, 'CFD'));
  check(ctx.ctSetting(P, 'OUT101FS') === 'Y', 'FS flag not merged into the equation');
}

// ══ Real records ══
const dir = process.argv[2] || process.env.CEV_DIR;
const find = (n) => dir && fs.existsSync(dir) ? fs.readdirSync(dir).find(f => f.includes(n) && /\.cev$/i.test(f)) : null;
const f1 = find('10427'), f2 = find('10428');
if (!f1 || !f2) {
  console.log('\n[1-6, 8] PGR SOUTHWICK 10427/10428 not found — skipped. Pass the folder that holds them.');
} else {
  ctx.T1 = fs.readFileSync(path.join(dir, f1), 'latin1');
  ctx.T2 = fs.readFileSync(path.join(dir, f2), 'latin1');
  vm.runInContext(`
    var P1 = parseCEV(T1, 'a.CEV'); var A1 = analyzeCEV(P1, null);
    var P2 = parseCEV(T2, 'b.CEV'); var A2 = analyzeCEV(P2, { parsed: P1, analysis: A1 });
  `, ctx);
  const t1 = ctx.A1.closeTrace, t2 = ctx.A2.closeTrace;

  console.log('\n[1] Close output and its blocker');
  check(t1 && t1.source.type === 'remote', 'close started by CC', t1 && t1.source.type);
  const o102 = t1 && t1.outputs.find(o => o.name === 'OUT102');
  check(o102 && o102.role === 'close' && !o102.everOn, 'OUT102 is the close contact and never operated');
  // 10427 ends about 1 s after CC, long before CFD (20 s): the outcome is in 10428, not here.
  check(t1 && t1.verdict.kind === 'pending' && /IN402/.test(t1.verdict.headline) && /OUT301/.test(t1.verdict.headline), 'in progress, names IN402 and the held OUT301', t1 && t1.verdict.headline);
  check(t2 && t2.verdict.kind === 'blocked' && /OUT301/.test(t2.verdict.headline) && /IN402/.test(t2.verdict.headline), 'CF record: failed, OUT301 held and IN402 named', t2 && t2.verdict.headline);
  check(!/Breaker Never Confirmed Closed/.test(ctx.A1.investigationFlags.map(f => f.title).join('|')),
    'no "breaker mechanism" flag when the close output never operated');

  console.log('\n[2] Alternatives ranked');
  const alts = o102 ? o102.alternatives : [];
  check(alts[0] && alts[0].route[0] === 'SV10T' && alts[0].rank === 0, 'SV10T path first', alts[0] && alts[0].route.join('>'));
  check(alts.some(a => a.route[0] === 'SV11T' && a.rank === 2), 'SV11T path ranked as switched off by LT05');

  console.log('\n[3] One-interval pulse');
  check(o102 && o102.momentaryTerms && o102.momentaryTerms.includes('CC'), 'CC pulse detected', o102 && (o102.momentaryTerms || []).join(','));
  check(alts.some(a => a.blockers.some(b => b.name === 'CC' && b.kind === 'pulse-only')), 'CC shown as pulse-only, not as the close path');

  console.log('\n[4] Held-on output');
  const o301 = t1 && t1.outputs.find(o => o.name === 'OUT301');
  check(o301 && o301.onAtStart && o301.heldBy && o301.heldBy[0].name === 'LT07', 'OUT301 held by LT07 from before this close');
  check(t1 && /OUT301[^.]*already on when this close started/.test(t1.verdict.detail), 'verdict says OUT301 saw no new signal');

  console.log('\n[5] Carried close in the CF record');
  check(t2 && t2.carried && t2.endReason === 'cf', 'CF record traced as a carried close');
  check(t2 && t2.cf && t2.cf.crossRecord && Math.abs(t2.cf.measuredMs - 20000) < 100, 'CLOSE → CF measured across records', t2 && t2.cf && t2.cf.measuredMs);
  check(t2 && t2.cf.unit === 'seconds', 'CFD read as seconds');
  check(ctx.A2.investigationFlags.some(f => /^Close Failure/.test(f.title)), 'CF record raises a close-failure flag');

  console.log('\n[6] Event report coverage');
  const er = t1 && t1.er;
  check(er && er.sources.find(s => s.term === 'CC').inER === true, 'CC is in ER');
  check(er && er.sources.find(s => s.term === 'PB03_PUL').inER === false, 'PB03_PUL is not in ER');
  check(er && er.orphans.some(o => o.label === 'SV26'), 'SV26 named as an event trigger not in ER');
  check(er && er.cfInER === true && er.closedInER === false, 'CF in ER; a successful close is not (F_TRIG 52A only)');
  check(t1 && t1.clock && !t1.clock.synced, 'unsynchronized clock flagged');

  console.log('\n[8] Timer units from dropout evidence');
  check(ctx.svTimerUnit(ctx.P1) === 'seconds', 'SV timers read as seconds', ctx.svTimerUnit(ctx.P1));
}

console.log(fails ? `\n${fails} check(s) failed.` : '\nAll checks passed.');
process.exit(fails ? 1 : 0);
