function dateInfo(dateString) {
    const [year, month, day] = dateString.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day, 12));
    return {
        weekday: date.getUTCDay(),
        pickerLabel: new Intl.DateTimeFormat("en-US", {
            timeZone: "UTC",
            month: "short",
            day: "numeric",
            year: "numeric",
        }).format(date),
    };
}

function addDays(dateString, days) {
    const [year, month, day] = dateString.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days, 12));
    return [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")].join("-");
}

function toDateString(date, timeZone = "America/Phoenix") {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function resolveReservationRequest({ requestedDate, referenceDate = new Date(), reservationWindowDays = 2 } = {}) {
    const referenceDateString = typeof referenceDate === "string" ? referenceDate : toDateString(referenceDate);
    const targetDate = requestedDate || addDays(referenceDateString, reservationWindowDays);
    const bookingWindowDate = addDays(referenceDateString, reservationWindowDays);
    const shouldQueue = targetDate > bookingWindowDate;
    const executionDate = shouldQueue ? addDays(targetDate, -reservationWindowDays) : targetDate;
    return {
        requestedDate: targetDate,
        bookingWindowDate,
        executionDate,
        shouldQueue,
    };
}

function normalizeTimeValue(value) {
    if (!value) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;

    const match = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(trimmed);
    if (!match) {
        const normalized = trimmed.replace(/\s+/g, " ").trim();
        if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(normalized)) return normalized.replace(/^\s+/, "").replace(/\s+$/, "");
        throw new Error(`Invalid time: ${value}`);
    }

    const hour = Number(match[1]);
    const minutes = match[2] ? Number(match[2]) : 0;
    const suffix = (match[3] || "AM").toUpperCase();
    if (hour < 1 || hour > 12 || minutes < 0 || minutes > 59) {
        throw new Error(`Invalid time: ${value}`);
    }
    return `${hour}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function scheduleFor(dateString, requestedTime = null) {
    const normalizedTime = normalizeTimeValue(requestedTime);
    if (normalizedTime) return [normalizedTime];

    const { weekday } = dateInfo(dateString);
    if (weekday === 0) return ["4:00 PM"];
    if (weekday === 2 || weekday === 4) return ["5:30 PM"];
    if (weekday === 5) return ["5:30 PM"];
    return null;
}

module.exports = { dateInfo, normalizeTimeValue, scheduleFor, resolveReservationRequest };
