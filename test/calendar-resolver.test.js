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

testRecurringStartEnd();
testOneDateOverrideOnlyAffectsExactDate();
testStaleOpenOverrideDoesNotHideLockedRegularSlot();
testLeeShokYuongNgooiJunRecurringStaysBooked();
testLatestBookingRecordWins();
testStudentNotShowDisplaysLatestStatus();
testSetOffSupersedesOlderBooking();

console.log("calendar-resolver stability tests passed");
