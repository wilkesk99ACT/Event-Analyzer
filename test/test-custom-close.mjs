// Custom (non-79) close logic detection.
//
// Run:  node test/test-custom-close.mjs [folder-of-CEV-files]
//
// What it protects:
//   1. A device with E79 := N and an SELogic enter-service timer must be reported as able to
//      close by itself. The old code called every such device "will NOT auto-close".
//   2. A close path that needs a pushbutton or a SCADA command must NOT be called automatic.
//   3. A latch bit must be read as a mode switch, not as an operator action — otherwise every
//      automatic path that is armed from the front panel is misreported as manual.
//   4. Nothing above may change the verdict of a device with a normal, enabled 79 scheme.

import fs from 'fs';
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
for (const f of ['signal-processing.js', 'parse-cev.js', 'analyze-cev.js',
                 'logic-graph-model.js', 'tooltips.js',
                 'analyze-reclose.js', 'analyze-custom-close.js']) {
  vm.runInContext(fs.readFileSync(R + f, 'utf8'), ctx, { filename: f });
}

let fails = 0;
const ok = (n, d = '') => console.log(`  PASS  ${n}${d ? '  — ' + d : ''}`);
const bad = (n, d = '') => { fails++; console.log(`  FAIL  ${n}${d ? '  — ' + d : ''}`); };

// ══ 1. Synthetic settings — the shapes, without needing a particular site's file ══
console.log('\n[1] Path classification');

const mkP = (svs, latches, closeEq, e79) => ({
  analogData: [[0], [0], [0]],
  digitalLabels: ['LT02', 'LT04', 'LT06', '3P59Z', '3P27Y', 'FREQOK', 'TCCAP', 'SV08', 'SV09T', 'SV11', 'PB11_PUL', 'CC3'],
  digitalTransitions: [],
  initialDigitalState: ['LT02', 'LT06', '3P59Z', '3P27Y', 'FREQOK', 'TCCAP', 'SV11'],
  eventInfo: { freq: 60, samPerCycA: 32 },
  svSettings: svs,
  latchSettings: latches,
  reclose: {
    present: true, settingsFound: true, E79raw: e79, enabled: e79 === 'N' ? false : true,
    shots: null, openIntervals: [null, null, null, null], trueOpenIntervalCount: 0,
    eq: { CL: closeEq, ULCL: null }, eqName: { CL: 'CL3P', ULCL: null },
  },
});

// The real shape: an operator path (SV08, started by a pushbutton or a SCADA close) OR an
// automatic path (SV09T, a 300 s window on healthy utility voltage), both AND-ed with a set of
// measured permissives. The automatic path must be found even though it is nested inside an
// inner OR rather than sitting at the top level of the equation.
const svs = [
  { num: 8, label: 'SV08', pickupDelay: 3600, dropoutDelay: 0,
    equation: '(((PB11_PUL AND LT05) OR (CC3 AND LT03)) OR SV08 AND NOT SV08T) AND NOT TRIP3P AND LT06 # PERMISSIVE CLOSE TIMER' },
  { num: 9, label: 'SV09', pickupDelay: 18000, dropoutDelay: 0,
    equation: '3P59Z AND SV11 AND NOT TRIP3P AND NOT 52A3P AND LT02 AND LT06 AND NOT LT04 # AUTOMATIC RESTORATION WINDOW' },
  { num: 11, label: 'SV11', pickupDelay: 0, dropoutDelay: 0, equation: '27ZA3 AND 27ZB3 AND 27ZC3' },
];
const latches = [
  { num: 2, label: 'LT02', setEquation: 'PB02_PUL AND NOT (LT02) AND LT05 # ENABLE AUTOMATIC RESTORATION', resetEquation: 'PB02_PUL AND LT02 OR CF3P', comment: 'ENABLE AUTOMATIC RESTORATION' },
  { num: 4, label: 'LT04', setEquation: '(51PT OR 50P1T OR 51G1T) AND NOT (HBL2T AND SV10T) # DER SIDE FAULT LOCKOUT', resetEquation: 'PB05_PUL AND LT04' },
  { num: 6, label: 'LT06', setEquation: 'PB07_PUL AND NOT (LT06) AND LT05 # HOT LINE TAG', resetEquation: 'PB07_PUL AND LT06' },
];
const CL = 'NOT LT04 AND (SV08 OR SV09T) AND 3P59Z AND SV11 AND 3P27Y AND FREQOK AND LT06 AND TCCAP # MANUAL CLOSE OR AUTORESTORE';

const P1 = mkP(svs, latches, CL, 'N');
const cc1 = ctx.analyzeCustomClose(P1, null);

cc1.present ? ok('close equation found') : bad('close equation found');
cc1.custom ? ok('automatic close path detected with E79 := N', cc1.autoPathName)
           : bad('automatic close path detected', JSON.stringify(cc1.paths.map(p => [p.name, p.kind])));

const auto = cc1.paths.find(p => p.kind === 'automatic');
const oper = cc1.paths.find(p => p.kind === 'operator');
auto && auto.name === 'SV09T' ? ok('SV09T classified automatic') : bad('SV09T classification', auto ? auto.name : 'none');
oper && oper.name === 'SV08' ? ok('SV08 classified operator', oper.operatorTerms.join(','))
                             : bad('SV08 classification', JSON.stringify(cc1.paths.map(p => [p.name, p.kind])));
