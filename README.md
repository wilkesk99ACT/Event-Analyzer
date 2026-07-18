# CEV Trip Analyzer
## Technical Overview and Capabilities Summary

---

### Executive Summary

The CEV Trip Analyzer is a purpose-built diagnostic tool for interpreting SEL relay event
(CEV) files. Its objective is to reduce the time and specialized relay-logic expertise required
to determine why a protective device operated, while simultaneously reducing the risk of
misdiagnosis in cases where the apparent cause of a trip — based on a superficial reading of
the waveform or digital record — does not match the actual condition that drove the relay's
trip logic. The tool operates entirely within the browser, requires no installation, and
transmits no data externally.

---

### 1. Purpose and Operating Principle

Protective relay event records contain two categories of information: the measured analog
waveforms (current, voltage, and derived quantities) and the digital record of every relay
word bit, timer, and logic variable that changed state during the recording window. In
practice, the second category — while it contains the definitive answer to "why did this
trip" — is rarely interpreted in full, because doing so correctly requires manually cross-
referencing the relay's settings file, tracing nested SELogic equations by hand, and accounting
for timer pickup/dropout behavior and edge-triggered (`R_TRIG`/`F_TRIG`) logic.

The Analyzer performs this process programmatically. It parses the relay's settings and
SELogic equations directly out of the CEV file, constructs a formal logical representation of
the trip equation and every internal variable (SV) it references, and evaluates that
representation against the actual recorded digital transitions to identify the specific
condition — or combination of conditions — that produced the trip.

---

### 2. Root Cause Resolution Engine

#### 2.1 Equation Parsing and Evaluation

The tool tokenizes and parses each relevant SELogic equation (the trip equation and every
internal SV/timer variable it depends on) into an abstract syntax tree, supporting the full
operator set used in SEL logic: `AND`, `OR`, `NOT`, and the edge-triggered operators `R_TRIG`
and `F_TRIG`. Each equation is evaluated against the relay's actual recorded state at the
instant of interest, rather than assumed from the settings alone.

#### 2.2 Ground-Truth Anchoring

A trip equation is frequently structured as a disjunction ("OR") of many independent
conditions. A naive evaluation approach — repeatedly re-evaluating the full equation and
searching for the point at which it transitions from false to true — fails when one of those
independent conditions was already satisfied prior to the start of the record: the equation
reads as "already true," obscuring the branch that changed at the moment the relay actually
tripped. The Analyzer instead anchors its evaluation to the specific digital transition record
in which the trip bit itself asserted, and identifies which live logical branch corresponds to
that same transition. This is a materially more robust method and has been verified to correct
misattribution in cases where a stale, always-true internal status bit would otherwise have
been reported as the cause.

#### 2.3 Recursive Substitution Through Internal Logic

Where the trip equation references an internal SV (SEL's general-purpose logic/timer
variable), the tool does not treat that reference as a terminal result. It recursively resolves
the SV's own equation — and any SVs referenced within it — until the chain terminates in
measured protection elements or physical status/input points. The result is a single, complete
causal path from the ultimate contributing condition(s) through to the trip command, rather
than a name that requires further manual lookup.

#### 2.4 Handling of Negated Conditions

The evaluator correctly attributes cases where a condition becomes true through the
*de-assertion* of one or more inputs (e.g., `NOT (IN301 AND IN303 AND IN305)`), including
compound negated expressions, rather than reporting only the positively-asserted side of an
equation. This is necessary to correctly explain trips driven by status-input logic rather than
by a measured electrical quantity.

---

### 3. Branching Logic Diagram

The resolved causal chain is rendered as a directed, left-to-right diagram rather than a linear
summary. The diagram reflects the true logical structure of the equation:

- **AND conditions** display every required operand, each independently colored by its actual
  state at the trip instant, so that a supervisory condition (e.g., a breaker-status
  permissive) is never omitted from the explanation.
- **OR conditions** are pruned to display only the branch(es) that actually contributed to the
  result — using a duality-consistent rule (an OR that evaluated true needed only one true
  input; an OR that evaluated false required every input to be false, and all remain visible)
  — so the diagram reflects only what occurred, not every alternative that did not.
