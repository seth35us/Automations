const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldResolveManualChallenge, shouldRetryCaptchaChallenge } = require("../manual-challenge-state");

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
test("stops retrying captcha after the configured limit", () => {
    assert.equal(shouldRetryCaptchaChallenge({ attempt: 0, maxAttempts: 3 }), true);
    assert.equal(shouldRetryCaptchaChallenge({ attempt: 2, maxAttempts: 3 }), true);
    assert.equal(shouldRetryCaptchaChallenge({ attempt: 3, maxAttempts: 3 }), false);
});