// Animated GIF export of the logic graph, plus the hand-rolled GIF/LZW encoder.

async function downloadLogicChartGIF() {
  if (!LLG_CURRENT || !PARSED) return;
  const origLabel = 'GIF';
  const savedViewIdx = LLG_VIEW_SAMPLE_IDX;
  stopLogicChartPlay();
  try {
    document.querySelectorAll('.llgGifBtn').forEach(b => { b.textContent = '…'; b.disabled = true; });

    // One frame for EVERY recorded bit change within the selected A/B window (plus the window's
    // own start), so nothing is skipped. Deduped and sorted.
    const trans = PARSED.digitalTransitions || [];
    const maxDIdx = trans.length ? trans[trans.length - 1].digitalSampleIdx : 0;
    const loA = LLG_MARK_A != null ? LLG_MARK_A : 0;
    const loB = LLG_MARK_B != null ? LLG_MARK_B : maxDIdx;
    const rawGifStart = Math.min(loA, loB), rawGifEnd = Math.max(loA, loB);
    const freqForGif = PARSED.eventInfo?.freq || 60;
    const digitalRateForGif = PARSED.eventInfo?.samPerCycD || 4;
    const intervalMsForGif = 1000 / (freqForGif * digitalRateForGif);
    // Shorten a long, uneventful trailing hold down to a fixed short pause instead of letting the
    // export run all the way out to the window's own end — see cappedTailEnd. Skipped entirely
    // when the user explicitly set B themselves.
    const gifStart = rawGifStart;
    const gifEnd = cappedTailEnd(trans.map(t => t.digitalSampleIdx), rawGifStart, rawGifEnd, intervalMsForGif, LLG_PLAYBACK_SPEED, BASE_TIME_DILATION, LLG_MARK_B != null, 1500);
    let frameIdxs = [gifStart, ...trans.map(t => t.digitalSampleIdx).filter(d => d >= gifStart && d <= gifEnd), gifEnd];
    // Extra frames DURING any base -> timed-output window that falls (at least partly) inside
    // the selected range, so the animated fill in renderLocalLogicGraph actually shows up as
    // motion across several frames instead of a single instantaneous jump.
    const timerWindows = findTimerAnimationWindows(PARSED, LLG_CURRENT.graph)
      .filter(w => w.endIdx >= gifStart && w.startIdx <= gifEnd);
    frameIdxs.push(...timerWindowSampleIdxs(timerWindows, 8).filter(d => d >= gifStart && d <= gifEnd));
    // General smoothness pass: don't let ANY two consecutive frames hold for more than ~700ms of
    // simulated (speed-adjusted) playback time, same reasoning as the main GIF export.
    frameIdxs.push(...smoothFrameGaps([...new Set(frameIdxs)].sort((a, b) => a - b), intervalMsForGif, LLG_PLAYBACK_SPEED, BASE_TIME_DILATION, 700, 100));
    frameIdxs = [...new Set(frameIdxs)].sort((a, b) => a - b);

    // Render each frame from a freshly-built FULL diagram (via renderLocalLogicGraph at that view
    // time), measured by its own full content size — NOT the on-screen possibly-clipped/scrolled
    // element. This guarantees the whole logic chain is captured every time, and avoids the piled
    // up / clipped text that happens when rasterizing a horizontally-scrolled container.
    const { graph, P, tripFocus } = LLG_CURRENT;
    const scale = 2;

    // Build one off-screen container we reuse for every frame, sized to the diagram's full extent.
    const probe = document.createElement('div');
    probe.style.position = 'fixed';
    probe.style.left = '-99999px';
    probe.style.top = '0';
    probe.style.background = resolveCssColor('var(--bg)') || '#06090f';
    document.body.appendChild(probe);

    const frames = [];
    // Canvas size is locked from the FIRST frame (plus a safety pad) and reused for every
    // subsequent frame — this diagram's own layout doesn't depend on the live state being
    // shown, only on its (fixed, per-event) structure, so this both guarantees every frame's
    // pixel buffer matches the single width/height later passed to encodeGIF (previously only
    // the LAST frame's measured size was used there, which could mismatch and corrupt earlier
    // frames) and gives the export a constant, viewport-independent size/resolution.
    const SIZE_SAFETY_PAD = 30;
    let W = 0, H = 0;
    try {
      for (let fi = 0; fi < frameIdxs.length; fi++) {
        const idx = frameIdxs[fi];
        setLogicChartViewIdx(idx);
        const fullHTML = renderLocalLogicGraph(graph, P, tripFocus);
        const tmp = document.createElement('div');
        tmp.innerHTML = fullHTML;
        const inner = tmp.querySelector('#llgInnerDiagram');
        if (!inner) continue;
        // The inner diagram's own positioned child sets an explicit width/height in px — use it
        // directly as the true full size (independent of any scroll container).
        const sizedChild = inner.firstElementChild;
        const fw = parseFloat(sizedChild?.style.width) || inner.scrollWidth;
        const fh = parseFloat(sizedChild?.style.height) || inner.scrollHeight;
        probe.innerHTML = '';
        probe.appendChild(inner);
        // Measure & rasterize.
        await new Promise(r => setTimeout(r, 0));
        if (fi === 0) {
          W = Math.max(1, Math.ceil((fw + SIZE_SAFETY_PAD) * scale));
          H = Math.max(1, Math.ceil((fh + SIZE_SAFETY_PAD) * scale));
        }
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.fillStyle = resolveCssColor('var(--bg)') || '#06090f';
        ctx.fillRect(0, 0, W / scale, H / scale);
        llgRenderDomToCanvas(inner, ctx, inner.getBoundingClientRect());
        const nextIdx = frameIdxs[fi + 1];
        const elapsedMs = nextIdx != null ? (nextIdx - idx) * intervalMsForGif : 400;
        const delayCs = Math.max(8, Math.min(600, (elapsedMs / (LLG_PLAYBACK_SPEED * BASE_TIME_DILATION)) / 10));
        frames.push({ imageData: ctx.getImageData(0, 0, W, H), delayCs });
        document.querySelectorAll('.llgGifBtn').forEach(b => { b.textContent = `${fi + 1}/${frameIdxs.length}`; });
      }
    } finally {
      probe.remove();
    }
    if (!frames.length) throw new Error('no frames captured');

    // Per-frame delays above already carry the correct, speed-scaled pacing. encodeGIF is async
    // and yields between frames — keeps the tab responsive (and the button's progress text
    // updating) rather than freezing for the whole encode at once, which is what could trip the
    // browser's own "page unresponsive" prompt on a larger event.
    const gifBytes = await encodeGIF(frames, W, H, 140, (done, total) => {
      document.querySelectorAll('.llgGifBtn').forEach(b => { b.textContent = `Encoding ${done}/${total}`; });
    });
    const blob = new Blob([gifBytes], { type: 'image/gif' });
    const titleEl = document.getElementById('bitModalTitle');
    const selectedLabel = titleEl ? titleEl.textContent : (graph?.centerLabel || 'logic_chart');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = buildExportFilename(PARSED, ANALYSIS, selectedLabel, 'Logic Chart', 'gif');
    document.body.appendChild(a); a.click(); a.remove();
  } catch (err) {
    console.error('GIF export failed:', err);
    alert('Could not generate the GIF in this browser. The scrubber and play button still work for stepping through the event.');
  } finally {
    // Restore the view to wherever the scrubber was.
    setLogicChartViewIdx(savedViewIdx);
    redrawLogicChartInner();
    const scrubber = document.querySelector('.llgScrubber');
    const restoreIdx = savedViewIdx != null ? savedViewIdx : (scrubber ? parseInt(scrubber.value, 10) : 0);
    syncScrubbers(restoreIdx);
    updateLlgTimeReadout(restoreIdx);
    document.querySelectorAll('.llgGifBtn').forEach(b => { b.textContent = origLabel; b.disabled = false; });
  }
}

