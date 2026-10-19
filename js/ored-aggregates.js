// SEL aggregate trip bits — ORED50T, ORED51T, ORED81T, ORED81RT.
//
// The SEL-751 (and related relays) offer these as relay word bits that are the OR of every
// timed-out element in one family. A trip equation such as
//   TR := ORED50T OR ORED51T OR REMTRIP OR ...
// therefore names the FAMILY, not the element. Stopping at "ORED51T" tells an operator only that
// some time-overcurrent element tripped — it does not say whether that was phase (51P1T),
// ground (51G1T), neutral (51N1T) or negative-sequence (51QT), and those four need four
// different charts and four different readings of the event.
//
// The member list below is the relay's documented definition of each aggregate. Members are
// matched against the labels this record actually contains, so the expansion never invents a
// bit the record did not capture.

const ORED_AGGREGATES = {
  ORED50T: { re: /^50(P|N|G|Q|A|B|C)\d*T$/, desc: 'OR of all instantaneous/definite-time overcurrent element outputs (50xT)' },
  ORED51T: { re: /^51(P|N|G|Q|A|B|C)\d*T$/, desc: 'OR of all inverse-time overcurrent element outputs (51xT)' },
  ORED81T: { re: /^81D\dT$/, desc: 'OR of all frequency element outputs (81DnT)' },
  ORED81RT: { re: /^81R\dT$/, desc: 'OR of all rate-of-change-of-frequency element outputs (81RnT)' },
};

function isOredAggregate(name) {
  return !!ORED_AGGREGATES[name];
}

// Every recorded label that the named aggregate ORs together. Empty when the name is not an
// aggregate or the record holds none of its members.
function oredAggregateMembers(name, recordedLabels) {
  const def = ORED_AGGREGATES[name];
  if (!def) return [];
  const out = [];
  for (const l of recordedLabels || []) if (l && def.re.test(l) && !out.includes(l)) out.push(l);
  return out;
}

function oredAggregateDescription(name) {
  return ORED_AGGREGATES[name]?.desc || '';
}

// Which member element(s) explain the aggregate at a given instant. Members that changed in the
// same digital transition come first (ground truth from the record); otherwise members that were
// simply asserted at that instant. Returns [] when no member can be seen asserted — the caller
// then keeps the aggregate name rather than guess.
function resolveOredAggregate(name, recordedLabels, changedLabels, isAsserted) {
  const members = oredAggregateMembers(name, recordedLabels);
  if (!members.length) return [];
  const changed = new Set(changedLabels || []);
  const changedMembers = members.filter(m => changed.has(m) && isAsserted(m));
  if (changedMembers.length) return changedMembers;
  return members.filter(m => isAsserted(m));
}
