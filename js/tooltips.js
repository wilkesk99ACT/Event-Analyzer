
// ════════════════════════════════════════════════════════════════════════════
// TOOLTIP DICTIONARY — SEL Relay Word Bits, ANSI Codes, Protection Elements
// Sources: SEL-651R-2 Instruction Manual (20251204), SEL-751A Instruction Manual (20260130)
// ════════════════════════════════════════════════════════════════════════════

const TOOLTIPS = {
  // ── Overcurrent Elements (50/51) ──
  '50A1':'Phase A instantaneous overcurrent level 1 pickup','50B1':'Phase B instantaneous overcurrent level 1 pickup','50C1':'Phase C instantaneous overcurrent level 1 pickup',
  '50P1':'Max-phase instantaneous overcurrent level 1 pickup (ANSI 50)','50P1T':'Max-phase inst. OC level 1 timed out — ready to trip',
  '50P2':'Max-phase inst. OC level 2 pickup','50P2T':'Max-phase inst. OC level 2 timed out','50P3':'Max-phase inst. OC level 3','50P3T':'Max-phase inst. OC level 3 timed out',
  '50P4':'Max-phase inst. OC level 4','50P4T':'Max-phase inst. OC level 4 timed out',
  '50G1':'Ground inst. overcurrent level 1 pickup (ANSI 50G)','50G1T':'Ground inst. OC level 1 timed out — ready to trip',
  '50G2':'Ground inst. OC level 2','50G2T':'Ground inst. OC level 2 timed out','50G3':'Ground inst. OC level 3','50G4':'Ground inst. OC level 4',
  '50Q1':'Neg-seq inst. OC level 1','50Q1T':'Neg-seq inst. OC level 1 timed out','50Q2':'Neg-seq inst. OC level 2','50Q3':'Neg-seq inst. OC level 3','50Q4':'Neg-seq inst. OC level 4',
  '50N1':'Neutral inst. OC level 1','50N1T':'Neutral inst. OC level 1 timed out','50N2':'Neutral inst. OC level 2',
  '50PAF':'Phase overcurrent all-phase flag','50NAF':'Neutral overcurrent all-phase flag',
  'ORED50T':'Logical OR of all 50-element timed outputs','ORED51T':'Logical OR of all 51-element timed outputs',
  '50BF':'Breaker failure overcurrent element (ANSI 50BF)',
  '51A':'Phase A time-overcurrent element (ANSI 51)','51AT':'Phase A time OC timed out','51AR':'Phase A time OC element reset',
  '51B':'Phase B time-overcurrent element','51BT':'Phase B time OC timed out','51BR':'Phase B time OC reset',
  '51C':'Phase C time-overcurrent element','51CT':'Phase C time OC timed out','51CR':'Phase C time OC reset',
  '51P':'Max-phase time-overcurrent pickup (ANSI 51)','51PT':'Max-phase time OC timed out — ready to trip','51PR':'Max-phase time OC reset','51PS':'Max-phase time OC started',
  '51P1P':'Phase time OC element 1 pickup','51P1T':'Phase time OC element 1 timed out','51P1R':'Phase time OC element 1 reset',
  '51P2P':'Phase time OC element 2 pickup','51P2T':'Phase time OC element 2 timed out',
  '51G1':'Ground time-overcurrent pickup (ANSI 51G)','51G1T':'Ground time OC timed out — ready to trip','51G1R':'Ground time OC reset','51G1S':'Ground time OC started',
  '51G2':'Ground time OC #2 pickup','51G2T':'Ground time OC #2 timed out','51G2R':'Ground time OC #2 reset',
  '51Q':'Neg-seq time-overcurrent pickup (ANSI 51Q)','51QT':'Neg-seq time OC timed out','51QR':'Neg-seq time OC reset',
  '51N1':'Neutral time OC #1','51N1T':'Neutral time OC #1 timed out','51N2':'Neutral time OC #2','51N2T':'Neutral time OC #2 timed out',
  // ── Voltage Elements (27/59) ──
  '27YA1':'Phase A undervoltage level 1 (Y-terminal, ANSI 27)','27YB1':'Phase B undervoltage level 1 (Y-terminal)','27YC1':'Phase C undervoltage level 1 (Y-terminal)',
  '27YA2':'Phase A undervoltage level 2 (Y-terminal, deeper UV)','27YB2':'Phase B UV level 2','27YC2':'Phase C UV level 2',
  '27YA3':'Phase A UV level 3 (Y-terminal)','27YB3':'Phase B UV level 3','27YC3':'Phase C UV level 3',
  '27YA4':'Phase A UV level 4 (Y-terminal)','27YB4':'Phase B UV level 4','27YC4':'Phase C UV level 4',
  '27ZA1':'Phase A UV level 1 (Z-terminal)','27ZB1':'Phase B UV level 1 (Z-terminal)','27ZC1':'Phase C UV level 1 (Z-terminal)',
  '27ZA2':'Phase A UV level 2 (Z-terminal)','27ZB2':'Phase B UV level 2 (Z-terminal)','27ZC2':'Phase C UV level 2 (Z-terminal)',
  '27ZA3':'Phase A UV level 3 (Z-terminal)','27ZB3':'Phase B UV level 3 (Z-terminal)','27ZC3':'Phase C UV level 3 (Z-terminal)',
  '27ZA4':'Phase A UV level 4 (Z-terminal)','27ZB4':'Phase B UV level 4 (Z-terminal)','27ZC4':'Phase C UV level 4 (Z-terminal)',
  '27P1':'Undervoltage level 1 pickup (ANSI 27)','27P1T':'UV level 1 timed out','27P2':'Undervoltage level 2 pickup','27P2T':'UV level 2 timed out',
  '27B81':'Undervoltage block for frequency elements — frequency tracking unreliable below this voltage',
  '3P27Y':'Three-phase undervoltage on Y-terminal (all 3 phases below pickup)','3P27Z':'Three-phase UV on Z-terminal','3P27':'Three-phase undervoltage',
  '59YA1':'Phase A overvoltage level 1 (Y-terminal, ANSI 59)','59YB1':'Phase B OV level 1','59YC1':'Phase C OV level 1',
  '59YA2':'Phase A OV level 2 (Y-terminal)','59YB2':'Phase B OV level 2','59YC2':'Phase C OV level 2',
  '59YA3':'Phase A OV level 3 (Y-terminal)','59YB3':'Phase B OV level 3','59YC3':'Phase C OV level 3',
  '59ZA1':'Phase A OV level 1 (Z-terminal)','59ZB1':'Phase B OV level 1 (Z-terminal)','59ZC1':'Phase C OV level 1 (Z-terminal)',
  '59ZA2':'Phase A OV level 2 (Z-terminal)','59ZB2':'Phase B OV level 2 (Z-terminal)','59ZC2':'Phase C OV level 2 (Z-terminal)',
  '59ZA3':'Phase A OV level 3 (Z-terminal)','59ZB3':'Phase B OV level 3 (Z-terminal)','59ZC3':'Phase C OV level 3 (Z-terminal)',
  '59P1':'Overvoltage level 1 pickup (ANSI 59)','59P1T':'OV level 1 timed out','59P2':'Overvoltage level 2 pickup','59P2T':'OV level 2 timed out',
  '3P59Y':'Three-phase overvoltage on Y-terminal','3P59Z':'Three-phase OV on Z-terminal','3P59':'Three-phase overvoltage',
  '59YN1':'Y-terminal zero-sequence (neutral) overvoltage level 1 (3V0)','59YN2':'Y-terminal zero-seq OV level 2',
  '59ZN1':'Z-terminal zero-sequence overvoltage level 1','59ZN2':'Z-terminal zero-seq OV level 2',
  '59YQ1':'Y-terminal negative-sequence overvoltage','59ZQ1':'Z-terminal negative-sequence overvoltage',
  '59G1':'Zero-sequence overvoltage element (ANSI 59G/59N)','59G1T':'Zero-seq OV timed out','59G2':'Zero-seq OV level 2','59G2T':'Zero-seq OV level 2 timed out',
  '59Q1':'Negative-sequence overvoltage','59Q1T':'Neg-seq OV timed out',
  '59VP':'Positive-seq OV pickup','59VS':'Calculated source voltage OV',
  // ── Frequency Elements (81) ──
  '81D1':'Frequency element level 1 (typically underfrequency, ANSI 81U)','81D1T':'Frequency level 1 timed out — ready to trip',
  '81D2':'Frequency element level 2','81D2T':'Frequency level 2 timed out',
  '81D3':'Frequency element level 3 (typically overfrequency, ANSI 81O)','81D3T':'Frequency level 3 timed out',
  '81D4':'Frequency element level 4','81D4T':'Frequency level 4 timed out',
  '81D5':'Frequency element level 5','81D5T':'Frequency level 5 timed out',
  '81D6':'Frequency element level 6','81D6T':'Frequency level 6 timed out',
  'FREQOK':'System frequency is within acceptable range for protection element operation',
  'ORED81T':'Logical OR of all 81D timed outputs','ORED81RT':'Logical OR of all 81 rate-of-change timed outputs',
  '81RFP':'Rate-of-change of frequency pickup','81RFT':'Rate-of-change of frequency timed out',
  // ── Breaker & Trip/Close ──
  '52A':'Breaker position: CLOSED (52a contact, ANSI 52)','52AA':'Breaker A-phase closed','52AB':'Breaker B-phase closed','52AC':'Breaker C-phase closed',
  '52A3P':'Three-phase breaker closed (all poles closed)','52B':'Breaker position: OPEN (52b contact)',
  'TRIP':'Trip output asserted','TRIP3P':'Three-phase trip output asserted','TRIPA':'Phase A trip','TRIPB':'Phase B trip','TRIPC':'Phase C trip',
  'TR':'Trip equation output (TR := trip logic)','TRIPLED':'TRIP target LED asserted',
  'CLOSE':'Close output asserted — the relay is commanding (or has commanded) the breaker to close','CL':'Close logic equation output (CL := close logic) — the settings-level definition behind the CLOSE Relay Word bit',
  'CLOSE3P':'Three-phase close command issued','CLOSEA':'Phase A close','CLOSEB':'Phase B close','CLOSEC':'Phase C close',
  'CC':'External/remote close command input (control contact) — typically a SCADA or RTU-initiated close','CC3':'External close command (control contact, 3-phase)','OC3':'External overcurrent/trip contact (3-phase)',
  'OC':'External overcurrent/trip contact input','OCA':'External OC contact phase A','OCB':'External OC B','OCC':'External OC C',
  'ULTRIP':'Unlatch trip — sustains trip after equation clears','ULCL3P':'Unlatch close (3-phase)',
  'SPOA':'Pole A open','SPOB':'Pole B open','SPOC':'Pole C open','SPO':'Single-pole open detected',
  '3PO':'Three-pole open condition — circuit breaker is open',
  'CFA':'Close failure phase A','CFB':'Close failure B','CFC':'Close failure C','CF3P':'Three-phase close failure','CF':'Close failure',
  'BFI':'Breaker failure initiate (ANSI 50BF)','BFT':'Breaker failure timed out — backup trip','BFTRIP':'Breaker failure trip',
  'BKMON':'Breaker monitor — excessive operations or slow clearing',
  // ── Reclosing (79) ──
  '79RS3P':'Reclose relay reset (ready for new reclose cycle)','79CY3P':'Reclose cycle in progress',
  '79LO3P':'Reclose locked out — all reclose attempts exhausted','79RS':'Reclose reset','79CY':'Reclose cycling','79LO':'Reclose lockout',
  'SH03P':'Reclose shot 0 (first trip, before any reclose attempts)','SH13P':'Shot 1 (1st reclose attempt)',
  'SH23P':'Shot 2','SH33P':'Shot 3','SH43P':'Shot 4',
  'RCSF3P':'Reclose successful — breaker held closed after reclose',
  // ── Power Quality & Misc ──
  'FAULT':'Fault condition detected (per FAULT equation)','FLT_ALM':'Fault alarm',
  'LOP':'Loss of potential — PT fuse failure or voltage source lost',
  'VPOLV':'Voltage polarizing available','V1GOOD':'Positive-sequence voltage sufficient for metering',
  'GNDSW':'Ground switch position (used for grounding transformer detection)',
  'TOSLP':'Relay going to sleep — loss of operating power imminent',
  'BTFAIL':'Battery failure detected','DTFAIL':'DC test failure',
  'TCCAP':'Trip/close capacitor charged and ready',
  'PWR_SRC1':'Primary power source healthy',
  '3PWR1':'Power measurement above threshold 1','3PWR1T':'Power threshold 1 timed','3PWR2':'Power measurement above threshold 2','3PWR2T':'Power threshold 2 timed',
  'SAGA':'Voltage sag detected on Phase A','SAGB':'Sag Phase B','SAGC':'Sag Phase C','SAG3P':'Three-phase voltage sag',
  'SWA':'Voltage swell detected on Phase A','SWB':'Swell Phase B','SWC':'Swell Phase C','SW3P':'Three-phase swell',
  '78VSO':'Vector shift (voltage phase angle shift) detected — possible islanding',
  'HBL2T':'Second harmonic blocking active (indicates transformer inrush, not a fault)',
  'HBL2AT':'2nd harmonic blocking Phase A','HBL2BT':'2nd harmonic blocking Phase B','HBL2CT':'2nd harmonic blocking Phase C',
  'REMTRIP':'Remote trip command received via communications',
  'COMMLOSS':'Communications link lost','COMMFLT':'Communications fault',
  // ── Directional Elements (67/32) ──
  '32QE':'Reactive power (Q) element (ANSI 32Q)','32VE':'Voltage-controlled directional element',
  'F32Q':'Forward reactive power','R32Q':'Reverse reactive power','F32V':'Forward voltage','R32V':'Reverse voltage',
  '67P1P':'Directional phase OC element 1 pickup','67P1T':'Directional phase OC 1 timed out',
  // ── Inputs/Outputs ──
  'IN101':'Digital input 101','IN102':'Digital input 102','IN103':'Digital input 103','IN104':'Digital input 104',
  'IN105':'Digital input 105 (often used for disconnect/yellow handle sense)','IN106':'Digital input 106','IN107':'Digital input 107',
  'IN201':'Digital input 201','IN202':'Digital input 202','IN203':'Digital input 203',
  'IN301':'Digital input 301','IN302':'Digital input 302','IN303':'Digital input 303','IN304':'Digital input 304',
  'OUT101':'Digital output 101','OUT102':'Digital output 102','OUT103':'Digital output 103',
  'OUT201':'Digital output 201','OUT202':'Digital output 202',
  'OUT301':'Digital output 301','OUT302':'Output 302','OUT303':'Output 303','OUT304':'Output 304',
  '69_YH':'Yellow handle operated (SEL recloser disconnect handle, ANSI 69)',
  // ── Pushbuttons & LEDs ──
  'PB01':'Front panel pushbutton 1','PB02':'Pushbutton 2','PB03':'Pushbutton 3','PB04':'Pushbutton 4',
  'PB05':'Pushbutton 5','PB06':'Pushbutton 6','PB07':'Pushbutton 7','PB08':'Pushbutton 8',
  'PB09':'Pushbutton 9','PB10':'Pushbutton 10','PB11':'Pushbutton 11 (typically CLOSE)','PB12':'Pushbutton 12 (typically TRIP)',
  'PB01_PUL':'PB01 pulse (momentary)','PB02_PUL':'PB02 pulse','PB11_PUL':'PB11 (CLOSE) pulse','PB12_PUL':'PB12 (TRIP) pulse — manual trip command',
  // ── Latch Bits & Logic ──
  'LT01':'Latch bit 01','LT02':'Latch bit 02 (often: reclose enabled)','LT03':'Latch bit 03 (often: remote enabled)',
  'LT04':'Latch bit 04 (often: fast curve enabled)','LT05':'Latch bit 05 (often: pushbutton lock)',
  'LT06':'Latch bit 06 (often: hot line tag — blocks closing)','LT07':'Latch bit 07','LT08':'Latch bit 08','LT09':'Latch bit 09',
  // ── SELogic Variables ──
  // These are device-specific — tooltips come from the SV equations parsed from the file
  // ── System/Status ──
  'EN':'Relay enabled','RELAY_EN':'Relay enabled and operational',
  'TSOK':'Time synchronization OK','IRIGOK':'IRIG-B time signal OK','PMDOK':'Phasor measurement data OK',
  'SALARM':'System alarm (settings changed, unauthorized access, etc.)','HALARM':'Hardware alarm',
  'HALARMA':'Hardware alarm A','HALARMP':'Hardware alarm P','HALARML':'Hardware alarm L',
  'DST':'Daylight saving time active','FREQTRK':'Frequency tracking — relay is tracking system frequency',
  'PMTRIG':'Phasor measurement triggered','ER':'Event report triggered',
  'TRGTR':'Target reset trigger',
  'SF':'Synchrocheck frequency match','25A1':'Synchrocheck element 1','25A2':'Synchrocheck element 2',
  'FIDEN':'Fault identification enabled',
  'FSA':'Fault phase A','FSB':'Fault phase B','FSC':'Fault phase C',
  'PHASE_A':'Fault on Phase A','PHASE_B':'Fault on Phase B','PHASE_C':'Fault on Phase C',
  'TESTDB':'Test mode active (via debug/test interface)',
};

