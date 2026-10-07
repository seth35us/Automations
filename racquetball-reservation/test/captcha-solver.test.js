const test = require("node:test");
const assert = require("node:assert/strict");
const { extractCaptchaSiteKey, buildCapSolverTask } = require("../captcha-solver");

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

test("buildCapSolverTask includes the invisible reCAPTCHA flag for enterprise sites", () => {
    const task = buildCapSolverTask({
        pageUrl: "https://example.com/signin",
        siteKey: "demo-site-key",
        isEnterprise: true,
    });

    assert.deepEqual(task, {
        type: "ReCaptchaV2EnterpriseTaskProxyLess",
        websiteURL: "https://example.com/signin",
        websiteKey: "demo-site-key",
        isInvisible: true,
    });
});
