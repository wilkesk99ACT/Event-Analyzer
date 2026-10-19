// Trip margin / no-fault check, ORED aggregate resolution, 3I2 basis and PHROT handling.
//
//   node test/test-trip-margin.mjs [folder with HILL TOP SOLAR 10512 .CEV]
//
// Sections 1–3 need no event files. Section 4 runs against the HILL TOP SOLAR record 10512
// (SEL-751, 51Q trip through ORED51T at 1.06× pickup, no fault) when the folder holds it.
import fs from 'fs';
import vm from 'vm';
const R = new URL('../js/', import.meta.url).pathname;
const ctx = { console, TextDecoder, DataView, Uint8Array, Math, Date, JSON, parseFloat, parseInt,
  Number, String, Array, Object, Set, Map, RegExp, isNaN, Infinity };
vm.createContext(ctx);
vm.runInContext(`
  function getTimestampMs(ts){return new Date(ts.year,ts.month-1,ts.day,ts.hour,ts.min,ts.sec,ts.msec).getTime();}
  function isFilteredQuarterCycle(spc){return spc===4;}
  function formatTimestamp(ts){return ts.month+'/'+ts.day+'/'+ts.year;}
`, ctx);
for (const f of ['signal-processing.js', 'ored-aggregates.js', 'analyze-trip-margin.js', 'parse-cev.js', 'analyze-cev.js',
                 'logic-graph-model.js', 'tooltips.js', 'analyze-reclose.js', 'analyze-custom-close.js']) {
  vm.runInContext(fs.readFileSync(R + f, 'utf8'), ctx, { filename: f });
}

