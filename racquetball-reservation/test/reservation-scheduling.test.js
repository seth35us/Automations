const test = require("node:test");
const assert = require("node:assert/strict");
const { scheduleFor, normalizeTimeValue, resolveReservationRequest } = require("../reservation-scheduling");

test("Friday defaults to 5:30 PM", () => {
    assert.deepEqual(scheduleFor("2026-09-04"), ["5:30 PM"]);
});

test("Tuesday and Thursday also default to 5:30 PM", () => {
    assert.deepEqual(scheduleFor("2026-09-01"), ["5:30 PM"]);
    assert.deepEqual(scheduleFor("2026-09-03"), ["5:30 PM"]);
});

test("A custom time overrides the default weekday schedule", () => {
    assert.deepEqual(scheduleFor("2026-09-05", "8:00 AM"), ["8:00 AM"]);
    assert.deepEqual(scheduleFor("2026-09-04", "8:30 PM"), ["8:30 PM"]);
});

test("Bare hour values are normalized to a 12-hour time", () => {
    assert.equal(normalizeTimeValue("8"), "8:00 AM");
    assert.equal(normalizeTimeValue("8pm"), "8:00 PM");
});

test("Invalid times throw an error", () => {
    assert.throws(() => normalizeTimeValue("13:00 PM"), /Invalid time/);
    assert.throws(() => normalizeTimeValue("8:75 AM"), /Invalid time/);
});

test("Sunday remains on the default 4:00 PM window", () => {
    assert.deepEqual(scheduleFor("2026-09-06"), ["4:00 PM"]);
});
test("Requests beyond the two-day booking window are queued to the earlier execution date", () => {
    const result = resolveReservationRequest({ requestedDate: "2026-09-06", referenceDate: "2026-09-02", reservationWindowDays: 2 });
    assert.equal(result.shouldQueue, true);
    assert.equal(result.executionDate, "2026-09-04");
    assert.equal(result.bookingWindowDate, "2026-09-04");
});

test("Requests within the booking window run on the requested date", () => {
    const result = resolveReservationRequest({ requestedDate: "2026-09-04", referenceDate: "2026-09-02", reservationWindowDays: 2 });
    assert.equal(result.shouldQueue, false);
    assert.equal(result.executionDate, "2026-09-04");
});