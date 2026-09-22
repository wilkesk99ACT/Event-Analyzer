// Close readiness — would a close sent now succeed?
//
// Run:  node test/test-close-readiness.mjs [folder-of-CEV-files]
//
// What it protects:
//   1. The simulator reproduces a real remote close, interval by interval (PGR SOUTHWICK 10427):
//      CC, CL, CLOSE and ER together; SV07/SV08/SV21 one interval later; SV09 (R_TRIG SV08) one
//      interval after that; OUT102 blind to the CC pulse; CF at CFD.
//   2. From an open recloser waiting on an outside permissive, a remote close is reported as
//      waiting on that input — not as a certain failure and not as a success.
//   3. A front-panel close in auto mode is traced through the path it really takes.
//   4. A latch-held output that will not change state is named as a risk.
//   5. The what-if (permissive arrives) says the close would go through.
//   6. A close into conditions that trip is caught, the element is named, and a voltage element
//      carries the VT-location caution.
//   7. The simulator reproduces a real, successful close (CLEARSKY ABG): the three close
//      outputs one interval after CLOSE.
//   8. No readiness answer when the breaker is closed.
//
// Needs the PGR SOUTHWICK 10427/10428 records; 7 also needs "CLEARSKY ABG". Missing files skip.

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
                 'analyze-reclose.js', 'analyze-custom-close.js', 'analyze-close-attempt.js', 'analyze-close-readiness.js']) {
  vm.runInContext(fs.readFileSync(R + f, 'utf8'), ctx, { filename: f });
}

