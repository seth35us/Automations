# Commute with Enterprise trip recording

Monthly automation for:

https://members.commutewithenterprise.com/#/

## Monthly behavior

- Dynamically targets the previous calendar month in `America/Phoenix`.
- Marks every editable Monday and Thursday as a round trip.
- Marks other editable days as Did Not Commute.
- Applies dates listed in `exceptions.json` as Did Not Commute.
- Records one fuel transaction on the prior month's final day: Fry's, 10 gallons,
  $3.65 per gallon, $36.50 total.
- Submits expenses, saves trips, and approves the month.
- Records successes in `successful-runs.json` and all attempts in
  `run-history.json`.
- Sends a persistent ZeptoMail email and a macOS notification on success or failure.

The LaunchAgent runs at 8:00 AM on days 1 through 10. After a successful month,
later attempts are skipped. If the Mac is off, a later scheduled day provides
another attempt before the deadline.

## Exceptions

Add missed commute dates before the monthly run:

```json
{
  "2026-08": ["2026-08-10", "2026-08-13"]
}
```

Only dates in the target month are used. An exception overrides the normal
Monday/Thursday round trip and records Did Not Commute.

## Save credentials locally

Run:

```sh
./setup-credentials.sh
```

The password prompt is hidden. The script writes `.env` with owner-only file
permissions. `.env` is excluded by `.gitignore`; do not paste its contents into
chat or commit it to source control.

## Manual commands

Read-only validation of the previous month:

```sh
./run-trip-recording.sh --dry-run --headed
```

Keep the authenticated browser open afterward for manual verification:

```sh
./run-trip-recording.sh --dry-run --keep-open
```

Live run for the previous month:

```sh
./run-trip-recording.sh --run --headed
```

Use `--target-month YYYY-MM` only for troubleshooting a specific prior month.

Scheduled output is written to `trip-recording.log` and
`trip-recording-error.log`. Failure screenshots are saved in `artifacts/`.
ZeptoMail delivery attempts are recorded in `notification-history.json`.

Test both notification channels without changing trip data:

```sh
./run-trip-recording.sh --test-notification
```