// Minimal animated-GIF (GIF89a) encoder. Each frame gets its own local color table built from
// its actual colors (the diagram uses only a small handful — background, red, muted, text,
// borders), so a 256-entry palette is always plenty and quantization is lossless in practice.
// delayCs is the per-frame delay in centiseconds (1/100 s). No dependencies.
// Async so the caller can await it and the browser stays responsive: quantizing + LZW-encoding
// every frame is real CPU work (a full pass over every pixel, more than once, per frame), and
// running all of it synchronously in one go — especially now that exported frames are a fixed,
// comfortably large size — was long enough to trip Chrome/Firefox's own "page unresponsive"
// hang detector on bigger events. Yielding back to the event loop between frames (a plain
// setTimeout(0), not requestAnimationFrame — this tab may not even be visible/foreground during
// a long export, and rAF callbacks are throttled or skipped entirely for background tabs) keeps
// each blocking chunk of work short enough that the browser never considers the page hung, even
// though the total wall-clock time is about the same. onProgress(done, total), if given, is
// called after each frame so the caller can show real progress instead of a static "…".
async function encodeGIF(frames, width, height, delayCs, onProgress) {
  const bytes = [];
  const push = (...b) => bytes.push(...b);
  const pushStr = s => { for (let i = 0; i < s.length; i++) push(s.charCodeAt(i)); };
  const pushShort = v => push(v & 0xff, (v >> 8) & 0xff);

  pushStr('GIF89a');
  pushShort(width); pushShort(height);
  push(0x70, 0, 0); // global flags: no global color table, color resolution bits
  // Netscape looping extension (loop forever)
  push(0x21, 0xff, 0x0b); pushStr('NETSCAPE2.0'); push(0x03, 0x01, 0x00, 0x00, 0x00);

  for (let fi = 0; fi < frames.length; fi++) {
    const frame = frames[fi];
    // Build this frame's palette + indexed pixels.
    const { palette, indices } = quantizeFrame(frame.imageData, width, height);
    // Palette must be a power-of-two size for the GIF color-table-size bits.
    let tableBits = Math.max(1, Math.ceil(Math.log2(Math.max(2, palette.length))));
    const tableSize = 1 << tableBits;

    // Graphic Control Extension (delay + no transparency) — a frame can carry its OWN delay
    // (frame.delayCs), letting playback pace hold each state proportional to how long it
    // actually lasted in the record, rather than every frame getting the same flat duration.
    const thisDelay = Math.max(1, Math.round(frame.delayCs != null ? frame.delayCs : delayCs));
    push(0x21, 0xf9, 0x04, 0x00, thisDelay & 0xff, (thisDelay >> 8) & 0xff, 0x00, 0x00);
    // Image Descriptor
    push(0x2c); pushShort(0); pushShort(0); pushShort(width); pushShort(height);
    push(0x80 | (tableBits - 1)); // local color table, size
    // Local color table (padded to tableSize entries)
    for (let i = 0; i < tableSize; i++) {
      const c = palette[i] || [0, 0, 0];
      push(c[0], c[1], c[2]);
    }
    // LZW-compressed image data
    const minCode = Math.max(2, tableBits);
    const lzw = lzwEncode(indices, minCode);
    push(minCode);
    for (let i = 0; i < lzw.length; i += 255) {
      const chunk = lzw.slice(i, i + 255);
      push(chunk.length, ...chunk);
    }
    push(0x00); // block terminator

    if (onProgress) onProgress(fi + 1, frames.length);
    await new Promise(r => setTimeout(r, 0));
  }

  push(0x3b); // trailer
  return new Uint8Array(bytes);
}