const ANSI_FAMILY = {
  '50': { name: 'Instantaneous overcurrent', kind: 'definite' },
  '51': { name: 'Time-overcurrent', kind: 'inverse' },
  '67': { name: 'Directional overcurrent', kind: 'definite' },
  '27': { name: 'Undervoltage', kind: 'definite' },
  '59': { name: 'Overvoltage', kind: 'definite' },
  '81': { name: 'Frequency', kind: 'definite' },
};
const PHASE_WORD = {
  A: 'Phase A', B: 'Phase B', C: 'Phase C', G: 'ground/residual', N: 'neutral',
  Q: 'negative-sequence', P: 'phase (max of A/B/C)', V: 'voltage-polarized',
};
const PHASE_SUBJECT = { // for use as a sentence subject, e.g. "Phase A current has..."
  A: 'Phase A current', B: 'Phase B current', C: 'Phase C current', G: 'Ground/residual current',
  N: 'Neutral current', Q: 'Negative-sequence current', P: 'The highest phase current', V: 'Voltage',
};

// ══════════════════════════════════════════════════════════════════════
// TIMED BIT -> ITS INPUT BIT
// ══════════════════════════════════════════════════════════════════════
// A timed output (27PP1T, 51PT, SV07T) and the raw pickup that starts its timer (27PP1, 51P,
// SV07) are two different points in time, often by a hundred milliseconds or more, and the gap
// between them IS the timer. Showing only the timed form hides both when the condition first
// arose and how long the relay waited — which is usually the question being asked of a record.
//
// The relationship is firmware, not SELogic, so it appears in no equation and has to be
// reconstructed from the bit name. Two families:
//   SVnnT  -> SVnn                (settings-defined SELogic variable + its timer)
//   <ANSI>T -> <ANSI> or <ANSI>P  (protection element pickup -> coordinated timed output)
// The second is name-guessing, so it is deliberately conservative:
//   * ANSI element numbers always begin with a digit (27, 50, 51, 59, 67, 81…), which ordinary
//     named contacts/inputs/outputs (TRIP, ULTRIP, GNDSW, IN101, TR) essentially never do — that
//     is what stops this firing on every label that merely ends in "T".
//   * The candidate must be a bit this file actually RECORDS. Both spellings exist in the wild
//     (27PP1T -> 27PP1, but 50P1T -> 50P1P), and checking the file's own digital label list
//     resolves which one this relay uses instead of guessing per family.
// Returns null when nothing resolves — callers then simply show the timed bit alone, as before.
function timedBitInputLabel(label, P) {
  if (!label || !P) return null;
  const svm = label.match(/^SV(\d+)T$/);
  if (svm) {
    const base = `SV${svm[1]}`;
    return (P.svSettings || []).some(sv => sv.num === parseInt(svm[1])) ? base : null;
  }
  if (label.length <= 2 || !label.endsWith('T')) return null;
  const stem = label.slice(0, -1);
  if (!/^\d/.test(stem)) return null;
  const recorded = new Set((P.digitalLabels || []).filter(l => l && l !== '*'));
  for (const cand of [stem, stem + 'P']) {
    if (recorded.has(cand) && cand !== label) return cand;
  }
  return null;
}

