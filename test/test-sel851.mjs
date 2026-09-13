// Node harness: runs the browser modules outside the browser against a real .evzip,
// the same eval-based approach used for the CEV regression suite.
import fs from 'fs';
import vm from 'vm';

const R = new URL('../js/', import.meta.url).pathname;
const ctx = {
  console, TextDecoder, DataView, Uint8Array, Math, Date, JSON, parseFloat, parseInt,
  Number, String, Array, Object, Set, Blob, Response, DecompressionStream, RegExp, isNaN,
};
vm.createContext(ctx);

// Helpers these modules expect to already exist in the page.
vm.runInContext(`
  function getTimestampMs(ts) {
    return new Date(ts.year, ts.month - 1, ts.day, ts.hour, ts.min, ts.sec, ts.msec).getTime();
  }
  function isFilteredQuarterCycle(spc) { return spc === 4; }
`, ctx);

for (const f of ['signal-processing.js', 'file-loading.js', 'parse-sel851.js', 'analyze-sel851.js']) {
  // file-loading.js touches document only inside processFiles(), so loading it is safe.
  vm.runInContext(fs.readFileSync(R + f, 'utf8'), ctx, { filename: f });
}

const zipPath = process.argv[2];
const buf = fs.readFileSync(zipPath);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const run = async () => {
  const entries = await ctx.unzipEntries(ab);
  console.log('ZIP entries:', entries.map(e => `${e.name} (${e.bytes.length} B)`).join('\n            '));

  const bundles = ctx.findSel851Bundle(entries);
  if (!bundles) { console.error('FAIL: findSel851Bundle returned null'); process.exit(1); }
  console.log('\nBundles found:', bundles.length);

  for (const b of bundles) {
    const P = ctx.parseSel851Bundle(ctx.entryText(b.cfg), b.dat.bytes, b.hdr ? ctx.entryText(b.hdr) : null, b.cfg.name);
    console.log('\n══ PARSE ══');
    console.log(' format          ', P.format);
    console.log(' device / site   ', P.device, '/', P.deviceLocation);
    console.log(' event           ', P.eventInfo.refNum, '—', P.eventInfo.eventType);
    console.log(' timestamp       ', `${P.timestamp.month}/${P.timestamp.day}/${P.timestamp.year} ${P.timestamp.hour}:${P.timestamp.min}:${P.timestamp.sec}.${P.timestamp.msec}`);
    console.log(' date order      ', P.cfg.dateOrder, '(cfg says', ctx.entryText(b.cfg).split(/\r?\n/).slice(-5)[0] + ')');
    console.log(' debug           ', JSON.stringify(P._debug));
    console.log(' ratios          ', JSON.stringify(P.ratios));
    console.log(' trip equation   ', (P.tripEquation || '').slice(0, 90) + '…');
    console.log(' channels        ', JSON.stringify(P.chan));
    console.log(' transitions     ', P.digitalTransitions.length);

    const A = ctx.analyzeSel851(P);
    console.log('\n══ ANALYSIS ══');
    console.log(' trip idx        ', A.tripIdx, `(${(A.tripIdx * P.msPerSample / 1000).toFixed(4)} s)`);
    console.log(' equation result ', A.equationResult);
    console.log(' initiators      ', A.initiators.join(', ') || '(none)');
    console.log(' breaker         ', JSON.stringify(A.breaker));
    console.log(' scaling         ', JSON.stringify(A.scaling));
    console.log(' fault origin    ', JSON.stringify(A.faultOrigin));

    console.log('\n ELEMENTS:');
    for (const e of A.elements) {
      console.log(`  ${e.element.padEnd(10)} init=${String(e.initiated).padEnd(5)} ena=${String(e.enabled).padEnd(5)} pu=${String(e.pickup).padEnd(8)}${e.qtyUnit.padEnd(6)}` +
        ` meas@TmOut=${e.measuredAtTimeout != null ? e.measuredAtTimeout.toFixed(2) : '—'}` +
        ` setDly=${e.delay ?? (e.expectedCurveSeconds != null ? e.expectedCurveSeconds.toFixed(3) : '—')}` +
        ` obsDly=${e.observedDelay != null ? e.observedDelay.toFixed(4) : '—'}` +
        ` agrees=${e.delayAgrees}`);
      for (const n of e.notes) console.log(`             note: ${n}`);
    }

    console.log('\n FINDINGS:');
    for (const f of A.findings) console.log(`  [${f.level.toUpperCase()}] ${f.code}: ${f.title}\n        ${f.detail}`);

    console.log('\n VERDICT:');
    console.log(`  ${A.verdict.level.toUpperCase()} — ${A.verdict.headline}`);
    console.log(`  ${A.verdict.detail}`);
  }
};
run().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