- Internal SV references are shown as labeled nodes within the same continuous diagram, rather
  than as separate, disconnected artifacts requiring manual re-linking.
- Unrelated independent trip conditions present in the same equation but not part of the
  resolved event are noted by count, not rendered, to avoid obscuring the relevant path.

---

### 4. Diagnostic Flag System

The Analyzer includes a set of automated checks designed to surface conditions that are easily
misread from a superficial review of an event. These are presented as informational flags
rather than directives, and are only surfaced when applicable to the event under review.

| Flag | Condition Detected | Operational Significance |
|---|---|---|
| **Logic/Status-Driven Trip** | No recognized voltage, current, or frequency protection element operated anywhere in the record; the trip resolves entirely to internal logic or status-input points. | Prevents a trip from being attributed to a measured electrical condition (e.g., "undervoltage") when the actual cause was internal relay logic. |
| **Breaker Already Open** | The breaker's status indication shows open for the entire pre-trip record, with negligible measured current throughout. | Establishes that the trip did not interrupt fault or load current, materially changing the appropriate follow-up. |
| **Possible Loss of Potential** | One phase's measured voltage is near zero while that same phase's current remains consistent with the other phases (i.e., no correlated current anomaly). | A genuine electrical fault or open conductor produces a correlated anomaly in both voltage and current on the affected phase. A voltage-only anomaly is characteristic of a failed voltage-sensing channel (blown PT fuse, disconnected VT secondary, or a faulty relay input) rather than an actual system condition. |

Each flag is generated from the same underlying analysis used to resolve the trip cause,
ensuring consistency between the headline determination and the supporting diagnostic
commentary.

---

### 5. Interactive Waveform Analysis

The current magnitude, voltage magnitude, and the derived quantity most relevant to the
determined cause (zero-sequence voltage, negative-sequence current, frequency, etc., selected
according to the resolved cause) are rendered as time-synchronized charts, alongside a
digital-state timeline of the resolved logic chain.

- **Time-axis zoom and pan** are available on all charts simultaneously (including the digital
  timeline): a single zoom or pan action is applied consistently across every chart, and
  interaction is restricted to the plotted data region so that it does not interfere with
  normal page scrolling.
- **A draggable measurement cursor** may be positioned anywhere on the time axis and is
  synchronized across all charts, producing a value read-out for every trace at that instant.
  Read-out labels are dynamically positioned to avoid obscuring the underlying waveform,
  searching outward from the point of interest for the nearest position that does not overlap
  plotted data.
- Trigger and trip reference markers are displayed consistently across all charts for direct
  time correlation.

---

### 6. Operational Value

1. **Reduced diagnostic time.** The determination presented is the outcome of full equation
   resolution, not a relay-word label requiring manual settings cross-reference.
2. **Reduced risk of misattribution.** The diagnostic flag system is specifically designed to
   intercept the class of error in which a plausible-looking but incorrect cause (e.g., a
   measured undervoltage condition) is accepted in place of the actual driver of the trip (e.g.,
   an internal logic condition, an already-open breaker, or a failed voltage-sensing channel).
3. **Reduced dependency on relay-logic specialization.** Interpreting nested SELogic equations
   by hand is a specialized skill; the tool performs this analysis automatically and presents
   the result as a diagram, broadening the population of personnel who can correctly interpret
   an event.
4. **Consistency across personnel and sites.** Every event is subject to the same analytical
   method, independent of the experience level of the individual reviewing it.

---

### 7. Scope and Limitations

The Analyzer is a diagnostic aid intended to accelerate and improve the accuracy of event
review; it does not replace engineering judgment, and its output should be understood as a
rigorously derived hypothesis grounded in the recorded data and the relay's own configured
logic, not an independent verification of field conditions. Diagnostic flags are informational
and are deliberately scoped to avoid prescribing corrective action.

---

*This document may be converted to Word or PDF format on request, or expanded with
site-specific deployment or configuration detail as needed.*