// How long the timer actually ran in THIS record: the gap between the input bit's last assert
// and the timed bit's assert. Measured from the digital columns, so it needs no assumption about
// whether a given relay family expresses its delay setting in cycles or in seconds — a real
// ambiguity across SEL families that has produced unit errors elsewhere. Returns null when
// either bit never asserts, or the timed output leads its own input (nothing sensible to report).
function measuredTimerMs(P, inputLabel, timedLabel) {
  const trans = P?.digitalTransitions || [];
  if (!trans.length) return null;
  const spc = P.eventInfo?.samPerCycA || 32;
  const msPerSample = 1000 / ((P.eventInfo?.freq || 60) * spc);
  let lastInputIdx = null, timedIdx = null;
  for (const t of trans) {
    for (const c of t.changes) {
      if (c.label === inputLabel && c.asserted && timedIdx == null) lastInputIdx = t.analogSampleIdx;
      if (c.label === timedLabel && c.asserted && timedIdx == null) timedIdx = t.analogSampleIdx;
    }
  }
  if (lastInputIdx == null || timedIdx == null || timedIdx < lastInputIdx) return null;
  return (timedIdx - lastInputIdx) * msPerSample;
}

// ══════════════════════════════════════════════════════════════════════
// SELOGIC TIMER UNITS — cycles or seconds, decided per file from evidence
// ══════════════════════════════════════════════════════════════════════
// SVnnPU/SVnnDO are expressed in CYCLES on some SEL families and in SECONDS on others, and
// nothing in the file declares which. Assuming cycles everywhere is a 60x error where it's
// wrong: on SEL-751 record 10824, SV07PU = 0.16 rendered as "0.16 cyc = 3 ms" for a timer whose
// SV07 -> SV07T gap measures 162.5 ms in the very same record — i.e. 0.16 SECONDS.
//
// Rather than hardcode a family table (which would be wrong for the next firmware revision that
// changes it), infer per file: for every SV whose bare and timed forms both assert in this
// record, compare the measured gap against both readings of its setting and keep whichever is
// closer, then take the majority verdict. Returns null when the record contains no SV timer
// that actually ran, in which case callers keep the historical cycles assumption and say so.
function svTimerUnit(P) {
  if (!P) return null;
  if (P._svTimerUnit !== undefined) return P._svTimerUnit;
  const freq = P.eventInfo?.freq || 60;
  let sec = 0, cyc = 0;
  for (const sv of (P.svSettings || [])) {
    if (!(sv.pickupDelay > 0)) continue;
    const measured = measuredTimerMs(P, sv.label, sv.label + 'T');
    if (measured == null || measured <= 0) continue;
    const asSec = sv.pickupDelay * 1000, asCyc = sv.pickupDelay / freq * 1000;
    // Compare in log space so the verdict doesn't depend on the timer's absolute size.
    if (Math.abs(Math.log(measured / asSec)) < Math.abs(Math.log(measured / asCyc))) sec++; else cyc++;
  }
  P._svTimerUnit = (sec === 0 && cyc === 0) ? null : (sec > cyc ? 'seconds' : 'cycles');
  return P._svTimerUnit;
}
// Convert an SV timer setting to milliseconds using this file's inferred units. `assumed` is
// true when no evidence was available and the historical cycles reading was used, so callers can
// caveat the number instead of stating it as fact.
function svDelayMs(P, value, freq) {
  freq = freq || P?.eventInfo?.freq || 60;
  const unit = svTimerUnit(P);
  if (unit === 'seconds') return { ms: value * 1000, unit: 'seconds', assumed: false };
  return { ms: value / freq * 1000, unit: 'cycles', assumed: unit == null };
}

