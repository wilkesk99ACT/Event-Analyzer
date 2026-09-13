import fs from 'fs';
import vm from 'vm';
const R = new URL('../js/', import.meta.url).pathname;
const ctx = { console, TextDecoder, DataView, Uint8Array, Math, Date, JSON, parseFloat, parseInt,
  Number, String, Array, Object, Set, Map, Blob, Response, DecompressionStream, RegExp, isNaN, Infinity };
vm.createContext(ctx);
vm.runInContext(`
  function getTimestampMs(ts){return new Date(ts.year,ts.month-1,ts.day,ts.hour,ts.min,ts.sec,ts.msec).getTime();}
  function isFilteredQuarterCycle(spc){return spc===4;}
  function formatTimestamp(ts){return ts.month+'/'+ts.day+'/'+ts.year;}
`, ctx);
for (const f of ['signal-processing.js','file-loading.js','parse-cev.js','analyze-cev.js',
                 'analyze-reclose.js','parse-sel851.js','analyze-sel851.js']) {
  vm.runInContext(fs.readFileSync(R+f,'utf8'), ctx, { filename: f });
}

let fails = 0;
const ok  = (n,d='') => console.log(`  PASS  ${n}${d?'  — '+d:''}`);
const bad = (n,d='') => { fails++; console.log(`  FAIL  ${n}${d?'  — '+d:''}`); };

// ══ 1. Existing CEV path still parses and analyzes ══
console.log('\n[1] CEV regression — existing files must still parse');
// Point CEV_DIR at a folder of real .CEV files to run this section. If the folder is not
// there the suite skips it rather than failing, so the SEL-851 checks can still run alone.
const cevDir = process.env.CEV_DIR || '/mnt/project';
const cevFiles = fs.existsSync(cevDir) ? fs.readdirSync(cevDir).filter(f => /\.CEV$/i.test(f)) : [];
if (!cevFiles.length) console.log('  SKIP  no .CEV files found in ' + cevDir);
const results = [];
for (const f of cevFiles) {
  try {
    const P = ctx.parseCEV(fs.readFileSync(cevDir + '/' + f, 'latin1'), f);
    const A = ctx.analyzeCEV(P, null);
    results.push({ parsed: P, analysis: A, fileName: f });
    ok(f, `${P.analogData.length} samples, ${P.digitalTransitions.length} transitions, cause=${A.tripCause ? (A.tripCause.immediateCause || 'set') : 'null'}`);
  } catch (e) { bad(f, e.message); }
}
try { ctx.reconcileVnomAcrossEvents(results); ok('reconcileVnomAcrossEvents runs with sel851 guard'); }
catch (e) { bad('reconcileVnomAcrossEvents', e.message); }

