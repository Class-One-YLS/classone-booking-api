function parsedTime(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

function bookingAmendmentTime(booking) {
  const values = [
    booking && booking.slotRevisionAt,
    booking && booking.statusChangedAt,
    booking && booking.updatedAt,
    booking && booking.updated_at,
    booking && booking.changedAt,
    booking && booking.changedSlot && booking.changedSlot.changedAt,
    booking && booking.rebookedAt,
    booking && booking.cancelledAt,
    booking && booking.completedAt,
    booking && booking.studentNotShowAt,
    booking && booking.deletedAt,
    booking && booking.createdAt,
    booking && booking.created_at
  ].map(parsedTime).filter(Boolean);
  return values.length ? Math.max(...values) : 0;
}

function isDeletedBooking(booking) {
  return !booking ||
    String(booking.status || "").toLowerCase() === "deleted" ||
    booking.deleted === true;
}

function isSupersededBooking(booking) {
  return Boolean(booking && (booking.supersededByBookingId || booking.rebookedByBookingId || booking.superseded === true));
}

function bookingTieRank(booking) {
  const status = String(booking && booking.status || "booked").toLowerCase();
  if (isDeletedBooking(booking)) return -100;
  if (status === "student_not_show") return 5;
  if (status === "booked") return 4;
  if (status === "completed") return 3;
  if (["cancelled", "public_holiday", "teacher_leave"].includes(status)) return 2;
  return 1;
}

function bookingChoice(candidate, existing) {
  if (!existing) return { useCandidate: true, reason: "first active record" };
  const candidateTime = bookingAmendmentTime(candidate);
  const existingTime = bookingAmendmentTime(existing);
  if (candidateTime !== existingTime) {
    return {
      useCandidate: candidateTime > existingTime,
      reason: candidateTime > existingTime ? "newer amendment time" : "older amendment time"
    };
  }
  const candidateRank = bookingTieRank(candidate);
  const existingRank = bookingTieRank(existing);
  if (candidateRank !== existingRank) {
    return {
      useCandidate: candidateRank > existingRank,
      reason: candidateRank > existingRank ? "equal timestamp status tie-break" : "lost equal timestamp status tie-break"
    };
  }
  const useCandidate = String(candidate.id || "") > String(existing.id || "");
  return { useCandidate, reason: useCandidate ? "equal timestamp stable id tie-break" : "lost stable id tie-break" };
}

function resolveBookingRecords(bookings, keyFor) {
  const winners = new Map();
  const traces = new Map();
  (Array.isArray(bookings) ? bookings : []).forEach(booking => {
    const key = keyFor(booking);
    if (!key) return;
    const trace = traces.get(key) || [];
    if (isSupersededBooking(booking)) {
      trace.push({ booking, selected: false, reason: `superseded by ${booking.supersededByBookingId || "newer booking"}` });
      traces.set(key, trace);
      return;
    }
    const existing = winners.get(key);
    const choice = bookingChoice(booking, existing);
    trace.push({ booking, selected: choice.useCandidate, reason: isDeletedBooking(booking) && choice.useCandidate ? "newer deletion tombstone wins" : choice.reason });
    if (choice.useCandidate) winners.set(key, booking);
    traces.set(key, trace);
  });
  return { winners, traces };
}

module.exports = {
  bookingAmendmentTime,
  bookingChoice,
  bookingTieRank,
  isDeletedBooking,
  isSupersededBooking,
  resolveBookingRecords
};