// ══════════════════════════════════════════════════════════════════════
// TIMER PROGRESS AT A GIVEN INSTANT
// ══════════════════════════════════════════════════════════════════════
// How far through its delay a base -> timed-output pair is, as of `viewDigIdx`. Measured from
// the record's own transitions (never from a delay setting), so it works identically for SVs and
// for hardware protection elements — including elements whose delay setting isn't parsed, or
// whose setting units are ambiguous across SEL families.
//
// Returns { frac, kind, elapsedSamples, totalSamples } while the timer is genuinely running, or
// null when it isn't — stable, never completes in this record, or resets partway (which is
// indeterminate, and guessing at it would invent a countdown that never happened).
// Shared by the local logic graph and the main-page trip tree so the two can never disagree.
function measuredTimerPhase(P, base, target, viewDigIdx) {
  if (!P || viewDigIdx == null || !base || !target) return null;
  const trans = P.digitalTransitions || [];
  const lastTo = (label, atIdx, want) => {
    let found = null;
    for (const t of trans) {
      if (t.digitalSampleIdx > atIdx) break;
      const c = t.changes.find(ch => ch.label === label);
      if (c && c.asserted === want) found = t.digitalSampleIdx;
    }
    return found;
  };
  const nextTo = (label, afterIdx, want) => {
    for (const t of trans) {
      if (t.digitalSampleIdx <= afterIdx) continue;
      const c = t.changes.find(ch => ch.label === label);
      if (c && c.asserted === want) return t.digitalSampleIdx;
    }
    return null;
  };
  const baseSt = currentBitState(base), targetSt = currentBitState(target);
  if (!baseSt || !targetSt) return null;
  const run = (want) => {
    // want=true  -> pickup  (base asserted, timed output hasn't caught up)
    // want=false -> dropout (base released, timed output hasn't dropped out)
    const tStart = lastTo(base, viewDigIdx, want);
    if (tStart == null) return null;            // already in this state at record start — no origin to measure from
    const tBaseReverts = nextTo(base, tStart, !want);
    const tEnd = nextTo(target, tStart, want);
    if (tEnd == null) return null;              // never actually completes in this record
    if (tBaseReverts != null && tBaseReverts < tEnd) return null; // reset before completing
    const total = Math.max(1, tEnd - tStart);
    return { frac: Math.max(0, Math.min(1, (viewDigIdx - tStart) / total)),
             kind: want ? 'pickup' : 'dropout',
             elapsedSamples: Math.max(0, Math.min(total, viewDigIdx - tStart)), totalSamples: total };
  };
  if (baseSt.state && !targetSt.state) return run(true);
  if (!baseSt.state && targetSt.state) return run(false);
  return null; // stable — both already agree
}

// The instant the logic diagrams are currently being read at, as a DIGITAL sample index: the
// scrubber/cursor position when one is set, otherwise the trip moment.
function logicViewDigitalIdx() {
  return (typeof LLG_VIEW_SAMPLE_IDX !== 'undefined' && LLG_VIEW_SAMPLE_IDX != null)
    ? LLG_VIEW_SAMPLE_IDX
    : (ANALYSIS?.tripCause?.tripTransition?.digitalSampleIdx ?? null);
}

// Best-effort lookup of a definite-time delay setting for a given element base (e.g. "50A1"),
// trying the handful of naming conventions SEL uses across relay families. Returns null (and
// the explanation falls back to qualitative wording) if nothing matches — this is inherently
// a guess at naming convention, not a guarantee every file exposes the delay under one of these.
function findElementDelayMs(P, base, freq) {
  if (!P) return null;
  const cyc = getSettingNum(P, [base + 'D', base + 'DL', base + 'DLY']);
  if (cyc != null) return { cycles: cyc, ms: cyc / (freq || 60) * 1000 };
  return null;
}