// ══ 2. entryText round-trips text and preserves binary ══
console.log('\n[2] ZIP entry decoding');
const zipPath = process.argv[2];
const buf = fs.readFileSync(zipPath);
const run = async () => {
  const entries = await ctx.unzipEntries(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const dat = entries.find(e => /\.dat$/i.test(e.name));
  const cfg = entries.find(e => /\.cfg$/i.test(e.name));
  dat.bytes.length === 192000 ? ok('binary .dat kept intact', `${dat.bytes.length} bytes`) : bad('binary .dat', `${dat.bytes.length}`);
  // Proof the old behaviour was lossy: UTF-8 decoding this .dat and re-encoding loses bytes.
  const lossy = Buffer.from(new TextDecoder('utf-8').decode(dat.bytes), 'utf8');
  lossy.length !== 192000 ? ok('UTF-8 decoding would have corrupted it', `${lossy.length} bytes after round-trip, not 192000`)
                          : bad('UTF-8 round-trip unexpectedly clean');
  ctx.entryText(cfg).startsWith('SEL-851') ? ok('entryText decodes the .cfg') : bad('entryText .cfg');

  // ══ 3. Missing .hdr ══
  console.log('\n[3] Edge case — archive with no .hdr');
  try {
    const P = ctx.parseSel851Bundle(ctx.entryText(cfg), dat.bytes, null, cfg.name);
    const A = ctx.analyzeSel851(P);
    P._debug.hdrPresent === false ? ok('hdrPresent flagged false') : bad('hdrPresent');
    P.tripEquation === null ? ok('no trip equation, as expected') : bad('trip equation should be null');
    A.verdict && A.verdict.code === 'NO_SETTINGS'
    ? ok('reports that it cannot judge, rather than claiming an error', A.verdict.headline)
    : bad('no-hdr verdict', A.verdict ? A.verdict.code : 'none');
  A.findings.every(f => f.level !== 'error')
    ? ok('raises no false error without settings') : bad('false error raised without settings');
    A.elements.length === 0 ? ok('no element claims made without settings') : bad('elements claimed without settings', String(A.elements.length));
  } catch (e) { bad('no-hdr path threw', e.message); }

  // ══ 4. Truncated .dat ══
  console.log('\n[4] Edge case — truncated .dat');
  try {
    ctx.parseSel851Bundle(ctx.entryText(cfg), dat.bytes.slice(0, 50), null, cfg.name);
    bad('truncated .dat should throw');
  } catch (e) { ok('truncated .dat rejected with a clear message', e.message.slice(0, 80)); }

  // ══ 5. Archive that holds neither CEV nor COMTRADE ══
  console.log('\n[5] Edge case — unrecognised archive');
  const junk = [{ name: 'notes.pdf', bytes: new Uint8Array([1, 2, 3]) }];
  ctx.findSel851Bundle(junk) === null ? ok('findSel851Bundle returns null, so CEV path takes over') : bad('false positive bundle');

  // ══ 6. Boolean evaluator ══
  console.log('\n[6] SELogic evaluator');
  const bits = { A: 1, B: 0, C: 1, D: 0 };
  const get = n => (bits[n] === undefined ? null : bits[n]);
  const cases = [
    ['A OR B', true], ['A AND B', false], ['NOT B', true],
    ['B OR (A AND C)', true],                       // precedence: AND binds tighter than OR
    ['B AND C OR A', true], ['A AND B OR D', false],
    ['(B OR D) AND A', false], ['NOT A OR C', true],
    ['0 OR B', false], ['1 AND A', true],
    ['A OR UNKNOWN_BIT', null],                     // unresolved name must not silently read 0
  ];
  for (const [expr, want] of cases) {
    const got = ctx.evalSel851Expr(expr, get);
    got === want ? ok(expr, String(got)) : bad(expr, `got ${got}, want ${want}`);
  }

  // ══ 7. Top-level OR branch split ══
  console.log('\n[7] Branch split');
  const eq = 'X.TmOut OR Y.TmOut OR (RB_001.Sta AND (P.PU OR Q.PU))';
  const br = ctx.sel851TopLevelOrBranches(eq);
  br.length === 3 ? ok('three top-level branches', br.join(' | ')) : bad('branch count', String(br.length));
  br[2] === '(RB_001.Sta AND (P.PU OR Q.PU))' ? ok('nested OR not split') : bad('nested OR split', br[2]);

  // ══ 8. Inverse-time curves against published values ══
  console.log('\n[8] Curve constants');
  // U3 very inverse at M=2, TD=1  →  0.0963 + 3.88/3 = 1.3897 s
  const u3 = vm.runInContext('SEL851_CURVES.U3(2)', ctx);
  Math.abs(u3 - 1.38963) < 1e-4 ? ok('U3 at M=2', u3.toFixed(5)) : bad('U3', u3.toFixed(5));
  // U4 extremely inverse at M=2, TD=1  →  0.0352 + 5.67/3 = 1.9252 s
  const u4 = vm.runInContext('SEL851_CURVES.U4(2)', ctx);
  Math.abs(u4 - 1.92520) < 1e-4 ? ok('U4 at M=2', u4.toFixed(5)) : bad('U4', u4.toFixed(5));
  // Integrator on a steady current must reproduce the closed-form time.
  const msPer = 1000 / 2000;
  const steady = new Array(20000).fill(2.0);   // M = 2 against a 1.0 pickup
  const r = ctx.sel851IntegrateCurve('U3', 1.0, steady, 1.0, 0, msPer, 'Instantaneous');
  r && Math.abs(r.seconds - 1.38963) < 0.01 ? ok('integrator matches closed form', r.seconds.toFixed(4) + ' s')
                                            : bad('integrator', r ? r.seconds : 'null');
  // A current that drops back inside pickup must reset the integration.
  const dips = new Array(20000).fill(2.0); for (let i = 1000; i < 19000; i++) dips[i] = 0.5;
  const r2 = ctx.sel851IntegrateCurve('U3', 1.0, dips, 1.0, 0, msPer, 'Instantaneous');
  r2 && r2.idx === null ? ok('dropout resets the integration') : bad('dropout reset', JSON.stringify(r2));

  // ══ 9. Date-order resolution ══
  console.log('\n[9] COMTRADE date order');
  const dm = ctx.resolveSel851DateOrder('13/09/2026,06:57:52.337000', '13/09/2026,06:57:52.437000',
                                        { Event_Date: '09/13/2026', 'Time.DateFormat': 'MDY' });
  dm === 'DMY' ? ok('hdr cross-check resolves DMY') : bad('date order', dm);
  const amb = ctx.resolveSel851DateOrder('05/09/2026,00:00:00', '05/09/2026,00:00:00',
                                         { Event_Date: '09/05/2026', 'Time.DateFormat': 'MDY' });
  amb === 'DMY' ? ok('ambiguous date resolved by hdr, not by guessing') : bad('ambiguous date', amb);
  const noHdr = ctx.resolveSel851DateOrder('05/09/2026,00:00:00', '05/09/2026,00:00:00', {});
  noHdr === 'DMY' ? ok('falls back to the C37.111 default') : bad('fallback', noHdr);

  console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll checks passed.\n');
  process.exit(fails ? 1 : 0);
};
run().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
