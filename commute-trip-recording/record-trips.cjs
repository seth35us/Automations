#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { chromium } = require("playwright");

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, ".env");
const PROFILE_DIR = path.join(ROOT, ".browser-profile");
const ARTIFACTS_DIR = path.join(ROOT, "artifacts");
const EXCEPTIONS_FILE = path.join(ROOT, "exceptions.json");
const SUCCESS_FILE = path.join(ROOT, "successful-runs.json");
const HISTORY_FILE = path.join(ROOT, "run-history.json");
const NOTIFICATION_HISTORY_FILE = path.join(ROOT, "notification-history.json");
const SITE_URL = "https://members.commutewithenterprise.com/#/trip-recording";
const TIME_ZONE = "America/Phoenix";
const MEMBER_NAME = "Seth Starr";
const GAS_VENDOR = "Fry's";
const GAS_PRICE_PER_GALLON = 3.65;
const GAS_GALLONS = 10;
const GAS_TOTAL = Number((GAS_PRICE_PER_GALLON * GAS_GALLONS).toFixed(2));
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function loadEnv(filename) {
  if (!fs.existsSync(filename)) return;
  for (const rawLine of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function readJson(filename, fallback) {
  if (!fs.existsSync(filename)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    throw new Error(`${filename} is not valid JSON.`);
  }
}

function writeJson(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function recordHistory(entry) {
  const history = readJson(HISTORY_FILE, []);
  history.push({ ...entry, recordedAt: new Date().toISOString() });
  writeJson(HISTORY_FILE, history.slice(-100));
}

function sendMacNotification(message, success) {
  const safe = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", `display notification "${safe}" with title "Commute trip recording" sound name "${success ? "Glass" : "Basso"}"`],
      (error) => {
        if (error) log(`macOS notification failed: ${error.message}`);
        resolve(!error);
      }
    );
  });
}

function zeptoMailToken() {
  const configured = (process.env.ZEPTOMAIL_SEND_MAIL_TOKEN || process.env.ZEPTOMAIL_API_KEY || "")
    .replace(/^zoho-enczapikey\s+/i, "")
    .trim();
  if (configured) return configured;

  const gcloud = process.env.GCLOUD_BIN || "/usr/local/share/google-cloud-sdk/bin/gcloud";
  const project = process.env.ZEPTOMAIL_GCLOUD_PROJECT;
  const secret = process.env.ZEPTOMAIL_SECRET_NAME;
  if (!project || !secret) return "";
  try {
    return execFileSync(
      gcloud,
      ["secrets", "versions", "access", "latest", "--secret", secret, "--project", project],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }
    ).trim();
  } catch (error) {
    throw new Error(`Could not load the ZeptoMail token from Google Secret Manager: ${error.message}`);
  }
}

function notificationEmailConfig() {
  return {
    from: (process.env.COMMUTE_NOTIFICATION_FROM || "").trim(),
    fromName: (process.env.COMMUTE_NOTIFICATION_FROM_NAME || "Commute Trip Recording").trim(),
    recipients: (process.env.COMMUTE_NOTIFICATION_EMAIL || "")
      .split(",")
      .map((email) => email.trim())
      .filter(Boolean),
  };
}

function notificationFingerprint(success, month, message) {
  return `${success ? "success" : "failure"}:${month || "unknown"}:${message}`;
}

function recentlyEmailed(fingerprint) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return readJson(NOTIFICATION_HISTORY_FILE, []).some(
    (entry) => entry.fingerprint === fingerprint && entry.status === "sent" &&
      (fingerprint.startsWith("success:") || Date.parse(entry.recordedAt) >= cutoff)
  );
}