// Structured, family-aware explanation for a numbered protection element bit — the natural-
// language short name PLUS specific (not boilerplate) sentences for what asserted/de-asserted
// actually means, distinguishing fixed-delay elements (50/27/59/81/67) from inverse-time
// elements (51), where "starts a fixed timer" would be physically wrong.
function explainElementBit(label, P, freq) {
  freq = freq || 60;

  // ── SV logic/timer variables: explain from THIS relay's own equation and delays ──
  let sm = label.match(/^SV(\d+)(T?)$/);
  if (sm && P) {
    const sv = (P.svSettings || []).find(s => s.num === parseInt(sm[1]));
    if (sv) {
      const comment = sv.equation.includes('#') ? sv.equation.split('#')[1].trim() : '';
      const eq = sv.equation.split('#')[0].trim();
      const puMs = svDelayMs(P, sv.pickupDelay, freq).ms.toFixed(0);
      const what = comment ? `${comment} (site-programmed logic ${sv.label})` : `Site-programmed logic variable ${sv.label}`;
      if (sm[2] === 'T') return {
        short: `${what} — timed output`,
        on: `The logic condition "${eq}" has held true for the full ${sv.pickupDelay}-cycle (${puMs} ms) pickup delay. This timed output is what feeds downstream trip/output logic.`,
        off: `The condition "${eq}" either isn't true right now, or hasn't yet held for the full ${sv.pickupDelay}-cycle delay.`,
      };
      return {
        short: what,
        on: `The logic condition "${eq}" is true right now. ${sv.pickupDelay > 0 ? `This starts the ${sv.pickupDelay}-cycle (${puMs} ms) timer toward ${sv.label}T.` : `With no pickup delay, ${sv.label}T follows immediately.`}`,
        off: `The condition "${eq}" is not currently true${sv.pickupDelay > 0 ? `, so the timer toward ${sv.label}T isn't running (or has reset)` : ''}.`,
      };
    }
  }

  // ── Specific, operationally-important named bits ──
  const NAMED = {
    TRIP: { short: 'Trip command', on: 'The relay is actively commanding its breaker/recloser to open — this is the final output of the trip logic.', off: 'No trip command is being issued.' },
    TR: { short: 'Trip logic result', on: 'The trip equation is currently satisfied — this drives the TRIP command output.', off: 'The trip equation is not currently satisfied.' },
    ULTRIP: { short: 'Unlatched trip', on: 'The unlatch/trip-release logic is active.', off: 'Unlatch condition not present.' },
    '52A': { short: 'Breaker status — closed', on: 'The breaker/recloser auxiliary contact reports CLOSED.', off: 'The breaker/recloser reports OPEN.' },
    '52B': { short: 'Breaker status — open (inverse contact)', on: 'The breaker/recloser reports OPEN (52B is the inverse of 52A).', off: 'The breaker/recloser reports CLOSED.' },
    LOP: { short: 'Loss of potential detected', on: 'The relay believes one or more of its own voltage inputs has failed (e.g. blown PT fuse) — measured voltages are inconsistent in a way a real power-system event wouldn\u2019t produce. Voltage-based elements may be blocked or unreliable while this is set.', off: 'Voltage inputs look consistent — no loss-of-potential condition detected.' },
    ER: { short: 'Event report trigger', on: 'The relay\u2019s event-recording condition fired — this is what caused a record like this file to be captured. It does not itself trip anything.', off: 'The event-record trigger condition is not active.' },
    CLOSE: { short: 'Close command', on: 'The relay is commanding the breaker/recloser to close.', off: 'No close command is being issued.' },
    CL: { short: 'Close logic result', on: 'The close equation is satisfied, driving the close command.', off: 'Close logic not satisfied.' },
    CC: { short: 'Close command received (external)', on: 'An external/remote close command input is present.', off: 'No external close command present.' },
    OC: { short: 'Open command received (external)', on: 'An external/remote open command input is present.', off: 'No external open command present.' },
    '79RS': { short: 'Recloser — reset state', on: 'The reclosing sequence is in its normal, reset state (ready; no shots used).', off: 'The recloser is NOT in reset — it\u2019s mid-sequence (cycling) or locked out.' },
    '79CY': { short: 'Recloser — cycling', on: 'A reclose sequence is actively in progress (the device tripped and is timing toward, or between, reclose attempts).', off: 'No reclose sequence in progress.' },
    '79LO': { short: 'Recloser — lockout', on: 'The recloser is LOCKED OUT: it has used its programmed reclose attempts (or was driven to lockout) and will not close again without intervention.', off: 'The recloser is not locked out.' },
    BFI: { short: 'Breaker-failure initiate', on: 'Breaker-failure timing has been started — the relay tripped and is now watching whether the breaker actually clears in time.', off: 'Breaker-failure scheme not initiated.' },
    BFT: { short: 'Breaker-failure trip', on: 'The breaker FAILED to clear within the breaker-failure time — this output typically trips upstream/backup devices. A serious, device-health event.', off: 'No breaker-failure operation.' },
    '50BF': { short: 'Breaker-failure current supervision', on: 'Current is still flowing above the breaker-failure threshold — used to judge whether the breaker actually opened.', off: 'Current is below the breaker-failure supervision threshold.' },
    FAULT: { short: 'Fault indication', on: 'The relay\u2019s composite fault-detection logic is active — some protective element sees a fault-like condition.', off: 'No composite fault condition indicated.' },
    LOCAL: { short: 'Local control mode', on: 'The device is in LOCAL control — remote/SCADA operate commands are typically blocked.', off: 'The device is in remote-permitted control.' },
    REMTRIP: { short: 'Remote trip received', on: 'A trip command arrived from a remote device/communications channel — the trip originated elsewhere, not from this relay\u2019s own measurements.', off: 'No remote trip command present.' },
    COMMLOSS: { short: 'Communications loss', on: 'A monitored communications channel is down.', off: 'Communications channel healthy.' },
    FREQTRK: { short: 'Frequency tracking', on: 'The relay\u2019s sampling is actively tracking measured system frequency.', off: 'Frequency tracking inactive (e.g. voltage too low to track) — the relay falls back to nominal frequency.' },
  };
  if (NAMED[label]) return NAMED[label];

  // ── 81RF rate-of-change-of-frequency scheme bits ──
  if (/^81RF/.test(label)) {
    const sub = { '81RFT': ['timed out', 'Rate-of-change-of-frequency (df/dt) protection has timed out — frequency was moving fast enough, long enough, to operate.', 'df/dt element not timed out.'], '81RFP': ['pickup', 'Frequency is currently changing faster than the df/dt pickup threshold.', 'Frequency rate-of-change is below the pickup threshold.'], '81RFI': ['inhibit', 'The df/dt element is inhibited (e.g. low voltage).', 'df/dt element not inhibited.'], '81RFBL': ['blocked', 'The df/dt element is blocked by supervising logic.', 'df/dt element not blocked.'] }[label];
    if (sub) return { short: `Rate-of-change-of-frequency (df/dt) — ${sub[0]}`, on: sub[1], off: sub[2] };
    return { short: 'Rate-of-change-of-frequency (df/dt) scheme bit', on: 'This df/dt scheme condition is active.', off: 'This df/dt scheme condition is not active.' };
  }

  // ── Numbered protection elements — the full grammar ──
  const m = label.match(/^(25|27|32|3?PWR|50|51|55|59|67|78|81)(PP|[ABCGNQPVSDIR])?(\d)?(RS|[PTRS])?$/);
  if (m) {
    const [, dev, qual, num, suf] = m;
    const lvl = num ? `level ${num}` : '';
    const base = label.replace(/(RS|[PTRS])$/, '');
    const pairT = base + 'T';

    // Subject + short name per device family and qualifier
    const QUAL_WORD = { A: 'Phase A', B: 'Phase B', C: 'Phase C', G: 'ground/residual', N: 'neutral', Q: 'negative-sequence', P: 'phase (max of A/B/C)', V: 'voltage-polarized', PP: 'phase-to-phase', S: 'synchronism (Vs) terminal', I: 'independent element bank', D: '', R: 'rate-of-change' };
    const qWord = qual ? (QUAL_WORD[qual] ?? qual) : '';

    let famName, subj, verb, qty, kind = 'definite';
    if (dev === '27') { famName = 'Undervoltage'; subj = qual === 'PP' ? 'A phase-to-phase voltage' : qual === 'S' ? 'The synchronism (Vs) input voltage' : qual === 'I' ? `Voltage (independent element ${num || ''})` : `${qWord ? qWord + ' ' : ''}voltage`; verb = 'dropped below'; qty = `the ${lvl} undervoltage threshold`; }
    else if (dev === '59') { famName = 'Overvoltage'; subj = qual === 'PP' ? 'A phase-to-phase voltage' : qual === 'S' ? 'The synchronism (Vs) input voltage' : qual === 'G' ? 'Zero-sequence (3V0) voltage' : qual === 'Q' ? 'Negative-sequence voltage' : qual === 'I' ? `Voltage (independent element ${num || ''})` : `${qWord ? qWord + ' ' : ''}voltage`; verb = 'exceeded'; qty = `the ${lvl} overvoltage threshold`; }
    else if (dev === '50') { famName = 'Instantaneous overcurrent'; subj = PHASE_SUBJECT[qual] || 'Current'; verb = 'exceeded'; qty = `the ${lvl} pickup`; }
    else if (dev === '51') { famName = 'Time-overcurrent'; subj = PHASE_SUBJECT[qual] || 'Current'; kind = 'inverse'; }
    else if (dev === '67') { famName = 'Directional overcurrent'; subj = PHASE_SUBJECT[qual] || 'Current'; verb = 'exceeded'; qty = `the ${lvl} pickup (in this element\u2019s supervised direction)`; }
    else if (dev === '81' && qual === 'R') { famName = 'Frequency rate-of-change'; subj = 'The rate of frequency change (df/dt)'; verb = 'exceeded'; qty = `the ${lvl} df/dt setpoint`; }
    else if (dev === '81') { famName = 'Frequency'; subj = 'System frequency'; verb = 'moved past'; qty = `the ${lvl} frequency setpoint (over- or under-frequency, per this element\u2019s setting)`; }
    else if (dev === '25') { famName = 'Synchronism check'; subj = 'The two sides being compared'; return { short: `Synchronism check ${lvl}`.trim(), on: 'Voltage magnitude, angle, and slip across the device are all within the configured sync-check windows — closing is permitted by this element.', off: 'The two sides are NOT currently within the sync-check windows — this element is withholding close permission.' }; }
    else if (dev === '55') { return { short: `Power factor element ${lvl}`.trim(), on: suf === 'T' ? 'Power factor stayed past its threshold for the full time delay.' : 'Power factor is currently past its configured threshold.', off: 'Power factor is within its normal configured range.' }; }
    else if (dev === '78') { return { short: 'Vector shift / out-of-step element', on: 'A sudden voltage phase-angle jump (vector shift) beyond the setpoint was detected — commonly used for anti-islanding at DER sites.', off: 'No qualifying vector shift detected.' }; }
    else if (/PWR/.test(dev)) { return { short: `Power element ${lvl}`.trim(), on: suf === 'T' ? `Measured power stayed past the ${lvl} threshold for the full delay — this output feeds trip/alarm logic.` : `Measured power is past the ${lvl} threshold${suf === 'P' ? `, starting the timer toward ${pairT}` : ''}.`, off: 'Measured power is within its normal configured range.' }; }
    else if (dev === '32') { return { short: `Directional power element ${qWord} ${lvl}`.trim(), on: 'Power flow past this element\u2019s threshold, in its configured direction.', off: 'Power flow is not past this element\u2019s directional threshold.' }; }

    if (famName) {
      const short = `${famName} ${lvl}${qWord ? ' \u2014 ' + qWord : ''}`.replace(/\s+/g, ' ').trim();
      if (kind === 'inverse') {
        if (suf === 'T') return { short: `${short} (timed out)`, on: `${subj} stayed above the ${lvl} pickup long enough for this element's inverse-time curve to fully integrate \u2014 this is the output that actually feeds trip logic.`, off: `The inverse-time curve has not completed \u2014 either ${subj.toLowerCase()} never exceeded pickup, or it dropped back before the curve finished.` };
        if (suf === 'R' || suf === 'RS') return { short: `${short} (reset)`, on: `${subj} dropped back below the ${lvl} pickup and the integrator has fully reset.`, off: `The integrator has not fully reset \u2014 it may still be counting down from a prior pickup.` };
        return { short, on: `${subj} has exceeded the ${lvl} time-overcurrent pickup. Timing toward a trip follows this element's inverse-time curve \u2014 the further above pickup, the faster it times out.`, off: `${subj} is below the ${lvl} pickup \u2014 not timing.` };
      }
      const delay = findElementDelayMs(P, base, freq);
      const delayPhrase = delay ? `${delay.cycles}-cycle (${delay.ms.toFixed(0)} ms)` : null;
      if (suf === 'T') return { short: `${short} (timed out)`, on: `${subj} stayed past ${qty} for the full ${delayPhrase || 'configured'} delay \u2014 this is the output that feeds trip/output logic (unlike the instantaneous pickup alone).`, off: `The ${lvl} timer has not completed \u2014 the condition cleared early or never started.` };
      if (suf === 'RS') return { short: `${short} (reset)`, on: `This element has fully reset after a prior operation.`, off: `This element has not reset.` };
      return { short, on: `${subj} has ${verb} ${qty}. This starts ${delayPhrase ? 'a ' + delayPhrase : 'this element\u2019s configured'} timer \u2014 if the condition holds for the full delay, ${pairT} asserts and feeds the trip logic.`, off: `${subj} is back within normal range \u2014 no longer ${verb === 'dropped below' ? 'below' : 'past'} ${qty}.` };
    }
  }

  // SV bit whose equation isn't in this file's parsed settings — still explain what SVs are.
  if (sm) {
    const isT = sm[2] === 'T';
    return {
      short: `Site-programmed logic variable SV${sm[1]}${isT ? ' \u2014 timed output' : ''}`,
      on: isT ? `The site-programmed condition behind SV${sm[1]} held true for its full pickup delay. Its specific equation isn't included in this file \u2014 check this relay's settings for what SV${sm[1]} is programmed to represent.` : `The site-programmed condition behind SV${sm[1]} is currently true. Its equation isn't included in this file \u2014 check this relay's settings.`,
      off: `The site-programmed condition behind SV${sm[1]} is not currently ${isT ? 'timed out' : 'true'}.`,
    };
  }

  // ── Y/Z-terminal voltage elements (SEL-651R style: 27YB1, 59YN1, 27ZAB1T, 59YV1...) ──
  let ym = label.match(/^(27|59)([YZ])(AB|BC|CA|[ABCNQVL])(\d)(RS|[PTRS])?$/);
  if (ym) {
    const [, dev, term, q, num, suf] = ym;
    const isUV = dev === '27';
    const qName = { A: 'Phase A', B: 'Phase B', C: 'Phase C', AB: 'A-B phase-to-phase', BC: 'B-C phase-to-phase', CA: 'C-A phase-to-phase', N: 'zero-sequence (3V0)', Q: 'negative-sequence', V: 'positive-sequence', L: 'line' }[q] || q;
    const subj = `${qName} voltage on the ${term}-terminal`;
    const thr = `the level ${num} ${isUV ? 'undervoltage' : 'overvoltage'} threshold`;
    const short = `${isUV ? 'Undervoltage' : 'Overvoltage'} level ${num} \u2014 ${qName}, ${term}-terminal`;
    const base = label.replace(/(RS|[PTRS])$/, '');
    if (suf === 'T') return { short: `${short} (timed out)`, on: `${subj} stayed ${isUV ? 'below' : 'above'} ${thr} for the full configured delay \u2014 this output feeds trip/logic.`, off: `The timer has not completed \u2014 the condition cleared early or never started.` };
    if (suf === 'RS') return { short: `${short} (reset)`, on: 'This element has fully reset after a prior operation.', off: 'This element has not reset.' };
    return { short, on: `${subj} has ${isUV ? 'dropped below' : 'exceeded'} ${thr}. If it holds for the configured delay, ${base}T asserts and feeds the trip logic.`, off: `${subj} is back within normal range for this element.` };
  }
  // ── Forward/reverse overcurrent direction-supervision bits: 50GF, 50QR, 50NF... ──
  let fm = label.match(/^50([PGQN])([FR])$/);
  if (fm) {
    const q = { P: 'phase', G: 'ground/residual', Q: 'negative-sequence', N: 'neutral' }[fm[1]];
    const d = fm[2] === 'F' ? 'FORWARD' : 'REVERSE';
    return { short: `${q} overcurrent \u2014 ${d.toLowerCase()}-direction supervision`, on: `${q[0].toUpperCase() + q.slice(1)} current above threshold AND flowing in the ${d} direction (per this relay's configured polarity) \u2014 enables the ${d.toLowerCase()}-looking directional elements.`, off: `Not currently above threshold in the ${d.toLowerCase()} direction.` };
  }

  // ── Non-element categories, each with meaningful ON/OFF ──
  let dm = label.match(/^(F|R)?DIR([A-Z0-9]{1,3})$/) || label.match(/^([GQPN])(\d)DIR$/);
  if (dm || /DIR$/.test(label) || /^(F|R)DIR/.test(label)) {
    const fwd = /^F/.test(label) || /F$/.test(label.replace(/DIR.*/, ''));
    return { short: `Directional decision \u2014 ${label}`, on: `The relay has determined flow direction for this quantity ${/^FDIR/.test(label) ? '(FORWARD, per this relay\u2019s configured polarity)' : /^RDIR/.test(label) ? '(REVERSE, per this relay\u2019s configured polarity)' : '(per this relay\u2019s configured polarity)'} \u2014 this supervises the associated directional (67/32) elements. Which physical direction \u201cforward\u201d means depends on this relay\u2019s CT/PT wiring and settings.`, off: 'This directional decision is not currently made in this direction (flow may be the other way, or too small to determine).' };
  }
  if (/^89/.test(label)) return { short: `Disconnect switch status/scheme point (${label})`, on: 'The switch position or scheme condition this point represents is currently TRUE (e.g. the monitored switch is in the indicated state). Which physical switch is site-configured.', off: 'The monitored switch/scheme condition is not in the indicated state.' };
  if (/^(RMB|TMB)\d/.test(label)) return { short: `${label.startsWith('R') ? 'Received' : 'Transmitted'} communications bit ${label}`, on: `This ${label.startsWith('R') ? 'incoming' : 'outgoing'} MIRRORED BITS channel point is set \u2014 a status carried over a data link with another device, not a locally measured quantity. What it represents is defined by the paired device\u2019s configuration.`, off: 'This communications point is clear.' };
  if (/^LT\d/.test(label)) return { short: `Latch bit ${label} (site-programmed)`, on: 'This latch has been SET by its site-programmed SET equation and stays set (through power cycles) until its RESET equation fires \u2014 it remembers a state rather than measuring one. Its meaning is defined in this site\u2019s settings.', off: 'This latch is reset/clear.' };
  if (/^(LB|RB)\d/.test(label)) return { short: `${label.startsWith('LB') ? 'Local' : 'Remote'} control bit ${label}`, on: `This ${label.startsWith('LB') ? 'front-panel/local' : 'SCADA/remote'} control point is set \u2014 typically an operator-controlled enable/mode selection defined in this site\u2019s settings.`, off: 'This control point is clear.' };
  if (/^VB\d/.test(label)) return { short: `Virtual bit ${label} (comms-mapped)`, on: 'This virtual point (typically mapped over communications, e.g. DNP/Modbus) is set. Its meaning is defined by the site\u2019s point map.', off: 'This virtual point is clear.' };
  if (/^SG\d/.test(label)) return { short: `Settings group ${label.slice(2)} active`, on: `The relay is currently operating on settings group ${label.slice(2)}.`, off: 'This settings group is not the active one.' };
  if (/^IN\d/.test(label)) return { short: `Physical input ${label}`, on: 'Voltage is present on this physical input terminal \u2014 whatever field device is wired to it (a breaker contact, switch, external relay) is closed/energized. The field meaning is per this site\u2019s wiring.', off: 'This input terminal is de-energized \u2014 the wired field contact is open.' };
  if (/^OUT\d/.test(label)) return { short: `Physical output ${label}`, on: 'The relay is closing this output contact \u2014 driving whatever is wired to it (trip coil, close coil, alarm, SCADA point) per this site\u2019s wiring.', off: 'This output contact is open/idle.' };
  if (/^PB\d+(_PUL)?$/.test(label) || /_LED$/.test(label) || /^T\d\d_LED$/.test(label) || /^TLED/.test(label)) return { short: `Front-panel ${/LED/.test(label) ? 'LED/target' : 'pushbutton'} ${label}`, on: /LED/.test(label) ? 'This front-panel LED/target is lit.' : 'This front-panel pushbutton is currently pressed (or its pulse just fired).', off: /LED/.test(label) ? 'This LED/target is dark.' : 'This pushbutton is not pressed.' };
  if (/^RTD/.test(label)) return { short: `Temperature (RTD) point ${label}`, on: label.endsWith('T') ? 'An RTD temperature has exceeded its TRIP threshold.' : label.endsWith('A') ? 'An RTD temperature has exceeded its ALARM threshold.' : 'This RTD status condition is active.', off: 'This RTD condition is not active \u2014 temperature within limits (or input not in that state).' };
  if (/^TH/.test(label)) return { short: `Thermal-model point ${label}`, on: 'The relay\u2019s thermal overload model has reached the state this point represents (alarm/trip/level).', off: 'The thermal model is not in this state.' };
  if (/^(HIF|AFS)/.test(label)) return { short: `High-impedance/arc-fault detection point ${label}`, on: 'The harmonic-based high-impedance/arcing fault algorithm is reporting this condition (e.g. suspected downed conductor or arcing).', off: 'This arc/high-impedance condition is not being reported.' };
  if (/^(TUTC|TSNTP|PTP|TIRIG|IRIGOK|TSOK|TQUAL|DST|LPSEC)/.test(label)) return { short: `Time-sync status ${label}`, on: 'This clock-synchronization status is true (relates to the relay\u2019s time source quality, not any electrical quantity).', off: 'This clock-sync status is false.' };
  if (/^SC\d+Q[UD]$/.test(label)) return { short: `Counter ${label.slice(0, 4)} \u2014 count-${label.endsWith('QU') ? 'up' : 'down'} input`, on: `The site-programmed condition that ${label.endsWith('QU') ? 'increments' : 'decrements'} this counter is currently true.`, off: 'The counter input condition is not true.' };
  if (/^(DNAUX|DNP)/.test(label)) return { short: `SCADA/DNP auxiliary point ${label}`, on: 'This SCADA-mapped auxiliary point is set, per the site\u2019s DNP point map.', off: 'This SCADA point is clear.' };

  // ── Fall back to the static dictionary, with honest generic ON/OFF ──
  if (TOOLTIPS[label]) return { short: TOOLTIPS[label], on: 'The condition just described is currently true/active on this device.', off: 'The condition described is not currently active.' };
  return null;
}

