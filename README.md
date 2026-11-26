# OSS Repo Monitor Template

Get Discord notifications for newly opened issues and pull requests on a schedule you choose. The default repositories are:

- bitcoin/bitcoin
- rust-bitcoin/rust-bitcoin
- bitcoin-core/secp256k1

All checks run in one `ubuntu-slim` job. To choose your repositories, edit the `REPOS` list in `.github/workflows/monitor.yml`. Use one line per repository.

## Setup

1. Create a repository from this template, or copy the files into your own repository. Keep the workflow at `.github/workflows/monitor.yml`.
2. Create a Discord channel webhook.
3. Go to **Settings → Secrets and variables → Actions → Secrets** and add the webhook URL as `DISCORD_WEBHOOK_URL`.
4. Under **Variables**, add `MONITOR_ENABLED` and set it to `true`.
5. Go to **Actions → Monitor OSS Repositories → Run workflow** to check that notifications arrive. The default schedule runs hourly.

## Change the schedule

The default cron, `0 * * * *`, runs hourly and checks the previous hour. If you change the schedule, update `INPUT_FETCH_DATA_INTERVAL` too. That value is in hours. GitHub can delay scheduled runs.
