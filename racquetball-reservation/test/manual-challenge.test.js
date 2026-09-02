const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldResolveManualChallenge, shouldRetryCaptchaChallenge, runCaptchaRetryBudget } = require("../manual-challenge-state");

test("resolves when the reservation page becomes visible", () => {
    assert.equal(
        shouldResolveManualChallenge({
            url: "https://anc.apm.activecommunities.com/chandleraz/reservation/landing/quick",
            quickReservationVisible: true,
        }),
        true
    );
});

test("resolves when the page is no longer on the sign-in flow", () => {
    assert.equal(
        shouldResolveManualChallenge({
            url: "https://anc.apm.activecommunities.com/chandleraz/reservation/landing/quick",
            emailFieldVisible: false,
            challengeVisible: false,
            signInButtonVisible: false,
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

test("waits while the sign-in button is still visible", () => {
    assert.equal(
        shouldResolveManualChallenge({
            url: "https://anc.apm.activecommunities.com/chandleraz/signin",
            signInButtonVisible: true,
        }),
        false
    );
});

test("stops retrying captcha after the configured limit", () => {
    assert.equal(shouldRetryCaptchaChallenge({ attempt: 0, maxAttempts: 3 }), true);
    assert.equal(shouldRetryCaptchaChallenge({ attempt: 2, maxAttempts: 3 }), true);
    assert.equal(shouldRetryCaptchaChallenge({ attempt: 3, maxAttempts: 3 }), false);
    assert.equal(shouldRetryCaptchaChallenge({ attempt: 1, maxAttempts: 0 }), false);
});

test("runCaptchaRetryBudget resolves on the first successful attempt", async () => {
    let calls = 0;
    const result = await runCaptchaRetryBudget({
        maxAttempts: 3,
        attemptFn: async () => {
            calls += 1;
            return calls === 1;
        },
    });

    assert.equal(result.resolved, true);
    assert.equal(result.attempt, 0);
    assert.equal(calls, 1);
});

test("runCaptchaRetryBudget exhausts after the configured limit", async () => {
    let calls = 0;
    const result = await runCaptchaRetryBudget({
        maxAttempts: 3,
        attemptFn: async () => {
            calls += 1;
            return false;
        },
    });

    assert.equal(result.resolved, false);
    assert.equal(result.exhausted, true);
    assert.equal(calls, 3);
});