// Generate tooltip for SV elements dynamically from parsed data
// ══════════════════════════════════════════════════════════════════════
// GENERIC FALLBACK DECODER — for the long tail of bits not worth hand-writing
// individually (89-series switch monitoring alone spans hundreds of point names
// across different switch schemes). Uses standard ANSI device-number and SEL
// naming conventions to produce a best-effort, honestly-hedged explanation
// rather than leaving the bit with no tooltip at all.
// ══════════════════════════════════════════════════════════════════════
function genericBitExplain(label, P, freq) {
  const el = explainElementBit(label, P, freq);
  if (el) return el.short;
  // Directional decision bits: DIRxx, FDIRx (forward), RDIRx (reverse)
  let m = label.match(/^(F|R)?DIR([A-Z]{1,2})$/);
  if (m) {
    const dirWord = m[1] === 'F' ? 'Forward-direction' : m[1] === 'R' ? 'Reverse-direction' : 'Directional';
    return `${dirWord} decision element for the "${m[2]}" quantity — indicates which way current or power is flowing, relative to this relay's configured polarity, feeding a directional (32/67) protection element.`;
  }
  if (/^89/.test(label)) return `Disconnect/isolation switch position or scheme-status point (ANSI 89) — reports the physical state of a switch, not a measured protection quantity. The specific switch is defined in this relay's configuration.`;
  if (/^79/.test(label)) return `Automatic reclosing (ANSI 79) status point — part of this device's reclose sequence/lockout logic.`;
  if (/^RTD/.test(label)) return `RTD (temperature sensor) input status — a resistance-temperature-detector input wired to this relay for thermal monitoring.`;
  if (/^TH/.test(label)) return `Thermal-model status point — part of the relay's thermal overload protection model, not a directly measured quantity.`;
  if (/^(HIF|AFS)/.test(label)) return `High-impedance/arcing-fault detection status point — part of the relay's harmonic-based fault-detection algorithm.`;
  if (/^(RMB|TMB)\d/.test(label)) return `Remote/transmit communications bit — carries a status point over a data link (e.g. to another relay, RTU, or SCADA); not a locally measured electrical quantity.`;
  if (/^(LT|LB|RB|VB|SG)\d/.test(label)) return `User-programmable general-purpose logic/status bit. Its specific meaning is assigned by this relay's own configuration rather than a standard protection function — check this site's settings/logic documentation for what it represents here.`;
  if (/^(TLED|T\d\d_LED|PB\d)/.test(label)) return `Front-panel target LED or pushbutton status point.`;
  if (/^(IN|OUT)\d/.test(label)) return `Physical digital input/output point on this device. Its field-wiring meaning (what's actually connected) is site-configured.`;
  if (/^(TUTC|TSNTP|PTP|TIRIG)/.test(label)) return `Time-synchronization status point (e.g. IRIG-B, PTP, or SNTP) — reflects whether this relay's clock is synced to an external source, not an electrical quantity.`;
  return null;
}


