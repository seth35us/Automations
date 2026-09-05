#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { shouldResolveManualChallenge, shouldRetryCaptchaChallenge, runCaptchaRetryBudget } = require("./manual-challenge-state");
const { scheduleFor, normalizeTimeValue } = require("./reservation-scheduling");
const { extractCaptchaSiteKey } = require("./captcha-solver");

let chromium;
let StealthPlugin;

try {
  ({ chromium } = require("playwright-extra"));
  StealthPlugin = require("puppeteer-extra-plugin-stealth");
} catch (error) {
  console.error("Missing Playwright automation dependencies. Install them with: npm install --omit=dev");
  console.error(error.message);
  process.exit(1);
}

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, ".env");
let BROWSER_CHANNEL = "msedge";
let BROWSER_MODE = "playwright";
let PROFILE_DIR = path.join(ROOT, ".edge-profile");
const ARTIFACTS_DIR = path.join(ROOT, "artifacts");
const RESERVATIONS_FILE = path.join(ROOT, "confirmed-reservations.json");
const NOTIFICATION_HISTORY_FILE = path.join(ROOT, "notification-history.json");
const BROWSER_MODE_FILE = path.join(ROOT, ".browser-mode");
const HYBRID_PROFILE_DIR = path.join(ROOT, ".hybrid-edge-profile");
const HYBRID_DEBUG_PORT = 9333;
const RESERVATION_URL =
  "https://anc.apm.activecommunities.com/chandleraz/reservation/landing/quick?groupId=20";
const TIME_ZONE = "America/Phoenix";
let EVENT_NAME = "Seth";
let COURTS = ["B", "A"];
let ACCEPT_RENTAL_WAIVER = true;
let RESERVATION_INITIALS = "s.s.";
let NOTIFICATION_TARGET_DATE = "unknown date";
const HUMAN_CHALLENGE_TIMEOUT_MS = 15 * 60 * 1000;
const CAPSOLVER_API_URL = "https://api.capsolver.com";
const CAPTCHA_RETRY_LIMIT = 3;

