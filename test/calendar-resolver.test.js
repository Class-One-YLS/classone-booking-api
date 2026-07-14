const assert = require("assert");
const {
  resolveTeacherCalendar,
  teacherDateTimeKey
} = require("../lib/calendar-resolver");

function baseTeacher(extra = {}) {
  return {
    id: "teacher_peggy",
    name: "Peggy Lok",
    rate: 10,
    regularSlots: [],
    overrideSlots: [],
    ...extra
  };
}

function resolve(state, from, to) {
  return resolveTeacherCalendar(state, {
    teacher: state.teachers[0],
    teacherId: state.teachers[0].id,
    from,
    to,
    stateVersion: 1
  }).cells;
}

function cell(cells, date, time) {
  return cells.find(item => item.cellKey === teacherDateTimeKey("teacher_peggy", date, time));
}

const PARITY_FIELDS = [
  "bookingId",
  "recurringScheduleId",
  "studentId",
  "studentName",
  "subject",
  "type",
  "status",
  "available",
  "locked",
  "remark",
  "minutes"
];

function paritySnapshot(value) {
  if (!value) return null;
  return {
    bookingId: value.bookingId || "",
    recurringScheduleId: value.recurringScheduleId || value.slotId || "",
    studentId: value.studentId || "",
    studentName: value.studentName || "",
    subject: value.subject || "",
    type: value.type || "",
    status: value.status || "",
    available: Boolean(value.available),
    locked: Boolean(value.locked),
    remark: value.remark || "",
    minutes: Number(value.minutes || 0)
  };
}

function assertParityCell(actual, expected, message) {
  const snapshot = paritySnapshot(actual);
  PARITY_FIELDS.forEach(field => {
    assert.deepStrictEqual(snapshot && snapshot[field], expected[field], `${message}: ${field}`);
  });
}

function testRecurringStartEnd() {
  const teacher = baseTeacher({
    regularSlots: [{
      id: "slot_monday_1800",
      day: "Monday",
      time: "18:00",
      locked: true,
      studentName: "Bryan Koek YiChen",
      subject: "CN",
      type: "regular class",
      startDate: "2026-07-20",
      endDate: "2026-08-03",
      updatedAt: "2026-07-01T00:00:00.000Z"
    }]
  });
  const cells = resolve({ teachers: [teacher], bookings: [], students: [] }, "2026-07-13", "2026-08-10");
  assert.equal(cell(cells, "2026-07-13", "18:00"), undefined, "recurring class must not appear before startDate");
  assert.equal(cell(cells, "2026-07-20", "18:00").studentName, "Bryan Koek YiChen");
  assert.equal(cell(cells, "2026-07-27", "18:00").studentName, "Bryan Koek YiChen");
  assert.equal(cell(cells, "2026-08-03", "18:00").studentName, "Bryan Koek YiChen");
  assert.equal(cell(cells, "2026-08-10", "18:00"), undefined, "recurring class must not appear after endDate");
}

function testOneDateOverrideOnlyAffectsExactDate() {
  const teacher = baseTeacher({
    regularSlots: [{
      id: "slot_tuesday_1630",
      day: "Tuesday",
      time: "16:30",
      locked: true,
      studentName: "Student A",
      subject: "CN",
      startDate: "2026-07-01",
      updatedAt: "2026-07-01T00:00:00.000Z"
    }],
    overrideSlots: [{
      id: "off_2026_07_14_1630",
      date: "2026-07-14",
      day: "Tuesday",
      time: "16:30",
      unavailable: true,
      status: "off",
      updatedAt: "2026-07-10T00:00:00.000Z"
    }]
  });
  const cells = resolve({ teachers: [teacher], bookings: [], students: [] }, "2026-07-14", "2026-07-21");
  assert.equal(cell(cells, "2026-07-14", "16:30").kind, "off");
  assert.equal(cell(cells, "2026-07-21", "16:30").studentName, "Student A", "one-date OFF must not hide future recurring classes");
}

