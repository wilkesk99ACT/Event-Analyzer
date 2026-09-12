
// Resolves a CSS value that might be a var(--x) reference (as used throughout this tool's
// generated SVG) to its actual computed value — needed because canvas drawing calls (fillStyle,
// strokeStyle, etc.) don't understand var() themselves.
function resolveCssColor(v) {
  if (!v) return v;
  v = v.trim();
  const m = v.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.*))?\)$/);
  if (!m) return v;
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim();
  return resolved || m[2] || v;
}

// Draws a rounded-rectangle path (used for the box/legend-swatch backgrounds and borders).
function llgRoundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Draws an SVG path's `d` attribute (this tool only ever emits M/L/C commands, each followed by
// exactly one point — or, for C, three) onto a canvas context, offset by (ox, oy).
function llgDrawPathD(ctx, d, ox, oy) {
  const cmds = d.match(/[MLC][^MLC]*/g) || [];
  ctx.beginPath();
  cmds.forEach(cmd => {
    const type = cmd[0];
    const n = cmd.slice(1).trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (type === 'M') ctx.moveTo(ox + n[0], oy + n[1]);
    else if (type === 'L') ctx.lineTo(ox + n[0], oy + n[1]);
    else if (type === 'C') ctx.bezierCurveTo(ox + n[0], oy + n[1], ox + n[2], oy + n[3], ox + n[4], oy + n[5]);
  });
}

