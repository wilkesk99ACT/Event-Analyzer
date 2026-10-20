// Per-phase trip logic (TRA/TRB/TRC), time-correct SV resolution, and frequency at the trip.
//
//   CEV_DIR=<folder> node test/test-per-phase-trip.mjs
//
// Section 1 needs no event files. Section 2 runs against LARKIN_MEDWAY event 10526 (SEL-651R,
// TR3P := 0, TRA := SV02T OR OC3; 81D4 overfrequency at 62.77 Hz -> SV29 -> SV02 -> TRIPA)
// when the folder holds a file whose name contains "LARKIN" and "10526".
import fs from 'fs';
import vm from 'vm';
const R = new URL('../js/', import.meta.url).pathname;
const ctx = { console: { log() {}, warn() {}, error() {} }, TextDecoder, DataView, Uint8Array, Math, Date, JSON,
  parseFloat, parseInt, Number, String, Array, Object, Set, Map, RegExp, isNaN, Infinity };
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
const ok = (n, d = '') => console.info(`  PASS  ${n}${d ? '  — ' + d : ''}`);
const bad = (n, d = '') => { fails++; console.info(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };

// ══ 1. Logic-graph mapping for per-phase bits ══
console.info('\n[1] Trip bit -> equation mapping');
const P1 = { tripEquationName: 'TR3P', tripEquation: '0', tripEquationsPhase: { TRA: 'SV02T OR OC3', TRB: 'SV03T OR OC3', TRC: '0' } };
ctx.ANALYSIS = { tripCause: { sourceEquationName: 'TRA' } };
ctx.canonicalTripLabel('TRIPA', P1) === 'TRA' ? ok('TRIPA -> TRA') : bad('TRIPA', ctx.canonicalTripLabel('TRIPA', P1));
ctx.canonicalTripLabel('TRIPB', P1) === 'TRB' ? ok('TRIPB -> TRB, not the equation that drove this trip') : bad('TRIPB', ctx.canonicalTripLabel('TRIPB', P1));
ctx.canonicalTripLabel('TRIPC', P1) === 'TR3P' ? ok('TRIPC with TRC := 0 never borrows another phase') : bad('TRIPC', ctx.canonicalTripLabel('TRIPC', P1));
ctx.canonicalTripLabel('TRIP3P', P1) === 'TRA' ? ok('TRIP3P -> the per-phase equation that drove the trip') : bad('TRIP3P', ctx.canonicalTripLabel('TRIP3P', P1));
const P2 = { tripEquationName: 'TR3P', tripEquation: '81D1T OR SV03T', tripEquationsPhase: { TRA: 'SV05T' } };
ctx.ANALYSIS = { tripCause: { sourceEquationName: 'TR3P' } };
ctx.canonicalTripLabel('TRIPA', P2) === 'TR3P' ? ok('TR3P keeps the bit when TR3P drove the trip') : bad('TR3P priority', ctx.canonicalTripLabel('TRIPA', P2));

// ══ 2. LARKIN_MEDWAY 10526 ══
console.info('\n[2] LARKIN_MEDWAY 10526 — per-phase TRA trip on 81D4 overfrequency');
const dir = process.env.CEV_DIR || '/mnt/project';
const file = fs.existsSync(dir) ? fs.readdirSync(dir).find(f => /LARKIN/i.test(f) && /\.CEV$/i.test(f)) : null;
if (!file) {
  console.info(`  SKIP  LARKIN_MEDWAY 10526 not found in ${dir}`);
} else {
  const P = ctx.parseCEV(fs.readFileSync(dir + '/' + file, 'latin1'), file);
  const A = ctx.analyzeCEV(P, null);
  const tc = A.tripCause || {};
  P.tripEquationsPhase && P.tripEquationsPhase.TRA ? ok('parser reads TRA', P.tripEquationsPhase.TRA) : bad('parser TRA missing');
  tc.immediateCause === 'SV02T' ? ok('immediate cause SV02T') : bad('immediate cause', String(tc.immediateCause));
  tc.sourceEquationName === 'TRA' ? ok('attributed to TRA') : bad('source equation', String(tc.sourceEquationName));
  const chain = (tc.causeChain || []).map(c => c.label);
  JSON.stringify(chain) === JSON.stringify(['81D4T', 'SV29', 'SV02', 'TRIPA'])
    ? ok('chain 81D4T > SV29 > SV02 > TRIPA') : bad('chain', chain.slice(0, 12).join('>') + (chain.length > 12 ? ` … (${chain.length})` : ''));
  /^Frequency Protection Trip/.test(tc.causeText || '') ? ok('cause text', tc.causeText) : bad('cause text', tc.causeText);
  const f4 = (A.freqStatus || []).find(r => r.element === '81D4');
  f4 && f4.asserted && f4.timedOut && /^62\.\d\d Hz at trip/.test(f4.measured)
    ? ok('81D4 row read at the trip instant', f4.measured) : bad('81D4 row', JSON.stringify(f4));
  const f1 = (A.freqStatus || []).find(r => r.element === '81D1');
  f1 && !f1.asserted ? ok('81D1 (underfrequency) not asserted') : bad('81D1 row', JSON.stringify(f1));
  const ev = tc.evidence || {};
  ev.tripPathHasOvercurrent === false ? ok('evidence knows there is no overcurrent in the trip path') : bad('tripPathHasOvercurrent', String(ev.tripPathHasOvercurrent));
  // Diagram: the trip-path tree must reach 81D4T through SV29, not stop at "NOT SV02T".
  const names = [];
  (function walk(n) { if (!n) return; if (n.label) names.push(n.label); if (n.name) names.push(n.name);
    if (n.child) walk(n.child); (n.children || []).forEach(walk); })(tc.logicTree);
  names.includes('81D4T') && names.includes('SV29') ? ok('diagram reaches 81D4T through SV29') : bad('diagram', names.join(' '));
  !names.includes('SV01') ? ok('diagram does not expand the negated SV01 close logic') : bad('diagram expands SV01');
}

console.info(`\n${fails ? fails + ' check(s) failed.' : 'All checks passed.'}`);
process.exit(fails ? 1 : 0);
