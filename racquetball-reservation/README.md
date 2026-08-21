# Chandler racquetball reservation automation

The local installation runs in hybrid Microsoft Edge mode. macOS opens the normal Edge application with a dedicated profile stored in `.hybrid-edge-profile/`, and Playwright attaches over a localhost-only connection. This keeps the reservation session separate from your personal Edge profile while leaving the visible browser open for human verification and receipt review.

Runs every day at 5:00 AM in `America/Phoenix`, waits five seconds for the inventory window to open, and looks two days ahead. Chandler does not permit these reservations to be finalized before 5:00 AM on the opening day. It only acts when the target date is:

The Mac is configured with a repeating macOS power event to wake at 4:58 AM every day so the LaunchAgent can start on time.

- Sunday: 4:00–5:00 PM
- Tuesday: 5:30–6:30 PM, then 5:00–6:00 PM, then 4:30–5:30 PM
- Thursday: 5:30–6:30 PM, then 5:00–6:00 PM, then 4:30–5:30 PM
- Friday: 5:30–6:30 PM

For each time it tries Court B first, then Court A. The event name is `Seth`. A candidate is used only when both consecutive 30-minute blocks are available.

## Commands

Dry-run a particular date without submitting:

```sh
./run-reservation.sh --dry-run --date 2026-07-19
```

Open a visible browser for manual sign-in or troubleshooting:

```sh
./run-reservation.sh --headed --dry-run --date 2026-07-19
```

Run the normal two-days-ahead reservation immediately:

```sh
./run-reservation.sh
```

The scheduled job writes to `racquetball.log` and `racquetball-error.log`. Failure screenshots are saved under `artifacts/`.

For a temporary browser, network, or sign-in failure before submission, the job retries after 10, 30, and 60 seconds. It does not retry when no configured slot is available or after the Reserve flow has started, because a retry at that point could create a duplicate. A final failure generates a macOS notification.

Browser transitions use page-state waits rather than arbitrary sleeps: completed sign-in, vanished loading overlays, refreshed court cells, waiver or limit responses, enabled checkout controls, reCAPTCHA errors, and completed receipt headings. The only deliberate timing delays are the five-second inventory-opening grace period and bounded pre-submission retry backoff.

Scheduled booking runs use a visible browser. If reCAPTCHA appears during sign-in or final submission, the automation sends a macOS notification with sound and leaves the browser open for up to 15 minutes. Complete the challenge in that same browser. For a final-submission reCAPTCHA error, re-login and finish the reservation in the visible browser; the automation detects the completed receipt and records it. Headed runs also use the full 15-minute wait whenever submission remains unresolved, so a changed or dismissed error modal cannot cause the browser to close after the normal 20-second checkout timeout.

Successful receipts are recorded in `confirmed-reservations.json`. A later run for the same date exits without submitting another reservation.

If Chandler reports that the account has reached its one-facility-per-day limit for racquetball, the automation treats that as an existing reservation and records the date locally instead of retrying or reporting a checkout failure.

If checkout requests payment, the script leaves the reservation in the cart unless this is added to `.env`:

```dotenv
ALLOW_PAID_CHECKOUT=true
```

If you want the automation to attempt reCAPTCHA solving automatically, add your CapSolver key to `.env`:

```dotenv
CAPSOLVER_API_KEY=your-key-here
CAPSOLVER_ENABLED=true
```

If CapSolver is not configured or the solve fails, the script falls back to the existing manual-browser flow.

The City of Chandler also requires acceptance of its Rec Facility Rental Waiver and initials. With the applicant's authorization, the automation accepts it automatically using:

```text
s.s.
```