// Renders one <svg>'s drawable children (path/polygon/text — the only elements this tool's
// generated SVGs ever contain) onto a canvas context. Coordinates are taken from each element's
// own attributes (not getBoundingClientRect), matching how they were authored.
function llgRenderSvgToCanvas(svg, ctx, ox, oy) {
  Array.from(svg.children).forEach(el => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'style' || tag === 'title') return;
    const stroke = resolveCssColor(el.getAttribute('stroke'));
    const fill = resolveCssColor(el.getAttribute('fill'));
    const strokeWidth = parseFloat(el.getAttribute('stroke-width')) || 1;
    const dash = el.getAttribute('stroke-dasharray');
    const elOpacity = parseFloat(el.getAttribute('opacity'));
    const priorAlpha = ctx.globalAlpha;
    if (!isNaN(elOpacity)) ctx.globalAlpha = elOpacity;
    if (tag === 'rect') {
      const rx0 = parseFloat(el.getAttribute('x')) || 0, ry0 = parseFloat(el.getAttribute('y')) || 0;
      const rw = parseFloat(el.getAttribute('width')) || 0, rh = parseFloat(el.getAttribute('height')) || 0;
      const rr = parseFloat(el.getAttribute('rx')) || 0;
      if (rw <= 0 || rh <= 0) return;
      llgRoundRectPath(ctx, ox + rx0, oy + ry0, rw, rh, rr);
      if (fill && fill !== 'none') { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke && stroke !== 'none' && stroke !== 'transparent') {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = strokeWidth;
        ctx.setLineDash(dash ? dash.split(',').map(Number) : []);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else if (tag === 'circle') {
      const cx = parseFloat(el.getAttribute('cx')) || 0, cy = parseFloat(el.getAttribute('cy')) || 0;
      const r = parseFloat(el.getAttribute('r')) || 0;
      if (r <= 0) return;
      ctx.beginPath();
      ctx.arc(ox + cx, oy + cy, r, 0, Math.PI * 2);
      if (fill && fill !== 'none') { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke && stroke !== 'none' && stroke !== 'transparent') {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = strokeWidth;
        ctx.stroke();
      }
    } else if (tag === 'path') {
      const d = el.getAttribute('d');
      if (!d) return;
      llgDrawPathD(ctx, d, ox, oy);
      if (fill && fill !== 'none') { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke && stroke !== 'none' && stroke !== 'transparent') {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = strokeWidth;
        ctx.setLineDash(dash ? dash.split(',').map(Number) : []);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else if (tag === 'polygon') {
      const pts = (el.getAttribute('points') || '').trim().split(/\s+/).map(p => p.split(',').map(Number)).filter(p => p.length === 2);
      if (!pts.length) return;
      ctx.beginPath();
      ctx.moveTo(ox + pts[0][0], oy + pts[0][1]);
      pts.slice(1).forEach(p => ctx.lineTo(ox + p[0], oy + p[1]));
      ctx.closePath();
      ctx.fillStyle = (fill && fill !== 'none') ? fill : '#888';
      ctx.fill();
    } else if (tag === 'polyline') {
      const pts = (el.getAttribute('points') || '').trim().split(/\s+/).map(p => p.split(',').map(Number)).filter(p => p.length === 2);
      if (!pts.length) return;
      ctx.beginPath();
      ctx.moveTo(ox + pts[0][0], oy + pts[0][1]);
      pts.slice(1).forEach(p => ctx.lineTo(ox + p[0], oy + p[1]));
      if (stroke && stroke !== 'none' && stroke !== 'transparent') {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = strokeWidth;
        ctx.setLineDash(dash ? dash.split(',').map(Number) : []);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (fill && fill !== 'none') { ctx.fillStyle = fill; ctx.fill(); }
    } else if (tag === 'line') {
      const x1 = parseFloat(el.getAttribute('x1')) || 0, y1 = parseFloat(el.getAttribute('y1')) || 0;
      const x2 = parseFloat(el.getAttribute('x2')) || 0, y2 = parseFloat(el.getAttribute('y2')) || 0;
      if (!stroke || stroke === 'none' || stroke === 'transparent') return;
      ctx.beginPath();
      ctx.moveTo(ox + x1, oy + y1);
      ctx.lineTo(ox + x2, oy + y2);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeWidth;
      ctx.setLineDash(dash ? dash.split(',').map(Number) : []);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (tag === 'text') {
      const x = parseFloat(el.getAttribute('x')) || 0, y = parseFloat(el.getAttribute('y')) || 0;
      const anchor = el.getAttribute('text-anchor') || 'start';
      const fontSize = parseFloat(el.getAttribute('font-size')) || 10;
      ctx.font = `${fontSize}px ${getComputedStyle(document.documentElement).getPropertyValue('--sans') || 'sans-serif'}`;
      ctx.fillStyle = (fill && fill !== 'none') ? fill : (resolveCssColor('var(--text)') || '#e0e7f1');
      ctx.textAlign = anchor === 'middle' ? 'center' : (anchor === 'end' ? 'right' : 'left');
      ctx.textBaseline = 'alphabetic';
      // Only DIRECT text-node children — el.textContent would also pull in a nested <title>
      // tooltip's text (e.g. the row-label's hover description), concatenating it in front of
      // the actual label with no separator. That's exactly what produced the garbled/truncated
      // "...ntact, ANSI 52)52A"-style text: it was the tail end of the tooltip plus the real label.
      const directText = Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('');
      ctx.fillText(directText, ox + x, oy + y);
    }
    ctx.globalAlpha = priorAlpha;
  });
}

// Recursively renders a plain HTML node (the divs/spans used for boxes, the legend, and their
// text labels) onto a canvas context. Positions come from getBoundingClientRect() relative to
// `rootRect`, so this works regardless of how the node happens to be laid out (flex, absolute
// positioning, whatever) — it draws whatever actually rendered, not an assumption about it.
function llgRenderDomToCanvas(node, ctx, rootRect) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent.replace(/\s+/g, ' ').trim();
    if (!text || !node.parentElement) return;
    const cs = getComputedStyle(node.parentElement);
    const pr = node.parentElement.getBoundingClientRect();
    if (!pr.width || !pr.height) return;
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    ctx.fillStyle = cs.color;
    ctx.textBaseline = 'middle';
    const align = cs.textAlign === 'center' || cs.textAlign === 'right' ? cs.textAlign : 'left';
    ctx.textAlign = align;
    const tx = pr.left - rootRect.left + (align === 'center' ? pr.width / 2 : align === 'right' ? pr.width : 0);
    ctx.fillText(text, tx, pr.top - rootRect.top + pr.height / 2);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const tag = node.tagName.toLowerCase();
  const rect = node.getBoundingClientRect();
  const cs = getComputedStyle(node);
  // Our custom rasterizer doesn't get CSS clipping "for free" the way a real browser paint
  // does — every element's true (unclipped) geometry is what getBoundingClientRect reports,
  // regardless of an ancestor's overflow:hidden. Without explicitly clipping here, content that
  // should be cut off (a long legend string, a cursor readout box, anything wider/taller than
  // its scaled-down container) gets drawn in full at its real position instead, spilling across
  // neighboring elements — exactly what made the scaled mini-charts overflow their boxes.
  const overflowStyle = cs.overflow + cs.overflowX + cs.overflowY;
  const clips = rect.width > 0 && rect.height > 0 && /hidden|clip/.test(overflowStyle);
  if (clips) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.left - rootRect.left, rect.top - rootRect.top, rect.width, rect.height);
    ctx.clip();
  }
  if (tag === 'svg') {
    llgRenderSvgToCanvas(node, ctx, rect.left - rootRect.left, rect.top - rootRect.top);
  } else {
    if (rect.width > 0 && rect.height > 0) {
      const x = rect.left - rootRect.left, y = rect.top - rootRect.top;
      const bg = cs.backgroundColor;
      const hasBg = bg && !/rgba?\(0,\s*0,\s*0,\s*0\)/.test(bg) && bg !== 'transparent';
      const borderWidth = parseFloat(cs.borderTopWidth) || 0;
      const radius = parseFloat(cs.borderTopLeftRadius) || 0;
      if (hasBg || borderWidth > 0) {
        llgRoundRectPath(ctx, x, y, rect.width, rect.height, radius);
        if (hasBg) { ctx.fillStyle = bg; ctx.fill(); }
        if (borderWidth > 0) { ctx.lineWidth = borderWidth; ctx.strokeStyle = cs.borderTopColor; ctx.stroke(); }
      }
    }
    node.childNodes.forEach(child => llgRenderDomToCanvas(child, ctx, rootRect));
  }
  if (clips) ctx.restore();
}

// Rasterizes a DOM node (the divs + inline SVG used throughout the logic charts) to a PNG and
// triggers a download. Deliberately NOT the common "serialize to SVG foreignObject, load as an
// Image, draw to canvas" trick — that approach taints the canvas in several browsers as soon as
// a foreignObject is involved, throwing a SecurityError on the canvas export call. Because that
// throw happens inside an async image-load callback (outside any synchronous try/catch), it was
// failing completely silently — no error, no download, nothing — which is exactly what this was
// doing. Drawing directly with the Canvas 2D API instead (reading each element's real geometry
// via getBoundingClientRect/getComputedStyle) never touches an external image at all, so the
// canvas is never tainted and the export always completes.
function exportNodeAsPNG(node, filename) {
  try {
    const rect = node.getBoundingClientRect();
    const width = Math.max(1, Math.ceil(node.scrollWidth || rect.width));
    const height = Math.max(1, Math.ceil(node.scrollHeight || rect.height));
    const scale = 2; // export at 2x for a crisper image
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = resolveCssColor('var(--bg)') || '#06090f';
    ctx.fillRect(0, 0, width, height);
    llgRenderDomToCanvas(node, ctx, rect);
    canvas.toBlob(blob => {
      if (!blob) { alert('Could not generate the image in this browser — try its built-in screenshot tool instead.'); return; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, 'image/png');
  } catch (err) {
    console.error('Logic chart export failed:', err);
    alert('Could not generate the image in this browser — try its built-in screenshot tool instead.');
  }
}