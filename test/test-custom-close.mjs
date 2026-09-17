// Custom (non-79) close logic detection.
//
// Run:  node test/test-custom-close.mjs [folder-of-CEV-files]
//
// What it protects:
//   1. A device with E79 := N and an SELogic enter-service timer must be reported as able to
//      close by itself. Reading the 79 block alone called every such device "will NOT auto-close".
//   2. An automatic path nested inside an OR with a pushbutton path must still be found. Real
//      logic reads "(PB11_PUL OR F_TRIG SV12T) AND LT02 OR SV11T" — one chain, three ways in.
//   3. A close path that needs a pushbutton or a SCADA command must NOT be called automatic.
//   4. A seal-in branch must not be counted as a way in. It holds; it cannot start.
//   5. A latch bit must be read as a mode switch, not as an operator action.
//   6. Per-pole and per-switch close equations (CLA, CLB, CLC) must be found, not only CL3P.
//   7. An analog comparison must not swallow the rest of the equation.
//   8. None of this may change the verdict of a device with a normal, enabled 79 scheme.

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
const kinds = (cc) => cc.paths.map(p => `${p.eqName}:${p.kind}:${(p.trigger[0] || {}).name || '-'}`).join(', ');

const mkP = (svs, latches, closeEquations, e79) => ({
  analogData: [[0], [0], [0]],
  digitalLabels: ['LT01', 'LT02', 'LT03', 'LT04', 'LT05', 'LT06', '3P59Z', '3P27Y', 'FREQOK', 'TCCAP',
                  'SV08', 'SV09T', 'SV11', 'PB11_PUL', 'CC3', 'IN105', 'IN106', 'IN107', 'RB01', 'TRIP3P', '52A3P'],
  digitalTransitions: [],
  initialDigitalState: ['LT02', 'LT05', 'LT06', '3P59Z', '3P27Y', 'FREQOK', 'TCCAP', 'SV11'],
  eventInfo: { freq: 60, samPerCycA: 32 },
  svSettings: svs,
  latchSettings: latches,
  reclose: {
    present: true, settingsFound: true, E79raw: e79, enabled: e79 === 'N' ? false : true,
    shots: null, openIntervals: [null, null, null, null], trueOpenIntervalCount: 0,
    eq: {}, eqName: {}, closeEquations, unlatchEquations: [],
  },
});

// ══ 1. The split lives at the top of the close equation ══
console.log('\n[1] Close equation with the split at the top');
const svsA = [
  { num: 8, label: 'SV08', pickupDelay: 3600, dropoutDelay: 0,
    equation: '(((PB11_PUL AND LT05) OR (CC3 AND LT03)) OR SV08 AND NOT SV08T) AND NOT TRIP3P AND LT06 # PERMISSIVE CLOSE TIMER' },
  { num: 9, label: 'SV09', pickupDelay: 18000, dropoutDelay: 0,
    equation: '3P59Z AND SV11 AND NOT TRIP3P AND NOT 52A3P AND LT02 AND LT06 AND NOT LT04 # AUTOMATIC RESTORATION WINDOW' },
  { num: 11, label: 'SV11', pickupDelay: 0, dropoutDelay: 0, equation: '27ZA3 AND 27ZB3 AND 27ZC3' },
];
const latches = [
  { num: 2, label: 'LT02', setEquation: 'PB02_PUL AND NOT (LT02) AND LT05', resetEquation: 'PB02_PUL AND LT02 OR CF3P', comment: 'ENABLE AUTOMATIC RESTORATION' },
  { num: 4, label: 'LT04', setEquation: '(51PT OR 50P1T OR 51G1T)', resetEquation: 'PB05_PUL AND LT04', comment: 'DER SIDE FAULT LOCKOUT' },
  { num: 6, label: 'LT06', setEquation: 'PB07_PUL AND NOT (LT06) AND LT05', resetEquation: 'PB07_PUL AND LT06', comment: 'HOT LINE TAG' },
];
const CL = 'NOT LT04 AND (SV08 OR SV09T) AND 3P59Z AND SV11 AND 3P27Y AND FREQOK AND LT06 AND TCCAP # MANUAL CLOSE OR AUTORESTORE';
const cc1 = ctx.analyzeCustomClose(mkP(svsA, latches, [{ name: 'CL3P', eq: CL }], 'N'), null);