function getSVTooltip(label, parsed) {
  if (!parsed) return TOOLTIPS[label] || genericBitExplain(label, null, 60) || null;
  const freq = parsed.eventInfo?.freq || 60;
  const svMatch = label.match(/^SV(\d+)(T?)$/);
  if (svMatch) {
    const num = parseInt(svMatch[1]);
    const isT = svMatch[2] === 'T';
    const sv = (parsed.svSettings || []).find(s => s.num === num);
    if (sv) {
      const comment = sv.equation.includes('#') ? sv.equation.split('#')[1].trim() : '';
      const eqShort = sv.equation.split('#')[0].trim();
      if (isT) {
        const d = svDelayMs(parsed, sv.pickupDelay, freq);
        return `${sv.label} timed output (pickup: ${sv.pickupDelay} ${d.unit}${d.assumed ? ', assumed' : ''} = ${d.ms.toFixed(0)}ms)${comment ? ' — ' + comment : ''}\nEquation: ${eqShort}`;
      }
      const du = svDelayMs(parsed, sv.pickupDelay, freq).unit;
      return `${comment || eqShort}${comment ? '\nEquation: ' + eqShort : ''}\nPU: ${sv.pickupDelay} ${du} | DO: ${sv.dropoutDelay} ${du}`;
    }
  }
  return TOOLTIPS[label] || genericBitExplain(label, parsed, freq) || null;
}

