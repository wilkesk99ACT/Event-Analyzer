# Event Analyzer

## What It Is

The Event Analyzer is an internally developed diagnostic tool that reads relay event records
and works out a likely, evidence-backed explanation for why a protective device operated. It
runs entirely in a web browser. It needs no installation and no server, and no data leaves the
browser at any point.

### Formats it reads

| Relay | What to load | What you get |
|---|---|---|
| SEL-751, SEL-651R and other CEV relays | `.CEV` file, or an `.evzip` archive of them | Full analysis: trip cause, SELogic diagram, diagnostics |
| **SEL-851** | **`.evzip` archive (`.cfg` + `.dat` + `.hdr`)** | **Full analysis, plus a reasonableness verdict** |
| Eaton Form 6 / ProView | `.cfg` + `.dat` + `settings.txt` | Waveforms, digital channels, pickup comparison |

The SEL-851 does not write CEV. It is configured with SEL Grid Configurator rather than
AcSELerator QuickSet, and exports a binary COMTRADE set inside an `.evzip`. Load the whole
`.evzip`; the tool finds the three files inside it.

It is a diagnostic aid, not a final authority — its output is a starting point grounded in the
relay's own recorded data and configured logic, meant to be checked against the diagram and
supporting tabs rather than taken as an unquestioned answer.

## The Problem It Solves

Determining the true cause of a relay trip requires cross-referencing the recorded event data
against the relay's own settings and SELogic (internal logic) equations — tracing nested timer
and logic variables by hand, accounting for edge-triggered logic, and correctly separating
conditions that merely *appear* in an equation from the ones that actually drove the result at
that moment. This is slow, requires specialized relay-logic expertise, and is easy to get wrong
in ways that look plausible: a trip can resolve to "undervoltage" when the real driver was
internal relay logic, a breaker that was already open, or even a failed voltage-sensing
instrument rather than a real electrical condition.

## Value Delivered

- **Faster event turnaround.** The tool performs the settings cross-reference and logic
  resolution automatically for every event, replacing what is otherwise a manual, multi-step
  process specific to each relay's configuration.
- **Fewer misdiagnosed trips.** A set of diagnostic checks looks for cases where the obvious-
  looking cause may not be the actual one — including trips driven by internal logic rather
  than a measured fault, trips issued on an already-open breaker, and voltage/current mismatches
  consistent with a failed voltage-sensing channel (e.g. a blown PT fuse) rather than a real
  fault. These are exactly the kind of pattern that's easy to miss on a quick manual review, and
  the tool is intended to help surface them consistently — the flags are a prompt to look
  closer, not a substitute for that look.
- **Broader usability.** Correctly interpreting nested SELogic by hand is a specialized skill.
  Presenting the resolved logic chain as a diagram — rather than requiring a manual settings
  walkthrough — allows a wider range of personnel to correctly interpret an event.
- **Consistency.** Every event is analyzed with the same method, independent of who is
  reviewing it or how experienced they are with a given relay's configuration.

## What the Tool Does, in Practice

1. **Works out a likely root cause.** It parses the relay's trip equation and every internal SV
   (logic/timer variable) it references, evaluates them against the actual recorded digital
   transitions, and identifies the condition(s) that the relay's own configured logic points to,
   anchored to the recorded transition rather than a re-derived approximation.
2. **Displays it as a logic diagram**, not a linear text summary — showing every side of an AND
   condition (so a supervisory condition like "breaker closed" is never silently omitted) and
   only the branch of an OR condition that actually occurred.
3. **Flags conditions that are easy to misread**, described in the FAQ below.
4. **Provides synchronized, interactive waveform charts** (current, voltage, and the most
   relevant derived quantity for the resolved cause) alongside a digital logic timeline, with
   shared zoom/pan and a draggable measurement cursor.
5. **Surfaces the supporting data tabs** described below, so the resolution can be checked
   against the underlying settings and measurements directly.

---

## Operator FAQ

**What am I looking at when I open an event?**
A headline cause banner, followed by a branching logic diagram showing the path the tool has
traced through the relay's own logic for this trip, any diagnostic flags relevant to the event,
and a set of waveform charts. Each piece is meant to be checkable against the underlying data,
not taken on faith.

