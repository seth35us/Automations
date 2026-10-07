const { setTimeout: sleep } = require("node:timers/promises");

function openingDelay(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Phoenix", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(now);
    const date = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    // Phoenix stays on UTC-07:00 throughout the year.
    const opening = new Date(`${date.year}-${date.month}-${date.day}T05:00:05-07:00`);
    return Math.max(0, opening.getTime() - now.getTime());
}

async function waitForOpening({ now = () => new Date(), wait = sleep, log = console.log } = {}) {
    let remaining = openingDelay(now());
    if (remaining > 0) log(`Waiting until 5:00:05 AM America/Phoenix before starting the scheduled reservation.`);
    while (remaining > 0) {
        await wait(Math.min(remaining, 60_000));
        remaining = openingDelay(now());
    }
}

module.exports = { openingDelay, waitForOpening };

if (require.main === module) {
    waitForOpening().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
