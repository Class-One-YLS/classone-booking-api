function uniqueSlots(slots) {
  // REVERTED 2026-08-28: a rank-before-timestamp uniqueSlots() (tried after the
  // 2026-08-25 incident notes) to stop a stray lower-rank "open" record from masking an
  // already-booked locked class purely by having a newer updatedAt. That fixed the reported case,
  // but it broke the opposite, equally legitimate scenario: a slot is set OFF, and a genuinely
  // newer locked class is later booked into the same cell -- rank-first kept the older OFF record
  // winning forever, which hid Hoh Kar Yee / Lim Ren Jun's Friday 15:30 class (reported 2026-08-28).
  // "Latest write wins" is the correct default for two competing deliberate actions on the same
  // cell; the original masking bug is better addressed at the write source (e.g.
  // releaseFixedReservation() now checks for an existing locked booking before reopening a slot)
  // than by reordering this generic tiebreak.
  const byTime = new Map();
  slots.forEach(slot => {
    if (isDeletedSlotRecord(slot)) return;
    const time = normalizeTime(slot.time);
    if (!time) return;
    const normalized = { ...slot, time };
    const key = `${normalized.date || ""}|${normalized.time}`;
    const existing = byTime.get(key);
    const newer = bookingAmendmentTime(normalized) > bookingAmendmentTime(existing);
    const sameTime = bookingAmendmentTime(normalized) === bookingAmendmentTime(existing);
    if (!existing || newer || (sameTime && slotRank(normalized) > slotRank(existing))) byTime.set(key, normalized);
  });
  return [...byTime.values()];
}
