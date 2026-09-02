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

module.exports = { shouldResolveManualChallenge };
