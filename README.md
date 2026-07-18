# CEV Trip Analyzer

## What It Is

The CEV Trip Analyzer is an internally developed diagnostic tool that reads SEL relay event
(CEV) files and works out a likely, evidence-backed explanation for why a protective device
operated. It runs entirely in a web browser, requires no installation, no server, and no data
leaves the browser at any point.

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
- **📊 Frequency** — frequency protection elements' pickups vs. measured values.
- **📋 Equations** — the raw SELogic text, for verifying the tool's resolution directly against
  the relay's own settings.

An in-app **Help** button (top right of the tool) contains this same reference material.
