const test = require("node:test");
const assert = require("node:assert/strict");
const { extractCaptchaSiteKey } = require("../captcha-solver");

test("extractCaptchaSiteKey reads a site key from a recaptcha iframe URL", () => {
    const siteKey = extractCaptchaSiteKey({
        frameSrc: "https://www.google.com/recaptcha/api2/anchor?k=demo-site-key",
    });

    assert.equal(siteKey, "demo-site-key");
});

test("extractCaptchaSiteKey falls back to a data-sitekey attribute", () => {
    const siteKey = extractCaptchaSiteKey({
        dataSiteKey: "fallback-site-key",
    });

    assert.equal(siteKey, "fallback-site-key");
});

test("extractCaptchaSiteKey returns null when no site key is available", () => {
    const siteKey = extractCaptchaSiteKey({
        frameSrc: "https://www.google.com/recaptcha/api2/anchor",
    });

    assert.equal(siteKey, null);
});