let fails = 0;
const ok = (n, d = '') => console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`);
const bad = (n, d = '') => { fails++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ══ 1. ORED aggregate members ══
console.log('\n[1] ORED aggregate resolution');
const labels = ['51P1T', '51G1T', '51QT', '51N1T', '50P1T', '81D1T', '51QP', 'ORED51T', 'TRIP'];
const m51 = ctx.oredAggregateMembers('ORED51T', labels);
JSON.stringify(m51) === JSON.stringify(['51P1T', '51G1T', '51QT', '51N1T']) ? ok('ORED51T members', m51.join(' ')) : bad('ORED51T members', m51.join(' '));
const asserted = new Set(['51QT', 'ORED51T']);
const r = ctx.resolveOredAggregate('ORED51T', labels, ['51QT', 'ORED51T', 'TRIP'], n => asserted.has(n));
r.length === 1 && r[0] === '51QT' ? ok('resolves to the member that changed with it') : bad('resolve', r.join(','));
ctx.resolveOredAggregate('ORED50T', labels, [], n => asserted.has(n)).length === 0 ? ok('no member asserted → empty, aggregate kept') : bad('ORED50T empty');
ctx.isOredAggregate('SV04T') === false ? ok('SV04T is not an aggregate') : bad('SV04T');

// ══ 2. Curve equations ══
console.log('\n[2] SEL curve operate times');
near(ctx.calcSelCurveTime('U4', 1.06, 0.5), 22.83, 0.05) ? ok('U4 TD0.5 at 1.06×', ctx.calcSelCurveTime('U4', 1.06, 0.5).toFixed(2) + ' s') : bad('U4');
near(ctx.calcSelCurveTime('U1', 5, 1), ctx.calcU1Time(5, 1), 1e-9) ? ok('U1 matches the existing calcU1Time') : bad('U1');
ctx.calcSelCurveTime('U3', 0.9, 1) === Infinity ? ok('below pickup → Infinity') : bad('below pickup');
ctx.calcSelCurveTime('XX', 3, 1) === null ? ok('unknown curve → null, not a wrong time') : bad('unknown curve');

// ══ 3. Phase rotation and the sequence transform ══
console.log('\n[3] PHROT — balanced ACB set reads as zero negative sequence');
const N = 32, cycles = 4, amp = 100;
const wave = ph => Array.from({ length: N * cycles }, (_, i) => amp * Math.cos(2 * Math.PI * i / N + ph));
const d = Math.PI * 2 / 3;
const a = wave(0), bACB = wave(+d), cACB = wave(-d);   // A-C-B sequence
const Pacb = { settings: { PHROT: 'ACB' } }, Pabc = { settings: { PHROT: 'ABC' } };
const i2acb = ctx.computeNegSeqMagnitude(...ctx.seqPhaseOrder(Pacb, a, bACB, cACB), N, 1);
const i2wrong = ctx.computeNegSeqMagnitude(...ctx.seqPhaseOrder(Pabc, a, bACB, cACB), N, 1);
const last = arr => arr[arr.length - 1];
last(i2acb) < 0.5 ? ok('ACB with PHROT := ACB → I2 ≈ 0', last(i2acb).toFixed(3)) : bad('ACB I2', last(i2acb));
near(last(i2wrong), amp / Math.SQRT2, 1) ? ok('same data read as ABC → I2 = full RMS magnitude (the old error)', last(i2wrong).toFixed(1)) : bad('ABC misread', last(i2wrong));
JSON.stringify(ctx.seqPhaseOrder({ settings: {} }, 1, 2, 3)) === '[1,2,3]' ? ok('no PHROT → ABC order, unchanged') : bad('default order');

// ══ 4. HILL TOP SOLAR 10512 ══
console.log('\n[4] HILL TOP SOLAR 10512 — 51Q no-fault trip');
const dir = process.argv[2] || process.env.CEV_DIR || '/mnt/project';
const file = fs.existsSync(dir) ? fs.readdirSync(dir).find(f => /HILL.?TOP.*10512.*\.CEV$/i.test(f)) : null;
if (!file) {
  console.log('  SKIP  HILL TOP SOLAR 10512 not found in ' + dir);
} else {
  const P = ctx.parseCEV(fs.readFileSync(dir + '/' + file, 'latin1'), file);
  const A = ctx.analyzeCEV(P, null);
  const tc = A.tripCause;
  tc.immediateCause === '51QT' ? ok('cause resolves past ORED51T to 51QT') : bad('immediateCause', tc.immediateCause);
  tc.family === 'negSeqI' ? ok('family negSeqI → 3I2 chart is shown') : bad('family', tc.family);
  tc.causeChain.map(c => c.label).join('>') === '51QT>ORED51T>TRIP' ? ok('chain 51QT > ORED51T > TRIP') : bad('chain', tc.causeChain.map(c => c.label).join('>'));
  const M = A.tripMargin;
  M && near(M.multipleAtTrip, 1.06, 0.03) ? ok('3I2 at trip ≈ 1.06× pickup', M.multipleAtTrip.toFixed(3)) : bad('multiple', M && M.multipleAtTrip);
  M && near(M.atTripPri, 14.8, 0.5) ? ok('3I2 ≈ 14.8 A primary (hand calculation 14.9 A)', M.atTripPri.toFixed(2)) : bad('3I2 primary', M && M.atTripPri);
  M && M.pickupAtStart && M.pickupFalls === 2 ? ok('51QP picked up at record start and chattered twice') : bad('pickup bit', M && `${M.pickupAtStart}/${M.pickupFalls}`);
  M && M.noFaultSignature ? ok('no fault signature') : bad('noFaultSignature');
  M && M.seq && near(M.seq.v2v1Pre, 0.026, 0.004) && near(M.seq.v2v1Post, 0.028, 0.004)
    ? ok('V2/V1 before and after opening ≈ 2.6 % / 2.8 %') : bad('V2/V1', M && JSON.stringify(M.seq));
  M && M.seq && M.seq.i2i1 < 0.2 ? ok('I2/I1 ≈ 11 % — no phase swap', (M.seq.i2i1 * 100).toFixed(1) + ' %') : bad('I2/I1');
  (A.investigationFlags || []).some(f => f.severity === 'high' && /No fault in the record/.test(f.title))
    ? ok('high-severity no-fault flag raised') : bad('flag missing');
  const row = A.protectionRows.find(x => x.el === '51Q');
  const atTrip = ctx.evalOcRowAtIdx(A, row, tc.tripTransition.analogSampleIdx);
  atTrip.asserted ? ok('Protection tab: 51Q reads asserted at the trip (3I2 basis)', atTrip.measured) : bad('51Q row at trip', atTrip.measured);
}

console.log(fails ? `\n${fails} check(s) failed.` : '\nAll checks passed.');
process.exit(fails ? 1 : 0);