// Maps each pixel to a small palette (nearest of the distinct colors seen, capped at 256).
function quantizeFrame(imageData, width, height) {
  const data = imageData.data;
  const paletteMap = new Map(); // "r,g,b" -> index
  const palette = [];
  const indices = new Uint8Array(width * height);
  const keyOf = (r, g, b) => (r >> 3) + ',' + (g >> 3) + ',' + (b >> 3); // 5-bit buckets: plenty for a flat-color diagram
  for (let p = 0; p < width * height; p++) {
    const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2];
    const k = keyOf(r, g, b);
    let idx = paletteMap.get(k);
    if (idx === undefined) {
      if (palette.length < 256) { idx = palette.length; palette.push([r, g, b]); paletteMap.set(k, idx); }
      else { idx = nearestPaletteIdx(palette, r, g, b); } // palette full (very unlikely here) — snap to nearest
    }
    indices[p] = idx;
  }
  return { palette, indices };
}
function nearestPaletteIdx(palette, r, g, b) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const c = palette[i], d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Standard GIF LZW compressor. Returns an array of bytes (the raw LZW code stream).
function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dict = new Map();
  const resetDict = () => {
    dict = new Map();
    for (let i = 0; i < clearCode; i++) dict.set(String.fromCharCode(i), i);
  };
  resetDict();
  let next = eoiCode + 1;

  const out = [];
  let cur = 0, curBits = 0;
  const emit = code => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) { out.push(cur & 0xff); cur >>= 8; curBits -= 8; }
  };

  emit(clearCode);
  let w = '';
  for (let i = 0; i < indices.length; i++) {
    const c = String.fromCharCode(indices[i]);
    const wc = w + c;
    if (dict.has(wc)) { w = wc; }
    else {
      emit(dict.get(w));
      dict.set(wc, next++);
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
      else if (next > 4095) { emit(clearCode); resetDict(); next = eoiCode + 1; codeSize = minCodeSize + 1; }
      w = c;
    }
  }
  emit(dict.get(w));
  emit(eoiCode);
  if (curBits > 0) out.push(cur & 0xff);
  return out;
}