class DoNotRetryError extends Error { }
class ExistingReservationError extends Error { }
class SlotConflictError extends Error { }

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
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function solveCaptchaWithCapsolver(page) {
  const enabled = process.env.CAPSOLVER_ENABLED !== "false";
  const apiKey = process.env.CAPSOLVER_API_KEY;
  if (!enabled || !apiKey) return false;

  const selectors = [
    'iframe[title*="recaptcha challenge" i]',
    'iframe[title*="recaptcha" i]',
    'iframe[src*="google.com/recaptcha"]',
    'iframe[src*="recaptcha/api2"]',
    'iframe[src*="recaptcha/enterprise"]',
  ];
  const challengeFrame = page.locator(selectors.join(", "));
  if (!(await visible(challengeFrame))) return false;

  const details = await page.evaluate((selectorList) => {
    // 1. Traverse iframes to find Google ReCAPTCHA iframe source
    const frames = Array.from(document.querySelectorAll("iframe"));
    let src = "";
    for (const frame of frames) {
      const s = frame.getAttribute("src") || "";
      if (
        s.includes("google.com/recaptcha") ||
        s.includes("recaptcha/api2") ||
        s.includes("recaptcha/enterprise")
      ) {
        src = s;
        break;
      }
    }

    // 2. Select any containers containing data-sitekey
    let dataSiteKey = "";
    const container = document.querySelector("[data-sitekey]");
    if (container) {
      dataSiteKey = container.getAttribute("data-sitekey") || "";
    }

    const frame = document.querySelector(selectorList);
    const fallbackSrc = frame?.getAttribute("src") || "";
    const fallbackDataSiteKey = frame?.getAttribute("data-sitekey") || "";
    const siteKey = (window.__captchaSiteKey || "") || "";

    return {
      pageUrl: window.location.href,
      siteKey: siteKey || (src ? new URLSearchParams(src.split("?")[1] || "").get("k") || new URLSearchParams(src.split("?")[1] || "").get("sitekey") || "" : ""),
      frameSrc: src || fallbackSrc,
      dataSiteKey: dataSiteKey || fallbackDataSiteKey,
    };
  }, selectors[0]);

  const siteKey = extractCaptchaSiteKey({ frameSrc: details.frameSrc, dataSiteKey: details.dataSiteKey });
  if (!siteKey) {
    log("CapSolver skipped: no reCAPTCHA site key was detected in the visible frame or body.");
    return false;
  }

  const isEnterprise = details.frameSrc.toLowerCase().includes("/recaptcha/enterprise/") || page.url().toLowerCase().includes("enterprise");
  const taskType = isEnterprise ? "ReCaptchaV2EnterpriseTaskProxyLess" : "ReCaptchaV2TaskProxyLess";

  log(`Attempting CapSolver solve for ${isEnterprise ? 'reCAPTCHA Enterprise' : 'reCAPTCHA V2'} on ${details.pageUrl} with site key ${siteKey}`);
  try {
    const createTaskResponse = await fetch(`${CAPSOLVER_API_URL}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: taskType,
          websiteURL: details.pageUrl,
          websiteKey: siteKey,
        },
      }),
    });

    const createTask = await createTaskResponse.json();
    if (!createTaskResponse.ok || createTask.errorId !== 0 || !createTask.taskId) {
      throw new Error(createTask?.errorDescription || "CapSolver createTask failed.");
    }

    const taskId = createTask.taskId;
    // Poll for the result up to 45 attempts (up to 90 seconds total)
    for (let attempt = 0; attempt < 45; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));

      let taskResult;
      try {
        const taskResultResponse = await fetch(`${CAPSOLVER_API_URL}/getTaskResult`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientKey: apiKey, taskId }),
        });
        taskResult = await taskResultResponse.json();
      } catch (err) {
        log(`CapSolver status fetch error: ${err.message}. Retrying...`);
        continue;
      }

      if (taskResult.status === "ready" && taskResult.solution?.gRecaptchaResponse) {
        const token = taskResult.solution.gRecaptchaResponse;

        const callbackInvoked = await page.evaluate((captchaToken) => {
          // A. Fill standard reCAPTCHA answer form fields
          const targets = [
            document.querySelector("#g-recaptcha-response"),
            document.querySelector('[name="g-recaptcha-response"]'),
            ...Array.from(document.querySelectorAll('textarea[id^="g-recaptcha-response"]')),
            ...Array.from(document.querySelectorAll('input[name="g-recaptcha-response"]')),
          ];
          for (const target of targets) {
            if (!target) continue;
            target.value = captchaToken;
            target.dispatchEvent(new Event("input", { bubbles: true }));
            target.dispatchEvent(new Event("change", { bubbles: true }));
          }

          let ranCallback = false;
          try {
            // B. Traverse ___grecaptcha_cfg to trigger the internal form callback
            if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
              const clients = window.___grecaptcha_cfg.clients;
              for (const key of Object.keys(clients)) {
                const client = clients[key];

                const traverseAndRun = (obj, depth = 0) => {
                  if (!obj || depth > 10) return false;
                  for (const k of Object.keys(obj)) {
                    try {
                      if (typeof obj[k] === "function") {
                        if (k === "callback" || k === "promise-callback" || obj[k].name === "callback") {
                          obj[k](captchaToken);
                          ranCallback = true;
                          return true;
                        }
                      } else if (typeof obj[k] === "object") {
                        if (traverseAndRun(obj[k], depth + 1)) return true;
                      }
                    } catch (e) {
                      // ignore cross-origin property security blocks
                    }
                  }
                  return false;
                };
                if (traverseAndRun(client)) break;
              }
            }
          } catch (error) {
            console.error("Error executing grecaptcha callback:", error);
          }

          // C. Fallback for data-callback attributes
          if (!ranCallback) {
            const elements = document.querySelectorAll("[data-callback]");
            for (const el of elements) {
              const cbName = el.getAttribute("data-callback");
              if (cbName && typeof window[cbName] === "function") {
                try {
                  window[cbName](captchaToken);
                  ranCallback = true;
                } catch (e) {
                  console.error("Error executing data-callback:", e);
                }
              }
            }
          }

          return ranCallback;
        }, token);

        if (!callbackInvoked) {
          log("No dynamic reCAPTCHA callback found; falling back to direct submit trigger.");
          await page.evaluate(() => {
            const submitButton = document.querySelector('button[type="submit"], input[type="submit"], button[id*="signin" i], button[class*="signin" i]');
            if (submitButton) {
              submitButton.dispatchEvent(new Event("click", { bubbles: true }));
              submitButton.click();
            } else {
              const form = document.querySelector("form");
              if (form) form.submit();
            }
          });
        }

        await page.waitForTimeout(1500);
        return true;
      }

      if (taskResult.status === "failed" || taskResult.status === "error") {
        throw new Error(taskResult?.errorDescription || "CapSolver task failed.");
      }
    }
  } catch (error) {
    log(`CapSolver failed to solve reCAPTCHA: ${error.message}`);
  }

  return false;
}

function sendMacNotification(message, kind) {
  const escaped = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const sound = kind === "failure" ? "Basso" : "Glass";
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", `display notification "${escaped}" with title "Court reservation" sound name "${sound}"`],
      (error) => {
        if (error) log(`macOS notification failed: ${error.message}`);
        resolve(!error);
      }
    );
  });
}

function readNotificationHistory() {
  if (!fs.existsSync(NOTIFICATION_HISTORY_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(NOTIFICATION_HISTORY_FILE, "utf8"));
  } catch {
    throw new Error(`${NOTIFICATION_HISTORY_FILE} is not valid JSON.`);
  }
}

function recordNotification(entry) {
  const history = readNotificationHistory();
  history.push({ ...entry, recordedAt: new Date().toISOString() });
  fs.writeFileSync(NOTIFICATION_HISTORY_FILE, `${JSON.stringify(history.slice(-100), null, 2)}\n`, {
    mode: 0o600,
  });
}

function notificationFingerprint(kind, date, message) {
  return `${kind}:${date}:${message}`;
}

function recentlyEmailed(fingerprint) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return readNotificationHistory().some(
    (entry) => entry.fingerprint === fingerprint && entry.status === "sent" &&
      (fingerprint.startsWith("success:") || Date.parse(entry.recordedAt) >= cutoff)
  );
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
    from: (process.env.RACQUETBALL_NOTIFICATION_FROM || "").trim(),
    fromName: (process.env.RACQUETBALL_NOTIFICATION_FROM_NAME || "Racquetball Reservations").trim(),
    recipients: (process.env.RACQUETBALL_NOTIFICATION_EMAIL || "")
      .split(",")
      .map((email) => email.trim())
      .filter(Boolean),
  };
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

function notificationSubject(kind, date) {
  if (kind === "success") return `✅ Racquetball reserved — ${date}`;
  if (kind === "attention") return `⚠️ Racquetball reservation needs attention — ${date}`;
  return `🚨 Racquetball reservation failed — ${date}`;
}

async function notifyHuman(message, { kind = "attention", date = NOTIFICATION_TARGET_DATE, screenshot, force = false } = {}) {
  const fingerprint = notificationFingerprint(kind, date, message);
  const macPromise = sendMacNotification(message, kind);
  let emailSent = false;

  if (!force && recentlyEmailed(fingerprint)) {
    log(`Duplicate ${kind} email suppressed for ${date}.`);
  } else {
    const subject = notificationSubject(kind, date);
    const lines = [
      `Status: ${kind.toUpperCase()}`,
      `Reservation date: ${date}`,
      `Time: ${new Date().toLocaleString("en-US", { timeZone: TIME_ZONE })} (${TIME_ZONE})`,
      "",
      message,
    ];
    if (screenshot) lines.push("", `Failure screenshot: ${screenshot}`);
    try {
      await sendZeptoMail({ subject, textBody: lines.join("\n") });
      recordNotification({ fingerprint, date, status: "sent", kind, subject });
      log(`ZeptoMail ${kind} notification accepted for ${date}.`);
      emailSent = true;
    } catch (error) {
      recordNotification({ fingerprint, date, status: "error", kind, message: error.message });
      log(`ZeptoMail notification failed: ${error.message}`);
    }
  }

  const macSent = await macPromise;
  return { emailSent, macSent };
}

async function hybridEndpointReady() {
  try {
    const response = await fetch(`http://127.0.0.1:${HYBRID_DEBUG_PORT}/json/version`);
    return response.ok;
  } catch {
    return false;
  }
}

async function startHybridBrowser() {
  if (process.platform !== "darwin") {
    throw new Error("Hybrid browser mode currently requires macOS.");
  }

  if (!(await hybridEndpointReady())) {
    fs.mkdirSync(HYBRID_PROFILE_DIR, { recursive: true });
    const appName = BROWSER_CHANNEL === "chrome" ? "Google Chrome" : "Microsoft Edge";
    log(`Opening the normal ${appName} application in hybrid mode.`);
    execFile(
      "/usr/bin/open",
      [
        "-na",
        appName,
        "--args",
        `--remote-debugging-port=${HYBRID_DEBUG_PORT}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${HYBRID_PROFILE_DIR}`,
        "--no-first-run",
      ],
      () => { }
    );

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !(await hybridEndpointReady())) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  if (!(await hybridEndpointReady())) {
    throw new Error("The hybrid browser did not open its local connection within 20 seconds.");
  }

  const browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${HYBRID_DEBUG_PORT}`,
    {
      // Edge 150 rejects Playwright's default download/context overrides when
      // attaching to an existing browser. They are unnecessary for bookings.
      noDefaults: true,
    }
  );
  const contexts = browser.contexts();
  const context = contexts[0];
  if (!context) throw new Error("The hybrid browser did not provide a browser context.");
  const pages = context.pages();
  const page = pages[0] || (await context.newPage());

  return {
    context,
    page,
    cleanup: () => browser.close(),
  };
}

async function startAutomationBrowser(args) {
  if (BROWSER_MODE === "hybrid") return startHybridBrowser();

  chromium.use(StealthPlugin());

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: BROWSER_CHANNEL,
    headless: !args.headed,
    viewport: { width: 1440, height: 1000 },
  });
  const pages = context.pages();
  const page = pages[0] || (await context.newPage());
  return {
    context,
    page,
    cleanup: () => context.close(),
  };
}

function confirmedReservations() {
  if (!fs.existsSync(RESERVATIONS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(RESERVATIONS_FILE, "utf8"));
  } catch {
    throw new Error(`${RESERVATIONS_FILE} is not valid JSON.`);
  }
}

function recordConfirmation(date, description, receipt) {
  const reservations = confirmedReservations();
  reservations[date] = {
    description,
    receipt,
    confirmedAt: new Date().toISOString(),
  };
  fs.writeFileSync(RESERVATIONS_FILE, `${JSON.stringify(reservations, null, 2)}\n`, {
    mode: 0o600,
  });
}

function parseArgs(argv) {
  const result = {
    dryRun: false,
    date: null,
    headed: false,
    scheduled: false,
    testNotification: false,
    time: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--headed") result.headed = true;
    else if (arg === "--scheduled") result.scheduled = true;
    else if (arg === "--date") result.date = argv[++index];
    else if (arg === "--time") result.time = argv[++index];
    else if (arg === "--test-notification") result.testNotification = true;
    else if (arg === "--help") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function zonedDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function addDays(dateString, days) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")].join("-");
}

function todayInArizona() {
  const { year, month, day } = zonedDateParts();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateInfo(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return {
    weekday: date.getUTCDay(),
    pickerLabel: new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date),
  };
}

function minutesFrom12Hour(value) {
  const match = /^(\d{1,2}):(\d{2}) (AM|PM)$/.exec(value);
  if (!match) throw new Error(`Invalid time: ${value}`);
  let hour = Number(match[1]) % 12;
  if (match[3] === "PM") hour += 12;
  return hour * 60 + Number(match[2]);
}

function format12Hour(totalMinutes) {
  const hour24 = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

async function visible(locator) {
  return (await locator.count()) > 0 && (await locator.first().isVisible());
}

async function waitForVisibleChoice(choices, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const [name, locator] of choices) {
      if (await visible(locator)) return name;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function waitForManualSignIn(page) {
  const message =
    "reCAPTCHA needs you. Open the visible reservation browser and complete sign-in within 15 minutes.";
  log(message);
  await notifyHuman(message, { kind: "attention" });
  await page.bringToFront();

  const deadline = Date.now() + HUMAN_CHALLENGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [url, emailFieldVisible, challengeVisible, quickReservationVisible, signInButtonVisible] = await Promise.all([
      page.url(),
      visible(page.getByRole("textbox", { name: /Email address Required/i })),
      visible(page.locator('iframe[title*="recaptcha challenge" i]')),
      visible(page.getByRole("heading", { name: "Quick reservation", exact: true })),
      visible(page.getByRole("button", { name: "Sign in", exact: true })),
    ]);

    if (shouldResolveManualChallenge({
      url,
      emailFieldVisible,
      challengeVisible,
      quickReservationVisible,
      signInButtonVisible,
    })) {
      await page.waitForLoadState("domcontentloaded").catch(() => { });
      return;
    }

    if (challengeVisible) {
      const captchaBudget = await runCaptchaRetryBudget({
        maxAttempts: CAPTCHA_RETRY_LIMIT,
        attemptFn: async () => {
          const solvedByCapsolver = await solveCaptchaWithCapsolver(page);
          if (solvedByCapsolver) {
            await page.waitForTimeout(1500);
            return true;
          }
          return false;
        },
      });
      if (captchaBudget.resolved) {
        continue;
      }
    }

    await delay(1000);
  }

  throw new Error("The manual reCAPTCHA challenge was not resolved within 15 minutes.");
}

async function signInIfNeeded(page, allowManualChallenge) {
  let emailField = page.getByRole("textbox", { name: /Email address Required/i });
  if (!(await visible(emailField))) {
    const signInNow = page.getByRole("link", { name: "Sign in now", exact: true });
    if (!(await visible(signInNow))) return;
    // Chandler continuously re-renders the JavaScript-only banner link, which
    // can prevent a real click from completing. Use Chandler's official sign-in
    // route directly and preserve the same quick-reservation return URL.
    const returnUrl = `${RESERVATION_URL}&fromLoginPage=true&from_original_cui=true`;
    const returnParams = encodeURIComponent(Buffer.from(returnUrl).toString("base64"));
    const signInUrl =
      "https://anc.apm.activecommunities.com/chandleraz/signin" +
      "?onlineSiteId=0&from_original_cui=true&override_partial_error=False" +
      `&custom_amount=False&params=${returnParams}`;
    await page.goto(signInUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    emailField = page.getByRole("textbox", { name: /Email address Required/i });
    await emailField.waitFor({ timeout: 15000 });
  }

  const email = process.env.ACTIVE_COMMUNITIES_EMAIL;
  const password = process.env.ACTIVE_COMMUNITIES_PASSWORD;
  if (!email || !password) throw new Error("Missing ACTIVE_COMMUNITIES_EMAIL or ACTIVE_COMMUNITIES_PASSWORD in .env");

  log("Chandler Online session expired; signing in again.");
  await emailField.fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page
    .getByRole("button", { name: "Sign in", exact: true })
    .click({ force: true });

  const challenge = page.locator('iframe[title*="recaptcha challenge" i]');
  const signInDeadline = Date.now() + 15000;
  while (Date.now() < signInDeadline) {
    if (await visible(challenge)) break;
    if (!page.url().toLowerCase().includes("/signin") && !(await visible(emailField))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (await visible(challenge)) {
    const solvedByCapsolver = await solveCaptchaWithCapsolver(page);
    if (solvedByCapsolver) {
      await page.waitForTimeout(1500);
      await page.getByRole("button", { name: "Sign in", exact: true }).click({ force: true });
      const challengeResolvedDeadline = Date.now() + 15000;
      while (Date.now() < challengeResolvedDeadline) {
        if (!page.url().toLowerCase().includes("/signin") && !(await visible(emailField))) {
          return;
        }
        if (!(await visible(challenge))) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return;
    }
    if (!allowManualChallenge) {
      throw new Error(
        "A reCAPTCHA challenge requires manual sign-in. Run ./run-reservation.sh --headed and sign in."
      );
    }
    await waitForManualSignIn(page);
    return;
  }
  if (await visible(emailField)) {
    if (allowManualChallenge) {
      await waitForManualSignIn(page);
      return;
    }
    throw new Error("Chandler Online sign-in failed. Check the credentials in .env.");
  }
}

async function selectDate(page, dateString) {
  const { pickerLabel } = dateInfo(dateString);
  const [targetYear, targetMonth] = dateString.split("-").map(Number);
  const targetMonthIndex = targetYear * 12 + targetMonth - 1;
  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  await page.getByRole("combobox", { name: "Date picker, current date", exact: true }).click();
  const calendar = page.locator('[data-qa-id="popupCalendar"]');
  await calendar.waitFor({ state: "visible", timeout: 5000 });
  const dateCell = calendar.locator(`[role="region"][aria-label="${pickerLabel}"]`);

  for (let navigationCount = 0; navigationCount < 24; navigationCount += 1) {
    if ((await dateCell.count()) === 1) break;

    const header = (await calendar.locator(".an-calendar-header-title").innerText()).trim();
    const match = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})$/.exec(header);
    if (!match) throw new Error(`Could not read the date picker's current month (${header}).`);

    const visibleMonthIndex = Number(match[2]) * 12 + monthNames.indexOf(match[1]);
    const direction = visibleMonthIndex < targetMonthIndex ? "next" : "previous";
    const monthButton = calendar.getByRole("button", {
      name:
        direction === "next"
          ? "Switch calendar to next month right arrow"
          : "Switch calendar to previous month left arrow",
      exact: true,
    });
    await monthButton.click();
    await calendar
      .locator(".an-calendar-header-title")
      .filter({ hasNotText: header })
      .waitFor({ state: "visible", timeout: 5000 });
  }

  if ((await dateCell.count()) !== 1) {
    throw new Error(`Could not find ${pickerLabel} after navigating the date picker.`);
  }
  if ((await dateCell.getAttribute("class"))?.includes("cursor-disabled")) {
    throw new Error(`${pickerLabel} is disabled in the date picker.`);
  }
  await dateCell.click();
  await page
    .waitForFunction(
      () => {
        const possibleOverlays = document.querySelectorAll(
          '[class*="loading" i], [class*="spinner" i], [class*="spin" i], [aria-busy="true"]'
        );
        return !Array.from(possibleOverlays).some((element) => {
          const style = window.getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || 1) !== 0 &&
            bounds.width > 20 &&
            bounds.height > 20
          );
        });
      },
      undefined,
      { timeout: 15000 }
    );
  await page
    .locator('[role="gridcell"][aria-label*="TRC Racquetball Court"]')
    .first()
    .waitFor({ timeout: 15000 });
}

