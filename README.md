# CEV Trip Analyzer — What It Does and Why It Matters

## What it is

A browser-based tool that reads SEL relay CEV event files and tells you, in plain language,
*why* a recloser or breaker actually tripped — not just which relay word bit fired, but the
full causal chain back through the relay's own SELogic equations to the real field condition
that started it. It runs entirely client-side: no server, no data leaving the browser, and no
install — drop in a `.CEV` file and it's parsed and analyzed instantly.

## Core capability: real root-cause tracing, not a settings dump

Most event-viewer tools show you the digital word and let you go read the settings sheet
yourself. This tool actually **evaluates the relay's own trip equation** — parsing the SELogic
text, walking AND/OR/NOT structure, and resolving it against the real digital transitions in
the file — to identify the specific element or logic path that fired, anchored to the exact
instant the relay's own TRIP bit asserted (not a re-derived approximation that can drift).

That resolution is substitutive: if the trip equation references an internal SV (SEL's timer/
logic variable), the tool doesn't stop there — it follows that SV's own equation, and the one
inside that, all the way down to real, measured protection elements or field status points.

## The branching logic diagram

Instead of a flat "A → B → C tripped" summary, the tool renders the actual logic structure as
a left-to-right diagram: AND conditions show every required side (so a supervisory condition
like "AND 52A closed" isn't silently dropped), OR conditions collapse to just the branch that
actually fired, and the whole thing traces from the earliest contributing condition through to
the final trip command. It's pruned to show only what actually happened — no wading through
a dozen alternative conditions that never mattered for this specific event.

## Catching what a quick read would get wrong

This is the part aimed squarely at reducing misdiagnosis:

- **Logic/status-driven trips** are called out explicitly when no real voltage/current/frequency
  element operated — so a trip driven by an internal latch or breaker-status bit doesn't get
  mistaken for a "real" protection operation just because the waveform nearby looks fault-like.
- **Breaker-already-open detection** flags trips that didn't actually interrupt any load or
  fault current, which changes what question you should even be asking about the event.
- **Loss-of-potential detection** compares each phase's voltage against its own current: if a
  phase's voltage reads near-zero while that same phase's current stays normal and in line with
  the other phases, that's the signature of a blown PT fuse or bad voltage input — not a real
  fault — and the tool says so instead of letting it pass as a three-phase undervoltage trip.
- A dynamic equation evaluator correctly separates conditions that are structurally present in
  an equation from ones that actually contributed to the result at that moment, so a stale,
  always-true supervisory bit doesn't get blamed over the real, just-changed cause.

## Interactive waveform review

Current, voltage, and the fault-relevant derived quantity (zero-sequence voltage, negative-
sequence current, frequency — whichever actually matters for that trip's cause) render as
linked charts, synchronized with a Trip/Trigger reference and a digital SV/flag timeline.
Scroll to zoom and drag to pan — synced across all charts at once — and drop a draggable
measurement cursor anywhere to read exact values off every trace simultaneously, SynchroWAVe-
style, with callout labels that reposition themselves to never cover the data they're describing.

## The net effect for operators

- **Faster triage**: the headline cause is the *resolved* cause, not a relay-word name someone
  has to go cross-reference against a settings sheet.
- **Fewer false conclusions**: the investigation flags exist specifically to stop a plausible-
  looking but wrong read of an event — "it looks like undervoltage" vs. "an instrumentation
  channel failed" vs. "the breaker was already open" are very different follow-ups, and the
  tool tells you which one you're actually looking at.
- **Less relay-logic literacy required**: understanding *why* SV28 tripped no longer requires
  manually tracing three levels of nested SELogic by hand — the tool has already done that
  walk and shows the result as a diagram.
- **Consistent methodology across events and sites**: every event gets the same rigorous
  equation-resolution and cross-check treatment, rather than depending on whoever happens to
  be reading the event that day.
