const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldResolveManualChallenge } = require("../manual-challenge-state");

test("resolves when the reservation page becomes visible", () => {
    assert.equal(
        shouldResolveManualChallenge({
            url: "https://anc.apm.activecommunities.com/chandleraz/reservation/landing/quick",
            quickReservationVisible: true,
        }),
        true
    );
});

test("waits while sign-in inputs and reCAPTCHA remain visible", () => {
    assert.equal(
        shouldResolveManualChallenge({
            url: "https://anc.apm.activecommunities.com/chandleraz/signin",
            emailFieldVisible: true,
            challengeVisible: true,
        }),
        false
    );
});
