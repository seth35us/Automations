# Chandler racquetball reservation setup for Mac

This bundle schedules the same one-hour Chandler racquetball preferences:

- Sunday at 4:00 PM
- Tuesday and Thursday at 5:30 PM, then 5:00 PM, then 4:30 PM
- Friday at 5:30 PM
- Installer-selectable court order: Court B then A, or Court A then B
- Booking starts at 5:00 AM two days before the reservation

## Setup

1. Extract the ZIP into a permanent folder. Do not move it after setup.
2. Double-click `Install.command`.
3. Follow the prompts. The installer can install Homebrew, Node.js, Playwright, and the selected Edge or Chrome browser when they are missing.

If macOS blocks the installer because it was downloaded, right-click `Install.command` and choose **Open**. As a fallback, open Terminal in this folder and run `./Install.command`.

The setup prompts for Microsoft Edge or Google Chrome and the preferred court order, then privately requests Chandler credentials, reservation name, waiver initials, and waiver consent. Safari is not supported. It creates a permission-restricted `.env`, installs Playwright locally, and registers a 5:00 AM LaunchAgent. It can optionally add a daily 4:58 AM Mac wake event.

The credentials, browser profile, logs, screenshots, and reservation history are excluded from the shared ZIP.

If reCAPTCHA intervenes, the automation can optionally try a CapSolver solve when CAPSOLVER_API_KEY is present in .env. If the solve fails or is not configured, it falls back to the existing manual-browser flow.

After installation, keep the Mac plugged in and logged into the same macOS user account.