function testStaleOpenOverrideDoesNotHideLockedRegularSlot() {
  const teacher = baseTeacher({
    regularSlots: [{
      id: "slot_thursday_2030",
      day: "Thursday",
      time: "20:30",
      locked: true,
      studentName: "Ngooi Jun",
      subject: "BM",
      startDate: "2026-07-01",
      updatedAt: "2026-07-12T00:00:00.000Z"
    }],
    overrideSlots: [{
      id: "stale_open_2030",
      date: "2026-07-16",
      day: "Thursday",
      time: "20:30",
      locked: false,
      unavailable: false,
      updatedAt: "2026-07-01T00:00:00.000Z"
    }]
  });
  const cells = resolve({ teachers: [teacher], bookings: [], students: [] }, "2026-07-16", "2026-07-16");
  assert.equal(cell(cells, "2026-07-16", "20:30").studentName, "Ngooi Jun");
}

function testLeeShokYuongNgooiJunRecurringStaysBooked() {
  const teacher = {
    id: "teacher_lee_shok_yuong",
    name: "Lee Shok Yuong",
    rate: 10,
    regularSlots: [{
      id: "slot_lee_shok_yuong_thursday_2030",
      day: "Thursday",
      time: "20:30",
      locked: true,
      studentName: "Ngooi Jun",
      studentId: "student_ngooi_jun",
      subject: "CN",
      type: "regular class",
      startDate: "2026-07-01",
      endDate: "",
      updatedAt: "2026-07-12T00:00:00.000Z"
    }],
    overrideSlots: [{
      id: "open_override_lee_shok_yuong_2026_07_16_2030",
      date: "2026-07-16",
      day: "Thursday",
      time: "20:30",
      locked: false,
      unavailable: false,
      source: "teacher-overview-open-slot",
      updatedAt: "2026-07-01T00:00:00.000Z"
    }]
  };
  const cells = resolveTeacherCalendar({
    teachers: [teacher],
    bookings: [],
    students: [{ id: "student_ngooi_jun", name: "Ngooi Jun" }]
  }, {
    teacher,
    teacherId: teacher.id,
    from: "2026-07-16",
    to: "2026-07-16",
    stateVersion: 1
  }).cells;
  const resolved = cells.find(item => item.cellKey === teacherDateTimeKey("teacher_lee_shok_yuong", "2026-07-16", "20:30"));
  assert.equal(resolved && resolved.studentName, "Ngooi Jun");
  assert.equal(resolved && resolved.type, "regular class");
  assert.notEqual(resolved && resolved.status, "available");
}

function testLatestBookingRecordWins() {
  const teacher = baseTeacher();
  const cells = resolve({
    teachers: [teacher],
    students: [],
    bookings: [{
      id: "old_cancel",
      teacherId: "teacher_peggy",
      date: "2026-07-09",
      time: "15:00",
      studentName: "Wong Jinn",
      subject: "CN",
      type: "regular class",
      status: "cancelled",
      updatedAt: "2026-07-09T02:00:00.000Z"
    }, {
      id: "new_exam",
      teacherId: "teacher_peggy",
      date: "2026-07-09",
      time: "15:00",
      studentName: "Pang Yi Ning",
      subject: "CN",
      type: "exam",
      status: "booked",
      updatedAt: "2026-07-09T03:00:00.000Z"
    }]
  }, "2026-07-09", "2026-07-09");
  const resolved = cell(cells, "2026-07-09", "15:00");
  assert.equal(resolved.studentName, "Pang Yi Ning");
  assert.equal(resolved.type, "exam");
  assert.equal(resolved.status, "booked");
}

function testStudentNotShowDisplaysLatestStatus() {
  const teacher = baseTeacher();
  const cells = resolve({
    teachers: [teacher],
    students: [],
    bookings: [{
      id: "chi_not_show",
      teacherId: "teacher_peggy",
      date: "2026-07-01",
      time: "20:00",
      studentName: "Chi Zhong Hyi",
      subject: "BM",
      type: "regular class",
      status: "student_not_show",
      statusChangedAt: "2026-07-01T12:00:00.000Z",
      updatedAt: "2026-07-01T12:00:00.000Z"
    }]
  }, "2026-07-01", "2026-07-01");
  assert.equal(cell(cells, "2026-07-01", "20:00").status, "student_not_show");
}