cc1.present ? ok('close equation found') : bad('close equation found');
cc1.custom ? ok('automatic path found', kinds(cc1)) : bad('automatic path found', kinds(cc1));
const a1 = cc1.paths.find(p => p.kind === 'automatic');
a1 && a1.trigger[0].name === 'SV09T' ? ok('SV09T is the trigger') : bad('trigger', a1 && a1.trigger[0].name);
a1 && Math.abs(a1.delay.ms - 300000) < 1 ? ok('delay read from SV09PU', ctx.ccFormatMs(a1.delay.ms)) : bad('delay');
a1 && a1.delay.assumed === true ? ok('units flagged as unconfirmed') : bad('units flag');
cc1.paths.some(p => p.kind === 'operator' && p.trigger.some(t => t.name === 'PB11_PUL'))
  ? ok('pushbutton path kept separate') : bad('pushbutton path', kinds(cc1));
cc1.paths.some(p => p.kind === 'operator' && p.trigger.some(t => t.name === 'CC3'))
  ? ok('SCADA close path kept separate') : bad('SCADA path', kinds(cc1));
cc1.paths.some(p => p.kind === 'seal-in') ? ok('seal-in branch marked, not counted as a way in') : bad('seal-in branch');
a1 && a1.terms.some(t => t.name === 'LT02' && !t.negated)
  ? ok('LT02 read as a mode switch, not an operator action') : bad('LT02 handling');

// ══ 2. The split is buried inside one SELogic variable ══
console.log('\n[2] Close equation with the split buried in an SV');
const svsB = [
  { num: 1, label: 'SV01', pickupDelay: 0, dropoutDelay: 4.25,
    equation: 'NOT SV04T AND NOT IN105 AND SV06T AND ((PB11_PUL OR F_TRIG SV12T) AND LT02 OR SV11T) AND NOT LT04 # CLOSE S1' },
  { num: 6, label: 'SV06', pickupDelay: 10800, dropoutDelay: 0, equation: 'NOT IN107 # CAPACITORS CHARGED 3 MIN' },
  { num: 11, label: 'SV11', pickupDelay: 21600, dropoutDelay: 0,
    equation: 'NOT IN105 AND NOT IN106 AND (VAY >= 6840.00 AND VBY >= 6840.00 AND VCY >= 6840.00) AND NOT LT02 AND NOT SV11T # ALL PHASES ABOVE 11KV FOR 6 MIN' },
  { num: 12, label: 'SV12', pickupDelay: 0, dropoutDelay: 1801, equation: 'NOT LT01 AND R_TRIG RB01 # 100 OP TEST MODE' },
];
const cc2 = ctx.analyzeCustomClose(mkP(svsB, latches, [{ name: 'CLA', eq: 'SV01T OR CC3' }], 'N'), null);
cc2.custom ? ok('nested automatic path found', kinds(cc2)) : bad('nested automatic path MISSED', kinds(cc2));
const a2 = cc2.paths.find(p => p.kind === 'automatic');
a2 && a2.trigger[0].name === 'SV11T' ? ok('SV11T is the trigger') : bad('trigger', a2 && a2.trigger[0].name);
a2 && Math.abs(a2.delay.ms - 360000) < 200 ? ok('longest timer on the path wins', ctx.ccFormatMs(a2.delay.ms))
  : bad('delay', a2 && a2.delay && a2.delay.ms);
cc2.paths.some(p => p.kind === 'operator') ? ok('pushbutton path still separate') : bad('pushbutton path', kinds(cc2));
cc2.paths.some(p => p.kind === 'external' && p.trigger.some(t => t.name === 'RB01'))
  ? ok('test-mode bit reported as external, not automatic') : bad('external path', kinds(cc2));
a2 && a2.terms.some(t => t.name === 'LT02' && t.negated)
  ? ok('terms after the analog comparison survive') : bad('analog comparison swallowed the equation');
a2 && a2.terms.filter(t => t.analog).length === 3
  ? ok('three analog comparisons carried through, unevaluated') : bad('analog terms', a2 && a2.terms.filter(t => t.analog).length);

