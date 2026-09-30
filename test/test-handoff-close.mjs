// Close through an outside controller — the relay close contact is not the only way in.
//
// Run:  node test/test-handoff-close.mjs [folder-of-CEV-files]
//
// PGR SOUTHWICK (SEL-751) closes its Tavrida recloser two ways. OUT102 := CLOSE AND (SV10T OR
// SV11T OR CC) is the relay's own close contact, and SV10T waits on IN402 (RVC permissive).
// OUT301 := SV07T OR LT07 starts the RVC. In 10430 the recloser closed with IN402 never on:
// OUT301 gave the RVC a new start (LT07 had been reset by the trip in 10429). In 10427 the close
// failed with OUT301 already held on by LT07, so the RVC saw no new start.
//
// What it protects:
//   1. A record that ends 1 s after CC, before CFD, is "in progress", not "blocked".
//   2. That answer names the new start signal on OUT301 and does not say the breaker was never
//      told to close.
//   3. The investigation flag is medium, not the high "genuine failure" flag.
//   4. From the open recloser at the end of 10429, a remote close is not "would not close
//      unless IN402" — it starts the RVC through OUT301, and IN402 is named for OUT102 only.
//   5. The front-panel close in auto mode gets the same answer.
//   6. With OUT301 already held on by LT07, the answer is "would likely fail", and names both.
//
// Needs the PGR SOUTHWICK 10429/10430 records. Missing files skip.

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
for (const f of ['signal-processing.js', 'file-loading.js', 'parse-cev.js', 'analyze-cev.js', 'logic-graph-model.js', 'tooltips.js',
                 'analyze-reclose.js', 'analyze-custom-close.js', 'analyze-close-attempt.js', 'analyze-close-readiness.js']) {
  vm.runInContext(fs.readFileSync(R + f, 'utf8'), ctx, { filename: f });
}

let fails = 0;
const check = (cond, n, d = '') => { if (!cond) fails++; console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${n}${d !== '' ? '  — ' + d : ''}`); };

const dir = process.argv[2] || process.env.CEV_DIR;
const find = (n) => dir && fs.existsSync(dir) ? fs.readdirSync(dir).find(f => f.includes(n) && /\.cev$/i.test(f)) : null;
const f29 = find('10429'), f30 = find('10430');
if (!f29 || !f30) {
  console.log('PGR SOUTHWICK 10429/10430 not found — skipped. Pass the folder that holds them.');
  process.exit(0);
}
ctx.T29 = fs.readFileSync(path.join(dir, f29), 'latin1');
ctx.T30 = fs.readFileSync(path.join(dir, f30), 'latin1');
vm.runInContext(`var P29 = parseCEV(T29, 'a.CEV'); var P30 = parseCEV(T30, 'b.CEV');`, ctx);

console.log('\n[1-3] Remote close, record ends before CFD (10430)');
const r30 = vm.runInContext(`(() => { const A = analyzeCEV(P30, null); const v = A.closeTrace.verdict;
  return { kind: v.kind, head: v.headline, detail: v.detail, handoff: A.closeTrace.handoff.map(x => x.name),
    flags: A.investigationFlags.map(f => f.severity + '|' + f.title) }; })()`, ctx);
check(r30.kind === 'pending', 'close is in progress, not blocked', r30.kind);
check(r30.handoff.join() === 'OUT301', 'OUT301 gave a new start', r30.handoff.join());
check(/OUT301/.test(r30.head) && /before CFD/.test(r30.detail), 'answer names OUT301 and CFD');
check(!/never told to close/.test(r30.detail), 'does not say the breaker was never told to close');
check(r30.flags.some(f => /^medium\|Close in progress/.test(f)) && !r30.flags.some(f => /genuine|Never Confirmed/i.test(f)), 'medium flag, no "genuine failure" flag', r30.flags.join(' ; '));

console.log('\n[4-5] Open recloser at the end of 10429');
const R29 = vm.runInContext(`analyzeCloseReadiness(P29, {})`, ctx);
const cc = R29 && R29.commands.find(c => c.term === 'CC');
check(cc && cc.verdict.kind === 'handoff', 'remote close starts the outside device', cc && cc.verdict.kind);
check(cc && !/would not close/.test(cc.verdict.headline) && /OUT301/.test(cc.verdict.headline) && /IN402/.test(cc.verdict.headline), 'headline: OUT301 starts, OUT102 waits on IN402', cc && cc.verdict.headline);
check(cc && /does not need IN402/.test(cc.verdict.detail), 'says the close can go without IN402');
const pb = R29 && R29.commands.find(c => c.term === 'PB03_PUL');
check(pb && pb.verdict.kind === 'handoff' && /OUT301/.test(pb.verdict.headline), 'front-panel close in auto: same answer', pb && pb.verdict.headline);

console.log('\n[6] Same, with OUT301 already held on by LT07 (the 10427 condition)');
const R6 = vm.runInContext(`(() => {
  const last = P29.analogData.length - 1;
  const P = { ...P29, digitalTransitions: P29.digitalTransitions.concat([{ analogSampleIdx: last, changes: [
    { label: 'LT07', asserted: true }, { label: 'OUT301', asserted: true }] }]) };
  return analyzeCloseReadiness(P, {});
})()`, ctx);
const c6 = R6 && R6.commands.find(c => c.term === 'CC');
check(c6 && c6.verdict.kind === 'handoff-held' && c6.verdict.tone === 'bad', 'would likely fail', c6 && c6.verdict.kind);
check(c6 && /OUT301/.test(c6.verdict.headline) && /IN402/.test(c6.verdict.headline) && /LT07/.test(c6.verdict.detail), 'names OUT301, LT07 and IN402', c6 && c6.verdict.headline);

console.log('\n[7] 10430 rebuilt with OUT301 already held on (the 10427 shape)');
const r7 = vm.runInContext(`(() => {
  const strip = (t) => ({ ...t, changes: t.changes.filter(c => c.label !== 'LT07' && c.label !== 'OUT301') });
  const P = { ...P30, initialDigitalState: (P30.initialDigitalState || []).concat(['LT07', 'OUT301']),
    digitalTransitions: P30.digitalTransitions.map(strip).filter(t => t.changes.length) };
  const t = analyzeCloseAttempt(P, {}); return { kind: t.verdict.kind, head: t.verdict.headline, detail: t.verdict.detail, stuck: t.stuckAux.map(x => x.name), handoff: t.handoff.map(x => x.name) };
})()`, ctx);
check(r7.kind === 'pending' && r7.stuck.join() === 'OUT301' && !r7.handoff.length, 'in progress, OUT301 held, no new start', r7.head);
check(/IN402/.test(r7.head) && /already held on/.test(r7.head), 'headline names IN402 and the held output');
check(/OUT301[^.]*already on when this close started/.test(r7.detail), 'detail says OUT301 saw no new signal');

console.log(fails ? `\n${fails} check(s) failed.` : '\nAll checks passed.');
process.exit(fails ? 1 : 0);
