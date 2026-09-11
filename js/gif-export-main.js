// Animated GIF export of the main event charts.

async function downloadMainGIF() {
  if (!PARSED || !ANALYSIS) return;
  const trans = PARSED.digitalTransitions || [];
  if (!trans.length) return;
  const savedCursor = CURSOR_IDX;
  const savedViewIdx = LLG_VIEW_SAMPLE_IDX;
  const savedBannerWidth = BANNER_CHART_WIDTH;
  const savedZoom = { current: CHART_ZOOM.current, voltage: CHART_ZOOM.voltage, relevant: CHART_ZOOM.relevant, svflags: CHART_ZOOM.svflags };
  const savedLogicColW = LOGIC_COL_W, savedLogicRowH = LOGIC_ROW_H, savedLogicBoxW = LOGIC_BOX_W, savedLogicBoxH = LOGIC_BOX_H, savedLogicMargin = LOGIC_MARGIN;
  stopMainPlay();
  const btns = document.querySelectorAll('.mainGifBtn');
  const origLabel = 'GIF';
  try {
    btns.forEach(b => { b.textContent = '…'; b.disabled = true; });
    // Use a fixed chart width for the DURATION of this export only — every mini chart this
    // builds while it's set reads BANNER_CHART_WIDTH internally, so this single override is what
    // decouples the exported media's size from whatever width the live page happens to be at.
    BANNER_CHART_WIDTH = GIF_CHART_WIDTH;
    // Scale the logic-tree diagram's own native layout constants up for this export (rather than
    // a CSS transform on the rendered card): the tree's connecting lines are plain SVG <line>
    // elements with hardcoded numeric coordinates, walked and drawn onto the export canvas by
    // reading those raw attribute values — a CSS transform scales the boxes (whose position is
    // read live via getBoundingClientRect) but NOT those raw coordinates, so the two drifted
    // apart and most edges ended up drawn in the wrong place. Enlarging the actual constants the
    // tree is built from keeps every box and every line consistent at the bigger size.
    LOGIC_COL_W = Math.round(savedLogicColW * GIF_TREE_SCALE);
    LOGIC_ROW_H = Math.round(savedLogicRowH * GIF_TREE_SCALE);
    LOGIC_BOX_W = Math.round(savedLogicBoxW * GIF_TREE_SCALE);
    LOGIC_BOX_H = Math.round(savedLogicBoxH * GIF_TREE_SCALE);
    LOGIC_MARGIN = Math.round(savedLogicMargin * GIF_TREE_SCALE);

    const totalLen = PARSED.analogData.length;
    const loA = PLAY_MARK_A != null ? PLAY_MARK_A : 0;
    const loB = PLAY_MARK_B != null ? PLAY_MARK_B : totalLen - 1;
    const rawStart = Math.min(loA, loB), rawEnd = Math.max(loA, loB);
    const samplesPerCycleForGif = PARSED.eventInfo?.samPerCycA || 32;
    const msPerSampleForGif = 1000 / ((PARSED.eventInfo?.freq || 60) * samplesPerCycleForGif);
    // Shorten a long, uneventful trailing hold (nothing changing for the last several real
    // seconds before the window's own end) down to a fixed short pause instead — see
    // cappedTailEnd. Skipped entirely when the user explicitly set B themselves.
    const start = rawStart;
    const end = cappedTailEnd(trans.map(t => t.analogSampleIdx), rawStart, rawEnd, msPerSampleForGif, MAIN_PLAYBACK_SPEED, BASE_TIME_DILATION, PLAY_MARK_B != null, 1500);
    // Crop every mini chart to exactly the A/B playback window (or the whole record if no
    // window is set) instead of always showing the full record with the window merely marked —
    // matches what's actually being played/exported, and gives the visible portion much more of
    // the chart's own width to work with.
    const gifZoomRange = (PLAY_MARK_A != null || PLAY_MARK_B != null) ? { start, end } : null;
    CHART_ZOOM.current = gifZoomRange; CHART_ZOOM.voltage = gifZoomRange;
    CHART_ZOOM.relevant = gifZoomRange; CHART_ZOOM.svflags = gifZoomRange;
    let frameIdxs = [start, ...trans.map(t => t.analogSampleIdx).filter(a => a >= start && a <= end), end];
    if (!CHARTED_FILTER_RELEVANT) {
      // Best-effort only — if anything here goes wrong, the export still works, it just won't
      // have the extra in-between animation frames.
      try {
        const labelForGraph = currentChartedBitLabel();
        const tripFocusForGraph = isTripFocusLabel(labelForGraph, PARSED);
        const graphForWindows = buildLocalLogicGraph(PARSED, labelForGraph, tripFocusForGraph ? 25 : 20, tripFocusForGraph ? 25 : 14, !tripFocusForGraph);
        const analogWindows = findTimerAnimationWindows(PARSED, graphForWindows)
          .map(w => ({ startIdx: digitalIdxToAnalogIdx(w.startIdx), endIdx: digitalIdxToAnalogIdx(w.endIdx) }))
          .filter(w => w.endIdx >= start && w.startIdx <= end);
        frameIdxs.push(...timerWindowSampleIdxs(analogWindows, 8).filter(a => a >= start && a <= end));
      } catch (e) { /* ignore */ }
    }
    // General smoothness pass: don't let ANY two consecutive frames hold for more than ~700ms of
    // simulated (speed-adjusted) playback time — otherwise a long quiet stretch between recorded
    // transitions would jump in one cut instead of the cursor/markers sweeping smoothly across it,
    // same as watching it live in the tool.
    frameIdxs.push(...smoothFrameGaps([...new Set(frameIdxs)].sort((a, b) => a - b), msPerSampleForGif, MAIN_PLAYBACK_SPEED, BASE_TIME_DILATION, 700, 100));
    frameIdxs = [...new Set(frameIdxs)].sort((a, b) => a - b);

    // Build one off-screen container: a time-indicator header, the logic tree — enlarged — at
    // full width beneath it, then the four waveform/flag charts in a row at the bottom — reused
    // across frames, only the cursor/view-time (hence each frame's colors/dot-readouts and the
    // time label) changes. Mirrors whatever the "Logic Bit Charted" picker currently has
    // selected (default trip cause or any other bit; pruned tree or full local graph), so the
    // exported GIF always matches what's actually on screen.
    const probe = document.createElement('div');
    probe.style.position = 'fixed';
    probe.style.left = '-99999px';
    probe.style.top = '0';
    probe.style.display = 'flex';
    probe.style.flexDirection = 'column';
    probe.style.gap = '10px';
    probe.style.background = resolveCssColor('var(--bg)') || '#06090f';
    probe.style.padding = '10px';
    document.body.appendChild(probe);

    const timeHeader = document.createElement('div');
    timeHeader.style.fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--mono') || 'monospace';
    timeHeader.style.fontSize = '15px';
    timeHeader.style.fontWeight = '700';
    timeHeader.style.color = resolveCssColor('var(--accent)') || '#3b9eff';
    timeHeader.style.padding = '2px 4px';
    probe.appendChild(timeHeader);
    const treeSlot = document.createElement('div');
    probe.appendChild(treeSlot);
    const chartsRow = document.createElement('div');
    chartsRow.style.display = 'flex';
    chartsRow.style.flexDirection = 'row';
    chartsRow.style.gap = '8px';
    chartsRow.style.alignItems = 'flex-start';
    probe.appendChild(chartsRow);

    // The logic tree card — built directly at its (now enlarged) native size, no CSS transform
    // involved at all.
    function plainTreeCard(treeHtml) {
      treeSlot.innerHTML = '';
      const card = document.createElement('div');
      card.style.background = resolveCssColor('var(--card)') || '#0c1220';
      card.style.border = '1px solid ' + (resolveCssColor('var(--card-border)') || '#1c2434');
      card.style.borderRadius = '8px';
      card.style.padding = '10px';
      card.innerHTML = treeHtml;
      treeSlot.appendChild(card);
    }

    // Each mini chart renders at the fixed GIF_CHART_WIDTH set above (and, for the three
    // waveform charts, a taller GIF_CHART_HEIGHT — there's ample vertical room to spare in this
    // composite that the live banner doesn't have), then gets wrapped in a container sized to
    // match its true footprint exactly, so the flex row lays them out by their real visual size.
    // Only the title + the actual chart-svg-slot are kept for this composite — everything else
    // (the SV Flags chart's own lengthy descriptive legend, in particular) is dropped by
    // rebuilding a fresh minimal card rather than trying to selectively remove an unwanted
    // element.
    function scaledChartCard(html) {
      const inner = document.createElement('div');
      inner.innerHTML = html;
      const original = inner.firstElementChild;
      if (!original) return;
      const slot = original.querySelector('.chart-svg-slot');
      if (!slot) return;
      const card = document.createElement('div');
      card.className = original.className; // banner-mini-chart styling (background/border/padding)
      const title = original.querySelector('.banner-mini-chart-title');
      if (title) {
        const titleClone = document.createElement('div');
        titleClone.className = title.className;
        titleClone.textContent = title.textContent.replace(/scroll to zoom.*$|drag to pan.*$/i, '').trim();
        card.appendChild(titleClone);
      }
      card.appendChild(slot);
      const wrapper = document.createElement('div');
      wrapper.style.flex = '0 0 auto';
      card.style.width = GIF_CHART_WIDTH + 'px';
      wrapper.appendChild(card);
      chartsRow.appendChild(wrapper); // attach FIRST so getBoundingClientRect reflects the true size
      const cardRect = card.getBoundingClientRect();
      wrapper.style.width = Math.ceil(cardRect.width) + 'px';
      wrapper.style.height = Math.ceil(cardRect.height) + 'px';
    }

    const frames = [];
    // Canvas size is locked ONCE, from the first frame's measured content, then reused for
    // EVERY frame — this is what actually fixes the cut-off/corrupted bottoms: previously this
    // was recomputed every iteration but only the LAST frame's size was ever passed to
    // encodeGIF, so any earlier frame captured at a smaller size got its pixel buffer
    // reinterpreted at the wrong (larger) width/height, shearing/blacking out its bottom rows.
    // Locking it up front — with a comfortable safety pad — also directly delivers the
    // requested "constant size/resolution" output, independent of the browser window at capture
    // time.
    const EXPORT_SCALE = 1.3;
    const SIZE_SAFETY_PAD = 40; // extra px (pre-scale) so a slightly taller/wider later frame never clips
    let W = 0, H = 0;
    try {
      for (let fi = 0; fi < frameIdxs.length; fi++) {
        const idx = frameIdxs[fi];
        CURSOR_IDX = idx; // set directly — avoid re-rendering the LIVE charts on every frame
        const dIdx = analogIdxToDigitalIdx(idx);
        if (dIdx != null) setLogicChartViewIdx(dIdx);
        timeHeader.textContent = mainTimeLabel(idx);
        chartsRow.innerHTML = '';
        // Logic tree/graph, re-evaluated at this frame's instant — enlarged, first, most
        // prominent — matching whatever the "Logic Bit Charted" picker currently shows.
        if (CHARTED_FILTER_RELEVANT) {
          const causeForTree = getCurrentChartedCauseForTree();
          if (causeForTree && causeForTree.logicTree) {
            const freshTree = reEvaluateLogicTree(causeForTree.logicTree);
            const patchedCause = Object.assign({}, causeForTree, { logicTree: freshTree });
            const patchedAnalysis = Object.assign({}, ANALYSIS, { tripCause: patchedCause });
            const treeHtml = buildLogicTreeSection(PARSED, patchedAnalysis);
            if (treeHtml) plainTreeCard(treeHtml); else treeSlot.innerHTML = '';
          } else {
            treeSlot.innerHTML = '';
          }
        } else {
          const localHtml = buildChartedLocalGraphHTML(currentChartedBitLabel());
          if (localHtml) plainTreeCard(localHtml); else treeSlot.innerHTML = '';
        }
        // The four waveform/flag charts, rebuilt fresh (compact) so their cursor/marker overlays
        // reflect this frame's idx, laid out in one fixed-width row underneath the tree.
        scaledChartCard(buildCurrentMagChart(PARSED, ANALYSIS, true, GIF_CHART_HEIGHT));
        scaledChartCard(buildVoltageMagChart(PARSED, ANALYSIS, true, GIF_CHART_HEIGHT));
        const relevantHtml = buildRelevantQuantityChart(PARSED, ANALYSIS, true, GIF_CHART_HEIGHT);
        if (relevantHtml) scaledChartCard(relevantHtml);
        const svflagsHtml = buildSVFlagsChart(PARSED, ANALYSIS, true);
        if (svflagsHtml) scaledChartCard(svflagsHtml);
        await new Promise(r => setTimeout(r, 0));
        const rect = probe.getBoundingClientRect();
        if (fi === 0) {
          W = Math.max(1, Math.ceil((rect.width + SIZE_SAFETY_PAD) * EXPORT_SCALE));
          H = Math.max(1, Math.ceil((rect.height + SIZE_SAFETY_PAD) * EXPORT_SCALE));
        }
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.scale(EXPORT_SCALE, EXPORT_SCALE);
        ctx.fillStyle = resolveCssColor('var(--bg)') || '#06090f';
        ctx.fillRect(0, 0, W / EXPORT_SCALE, H / EXPORT_SCALE);
        llgRenderDomToCanvas(probe, ctx, rect);
        const nextIdx = frameIdxs[fi + 1];
        const elapsedMs = nextIdx != null ? (nextIdx - idx) * msPerSampleForGif : 400;
        const delayCs = Math.max(8, Math.min(600, (elapsedMs / (MAIN_PLAYBACK_SPEED * BASE_TIME_DILATION)) / 10));
        frames.push({ imageData: ctx.getImageData(0, 0, W, H), delayCs });
        btns.forEach(b => { b.textContent = `${fi + 1}/${frameIdxs.length}`; });
      }
    } finally {
      probe.remove();
    }
    if (!frames.length) throw new Error('no frames captured');

    // encodeGIF is async and yields between frames — keeps this responsive (and the button's
    // progress text updating) instead of freezing the tab for the whole encode in one go, which
    // is what could trip the browser's own "page unresponsive" prompt on a larger event.
    const gifBytes = await encodeGIF(frames, W, H, 140, (done, total) => {
      btns.forEach(b => { b.textContent = `Encoding ${done}/${total}`; });
    });
    const blob = new Blob([gifBytes], { type: 'image/gif' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const selectedLabel = currentChartedBitLabel() || ANALYSIS?.tripCause?.finalLabel || PARSED?.tripEquationName || 'TRIP';
    a.download = buildExportFilename(PARSED, ANALYSIS, selectedLabel, 'Event Playback', 'gif');
    document.body.appendChild(a); a.click(); a.remove();
  } catch (err) {
    console.error('Main GIF export failed:', err);
    alert('Could not generate the GIF in this browser. The play button and scrubber still work for stepping through the event.');
  } finally {
    BANNER_CHART_WIDTH = savedBannerWidth;
    CHART_ZOOM.current = savedZoom.current; CHART_ZOOM.voltage = savedZoom.voltage;
    CHART_ZOOM.relevant = savedZoom.relevant; CHART_ZOOM.svflags = savedZoom.svflags;
    LOGIC_COL_W = savedLogicColW; LOGIC_ROW_H = savedLogicRowH; LOGIC_BOX_W = savedLogicBoxW;
    LOGIC_BOX_H = savedLogicBoxH; LOGIC_MARGIN = savedLogicMargin;
    CURSOR_IDX = savedCursor;
    setLogicChartViewIdx(savedViewIdx);
    ZOOM_KINDS.forEach(k => rerenderZoomChart(k));
    syncMainScrubber(savedCursor != null ? savedCursor : 0);
    if (savedCursor != null) updateMainTimeReadout(savedCursor);
    redrawMainLogicTree();
    btns.forEach(b => { b.textContent = origLabel; b.disabled = false; });
  }
}
