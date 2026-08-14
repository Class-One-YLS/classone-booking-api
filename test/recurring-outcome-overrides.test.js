const assert = require("assert");
const {
  occurrenceKeyForBooking,
  occurrenceKeyForSlot,
  occurrenceKeysForBooking,
  occurrenceKeysForSlot,
  resolveTeacherCalendar,
  teacherDateTimeKey
} = require("../lib/calendar-resolver");

function baseState(bookings = []) {
  const teacher = {
    id: "teacher_catherine_mu",
    name: "Catherine Mu",
    rate: 10,
    regularSlots: [{
      id: "legacy_slot_catherine_friday_1430",
      normalizedRecurringAssignmentId: "assignment_catherine_elyisa_friday_1430",
      assignmentId: "assignment_catherine_elyisa_friday_1430",
      day: "Friday",
      time: "14:30",
      locked: true,
      studentId: "student_elyisa",
      studentName: "Elyisa Arielle Raj",
      subject: "CN",
      type: "regular class",
      startDate: "2026-08-01",
      endDate: "",
      updatedAt: "2026-08-01T00:00:00.000Z"
    }],
    overrideSlots: []
  };
  return {
    teachers: [teacher],
    students: [{ id: "student_elyisa", name: "Elyisa Arielle Raj" }],
    bookings
  };
}

function outcomeBooking(status, extra = {}) {
  const stamp = extra.updatedAt || "2026-08-14T05:00:00.000Z";
  return {
    id: extra.id || `outcome_elyisa_${status}`,
    bookingId: extra.id || `outcome_elyisa_${status}`,
    teacherId: "teacher_catherine_mu",
    studentId: "student_elyisa",
    studentName: "Elyisa Arielle Raj",
    subject: "CN",
    type: "regular class",
    date: "2026-08-14",
    day: "Friday",
    time: "14:30",
    status,
    outcome: status,
    classOutcome: status,
    sourceSlotId: extra.sourceSlotId || "assignment_catherine_elyisa_friday_1430",
    recurringSourceSlotId: extra.recurringSourceSlotId || "assignment_catherine_elyisa_friday_1430",
    occurrenceDate: "2026-08-14",
    suppressRecurringOccurrence: true,
    resolutionActive: true,
    resolutionStatus: status,
    updatedAt: stamp,
    statusChangedAt: stamp,
    slotRevisionAt: stamp,
    createdAt: extra.createdAt || stamp,
    ...(status === "cancelled" ? { cancelledAt: stamp, replacementCreditCreated: true } : {}),
    ...(status === "completed" ? { completedAt: stamp, finalizedAt: stamp } : {}),
    ...(status === "student_not_show" ? { studentNotShowAt: stamp } : {})
  };
}

function resolvedCell(state, date = "2026-08-14") {
  const teacher = state.teachers[0];
  const cells = resolveTeacherCalendar(state, {
    teacher,
    teacherId: teacher.id,
    from: date,
    to: date,
    stateVersion: 1
  }).cells;
  return cells.find(item => item.cellKey === teacherDateTimeKey(teacher.id, date, "14:30"));
}

function testBaseRecurringClassOnly() {
  const cell = resolvedCell(baseState());
  assert.equal(cell.status, "booked");
  assert.equal(cell.studentName, "Elyisa Arielle Raj");
  assert.equal(cell.type, "regular class");
}

function testCanonicalOccurrenceIdentityUsesNormalizedAssignmentAlias() {
  const state = baseState([outcomeBooking("cancelled")]);
  const slot = state.teachers[0].regularSlots[0];
  const booking = state.bookings[0];
  assert.equal(occurrenceKeyForSlot(slot, "2026-08-14"), "assignment_catherine_elyisa_friday_1430|2026-08-14");
  assert.equal(occurrenceKeyForBooking(booking), "assignment_catherine_elyisa_friday_1430|2026-08-14");
  assert(occurrenceKeysForSlot(slot, "2026-08-14").includes("legacy_slot_catherine_friday_1430|2026-08-14"));
  assert(occurrenceKeysForBooking(booking).includes("assignment_catherine_elyisa_friday_1430|2026-08-14"));
}

function testExactCancelledOutcomeSuppressesVirtualRecurringClass() {
  const cell = resolvedCell(baseState([outcomeBooking("cancelled")]));
  assert.equal(cell.status, "cancelled");
  assert.equal(cell.bookingId, "outcome_elyisa_cancelled");
  assert.equal(cell.studentName, "Elyisa Arielle Raj");
}

function testExactCompletedOutcomeSuppressesVirtualRecurringClass() {
  const cell = resolvedCell(baseState([outcomeBooking("completed")]));
  assert.equal(cell.status, "completed");
  assert.equal(cell.bookingId, "outcome_elyisa_completed");
}

