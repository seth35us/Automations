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

module.exports = { extractCaptchaSiteKey };
