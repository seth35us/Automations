function shouldResolveManualChallenge({
    url = "",
    emailFieldVisible = false,
    challengeVisible = false,
    quickReservationVisible = false,
    signInButtonVisible = false,
} = {}) {
    const normalizedUrl = (url || "").toLowerCase();
    const onSignInPage = normalizedUrl.includes("/signin") || normalizedUrl.includes("/login");

    if (quickReservationVisible) return true;
    if (!onSignInPage && !emailFieldVisible && !challengeVisible && !signInButtonVisible) return true;
    return false;
}

function shouldRetryCaptchaChallenge({ attempt = 0, maxAttempts = 3 } = {}) {
    return attempt < maxAttempts;
}

async function runCaptchaRetryBudget({ maxAttempts = 3, attemptFn } = {}) {
    if (typeof attemptFn !== "function") {
        throw new TypeError("attemptFn must be a function");
    }

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const resolved = await attemptFn(attempt);
        if (resolved) {
            return { resolved: true, attempt, exhausted: false };
        }
    }

    return { resolved: false, attempt: maxAttempts, exhausted: true };
}

module.exports = { shouldResolveManualChallenge, shouldRetryCaptchaChallenge, runCaptchaRetryBudget };