function testSetOffSupersedesOlderBooking() {
  const teacher = baseTeacher({
    overrideSlots: [{
      id: "off_2026_07_07_1630",
      date: "2026-07-07",
      day: "Tuesday",
      time: "16:30",
      unavailable: true,
      status: "off",
      updatedAt: "2026-07-07T09:00:00.000Z"
    }]
  });
  const cells = resolve({
    teachers: [teacher],
    students: [],
    bookings: [{
      id: "old_trial",
      teacherId: "teacher_peggy",
      date: "2026-07-07",
      time: "16:30",
      studentName: "CANCEL",
      subject: "CN",
      type: "trial class",
      status: "booked",
      updatedAt: "2026-07-07T08:00:00.000Z"
    }]
  }, "2026-07-07", "2026-07-07");
  const resolved = cell(cells, "2026-07-07", "16:30");
  assert.equal(resolved.kind, "off");
  assert.equal(resolved.status, "off");
}

function testResolvedCellParityCases() {
  const teacher = baseTeacher({
    regularSlots: [{
      id: "slot_regular_monday_1800",
      day: "Monday",
      time: "18:00",
      locked: true,
      studentId: "student_regular",
      studentName: "Regular Student",
      subject: "CN",
      type: "regular class",
      startDate: "2026-07-01",
      updatedAt: "2026-07-01T00:00:00.000Z"
    }, {
      id: "slot_leave_tuesday_1000",
      day: "Tuesday",
      time: "10:00",
      locked: false,
      subject: "CN",
      startDate: "2026-07-01",
      updatedAt: "2026-07-01T00:00:00.000Z"
    }],
    overrideSlots: [{
      id: "off_wednesday_1430",
      date: "2026-07-15",
      day: "Wednesday",
      time: "14:30",
      unavailable: true,
      status: "off",
      updatedAt: "2026-07-15T09:00:00.000Z"
    }]
  });
  const state = {
    teachers: [teacher],
    students: [],
    teacherLeaves: [{
      id: "leave_1",
      teacherId: teacher.id,
      status: "active",
      startDate: "2026-07-14",
      endDate: "2026-07-14",
      fromTime: "10:00",
      toTime: "10:00",
      remark: "Training",
      updatedAt: "2026-07-14T08:00:00.000Z"
    }],
    bookings: [{
      id: "booking_trial",
      teacherId: teacher.id,
      date: "2026-07-13",
      time: "09:00",
      studentId: "student_trial",
      studentName: "Trial Student",
      subject: "CN",
      type: "trial class",
      status: "booked",
      updatedAt: "2026-07-13T08:00:00.000Z"
    }, {
      id: "booking_exam",
      teacherId: teacher.id,
      date: "2026-07-13",
      time: "09:30",
      studentId: "student_exam",
      studentName: "Exam Student",
      subject: "BM",
      type: "exam",
      status: "booked",
      updatedAt: "2026-07-13T08:00:00.000Z"
    }, {
      id: "booking_assessment",
      teacherId: teacher.id,
      date: "2026-07-13",
      time: "10:00",
      studentId: "student_assessment",
      studentName: "Assessment Student",
      subject: "PK",
      type: "assessment",
      status: "booked",
      updatedAt: "2026-07-13T08:00:00.000Z"
    }, {
      id: "booking_replacement",
      teacherId: teacher.id,
      date: "2026-07-13",
      time: "10:30",
      studentId: "student_replacement",
      studentName: "Replacement Student",
      subject: "CN",
      type: "replacement class",
      status: "booked",
      updatedAt: "2026-07-13T08:00:00.000Z"
    }, {
      id: "booking_cancelled",
      teacherId: teacher.id,
      date: "2026-07-13",
      time: "11:00",
      studentId: "student_cancelled",
      studentName: "Cancelled Student",
      subject: "CN",
      type: "regular class",
      status: "cancelled",
      remark: "Parent cancelled",
      updatedAt: "2026-07-13T08:00:00.000Z"
    }, {
      id: "booking_not_show",
      teacherId: teacher.id,
      date: "2026-07-13",
      time: "11:30",
      studentId: "student_not_show",
      studentName: "Not Show Student",
      subject: "CN",
      type: "regular class",
      status: "student_not_show",
      updatedAt: "2026-07-13T08:00:00.000Z"
    }, {
      id: "booking_public_holiday",
      teacherId: teacher.id,
      date: "2026-07-13",
      time: "12:00",
      studentId: "student_holiday",
      studentName: "Holiday Student",
      subject: "CN",
      type: "regular class",
      status: "public_holiday",
      updatedAt: "2026-07-13T08:00:00.000Z"
    }, {
      id: "booking_moved",
      teacherId: teacher.id,
      date: "2026-07-13",
      time: "12:30",
      studentId: "student_moved",
      studentName: "Moved Student",
      subject: "CN",
      type: "regular class",
      status: "booked",
      changedSlot: { fromDate: "2026-07-13", fromTime: "13:00", changedAt: "2026-07-13T08:05:00.000Z" },
      updatedAt: "2026-07-13T08:05:00.000Z"
    }, {
      id: "booking_deleted",
      teacherId: teacher.id,
      date: "2026-07-13",
      time: "13:30",
      studentName: "Deleted Student",
      subject: "CN",
      type: "regular class",
      status: "deleted",
      deleted: true,
      updatedAt: "2026-07-13T08:00:00.000Z"
    }]
  };
  const cells = resolve(state, "2026-07-13", "2026-07-15");
  assertParityCell(cell(cells, "2026-07-13", "18:00"), {
    bookingId: "",
    recurringScheduleId: "slot_regular_monday_1800",
    studentId: "student_regular",
    studentName: "Regular Student",
    subject: "CN",
    type: "regular class",
    status: "booked",
    available: false,
    locked: true,
    remark: "",
    minutes: 25
  }, "recurring regular class");
  [
    ["09:00", "booking_trial", "student_trial", "Trial Student", "CN", "trial class", "booked", ""],
    ["09:30", "booking_exam", "student_exam", "Exam Student", "BM", "exam", "booked", ""],
    ["10:00", "booking_assessment", "student_assessment", "Assessment Student", "PK", "assessment", "booked", ""],
    ["10:30", "booking_replacement", "student_replacement", "Replacement Student", "CN", "replacement class", "booked", ""],
    ["11:00", "booking_cancelled", "student_cancelled", "Cancelled Student", "CN", "regular class", "cancelled", "Parent cancelled"],
    ["11:30", "booking_not_show", "student_not_show", "Not Show Student", "CN", "regular class", "student_not_show", ""],
    ["12:00", "booking_public_holiday", "student_holiday", "Holiday Student", "CN", "regular class", "public_holiday", ""],
    ["12:30", "booking_moved", "student_moved", "Moved Student", "CN", "regular class", "booked", ""]
  ].forEach(([time, bookingId, studentId, studentName, subject, type, status, remark]) => {
    assertParityCell(cell(cells, "2026-07-13", time), {
      bookingId,
      recurringScheduleId: "",
      studentId,
      studentName,
      subject,
      type,
      status,
      available: false,
      locked: true,
      remark,
      minutes: 25
    }, `${type} ${status}`);
  });
  assertParityCell(cell(cells, "2026-07-14", "10:00"), {
    bookingId: "leave_leave_1_2026-07-14_10:00",
    recurringScheduleId: "",
    studentId: "",
    studentName: "Teacher Leave",
    subject: "CN",
    type: "teacher leave",
    status: "teacher_leave",
    available: false,
    locked: true,
    remark: "Training",
    minutes: 25
  }, "teacher leave");
  assertParityCell(cell(cells, "2026-07-15", "14:30"), {
    bookingId: "",
    recurringScheduleId: "off_wednesday_1430",
    studentId: "",
    studentName: "",
    subject: "",
    type: "off",
    status: "off",
    available: false,
    locked: false,
    remark: "",
    minutes: 25
  }, "set off");
  assert.equal(cell(cells, "2026-07-13", "13:30"), undefined, "deleted booking should not produce an active final cell");
}

testRecurringStartEnd();
testOneDateOverrideOnlyAffectsExactDate();
testStaleOpenOverrideDoesNotHideLockedRegularSlot();
testLeeShokYuongNgooiJunRecurringStaysBooked();
testLatestBookingRecordWins();
testStudentNotShowDisplaysLatestStatus();
testSetOffSupersedesOlderBooking();
testResolvedCellParityCases();

console.log("calendar-resolver stability tests passed");