// Exports the CURRENT logic chart (legend + diagram, exactly as shown) to a downloadable PNG.
// Always reads from the original, live #llgSourceLegend/#llgSourceBody elements — which stay
// present in the DOM (the bit popup is simply covered, not removed, when fullscreen is open) —
// rather than whatever might currently be on screen, so this works identically whether or not
// the fullscreen overlay happens to be open.
function downloadLogicChart() {
  const body = document.getElementById('llgSourceBody');
  if (!body) return;
  const legend = document.getElementById('llgSourceLegend');
  const titleEl = document.getElementById('bitModalTitle');
  const selectedLabel = titleEl ? titleEl.textContent : 'logic_chart';
  const name = buildExportFilename(PARSED, ANALYSIS, selectedLabel, 'Logic Chart', 'png');

  // Stack a clone of the legend above a clone of the diagram in an off-screen (but still laid
  // out — position:fixed, not display:none) container so both export together as one image.
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-99999px';
  container.style.top = '0';
  container.style.display = 'inline-block';
  container.style.padding = '16px';
  container.style.background = resolveCssColor('var(--bg)') || '#06090f';
  if (legend) container.appendChild(legend.cloneNode(true));
  const bodyClone = body.cloneNode(true);
  // The live body has overflow-x:auto and is only as wide as the popup, so a wide chart is
  // clipped/scrolled on screen. Neutralize that on the clone so its FULL content lays out and
  // the whole chain is exported, not just the visible portion.
  bodyClone.removeAttribute('id');
  bodyClone.style.overflow = 'visible';
  bodyClone.style.width = 'max-content';
  bodyClone.style.maxWidth = 'none';
  container.appendChild(bodyClone);
  document.body.appendChild(container);
  try {
    exportNodeAsPNG(container, name);
  } finally {
    document.body.removeChild(container);
  }
}

// Resolves a CSS value that might be a var(--x) reference (as used throughout this tool's
// generated SVG) to its actual computed value — needed because canvas drawing calls (fillStyle,
// strokeStyle, etc.) don't understand var() themselves.