oper && oper.operatorTerms.includes('PB11_PUL') && oper.operatorTerms.includes('CC3')
  ? ok('operator terms named') : bad('operator terms', oper ? oper.operatorTerms.join(',') : 'none');

// Latch as mode switch, not operator action. LT02 is set by a pushbutton; if the walk followed
// SET02 into PB02_PUL the automatic path would be misreported as manual.
auto && auto.latchTerms.includes('LT02') ? ok('LT02 reported as a mode switch, not an operator action')
                                         : bad('LT02 handling', auto ? auto.latchTerms.join(',') : 'none');

// Delay: 18000 at 60 Hz read as cycles is 300 s. No timer runs in this synthetic record, so the
// units are not confirmed and the flag must say so rather than state the number as fact.
auto && auto.delay && Math.abs(auto.delay.ms - 300000) < 1
  ? ok('delay read from SV09PU', ctx.ccFormatMs(auto.delay.ms)) : bad('delay', JSON.stringify(auto && auto.delay));
auto && auto.delay && auto.delay.assumed === true
  ? ok('units flagged as unconfirmed') : bad('units flag should be assumed=true');

// ══ 2. The verdict the Reclosing tab shows ══
console.log('\n[2] Reclosing verdict');
const A1 = { tripCause: null };
const RC1 = ctx.analyzeReclose(P1, A1);
RC1.verdict && /close by itself/i.test(RC1.verdict.headline)
  ? ok('verdict corrected', RC1.verdict.headline) : bad('verdict', RC1.verdict && RC1.verdict.headline);
RC1.hasCustomAutoClose ? ok('hasCustomAutoClose set on the reclose result') : bad('hasCustomAutoClose');
!/will not auto-close/i.test(RC1.verdict.headline)
  ? ok('no longer claims the device will not auto-close') : bad('still claims no auto-close');

// ══ 3. Operator-only device must NOT be called automatic ══
console.log('\n[3] Operator-only close');
const P2 = mkP(
  [svs[0]], latches,
  'NOT LT04 AND SV08 AND 3P59Z AND FREQOK AND TCCAP # MANUAL CLOSE ONLY', 'N');
const cc2 = ctx.analyzeCustomClose(P2, null);
!cc2.custom ? ok('no false automatic path') : bad('false automatic path', JSON.stringify(cc2.paths.map(p => [p.name, p.kind])));
cc2.verdict && /only an operator/i.test(cc2.verdict.headline)
  ? ok('reported as operator close only', cc2.verdict.headline) : bad('operator-only verdict', cc2.verdict && cc2.verdict.headline);

// ══ 4. External input is reported as unknown, not as automatic ══
console.log('\n[4] External input');
const P3 = mkP([], latches, 'IN103 AND 3P59Z AND TCCAP', 'N');
const cc3 = ctx.analyzeCustomClose(P3, null);
!cc3.custom && cc3.hasExternal ? ok('contact input not claimed as automatic')
                               : bad('external handling', JSON.stringify(cc3.paths.map(p => [p.name, p.kind])));

// ══ 4b. A normal, enabled 79 scheme must be left alone ══
console.log('\n[4b] Enabled 79 element');
const P4 = mkP([svs[0]], latches, 'NOT LT04 AND SV08 AND 3P59Z AND TCCAP', '4');
const cc4 = ctx.analyzeCustomClose(P4, null);
!cc4.custom ? ok('no automatic path claimed') : bad('false automatic path on a 79 device');
cc4.verdict === null ? ok('no competing verdict produced') : bad('verdict produced', JSON.stringify(cc4.verdict));
ctx.buildCustomCloseCard(P4, { customClose: cc4 }) === ''
  ? ok('card suppressed — the 79 tab already tells this story') : bad('card should be suppressed');

// ══ 5. Real files must still parse, and enabled-79 devices must be untouched ══
console.log('\n[5] Real CEV files');
const dir = process.argv[2] || process.env.CEV_DIR || '/mnt/project';
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.CEV$/i.test(f)) : [];
if (!files.length) console.log('  SKIP  no .CEV files in ' + dir);
for (const f of files) {
  try {
    const P = ctx.parseCEV(fs.readFileSync(dir + '/' + f, 'latin1'), f);
    const A = ctx.analyzeCEV(P, null);
    const RC = A.reclose;
    const cc = A.customClose;
    const bits = [];
    bits.push(`E79=${P.reclose && P.reclose.E79raw}`);
    if (cc && cc.present) bits.push(`close=${cc.closeName}`);
    bits.push(`paths=${cc && cc.paths.length ? cc.paths.map(p => `${p.name}:${p.kind}`).join(',') : 'none'}`);
    if (RC && RC.verdict) bits.push(`verdict="${RC.verdict.headline}"`);
    ok(f, bits.join('  '));
    // An enabled 79 scheme must not be re-labelled by this feature.
    if (RC && RC.enabled === true && RC.verdict && /close by itself/i.test(RC.verdict.headline) && !cc.custom) {
      bad(f + ' — enabled 79 verdict changed without a custom path');
    }
  } catch (e) { bad(f, e.message); }
}

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll checks passed.\n');
process.exit(fails ? 1 : 0);