let fails = 0;
const check = (cond, n, d = '') => { if (!cond) fails++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${n}${d !== '' ? '  — ' + d : ''}`); };

const dir = process.argv[2] || process.env.CEV_DIR;
const find = (n) => dir && fs.existsSync(dir) ? fs.readdirSync(dir).find(f => f.includes(n) && /\.cev$/i.test(f)) : null;
const f1 = find('10427'), f2 = find('10428'), f3 = find('CLEARSKY ABG');
if (!f1 || !f2) {
  console.log('PGR SOUTHWICK 10427/10428 not found — skipped. Pass the folder that holds them.');
  process.exit(0);
}
ctx.T1 = fs.readFileSync(path.join(dir, f1), 'latin1');
ctx.T2 = fs.readFileSync(path.join(dir, f2), 'latin1');
vm.runInContext(`var P1 = parseCEV(T1, 'a.CEV'); var P2 = parseCEV(T2, 'b.CEV');`, ctx);

console.log('\n[1] Simulator against the recorded remote close (10427)');
const s1 = vm.runInContext(`(() => {
  const K = rsCompile(P1);
  const cc = P1.digitalTransitions.find(t => t.changes.some(c => c.label === 'CC' && c.asserted));
  const base = rsBaseState(P1, cc.analogSampleIdx - 1);
  const sim = rsSimulate(P1, K, base, 'CC', { unit: 'seconds' });
  const fmt = (t, off) => (t.analogSampleIdx - off) + ':' + t.changes.filter(c => !/^(PMTRIG|TREA\\d|ER)$/.test(c.label)).map(c => (c.asserted ? '+' : '-') + c.label).sort().join(' ');
  return {
    want: P1.digitalTransitions.filter(t => t.analogSampleIdx >= cc.analogSampleIdx).slice(0, 4).map(t => fmt(t, cc.analogSampleIdx - 1)),
    got: sim.synth.digitalTransitions.slice(0, 4).map(t => fmt(t, 0)),
    res: sim.res, dt: sim.dt,
  };
})()`, ctx);
s1.want.forEach((w, i) => check(w === s1.got[i], `interval ${w.split(':')[0]} matches`, `${w}  |  sim ${s1.got[i]}`));
check(s1.res.er === 1 && s1.res.erTerm === 'CC', 'ER on the CC interval');
check(s1.res.closeOutAt == null, 'OUT102 never operates');
check(s1.res.cf != null && Math.abs(s1.res.cf * s1.dt - 20000) < 10, 'CF at CFD (20 s)', s1.res.cf * s1.dt);

console.log('\n[2-5] Open recloser at the end of 10428');
const R2 = vm.runInContext(`analyzeCloseReadiness(P2, {})`, ctx);
const cc = R2 && R2.commands.find(c => c.term === 'CC');
check(cc && cc.outcome === 'waits-external' && /IN402/.test(cc.verdict.headline), 'remote close waits on IN402', cc && cc.verdict.headline);
const pb = R2 && R2.commands.find(c => c.term === 'PB03_PUL');
check(pb && pb.outcome === 'cl-waits-external' && pb.ownRoute[0] === 'SV10T', 'front-panel close in auto goes through SV10T and waits on IN402', pb && pb.outcome);
check(R2 && R2.general.some(g => /OUT301/.test(g.text) && /LT07/.test(g.text)), 'OUT301 held by LT07 named');
check(cc && cc.whatIf && cc.whatIf.energizes && !cc.whatIf.trips, 'what-if: IN402 arrives → close output operates, no trip');
check(R2 && R2.general.some(g => /event report \(ER via CC\)/.test(g.text)), 'command would make an event report');

console.log('\n[6] Close into a trip');
const s6 = vm.runInContext(`(() => {
  const K = rsCompile(P2); const base = rsBaseState(P2, P2.analogData.length - 1);
  return rsSimulate(P2, K, base, 'CC', { unit: 'seconds', hold: { IN402: true, '27P1T': true } }).res;
})()`, ctx);
check(s6.closeOutAt != null && s6.tripAt != null && s6.tripBranch === 'SV15T', 'trip via SV15T after closing', s6.tripBranch);
check((s6.tripDrivers || []).includes('27P1T') && !(s6.tripDrivers || []).includes('52A'), 'driver named, 52A left out', (s6.tripDrivers || []).join(','));
const v6 = vm.runInContext(`rsCommandVerdict({ label: 'X', outcome: 'closes-then-trips', res: ${JSON.stringify(s6)}, times: { out: 8, trip: 0 } }, rsCompile(P2), P2)`, ctx);
check(/VTs/.test(v6.detail) && v6.tone === 'warn', 'voltage-element trip carries the VT caution');

console.log('\n[7] Simulator against a real successful close (CLEARSKY ABG)');
if (!f3) console.log('  skipped — CLEARSKY ABG not found');
else {
  ctx.T3 = fs.readFileSync(path.join(dir, f3), 'latin1');
  const s7 = vm.runInContext(`(() => {
    const P = parseCEV(T3, 'c.CEV'); const K = rsCompile(P);
    const cc = P.digitalTransitions.find(t => t.changes.some(c => c.label === 'CC' && c.asserted));
    const sim = rsSimulate(P, K, rsBaseState(P, cc.analogSampleIdx - 1), 'CC', { unit: rsUnits(P).unit });
    const real = P.digitalTransitions.find(t => t.changes.some(c => c.label === 'OUT401' && c.asserted));
    return { simOut: sim.res.closeOutAt, realOut: real.analogSampleIdx - cc.analogSampleIdx + 1 };
  })()`, ctx);
  check(s7.simOut === s7.realOut, 'close outputs on the same interval as the real record', `sim ${s7.simOut}, real ${s7.realOut}`);
}

console.log('\n[9] Real TRIG record on an open recloser (STAMEY 11290)');
const f4 = find('STAMEY');
if (!f4) console.log('  skipped — STAMEY record not found');
else {
  ctx.T4 = fs.readFileSync(path.join(dir, f4), 'latin1');
  const r9 = vm.runInContext(`(() => { const P = parseCEV(T4, 'd.CEV'); const R = analyzeCloseReadiness(P, {}); const c = R.commands[0];
    return { type: P.eventInfo.eventType, outcome: c.outcome, head: c.verdict.headline, detail: c.verdict.detail, notes: R.notes,
      roles: c.trace.outputs.map(o => o.name + ':' + o.role).join(','), whatIf: c.whatIf }; })()`, ctx);
  check(/^Trigger$/i.test(r9.type), 'event type is Trigger', r9.type);
  check(r9.roles === 'OUT401:close,OUT402:close,OUT403:close,OUT404:aux', 'OUT401-403 are close contacts through SVs, OUT404 is the RVC start', r9.roles);
  check(r9.outcome === 'waits-external' && /IN314/.test(r9.head), 'remote close waits on IN314', r9.head);
  check(/OUT404[^.]*would operate/.test(r9.detail), 'OUT404 start signal named');
  check(r9.whatIf && r9.whatIf.energizes && !r9.whatIf.trips, 'what-if: IN314 arrives → close, no trip');
  check(!r9.notes.some(n => /SV21/.test(n)), 'blinker timer not reported as an assumption');
}

console.log('\n[8] Breaker closed');
const r8 = vm.runInContext(`analyzeCloseReadiness({ ...P2, digitalTransitions: [], initialDigitalState: (P2.initialDigitalState || []).concat(['52A']) }, {})`, ctx);
check(r8 === null, 'no readiness answer');

console.log(fails ? `\n${fails} check(s) failed.` : '\nAll checks passed.');
process.exit(fails ? 1 : 0);