function testExactNotShowOutcomeSuppressesVirtualRecurringClass() {
  const cell = resolvedCell(baseState([outcomeBooking("student_not_show")]));
  assert.equal(cell.status, "student_not_show");
  assert.equal(cell.bookingId, "outcome_elyisa_student_not_show");
}

function testCancelledDateOnlyDoesNotEndRecurringAssignment() {
  const state = baseState([outcomeBooking("cancelled")]);
  const cancelled = resolvedCell(state, "2026-08-14");
  const nextWeek = resolvedCell(state, "2026-08-21");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(nextWeek.status, "booked");
  assert.equal(nextWeek.studentName, "Elyisa Arielle Raj");
  assert.equal(nextWeek.bookingId, "");
}

function testRestoreBookedOutcomeReturnsClassForExactDate() {
  const cell = resolvedCell(baseState([outcomeBooking("booked", { id: "outcome_elyisa_restore", updatedAt: "2026-08-14T06:00:00.000Z" })]));
  assert.equal(cell.status, "booked");
  assert.equal(cell.studentName, "Elyisa Arielle Raj");
}

function testRepeatedCancellationChoosesOneCanonicalLatestOutcome() {
  const older = outcomeBooking("cancelled", { id: "outcome_elyisa_cancelled_old", updatedAt: "2026-08-14T05:00:00.000Z" });
  const newer = outcomeBooking("cancelled", { id: "outcome_elyisa_cancelled_new", updatedAt: "2026-08-14T06:00:00.000Z" });
  const cell = resolvedCell(baseState([older, newer]));
  assert.equal(cell.status, "cancelled");
  assert.equal(cell.bookingId, "outcome_elyisa_cancelled_new");
}

function upsertLocalRecord(state, collectionName, record) {
  state[collectionName] ||= [];
  const index = state[collectionName].findIndex(item => item.id === record.id);
  if (index >= 0) state[collectionName][index] = { ...state[collectionName][index], ...record };
  else state[collectionName].unshift(record);
}

function testReadAfterWriteCancelledResponseSuppressesRecurringClass() {
  const state = baseState();
  const responseBooking = outcomeBooking("cancelled", {
    id: "booking_delta_response_elyisa",
    // Production can contain older teacher-slot ids while the recurring candidate
    // uses the normalized assignment id. Alias matching must bridge both.
    sourceSlotId: "legacy_slot_catherine_friday_1430",
    recurringSourceSlotId: "",
    updatedAt: "2026-08-14T07:00:00.000Z"
  });
  delete responseBooking.normalizedRecurringAssignmentId;
  delete responseBooking.assignmentId;
  delete responseBooking.recurringAssignmentId;
  responseBooking.recurringSourceSlotId = "";
  responseBooking.occurrenceKey = "legacy_slot_catherine_friday_1430|2026-08-14";
  responseBooking.occurrenceId = `occurrence:${responseBooking.occurrenceKey}`;
  upsertLocalRecord(state, "bookings", responseBooking);
  const cancelled = resolvedCell(state, "2026-08-14");
  const nextWeek = resolvedCell(state, "2026-08-21");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.bookingId, "booking_delta_response_elyisa");
  assert.equal(nextWeek.status, "booked");
  assert.equal(nextWeek.bookingId, "");
}

function testReadAfterWriteResponseWithOnlyOccurrenceKeySuppressesRecurringClass() {
  const state = baseState();
  const responseBooking = outcomeBooking("cancelled", {
    id: "booking_delta_occurrence_key_only",
    sourceSlotId: "",
    recurringSourceSlotId: "",
    updatedAt: "2026-08-14T07:30:00.000Z"
  });
  delete responseBooking.normalizedRecurringAssignmentId;
  delete responseBooking.assignmentId;
  delete responseBooking.recurringAssignmentId;
  delete responseBooking.sourceSlotId;
  delete responseBooking.recurringSourceSlotId;
  responseBooking.occurrenceKey = "assignment_catherine_elyisa_friday_1430|2026-08-14";
  responseBooking.occurrenceId = `occurrence:${responseBooking.occurrenceKey}`;
  upsertLocalRecord(state, "bookings", responseBooking);
  const cancelled = resolvedCell(state, "2026-08-14");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.bookingId, "booking_delta_occurrence_key_only");
}

testBaseRecurringClassOnly();
testCanonicalOccurrenceIdentityUsesNormalizedAssignmentAlias();
testExactCancelledOutcomeSuppressesVirtualRecurringClass();
testExactCompletedOutcomeSuppressesVirtualRecurringClass();
testExactNotShowOutcomeSuppressesVirtualRecurringClass();
testCancelledDateOnlyDoesNotEndRecurringAssignment();
testRestoreBookedOutcomeReturnsClassForExactDate();
testRepeatedCancellationChoosesOneCanonicalLatestOutcome();
testReadAfterWriteCancelledResponseSuppressesRecurringClass();
testReadAfterWriteResponseWithOnlyOccurrenceKeySuppressesRecurringClass();

console.log("recurring outcome override tests passed");