async function slotAvailable(page, court, start) {
  const startMinutes = minutesFrom12Hour(start);
  const middle = format12Hour(startMinutes + 30);
  const end = format12Hour(startMinutes + 60);
  const resource = `TRC Racquetball Court ${court}`;
  const firstName = `${resource} ${start} - ${middle} Available`;
  const secondName = `${resource} ${middle} - ${end} Available`;
  const first = page.getByRole("gridcell", { name: firstName, exact: true });
  const second = page.getByRole("gridcell", { name: secondName, exact: true });
  return {
    available: (await first.count()) === 1 && (await second.count()) === 1,
    first,
    second,
    description: `${resource}, ${start}–${end}`,
  };
}

async function chooseReservation(page, times, rejected = new Set()) {
  for (const start of times) {
    for (const court of COURTS) {
      const candidate = await slotAvailable(page, court, start);
      if (!candidate.available || rejected.has(candidate.description)) continue;
      await candidate.first.click();
      await candidate.second.click();
      return candidate;
    }
  }
  return null;
}

async function waitForConfirmation(page, allowManualChallenge) {
  const serviceError = page.getByText(/reCAPTCHA verification failed, please re-login/i);
  const challenge = page.locator('iframe[title*="recaptcha challenge" i]');
  const automaticDeadline = Date.now() + 20000;

  while (Date.now() < automaticDeadline) {
    if (page.url().includes("/quickreservation/checkout/confirmation")) return;
    const serviceErrorVisible = await visible(serviceError);
    const challengeVisible = serviceErrorVisible || (await visible(challenge));
    if (challengeVisible) {
      const captchaBudget = await runCaptchaRetryBudget({
        maxAttempts: CAPTCHA_RETRY_LIMIT,
        attemptFn: async () => {
          const solvedByCapsolver = await solveCaptchaWithCapsolver(page);
          if (solvedByCapsolver) {
            await page.waitForTimeout(1500);
            return true;
          }
          return false;
        },
      });
      if (captchaBudget.resolved) {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (allowManualChallenge) {
    const message =
      "Reservation needs your attention. The visible browser will remain open for 15 minutes; re-login or finish the booking there.";
    log(message);
    await notifyHuman(message, { kind: "attention" });
    await page.bringToFront();
    await page.waitForURL(/\/quickreservation\/checkout\/confirmation/, {
      timeout: HUMAN_CHALLENGE_TIMEOUT_MS,
    });
    return;
  }

  throw new Error("Timed out waiting for Chandler Online to complete the reservation.");
}

async function finishReservation(page, allowManualChallenge) {
  const confirm = page.getByRole("button", { name: /Confirm bookings/i });
  if (!(await visible(confirm))) throw new Error("The Confirm bookings button did not appear.");
  await confirm.click();

  const waiverHeading = page.getByRole("heading", { name: "Waiver and information", exact: true });
  const zeroCostReserve = page.getByRole("button", { name: /Total \$0\.00 Reserve/i });
  const dailyReservationLimit = page.getByText(
    /At most 1 facility in this type can be reserved per day for each customer/i
  );
  const slotConflict = page.getByText(/resource is unavailable at this time/i);
  const confirmOutcome = await waitForVisibleChoice([
    ["waiver", waiverHeading],
    ["reserve", zeroCostReserve],
    ["existing", dailyReservationLimit],
    ["conflict", slotConflict],
  ]);
  if (confirmOutcome === "conflict") {
    throw new SlotConflictError("Chandler Online reports that the selected court became unavailable.");
  }
  if (confirmOutcome === "existing") {
    throw new ExistingReservationError(
      "Chandler Online reports that this account already has a racquetball reservation for the target date."
    );
  }
  if (!confirmOutcome) {
    throw new Error("Chandler Online did not display the waiver, Reserve button, or a reservation-limit message.");
  }

  if (await visible(waiverHeading)) {
    if (!ACCEPT_RENTAL_WAIVER || !RESERVATION_INITIALS) {
      throw new Error(
        "The required Rec Facility Rental Waiver is not configured for automatic acceptance."
      );
    }

    const waiverCheckbox = page.getByRole("checkbox", {
      name: "I have read and agree to Rec Facility Rental Waiver",
      exact: true,
    });
    await waiverCheckbox.check();
    await page
      .getByRole("textbox", { name: "Please enter your initials", exact: true })
      .fill(RESERVATION_INITIALS);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const waiverOutcome = await waitForVisibleChoice([
      ["reserve", zeroCostReserve],
      ["existing", dailyReservationLimit],
      ["conflict", slotConflict],
    ]);
    if (waiverOutcome === "conflict") {
      throw new SlotConflictError("Chandler Online reports that the selected court became unavailable.");
    }
    if (waiverOutcome === "existing") {
      throw new ExistingReservationError(
        "Chandler Online reports that this account already has a racquetball reservation for the target date."
      );
    }
    if (waiverOutcome !== "reserve") {
      throw new Error("The Reserve button did not appear after saving the waiver.");
    }
  }

  if (await visible(zeroCostReserve)) {
    await zeroCostReserve.click();

    const reservationWaiver = page.getByRole("heading", {
      name: "Reservation waiver",
      exact: true,
    });
    const serviceError = page.getByText(/reCAPTCHA verification failed, please re-login/i);
    const reserveOutcome = await waitForVisibleChoice(
      [
        ["waiver", reservationWaiver],
        ["service-error", serviceError],
      ],
      5000
    );
    if (reserveOutcome === "waiver") {
      await page.getByRole("button", { name: "OK", exact: true }).click();
    }
    await waitForConfirmation(page, allowManualChallenge);
  }

  if (await visible(dailyReservationLimit)) {
    throw new ExistingReservationError(
      "Chandler Online reports that this account already has a racquetball reservation for the target date."
    );
  }

  // ACTIVE Communities may either finalize here or present a cart/review step.
  const addToCart = page.getByRole("button", { name: /Add to cart/i });
  if (await visible(addToCart)) {
    await addToCart.click();
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => { });
  }

  const checkout = page.getByRole("button", { name: /^(Checkout|Proceed to checkout)$/i });
  if (await visible(checkout)) {
    await checkout.click();
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => { });
  }

  const payButton = page.getByRole("button", { name: /^(Pay|Submit order|Complete purchase|Place order)$/i });
  if (await visible(payButton)) {
    if (process.env.ALLOW_PAID_CHECKOUT !== "true") {
      throw new Error("A paid checkout requires ALLOW_PAID_CHECKOUT=true in .env; the reservation remains in the cart.");
    }
    await payButton.click();
    await page.waitForURL(/\/quickreservation\/checkout\/confirmation/, { timeout: 30000 });
  }

  const receiptHeading = page.getByRole("heading", {
    name: /Your receipt #.* has been completed!/i,
  });
  if (page.url().includes("/quickreservation/checkout/confirmation")) {
    await receiptHeading.waitFor({ state: "visible", timeout: 30000 }).catch(() => { });
  }
  if (!page.url().includes("/quickreservation/checkout/confirmation") || !(await visible(receiptHeading))) {
    throw new Error("Chandler Online did not display a completed receipt. The booking was not completed.");
  }
  return receiptHeading.innerText();
}

async function main() {
  loadEnv(ENV_FILE);
  EVENT_NAME = process.env.RESERVATION_NAME || EVENT_NAME;
  RESERVATION_INITIALS = process.env.RESERVATION_INITIALS || RESERVATION_INITIALS;
  BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || BROWSER_CHANNEL;
  BROWSER_MODE = process.env.BROWSER_MODE || BROWSER_MODE;
  if (fs.existsSync(BROWSER_MODE_FILE)) {
    BROWSER_MODE = fs.readFileSync(BROWSER_MODE_FILE, "utf8").trim() || BROWSER_MODE;
  }
  if (process.env.COURT_ORDER) {
    const configuredCourts = process.env.COURT_ORDER
      .split(",")
      .map((court) => court.trim().toUpperCase())
      .filter((court, index, courts) =>
        ["A", "B"].includes(court) && courts.indexOf(court) === index
      );
    if (configuredCourts.length === 2) COURTS = configuredCourts;
  }
  PROFILE_DIR = path.join(
    ROOT,
    BROWSER_CHANNEL === "chrome" ? ".chrome-profile" : ".edge-profile"
  );
  if ("ACCEPT_RENTAL_WAIVER" in process.env) {
    ACCEPT_RENTAL_WAIVER = process.env.ACCEPT_RENTAL_WAIVER === "true";
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: ./run-reservation.sh [--dry-run] [--headed] [--scheduled] [--date YYYY-MM-DD] [--time HH:MM AM/PM] [--test-notification]"
    );
    return;
  }
  if (args.testNotification) {
    const result = await notifyHuman("ZeptoMail and macOS notification delivery test passed.", {
      kind: "success",
      date: "notification test",
      force: true,
    });
    if (!result.emailSent) throw new Error("The ZeptoMail test notification was not accepted.");
    return;
  }

  const targetDate = args.date || addDays(todayInArizona(), 2);
  NOTIFICATION_TARGET_DATE = targetDate;
  const requestedTime = normalizeTimeValue(args.time);
  const times = scheduleFor(targetDate, requestedTime);
  if (!times) {
    log(`${targetDate} is not Sunday, Tuesday, Thursday, or Friday; nothing to reserve.`);
    return;
  }

  const priorConfirmation = confirmedReservations()[targetDate];
  if (priorConfirmation && !args.dryRun) {
    const message = `Reservation confirmed for ${priorConfirmation.description}. ${priorConfirmation.receipt}`;
    const fingerprint = notificationFingerprint("success", targetDate, message);
    if (!recentlyEmailed(fingerprint)) await notifyHuman(message, { kind: "success", date: targetDate });
    log(`${targetDate} is already recorded as confirmed: ${priorConfirmation.description}; ${priorConfirmation.receipt}`);
    return;
  }

  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  log(
    `Looking for a one-hour reservation on ${targetDate}; times: ${times.join(", ")}; courts: ${COURTS.join(" then ")}.`
  );

  const { context, page, cleanup } = await startAutomationBrowser(args);

  let submissionStarted = false;
  try {
    await page.goto(RESERVATION_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await signInIfNeeded(page, args.headed);
    if (!page.url().includes("/reservation/landing/quick")) {
      await page.goto(RESERVATION_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    }
    await page.getByRole("heading", { name: "Quick reservation", exact: true }).waitFor({ timeout: 20000 });
    await selectDate(page, targetDate);
    await page.getByRole("textbox", { name: "Event name", exact: true }).fill(EVENT_NAME);

    const rejected = new Set();
    while (true) {
      const chosen = await chooseReservation(page, times, rejected);
      if (!chosen) {
        throw new DoNotRetryError(
          "No complete one-hour slot was available for any configured court/time fallback."
        );
      }
      log(`Selected ${chosen.description}.`);

      if (args.dryRun) {
        log("Dry run complete; no reservation was submitted.");
        return;
      }

      submissionStarted = true;
      try {
        const receipt = await finishReservation(page, args.headed);
        recordConfirmation(targetDate, chosen.description, receipt);
        log(`Reservation confirmed for ${chosen.description}. ${receipt}`);
        await notifyHuman(`Reservation confirmed for ${chosen.description}. ${receipt}`, {
          kind: "success",
          date: targetDate,
        });
        break;
      } catch (error) {
        if (!(error instanceof SlotConflictError)) throw error;
        rejected.add(chosen.description);
        submissionStarted = false;
        log(`${chosen.description} became unavailable; continuing to the next configured fallback.`);
        await page.goto(RESERVATION_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.getByRole("heading", { name: "Quick reservation", exact: true }).waitFor({ timeout: 20000 });
        await selectDate(page, targetDate);
        await page.getByRole("textbox", { name: "Event name", exact: true }).fill(EVENT_NAME);
      }
    }
  } catch (error) {
    if (error instanceof ExistingReservationError) {
      const description = "Existing Chandler racquetball reservation (court and time not returned)";
      const receipt = "Confirmed by Chandler's one-facility-per-day reservation limit";
      recordConfirmation(targetDate, description, receipt);
      log(`${error.message} Recorded locally to prevent a duplicate attempt.`);
      await notifyHuman(`Reservation confirmed: ${description}. ${receipt}`, {
        kind: "success",
        date: targetDate,
      });
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const screenshot = path.join(ARTIFACTS_DIR, `failure-${stamp}.png`);
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => { });
    log(`ERROR: ${error.message}`);
    log(`Failure screenshot: ${screenshot}`);
    if (submissionStarted) {
      log(
        "Submission began, so automatic retries are disabled to avoid a duplicate. Check Chandler Online before trying again."
      );
      process.exitCode = 2;
    } else if (error instanceof DoNotRetryError) {
      process.exitCode = 2;
    } else {
      process.exitCode = 1;
    }
    const attempt = Number(process.env.RESERVATION_ATTEMPT || 0);
    const maxAttempts = Number(process.env.RESERVATION_MAX_ATTEMPTS || 0);
    if (process.exitCode === 2 || !maxAttempts || attempt >= maxAttempts) {
      await notifyHuman(`Racquetball reservation failed: ${error.message}`, {
        kind: "failure",
        date: targetDate,
        screenshot,
      });
      error.notificationAttempted = true;
    }
  } finally {
    await cleanup();
  }
}

main().catch(async (error) => {
  const attempt = Number(process.env.RESERVATION_ATTEMPT || 0);
  const maxAttempts = Number(process.env.RESERVATION_MAX_ATTEMPTS || 0);
  if (!error.notificationAttempted && (!maxAttempts || attempt >= maxAttempts)) {
    await notifyHuman(`Racquetball automation failed before reservation processing started: ${error.message}`, {
      kind: "failure",
      date: NOTIFICATION_TARGET_DATE,
    }).catch(() => { });
  }
  log(`FATAL: ${error.message}`);
  process.exitCode = 1;
});
