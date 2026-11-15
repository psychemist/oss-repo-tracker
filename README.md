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

If you already have a monitor workflow, replace it at the same path to avoid duplicate runs. Set `MONITOR_ENABLED` even if your previous workflow did not need it.

GitHub provides `github.token` automatically, so you don't need a personal access token. The first run and manual runs can send notifications for items opened in the previous hour.

## How it works

The workflow downloads [Repo Activity Monitor](https://github.com/shubhaamgupta11/repo-monitor) at commit `3d98f52e802544401b991bb7f6484b604675a1a9` (v1.0.4). It includes the dependencies it needs, so there's nothing to install. A loop runs the same upstream code with Node for each repository, without repeating the `uses:` steps.

Each repository runs both `monitor-issues` and `monitor-prs`. If a check reports a failure, the remaining checks still run and the job is marked as failed. Logs are grouped by repository and task.

The monitor doesn't remember which notifications it has sent. Overlapping checks or manual reruns can send duplicates, and delayed runs can miss items. Issues closed and PRs closed or merged before a check are missed. Dependabot PRs are skipped. Some API errors appear in the logs without failing the job.

## Cost

GitHub Free includes $12 of shared compute usage per billing cycle. GitHub Pro includes $18. For a private repository, `ubuntu-slim` uses $0.002 per billed minute. Each job is rounded up to the next whole minute.

Running hourly for 30 days:

| Billed time per job | Jobs | Compute usage |
| --- | --- | --- |
| 1 minute | 720 | $1.44 |
| 2 minutes | 720 | $2.88 |

## Change the schedule

The default cron, `0 * * * *`, runs hourly and checks the previous hour. If you change the schedule, update `INPUT_FETCH_DATA_INTERVAL` too. That value is in hours. GitHub can delay scheduled runs.