**What do the colors in the logic diagram mean?**
Green = true/asserted at the moment of the trip. Grey/muted = false/not asserted, shown only
when it's structurally necessary to explain the result. A thicker accent or red border marks an
internal SV (a named logic/timer variable), rather than a directly measured element.

**What does "ALL required (AND)" / "ANY of these (OR)" mean?**
AND means every box in that group had to be in the state shown for the result; OR means only
one needed to be — the alternatives that didn't happen are simply not shown.

**What does "NOT" or "R_TRIG"/"F_TRIG" in front of a label mean?**
The condition is being evaluated as negated (NOT), or only counts at the instant it just
changed state — a rising or falling edge (R_TRIG/F_TRIG) — not merely whenever it happens to be
in that state.

**What are the diagnostic flags, and should I act on them?**
They call out patterns that are easy to misread from a quick look at an event: a trip produced
by internal relay logic rather than a measured fault, a trip issued while the breaker was
already open, or a phase where the voltage reads near-zero while its current stays normal
(consistent with a failed voltage-sensing channel, not a real fault). They are informational —
the tool deliberately does not tell you what corrective action to take, only what's worth a
closer look.

**How do I use the charts?**
Scroll anywhere inside a chart's plotted area to zoom in or out — this applies to all charts
(current, voltage, relevant quantity, and the SV/logic timeline) simultaneously. Drag to pan
once zoomed. Click or drag anywhere to place the measurement cursor, which shows exact values
on every chart at that instant. Double-click any chart to reset its zoom.

**What is the verdict on an SEL-851 event?**
The 851 writes its complete settings into the event record, so the tool can do something it
cannot do for other formats: check the trip against the relay's own settings and say whether
the two agree. The verdict is one of three results.

- **Trip agrees with settings.** The element that tripped was enabled, the measured value was
  past its pickup, and the delay matched the setting.
- **Review needed.** The trip holds up, but one or more details do not match what the tool
  expected.
- **Disagreement found.** Something in the record contradicts the settings. The tool names what
  disagrees and what could cause it.

Each check compares two things in the file that must agree. Where the record cannot settle a
question, the tool says so instead of guessing. A missing verdict is an honest result.

**What can the 851 checks find?**

| Check | What it compares |
|---|---|
| Measurement basis | Pre-event voltage against `Sys.VNom` and `VTP.Rat` |
| Element pickup | Measured value at timeout against `PUVal` |
| Element delay | Time from pickup to timeout against `PUDly`, or against the curve |
| Pickup held | Whether the value stayed past pickup for the whole timing window |
| Enable and torque control | Whether an element operated while set off or supervised off |
| Trip equation | Which branch of `Trip_01.Init` read 1 at the trip |
| Loss of potential | Whether `60LOP.PU` tracks the measured voltage |
| Breaker | Time from trip to `Bkr_01.52A_Sta` dropout |
| Fault origin | Peak current against the relay's own phase overcurrent pickups |

The last one matters at a distributed generation site. A fault on the protected feeder raises
current through the relay's CTs. A disturbance elsewhere on the system lowers voltage without
raising current. This separates a site that caused an event from a site that only responded to
one.

**The 79 element is off. Does that mean the device will not come back by itself?**
Not necessarily, and the tool no longer assumes it does. Many DER interconnection reclosers have
`E79 := N` and an automatic return written by hand in SELogic instead — usually an IEEE 1547
enter-service window: a long timer on an SV that watches the utility-side voltage and frequency,
armed by a latch bit. The Reclosing tab reads the close equation (`CL3P` / `CL`) and walks each
term down through the SVs that feed it. It then sorts every way in:

| Path | What it means |
|---|---|
| **Automatic** | No operator action is necessary. A timer and measured conditions run it. |
| **Operator** | A pushbutton press or a close command from a port is necessary. |
| **External** | A contact input or a communications bit starts it. What drives that signal is outside this file, so the tool says so instead of guessing. |
| **Seal-in** | The branch holds a variable up once it is already true. It cannot start a close, so it is shown and then set aside. |

The close equation is expanded into its OR branches first, because the operator path and the
automatic path often share one chain — `(PB11_PUL OR F_TRIG SV12T) AND LT02 OR SV11T` is three
separate ways in, and only the third is automatic. Judging the chain as a whole would call the
whole thing operator-run. `CL3P`, `CL`, `CLA`, `CLB` and `CLC` are all read, so a control that
pulses two switches in turn is covered as well as a three-pole recloser.

