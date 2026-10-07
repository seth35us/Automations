const test = require("node:test");
const assert = require("node:assert/strict");
const { openingDelay, waitForOpening } = require("../booking-opening");

test("the observed 2 AM Arizona trigger waits until the booking window", () => {
    assert.equal(openingDelay(new Date("2026-10-07T09:00:00Z")), 10_805_000);
});

test("opening includes a five-second grace period and late runs proceed immediately", () => {
    assert.equal(openingDelay(new Date("2026-10-07T12:00:00Z")), 5_000);
    assert.equal(openingDelay(new Date("2026-10-07T12:00:05Z")), 0);
    assert.equal(openingDelay(new Date("2026-10-07T14:00:00Z")), 0);
});

test("Arizona calendar date and UTC offset apply across midnight and seasons", () => {
    assert.equal(openingDelay(new Date("2026-10-08T01:00:00Z")), 0);
    assert.equal(openingDelay(new Date("2026-01-07T12:00:00Z")), 5_000);
    assert.equal(openingDelay(new Date("2026-07-07T12:00:00Z")), 5_000);
});

test("wait rechecks the clock after waking instead of assuming elapsed time", async () => {
    let current = new Date("2026-10-07T09:00:00Z");
    const waits = [];
    await waitForOpening({
        now: () => current,
        log: () => {},
        wait: async (duration) => {
            waits.push(duration);
            current = new Date(waits.length === 1 ? "2026-10-07T12:00:04Z" : "2026-10-07T12:00:05Z");
        },
    });
    assert.deepEqual(waits, [60_000, 1_000]);
});
