function extractCaptchaSiteKey({ frameSrc = "", dataSiteKey = "" } = {}) {
    const candidate = [frameSrc, dataSiteKey].find((value) => typeof value === "string" && value.trim());
    if (!candidate) return null;

    const params = new URLSearchParams(candidate.split("?")[1] || "");
    const siteKeyFromQuery = params.get("k") || params.get("sitekey") || "";
    if (siteKeyFromQuery) return siteKeyFromQuery;

    const fromAttribute = candidate.match(/sitekey=([^&]+)/i)?.[1];
    if (fromAttribute) return fromAttribute;
    return dataSiteKey.trim() || null;
}

function buildCapSolverTask({
    pageUrl = "",
    siteKey = "",
    isEnterprise = false,
    isInvisible = true,
    type = null,
} = {}) {
    if (!pageUrl || !siteKey) {
        throw new Error("CapSolver task requires both a page URL and site key.");
    }

    return {
        type: type || (isEnterprise ? "ReCaptchaV2EnterpriseTaskProxyLess" : "ReCaptchaV2TaskProxyLess"),
        websiteURL: pageUrl,
        websiteKey: siteKey,
        isInvisible: Boolean(isInvisible),
    };
}

module.exports = { extractCaptchaSiteKey, buildCapSolverTask };