function recordNotification(entry) {
  const history = readJson(NOTIFICATION_HISTORY_FILE, []);
  history.push({ ...entry, recordedAt: new Date().toISOString() });
  writeJson(NOTIFICATION_HISTORY_FILE, history.slice(-100));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sendZeptoMail({ subject, textBody }) {
  const token = zeptoMailToken();
  const { from, fromName, recipients } = notificationEmailConfig();
  if (!token) throw new Error("ZeptoMail token is not configured.");
  if (!from || recipients.length === 0) throw new Error("Notification sender or recipient is not configured.");

  const payload = {
    from: { address: from, name: fromName },
    to: recipients.map((address) => ({ email_address: { address } })),
    subject,
    textbody: textBody,
  };
  const apiURL = process.env.ZEPTOMAIL_API_URL || "https://api.zeptomail.com/v1.1/email";
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(apiURL, {
        method: "POST",
        headers: {
          Authorization: `Zoho-enczapikey ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) return;
      const responseText = (await response.text()).slice(0, 500);
      const error = new Error(`ZeptoMail returned ${response.status}: ${responseText}`);
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    } catch (error) {
      lastError = error;
      if (error.retryable === false || attempt === 3) break;
      await delay(attempt * 2000);
    }
  }
  throw lastError;
}

async function notify(message, success, details = {}) {
  const month = details.month || "unknown month";
  const fingerprint = notificationFingerprint(success, month, message);
  const macPromise = sendMacNotification(message, success);
  let emailSent = false;

  if (!details.force && recentlyEmailed(fingerprint)) {
    log(`Duplicate ${success ? "success" : "failure"} email suppressed for ${month}.`);
  } else {
    const subject = `${success ? "✅" : "🚨"} Commute recording ${success ? "approved" : "failed"} — ${month}`;
    const lines = [
      `Status: ${success ? "APPROVED" : "FAILED"}`,
      `Month: ${month}`,
      `Time: ${new Date().toLocaleString("en-US", { timeZone: TIME_ZONE })} (${TIME_ZONE})`,
      "",
      message,
    ];
    if (details.screenshot) lines.push("", `Failure screenshot: ${details.screenshot}`);
    try {
      await sendZeptoMail({ subject, textBody: lines.join("\n") });
      recordNotification({ fingerprint, month, status: "sent", success, subject });
      log(`ZeptoMail ${success ? "success" : "failure"} notification accepted for ${month}.`);
      emailSent = true;
    } catch (error) {
      recordNotification({ fingerprint, month, status: "error", success, message: error.message });
      log(`ZeptoMail notification failed: ${error.message}`);
    }
  }

  const macSent = await macPromise;
  return { emailSent, macSent };
}

function parseArgs(argv) {
  const result = { dryRun: true, headed: false, keepOpen: false, scheduled: false, targetMonth: null, testNotification: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--run") result.dryRun = false;
    else if (arg === "--scheduled") { result.scheduled = true; result.dryRun = false; }
    else if (arg === "--headed") result.headed = true;
    else if (arg === "--keep-open") { result.keepOpen = true; result.headed = true; }
    else if (arg === "--target-month") result.targetMonth = argv[++index];
    else if (arg === "--test-notification") result.testNotification = true;
    else if (arg === "--help") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function zonedParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function previousMonthKey() {
  const now = zonedParts();
  const date = new Date(Date.UTC(now.year, now.month - 2, 1, 12));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function parseMonthKey(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) {
    throw new Error(`Invalid target month ${value}; use YYYY-MM.`);
  }
  return { year: Number(match[1]), month: Number(match[2]), key: value };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dateKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function exceptionDates(monthKey) {
  const configured = readJson(EXCEPTIONS_FILE, {});
  const values = configured[monthKey] || [];
  if (!Array.isArray(values)) throw new Error(`${EXCEPTIONS_FILE}: ${monthKey} must be an array of dates.`);
  return new Set(values);
}

async function visible(locator) {
  return (await locator.count()) > 0 && (await locator.first().isVisible());
}

async function clickFirstVisible(locators) {
  for (const locator of locators) {
    if (await visible(locator)) { await locator.first().click(); return true; }
  }
  return false;
}

async function waitForMemberSite(page, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const url = page.url();
    const route = url.includes("#/dashboard") || url.includes("#/trip-recording");
    const dashboard = page.getByRole("link", { name: "Dashboard", exact: true });
    if (route && (await visible(dashboard))) {
      await page.waitForTimeout(4000);
      const email = page.getByRole("textbox", { name: "Email", exact: true });
      if ((await visible(dashboard)) && !(await visible(email))) return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Sign-in did not reach the authenticated dashboard. Current page: ${page.url()}`);
}

async function openTripRecording(page) {
  const email = process.env.COMMUTE_EMAIL;
  const password = process.env.COMMUTE_PASSWORD;
  if (!email || !password) throw new Error("Missing COMMUTE_EMAIL or COMMUTE_PASSWORD in .env.");

  await page.goto(SITE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  const emailField = page.getByRole("textbox", { name: "Email", exact: true });
  const dashboard = page.getByRole("link", { name: "Dashboard", exact: true });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await visible(emailField)) break;
    if (await visible(dashboard)) {
      await page.waitForTimeout(3000);
      if (await visible(dashboard)) break;
    }
    await page.waitForTimeout(250);
  }

  if (await visible(emailField)) {
    log("Stored session is not authenticated; signing in with local credentials.");
    await emailField.fill(email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const passwordField = page.locator('input[type="password"]');
    await passwordField.waitFor({ state: "visible", timeout: 20000 });
    await passwordField.fill(password);
    const clicked = await clickFirstVisible([
      page.getByRole("button", { name: "LOG IN", exact: true }),
      page.getByRole("button", { name: "Sign in", exact: true }),
      page.getByRole("button", { name: "Continue", exact: true }),
    ]);
    if (!clicked) throw new Error("Could not find the password submission button.");
    await waitForMemberSite(page);
  } else if (!(await visible(dashboard))) {
    throw new Error(`Could not determine authentication state at ${page.url()}.`);
  }

  if (!page.url().includes("#/trip-recording")) {
    await page.getByRole("link", { name: "Trip Recording", exact: true }).click();
    await page.waitForURL(/#\/trip-recording/, { timeout: 20000 });
  }
  await page.getByRole("button", { name: "Save", exact: true }).waitFor({ state: "visible", timeout: 20000 });
}

async function dismissPopups(page) {
  const decline = page.getByText("No, Thanks", { exact: true });
  if (await visible(decline)) await decline.first().click();
  const closeCookies = page.getByRole("button", { name: "CLOSE", exact: true });
  if (await visible(closeCookies)) await closeCookies.first().click();
}

async function returnToVanpoolTrips(page, target) {
  const vanpoolTrips = page.getByRole("link", { name: "Vanpool Trips", exact: true });
  await vanpoolTrips.waitFor({ state: "visible", timeout: 20000 });
  await vanpoolTrips.click();
  await page.waitForURL(/#\/trip-recording$/, { timeout: 20000 });
  await page.getByRole("button", { name: "Save", exact: true }).waitFor({ state: "visible", timeout: 20000 });
  await page.getByRole("button", { name: "Approve", exact: true }).waitFor({ state: "visible", timeout: 20000 });
  await selectTargetMonth(page, target);
}

async function selectTargetMonth(page, target) {
  const monthName = MONTH_NAMES[target.month - 1];
  const button = page.getByRole("button", {
    name: new RegExp(`^(previous|current) month ${monthName}$`, "i"),
  });
  if ((await button.count()) !== 1) {
    throw new Error(`The ${monthName} month selector is not available; only the current and previous month can be automated.`);
  }
  await button.click();
  await page.waitForFunction(
    (label) => document.querySelector(`button[aria-label="${label}"]`)?.classList.contains("selected"),
    (await button.getAttribute("aria-label")),
    { timeout: 15000 }
  );
}

function weekStartDate(target, monthText, startDay) {
  const monthIndex = MONTH_ABBR.findIndex((name) => name.toLowerCase() === monthText.toLowerCase());
  if (monthIndex < 0) throw new Error(`Unknown week month label: ${monthText}`);
  let year = target.year;
  if (target.month === 1 && monthIndex === 11) year -= 1;
  if (target.month === 12 && monthIndex === 0) year += 1;
  return new Date(Date.UTC(year, monthIndex, startDay, 12));
}

async function processTrips(page, target, exceptions, dryRun) {
  const names = (await page.locator('.vanpoolers .vanpooler .name[aria-label="vanpooler"]').allTextContents())
    .map((value) => value.replace(/Driver/g, "").trim());
  const memberIndex = names.findIndex((name) => name === MEMBER_NAME);
  if (memberIndex < 0) throw new Error(`${MEMBER_NAME} was not found in the vanpool rider list.`);

  const expectedCount = daysInMonth(target.year, target.month);
  const processed = new Set();
  let changed = 0;

  for (let week = 0; week < 7 && processed.size < expectedCount; week += 1) {
    const monthText = (await page.locator(".week-nav .month").innerText()).trim();
    const startDay = Number(await page.locator(".week-nav .start").innerText());
    const dayColumns = page.locator(".day");
    const columnCount = await dayColumns.count();
    const displayedDays = [];
    for (let index = 0; index < columnCount; index += 1) {
      displayedDays.push(Number(await dayColumns.nth(index).locator(".day-of-month").innerText()));
    }
    const anchorIndex = displayedDays.indexOf(startDay);
    if (anchorIndex < 0) throw new Error(`Week header ${monthText} ${startDay} does not match a displayed day.`);
    const anchorDate = weekStartDate(target, monthText, startDay);
    const startDate = new Date(anchorDate.getTime() - anchorIndex * 86400000);

    for (let index = 0; index < columnCount; index += 1) {
      const date = new Date(startDate.getTime() + index * 86400000);
      if (date.getUTCFullYear() !== target.year || date.getUTCMonth() + 1 !== target.month) continue;
      const key = dateKey(date);
      if (processed.has(key)) continue;

      const day = dayColumns.nth(index);
      const cells = day.locator(".trip-status:not(.trip-time)");
      if ((await cells.count()) <= memberIndex) {
        log(`Skipping inactive, non-editable date ${key}.`);
        processed.add(key);
        continue;
      }
      const cell = cells.nth(memberIndex);
      const icon = cell.locator('svg[aria-label]');
      if ((await icon.count()) === 0) {
        log(`Skipping inactive, non-editable date ${key}.`);
        processed.add(key);
        continue;
      }
      const actual = ((await icon.getAttribute("aria-label")) || "").toLowerCase();
      const commuteDay = date.getUTCDay() === 1 || date.getUTCDay() === 4;
      const expected = commuteDay && !exceptions.has(key) ? "round trip" : "did not commute";

      if (actual !== expected) {
        log(`${dryRun ? "Would change" : "Changing"} ${key}: ${actual || "unknown"} -> ${expected}.`);
        if (!dryRun) {
          await cell.press(expected === "round trip" ? "r" : "x");
          const statusDeadline = Date.now() + 10000;
          let updated = "";
          while (Date.now() < statusDeadline) {
            updated = ((await cell.locator('svg[aria-label]').getAttribute("aria-label")) || "").toLowerCase();
            if (updated === expected) break;
            await page.waitForTimeout(100);
          }
          if (updated !== expected) throw new Error(`Trip status for ${key} did not change to ${expected}.`);
        }
        changed += 1;
      }
      processed.add(key);
    }

    if (processed.size < expectedCount) {
      const signature = `${monthText}-${startDay}`;
      await page.getByRole("button", { name: "Previous week", exact: true }).click();
      await page.waitForFunction(
        (oldValue) => {
          const month = document.querySelector(".week-nav .month")?.textContent?.trim();
          const start = document.querySelector(".week-nav .start")?.textContent?.trim();
          return month && start && `${month}-${start}` !== oldValue;
        },
        signature,
        { timeout: 10000 }
      );
    }
  }

  if (processed.size !== expectedCount) {
    throw new Error(`Validated ${processed.size} of ${expectedCount} days for ${target.key}.`);
  }
  log(`Validated all ${expectedCount} days for ${MEMBER_NAME}; ${changed} change(s) ${dryRun ? "needed" : "applied"}.`);

  if (dryRun) return { changed, approved: false };
  const save = page.getByRole("button", { name: "Save", exact: true });
  await save.click();

  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await approve.click({ timeout: 20000 });
  const confirmApproval = page.getByRole("button", { name: "Yes, Approve", exact: true });
  await confirmApproval.waitFor({ state: "visible", timeout: 10000 });
  await confirmApproval.click();
  await page.waitForFunction(
    () => {
      const button = document.querySelector("button.approve");
      return !button || button.disabled || document.querySelector(".month.approved");
    },
    undefined,
    { timeout: 15000 }
  );
  return { changed, approved: true };
}

function numericText(value) {
  return Number(value.replace(/[^0-9.-]/g, ""));
}

async function processExpense(page, target, dryRun) {
  await page.getByRole("link", { name: "Expenses", exact: true }).click();
  await page.waitForURL(/#\/trip-recording\/expenses/, { timeout: 20000 });
  await selectTargetMonth(page, target);
  await dismissPopups(page);

  const fuelTotal = numericText(await page.locator(".stats .fuel-expense .data").innerText());
  const gallonsTotal = numericText(await page.locator(".stats .fuel-gallons .data").innerText());
  if (fuelTotal === GAS_TOTAL && gallonsTotal === GAS_GALLONS) {
    log(`The ${target.key} gas expense is already present; skipping duplicate entry.`);
    return { added: false, alreadyPresent: true };
  }
  if (fuelTotal !== 0 || gallonsTotal !== 0) {
    throw new Error(
      `Unexpected existing fuel totals for ${target.key}: $${fuelTotal.toFixed(2)}, ${gallonsTotal} gallons. ` +
      "Stopped to avoid creating a duplicate."
    );
  }

  log(`${dryRun ? "Would add" : "Adding"} ${GAS_GALLONS} gallons from ${GAS_VENDOR} at $${GAS_PRICE_PER_GALLON.toFixed(2)}/gal ($${GAS_TOTAL.toFixed(2)} total).`);
  if (dryRun) return { added: false, alreadyPresent: false };

  await page.getByRole("button", { name: "ADD EXPENSE", exact: true }).click();
  await page.getByRole("heading", { name: "Add Expense", exact: true }).waitFor({ state: "visible", timeout: 10000 });
  const lastDay = daysInMonth(target.year, target.month);
  const activityValue = `${target.key}-${String(lastDay).padStart(2, "0")}T00:00`;
  await page.locator('input[name="datetime"][type="datetime-local"]').evaluate((input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, activityValue);
  await page.getByPlaceholder("Vendor", { exact: true }).fill(GAS_VENDOR);
  await page.getByPlaceholder("0.00", { exact: true }).fill(GAS_TOTAL.toFixed(2));
  await page.getByPlaceholder("0", { exact: true }).fill(String(GAS_GALLONS));
  const add = page.getByRole("button", { name: "Add to Expenses", exact: true });
  await add.waitFor({ state: "visible", timeout: 10000 });
  if (!(await add.isEnabled())) throw new Error("The gas expense form did not become valid.");
  await add.click();
  await page.getByRole("heading", { name: "Add Expense", exact: true }).waitFor({ state: "hidden", timeout: 15000 });
  await page.waitForFunction(
    ({ total, gallons }) => {
      const cost = document.querySelector(".stats .fuel-expense .data")?.textContent || "";
      const amount = document.querySelector(".stats .fuel-gallons .data")?.textContent || "";
      return Number(cost.replace(/[^0-9.-]/g, "")) === total && Number(amount.replace(/[^0-9.-]/g, "")) === gallons;
    },
    { total: GAS_TOTAL, gallons: GAS_GALLONS },
    { timeout: 15000 }
  );
  fs.writeFileSync(path.join(ARTIFACTS_DIR, "expense-after-add.html"), await page.content());
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, "expense-after-add.png"), fullPage: true });
  const submitExpenses = page.getByRole("button", { name: "Submit Expenses", exact: true });
  await submitExpenses.waitFor({ state: "visible", timeout: 10000 });
  log("Submitting the staged monthly expense.");
  await submitExpenses.click();
  const expenseConfirmCandidates = [
    page.getByRole("button", { name: "Yes, Submit", exact: true }),
    page.getByRole("button", { name: "Yes, Submit Expenses", exact: true }),
  ];
  const expenseConfirmDeadline = Date.now() + 2500;
  while (Date.now() < expenseConfirmDeadline) {
    if (await clickFirstVisible(expenseConfirmCandidates)) break;
    if (!(await visible(submitExpenses))) break;
    await page.waitForTimeout(100);
  }
  await page.waitForFunction(
    () => {
      const statuses = Array.from(document.querySelectorAll(".etable-cell.status"));
      return statuses.length > 0 && statuses.every((status) => !status.textContent.includes("Not Submitted"));
    },
    undefined,
    { timeout: 15000 }
  );
  return { added: true, alreadyPresent: false };
}

async function run() {
  loadEnv(ENV_FILE);
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: ./run-trip-recording.sh [--dry-run|--run|--scheduled] [--headed] [--keep-open] [--target-month YYYY-MM] [--test-notification]");
    return;
  }
  if (args.testNotification) {
    const result = await notify("ZeptoMail and macOS notification delivery test passed.", true, {
      month: "notification test",
      force: true,
    });
    if (!result.emailSent) throw new Error("The ZeptoMail test notification was not accepted.");
    return;
  }
  const today = zonedParts();
  if (args.scheduled && (today.day < 1 || today.day > 10)) {
    log("Scheduled run skipped because today is outside days 1-10.");
    return;
  }

  const target = parseMonthKey(args.targetMonth || previousMonthKey());
  const successes = readJson(SUCCESS_FILE, {});
  if (!args.dryRun && successes[target.key]) {
    const successMessage = `Success: ${target.key} trips and gas were recorded and approved.`;
    const fingerprint = notificationFingerprint(true, target.key, successMessage);
    if (!recentlyEmailed(fingerprint)) {
      await notify(successMessage, true, { month: target.key });
    }
    log(`${target.key} already completed successfully at ${successes[target.key].completedAt}; skipping.`);
    return;
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "msedge",
    headless: !args.headed,
    viewport: { width: 1440, height: 1000 },
  });
  const pages = context.pages();
  const page = pages[0] || (await context.newPage());

  try {
    await openTripRecording(page);
    await dismissPopups(page);
    await selectTargetMonth(page, target);
    const exceptions = exceptionDates(target.key);
    const expense = await processExpense(page, target, args.dryRun);
    await returnToVanpoolTrips(page, target);
    const trips = await processTrips(page, target, exceptions, args.dryRun);

    if (args.dryRun) {
      recordHistory({ month: target.key, status: "dry-run-success", expense, trips });
      log(`Dry run passed for ${target.key}; nothing was saved or approved.`);
      if (args.keepOpen) {
        log("Keeping the authenticated browser open for manual verification. Close the tab when finished.");
        await page.bringToFront();
        await page.waitForEvent("close", { timeout: 0 });
      }
      return;
    }

    const result = {
      completedAt: new Date().toISOString(),
      gas: { vendor: GAS_VENDOR, gallons: GAS_GALLONS, pricePerGallon: GAS_PRICE_PER_GALLON, total: GAS_TOTAL },
      exceptions: [...exceptions].sort(),
      expense,
      trips,
    };
    successes[target.key] = result;
    writeJson(SUCCESS_FILE, successes);
    recordHistory({ month: target.key, status: "success", ...result });
    log(`Successfully recorded gas, saved trips, and approved ${target.key}.`);
    await notify(`Success: ${target.key} trips and gas were recorded and approved.`, true, { month: target.key });
  } catch (error) {
    const screenshot = path.join(ARTIFACTS_DIR, `failure-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
    recordHistory({ month: target.key, status: "error", message: error.message, screenshot });
    await notify(`Failed for ${target.key}: ${error.message}`, false, { month: target.key, screenshot });
    error.notificationAttempted = true;
    throw error;
  } finally {
    await context.close();
  }
}

run().catch(async (error) => {
  if (!error.notificationAttempted) {
    await notify(`The commute automation failed before trip processing started: ${error.message}`, false, {
      month: previousMonthKey(),
    }).catch(() => {});
  }
  console.error(`[${new Date().toISOString()}] ${error.stack || error.message}`);
  process.exitCode = 1;
});