Analog comparisons (`VAY >= 6840.00`) are shown as the site wrote them and are not evaluated
against the record, because the setting and the record are not in the same units.

A latch bit (`LT`) is read as a mode switch, not as an operator action. `LT02` armed means the
automatic mode is on. It does not mean a person is at the recloser.

**Does the tool say the device will close?**
No. It reports what the close logic permits, and the state of each condition at the last sample
of the record. The close falls minutes after the record ends, so the record cannot show it.

**How is this different from just opening the file in QuickSet or SynchroWAVe?**
QuickSet shows how the relay is configured; SynchroWAVe shows what was recorded. Neither
automatically connects the two for a specific event. This tool does that connection
automatically — matching the recorded data against the relay's own pickups, timers, and logic
for the event in front of you, which otherwise has to be done manually, equation by equation.

---

## Tab Reference

- **📍 Event Timeline** — every digital bit that changed, in order, with exact timing and
  plain-language labels, plus a legend explaining the trip marker and assert/de-assert coloring.
- **🔌 Voltages** — pre-fault vs. fault voltage per phase/terminal with percent change flagged,
  plus every voltage protection element's pickup compared against the measured value.
- **〰️ Currents** — the same pre/fault comparison for every current channel.
- **🛡️ Protection** — every overcurrent element's pickup, measured value, and multiple-of-pickup
  for this event.
- **🩺 Diagnostics** — physical consistency checks cross-referencing sequence voltage against
  sequence current, surfacing likely CT wiring, grounding-transformer, or open-phase issues.
- **🔗 SV Logic** — every internal SV used in the trip equation (and every other active SV),
  with pickup/dropout delays and the underlying equation, plus a legend explaining the
  in-trip/not-in-trip coloring.
- **🔄 Reclosing** — whether the device comes back by itself, and how. The ANSI 79 sequence when
  the element is enabled, and — new — a **Close Logic Outside the 79 Element** card when the
  close equation holds a path the 79 block does not: the path that starts the close, its delay,
  the mode switches that arm it, and every condition the close waits on, each shown with its
  state at the last sample of the record.
- **📊 Frequency** — frequency protection elements' pickups vs. measured values.
- **📋 Equations** — the raw SELogic text, for verifying the tool's resolution directly against
  the relay's own settings.

### SEL-851 tabs

- **⚖️ Verdict** — the answer. Whether the trip agrees with the settings, what started it, every
  finding, the trip equation term by term, and the measurement basis every number rests on.
- **🛡️ Elements** — every element in the trip equation, with its setting beside the value
  measured from this record's own waveforms, and a chart of the operating quantity against its
  pickup.
- **📍 Event Timeline** — every change of state among the named relay bits, in order.
- **🔌 Voltages** — phase-to-phase, phase-to-neutral, sequence voltage, and frequency.
- **〰️ Currents** — phase, ground and sequence current, plus the fault origin comparison.
- **⚙️ Settings** — the complete relay settings from the `.hdr` file, and the record details.

An in-app **Help** button (top right of the tool) contains this same reference material.

---

## Tests

`test/test-sel851.mjs` runs the SEL-851 parser and analysis against a real `.evzip` and prints
the full result. `test/test-regression.mjs` runs the edge cases and unit checks: binary ZIP
entry handling, an archive with no `.hdr`, a truncated `.dat`, the Boolean evaluator, trip
equation branch splitting, the inverse-time curve constants, and COMTRADE date order.

```
node test/test-sel851.mjs path/to/event.evzip
node test/test-regression.mjs path/to/event.evzip
CEV_DIR=/path/to/cev/corpus node test/test-regression.mjs path/to/event.evzip
```

`test/test-custom-close.mjs` covers the close logic that sits outside the 79 element: that an
SELogic enter-service timer on a device with `E79 := N` is found, that a pushbutton or SCADA
path is not called automatic, that a latch bit is read as a mode switch, and that a device with
a normal enabled 79 scheme is left alone. It needs no `.evzip`.

```
node test/test-custom-close.mjs /path/to/cev/corpus
```

Set `CEV_DIR` to a folder of real `.CEV` files to include the CEV regression section. Without
it that section is skipped, and the SEL-851 checks still run.
