const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "@neondatabase/serverless") {
    return {
      Pool: class MockPool {},
      neon: () => {
        throw new Error("Neon client should not be used by phase2 architecture unit tests.");
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const {
  normalizeRecurringAssignment,
  overlayRecurringAssignments,
  recurringAssignmentId
} = require("../lib/composed-state");

const repoRoot = path.resolve(__dirname, "..", "..");
const frontend = fs.readFileSync(path.join(repoRoot, "outputs", "index.html"), "utf8");

function functionBlock(source, name, nextName) {
  const marker = `async function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist`);
  if (nextName) {
    const endMarker = `async function ${nextName}`;
    const end = source.indexOf(endMarker, start + marker.length);
    assert.notEqual(end, -1, `${nextName} must exist after ${name}`);
    return source.slice(start, end);
  }
  const end = source.indexOf("\n    function ", start + marker.length);
  return end > start ? source.slice(start, end) : source.slice(start);
}

function testRecurringAssignmentIdentityAllowsSameTeacherSameTimeDifferentDays() {
  const teacher = { id: "teacher_so_jing_wen" };
  const tuesday = {
    teacherId: teacher.id,
    studentId: "student_lucas",
    studentName: "Lucas Tzia",
    day: "Tuesday",
    time: "20:00",
    startDate: "2026-08-18"
  };
  const thursday = {
    teacherId: teacher.id,
    studentId: "student_other",
    studentName: "Another Student",
    day: "Thursday",
    time: "20:00",
    startDate: "2026-08-20"
  };
  assert.notEqual(
    recurringAssignmentId(tuesday, teacher, "regularSlots"),
    recurringAssignmentId(thursday, teacher, "regularSlots"),
    "recurring assignment identity must not be teacherId/time only"
  );
}

function testSameStudentMultipleRegularSlotsStayDistinct() {
  const teacher = { id: "teacher_karen_lee", regularSlots: [] };
  const student = { id: "student_multi_slot", name: "Multi Slot Student", regularSlots: [] };
  const tuesday = normalizeRecurringAssignment({
    teacherId: teacher.id,
    studentId: student.id,
    studentName: student.name,
    day: "Tuesday",
    time: "21:00",
    subject: "CN",
    sourceCollection: "regularSlots",
    sourceSlotId: "student_slot_tuesday",
    studentSlotId: "student_slot_tuesday",
    startDate: "2026-08-18"
  });
  const wednesday = normalizeRecurringAssignment({
    teacherId: teacher.id,
    studentId: student.id,
    studentName: student.name,
    day: "Wednesday",
    time: "21:00",
    subject: "CN",
    sourceCollection: "regularSlots",
    sourceSlotId: "student_slot_wednesday",
    studentSlotId: "student_slot_wednesday",
    startDate: "2026-08-19"
  });

  assert.notEqual(tuesday.assignmentId, wednesday.assignmentId, "each student regular slot must have its own assignment id");
  const state = { teachers: [teacher], students: [student], recurringAssignments: [] };
  overlayRecurringAssignments(state, [tuesday, wednesday]);
  assert.equal(state.teachers[0].regularSlots.filter(slot => slot.studentId === student.id).length, 2);
  assert(state.teachers[0].regularSlots.some(slot => slot.day === "Tuesday" && slot.time === "21:00"));
  assert(state.teachers[0].regularSlots.some(slot => slot.day === "Wednesday" && slot.time === "21:00"));
  assert.equal(state.students[0].regularSlots.length, 2);
}

function testOverlayRecurringAssignmentsIsRecordLevel() {
  const state = {
    teachers: [{
      id: "teacher_so_jing_wen",
      regularSlots: [{
        id: "legacy_thursday",
        day: "Thursday",
        time: "20:00",
        studentId: "student_other",
        studentName: "Another Student",
        subject: "CN",
        locked: true,
        startDate: "2026-08-20"
      }]
    }],
    students: [{
      id: "student_lucas",
      regularSlots: []
    }]
  };
  const assignment = normalizeRecurringAssignment({
    id: "normalized_tuesday",
    assignmentId: "normalized_tuesday",
    teacherId: "teacher_so_jing_wen",
    studentId: "student_lucas",
    studentName: "Lucas Tzia",
    day: "Tuesday",
    time: "20:00",
    subject: "CN",
    sourceCollection: "regularSlots",
    sourceSlotId: "normalized_tuesday",
    startDate: "2026-08-18"
  });
  overlayRecurringAssignments(state, [assignment]);
  const slots = state.teachers[0].regularSlots;
  assert(slots.some(slot => slot.day === "Tuesday" && slot.studentName === "Lucas Tzia"), "normalized Tuesday assignment should be added");
  assert(slots.some(slot => slot.day === "Thursday" && slot.studentName === "Another Student"), "legacy unrelated Thursday assignment should remain");
  const normalizedSlot = slots.find(slot => slot.day === "Tuesday" && slot.studentName === "Lucas Tzia");
  assert.equal(normalizedSlot.locked, true, "normalized student assignment should render as an occupied recurring class");
  assert.equal(normalizedSlot.available, undefined, "composed recurring slot should not be converted into an open availability record");
}

function testLastClassDateDoesNotCreateAvailabilitySlots() {
  assert(!frontend.includes('source: "teacher-overview-ended-regular"'), "last class date must not create replacement open availability slots");
  assert(!frontend.includes("Open slot covered by extended regular class last date"), "last class date must not rewrite existing open slot ranges");
}

function testDeltaSuccessPathsDoNotCallLegacySave() {
  [
    ["syncBookingOutcomeDelta", "syncBookingOutcomeDeltas"],
    ["syncBookingCreateDelta", "syncBookingCreateDeltas"],
    ["syncRecurringAssignmentDelta", "fetchNeonManifest"]
  ].forEach(([name, nextName]) => {
    const body = functionBlock(frontend, name, nextName);
    assert(!/\bsave\s*\(/.test(body), `${name} must not call save() after normalized endpoint success`);
    assert(!/\bautoPushIfConfigured\s*\(/.test(body), `${name} must not queue legacy state sync`);
    assert(!/\benqueueNeonPush\s*\(/.test(body), `${name} must not queue /api/state-patch`);
    assert(/\bpersistState\s*\(/.test(body), `${name} should still persist browser-local state`);
  });
}

function testMigratedEndpointConstantsAreEnabled() {
  assert(frontend.includes("const ENABLE_BOOKING_OUTCOME_DELTA_SYNC = true;"));
  assert(frontend.includes("const ENABLE_BOOKING_CREATE_DELTA_SYNC = true;"));
  assert(frontend.includes("const ENABLE_RECURRING_ASSIGNMENT_DELTA_SYNC = true;"));
  assert(frontend.includes('"/api/bookings/outcome"'));
  assert(frontend.includes('"/api/bookings/create"'));
  assert(frontend.includes('"/api/recurring-assignments/upsert"'));
}

function testOutcomePostSuccessRefreshUsesExistingRenderers() {
  assert(!/renderActivity\s*\(/.test(frontend), "outcome success path must not call missing renderActivity()");
  assert(/function renderActivityLog\s*\(/.test(frontend), "Activity Log renderer must exist");
  assert(/function refreshBookingOutcomeUi\s*\(/.test(frontend), "booking outcome UI refresh wrapper must exist");
  assert(frontend.includes("Booking outcome saved, but UI refresh failed"), "post-save UI refresh errors must be separated from persistence failures");
}

testRecurringAssignmentIdentityAllowsSameTeacherSameTimeDifferentDays();
testSameStudentMultipleRegularSlotsStayDistinct();
testOverlayRecurringAssignmentsIsRecordLevel();
testLastClassDateDoesNotCreateAvailabilitySlots();
testDeltaSuccessPathsDoNotCallLegacySave();
testMigratedEndpointConstantsAreEnabled();
testOutcomePostSuccessRefreshUsesExistingRenderers();

console.log("phase2 architecture tests passed");
