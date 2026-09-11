// App bootstrap: wires up the drop zone and file input.

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const dropOverlay = document.getElementById('drop-overlay');

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => { if (e.target.files.length) processFiles(e.target.files); });

// ── Whole-window drag & drop ──
// Root cause of "drag-and-drop downloads a copy": the old code only listened on the small
// dropZone div. Missing that box by a pixel — or dragging onto the analysis screen, where
// the box isn't even in the DOM flow — left the browser with no handler to call
// preventDefault(), so it fell through to its native behavior of opening/downloading the
// file. Attaching dragover/drop at the window level, and calling preventDefault()
// unconditionally on both, means a drop is *never* allowed to fall through to the browser
// no matter where on the page it lands. processFiles() is then called regardless of which
// screen (upload or analysis) is currently showing, so dropping a new file works at any
// point in the workflow, not just on first load.

let dragDepth = 0; // counts nested dragenter/dragleave from child elements to avoid flicker

const isFileDrag = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

window.addEventListener('dragenter', e => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging-file');
});

window.addEventListener('dragover', e => {
  // This preventDefault() is the critical line: without it the browser refuses the drop
  // and instead performs its default action (navigate to / download the file).
  if (!isFileDrag(e)) return;
  e.preventDefault();
});

window.addEventListener('dragleave', e => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove('dragging-file');
});

window.addEventListener('drop', e => {
  e.preventDefault(); // always prevent the browser's default open/download behavior
  dragDepth = 0;
  document.body.classList.remove('dragging-file');
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files && e.dataTransfer.files.length) {
    processFiles(e.dataTransfer.files);
  }
});

// Keep the visible drop-zone box lighting up too, purely for the local highlight —
// functionality no longer depends on hitting it exactly.
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