// Wrap a label in a tooltip span. Virtually every label gets SOME explanation now (a specific
// one from TOOLTIPS, a pattern-based one from genericBitExplain, or — as an absolute last
// resort — an honest "not in this tool's reference" note) rather than silently having none.
// Clickable: opens a larger, plain-language detail popup (showBitDetail) rather than relying
// on hover alone, which doesn't work on touch and is easy to miss.
function tt(label, parsed) {
  const tip = getSVTooltip(label, parsed)
    || `Relay word bit "${label}" — a Boolean status point recorded by this device. Its specific meaning isn't in this tool's built-in reference; check the relay's settings/logic documentation.`;
  const escaped = tip.replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
  const jsSafe = label.replace(/'/g, "\\'");
  return `<span class="has-tip bit-click" title="${escaped}" onclick="event.stopPropagation(); showBitDetail('${jsSafe}');">${label}</span>`;
}

// Wraps every relay-word-bit-looking token inside a raw SELOGIC equation string with the same
// clickable tooltip as tt() — used wherever an equation is shown verbatim (e.g. the SV/Trip
// Chain Flags legend's "[59G1T AND 52A]" text) so each individual bit it references is just as
// explorable as the bit whose equation it is. Keywords (AND/OR/NOT/R_TRIG/F_TRIG), parentheses,
// and bare numeric literals (pickup/delay values) are left as plain text.
const SELOGIC_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'R_TRIG', 'F_TRIG', 'R_TRIGGER', 'F_TRIGGER']);
function linkifyEquationBits(eqText, parsed) {
  return eqText.replace(/\(|\)|\bAND\b|\bOR\b|\bNOT\b|\bR_TRIGGER\b|\bF_TRIGGER\b|\bR_TRIG\b|\bF_TRIG\b|[A-Za-z0-9_]+/g, tok => {
    if (tok === '(' || tok === ')') return tok;
    if (SELOGIC_KEYWORDS.has(tok)) return tok;
    if (/^[0-9]+(\.[0-9]+)?$/.test(tok)) return tok; // pure numeric literal (e.g. a pickup value), not a bit
    return tt(tok, parsed);
  });
}

// Bit-detail popups are largely free-text sentences (site comments, generated prose), not raw
// SELOGIC — so linkifyEquationBits' "wrap every identifier" approach isn't safe to run over
// them directly; it would just as happily wrap ordinary English words. This instead only
// touches the two spots inside that prose that are reliably an actual bit reference and
// nothing else: (1) a raw equation the tool itself quoted in double quotes (e.g. the generated
// sentence `The logic condition "59G1T AND 52A" is true right now.`), and (2) an explicit
// SV-timer mention like "SV17T" appearing bare in a sentence (e.g. "...toward SV17T
// immediately") — SEL's own SV-numbering convention, never a coincidental English word.
function linkifyBitMentions(text, parsed) {
  // Split off a trailing "Equation: <raw equation>" line if present (as produced by
  // getSVTooltip for a timed SV) — that portion is pure SELOGIC and safe to fully linkify;
  // handled separately so the passes below never see (and re-wrap) its already-linkified output.
  const eqLineMatch = text.match(/^([\s\S]*?)(\nEquation:\s*)(.+)$/);
  let head = text, eqSuffix = '';
  if (eqLineMatch) {
    head = eqLineMatch[1];
    eqSuffix = eqLineMatch[2] + linkifyEquationBits(eqLineMatch[3], parsed);
  }
  // Within the remaining text, split on quoted segments (each an actual equation the tool
  // itself quoted) so the bare-SVxxT pass below never reprocesses their linkified output.
  const parts = head.split(/("[^"]*")/);
  const linkedHead = parts.map((part, i) => {
    if (i % 2 === 1) {
      const inner = part.slice(1, -1);
      return `"${linkifyEquationBits(inner, parsed)}"`;
    }
    return part.replace(/\bSV\d+T?\b/g, tok => tt(tok, parsed));
  }).join('');
  return linkedHead + eqSuffix;
}