// ══ 3. Operator-only device must NOT be called automatic ══
console.log('\n[3] Operator-only close');
const cc3 = ctx.analyzeCustomClose(mkP([svsA[0]], latches, [{ name: 'CL3P', eq: 'NOT LT04 AND SV08 AND 3P59Z AND TCCAP' }], 'N'), null);
!cc3.custom ? ok('no false automatic path') : bad('false automatic path', kinds(cc3));
/only an operator/i.test(cc3.verdict.headline) ? ok('reported as operator close only') : bad('verdict', cc3.verdict.headline);

// ══ 4. External input is reported as unknown, not as automatic ══
console.log('\n[4] External input');
const cc4 = ctx.analyzeCustomClose(mkP([], latches, [{ name: 'CL3P', eq: 'IN103 AND 3P59Z AND TCCAP' }], 'N'), null);
!cc4.custom && cc4.hasExternal ? ok('contact input not claimed as automatic') : bad('external handling', kinds(cc4));

// ══ 5. A normal, enabled 79 scheme must be left alone ══
console.log('\n[5] Enabled 79 element');
const P5 = mkP([svsA[0]], latches, [{ name: 'CL3P', eq: 'NOT LT04 AND SV08 AND 3P59Z AND TCCAP' }], '4');
const cc5 = ctx.analyzeCustomClose(P5, null);
!cc5.custom ? ok('no automatic path claimed') : bad('false automatic path on a 79 device');
cc5.verdict === null ? ok('no competing verdict produced') : bad('verdict produced', JSON.stringify(cc5.verdict));
ctx.buildCustomCloseCard(P5, { customClose: cc5 }) === '' ? ok('card suppressed') : bad('card should be suppressed');

// ══ 6. Equation discovery from the settings text ══
console.log('\n[6] Close equation discovery');
const settings = ['E79     := N', 'CLA     :=SV01T OR CC3', 'CLB     :=SV05T OR CC3',
                  'CLC     :=0', 'ULCLA   :=F_TRIG SV01T'].join('\r\n');
const sch = ctx.parseRecloseScheme(settings, settings);
const found = (sch.closeEquations || []).map(e => e.name).join(',');
found === 'CLA,CLB,CLC' ? ok('per-switch close equations found', found) : bad('close equation discovery', found);
(sch.unlatchEquations || []).length === 1 ? ok('unlatch equation found') : bad('unlatch discovery');
const sch2 = ctx.parseRecloseScheme('E79     := N\r\nCL3P    :=SV09T', 'E79     := N\r\nCL3P    :=SV09T');
(sch2.closeEquations || []).length === 1 && sch2.closeEquations[0].name === 'CL3P'
  ? ok('CL3P still found on a standard recloser') : bad('CL3P discovery', JSON.stringify(sch2.closeEquations));

// ══ 7. Real files ══
console.log('\n[7] Real CEV files');
const dir = process.argv[2] || process.env.CEV_DIR || '/mnt/project';
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.CEV$/i.test(f)) : [];
if (!files.length) console.log('  SKIP  no .CEV files in ' + dir);
for (const f of files) {
  try {
    const P = ctx.parseCEV(fs.readFileSync(dir + '/' + f, 'latin1'), f);
    const A = ctx.analyzeCEV(P, null);
    const cc = A.customClose;
    const bits = [`E79=${P.reclose && P.reclose.E79raw}`];
    if (cc && cc.equations.length) bits.push(`close=${cc.equations.map(e => e.name).join('/')}`);
    bits.push(`auto=${cc && cc.custom ? (cc.autoPathName + ' @ ' + (cc.autoDelay ? ctx.ccFormatMs(cc.autoDelay.ms) : '?')) : 'none'}`);
    if (A.reclose && A.reclose.verdict) bits.push(`"${A.reclose.verdict.headline}"`);
    ok(f, bits.join('  '));
    if (A.reclose && A.reclose.enabled === true && cc && !cc.custom
        && /close by itself/i.test(A.reclose.verdict.headline)) {
      bad(f + ' — enabled 79 verdict changed without a custom path');
    }
  } catch (e) { bad(f, e.message); }
}

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll checks passed.\n');
process.exit(fails ? 1 : 0);
