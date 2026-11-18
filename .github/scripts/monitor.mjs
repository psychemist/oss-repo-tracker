import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE_BRANCH = 'monitor-state';
const STATE_FILE = 'state.json';
const DAY = 24 * 60 * 60 * 1000;

const lagosDate = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos', day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function ageAtDelivery(created, alerted) {
  const minutes = Math.floor(Math.max(0, alerted.getTime() - created.getTime()) / 60_000);
  if (minutes === 0) return 'less than a minute';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes / 60) % 24;
  const unit = (n, name) => `${n} ${name}${n === 1 ? '' : 's'}`;
  if (days) return [unit(days, 'day'), hours ? unit(hours, 'hour') : ''].filter(Boolean).join(' ');
  if (hours) return [unit(hours, 'hour'), minutes % 60 ? unit(minutes % 60, 'minute') : ''].filter(Boolean).join(' ');
  return unit(minutes, 'minute');
}

export function buildDiscordPayload(item, repo, alertedAt) {
  const isPR = Boolean(item.pull_request);
  const type = isPR ? 'PR' : 'Issue';
  const created = new Date(item.created_at);
  const alerted = new Date(alertedAt);
  if (!Number.isFinite(created.getTime()) || !Number.isFinite(alerted.getTime())) {
    throw new Error('Cannot format an alert with an invalid timestamp.');
  }
  const status = isPR && item.merged_at
    ? { text: '🟣 Merged', color: 0x9b59b6 }
    : item.state !== 'closed'
      ? { text: '🟢 Open', color: 0x57f287 }
      : isPR
        ? { text: '🔴 Closed (unmerged)', color: 0xed4245 }
        : { text: '⚪ Closed', color: 0x95a5a6 };
  const labels = item.labels.map(label => typeof label === 'string' ? label : label.name).join(', ');
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      author: { name: item.user?.login ?? 'unknown', ...(item.user?.avatar_url ? { icon_url: item.user.avatar_url } : {}) },
      title: `${isPR ? '🚀' : '🐛'} ${repo} — ${type} #${item.number}`,
      url: item.html_url,
      fields: [
        { name: 'Title', value: item.title.slice(0, 1024) },
        { name: 'Status', value: status.text, inline: true },
        { name: 'Labels', value: labels.slice(0, 1024) || 'None', inline: true },
        { name: 'Created', value: `${lagosDate.format(created)} WAT` },
        { name: 'Alerted', value: `${lagosDate.format(alerted)} WAT · ${ageAtDelivery(created, alerted)} after creation` },
      ],
      description: `[View ${type}](${item.html_url})`,
      color: status.color,
    }],
  };
}

export async function monitor({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  sleep = ms => new Promise(done => setTimeout(done, ms)),
  log = console,
} = {}) {
  const repositories = [...new Set((env.REPOS ?? '').trim().split(/\s+/).filter(Boolean))];
  const repository = env.GITHUB_REPOSITORY;
  if (!repository || !env.GH_TOKEN || !env.DISCORD_WEBHOOK_URL || !repositories.length) {
    throw new Error('Set REPOS, GH_TOKEN, GITHUB_REPOSITORY and DISCORD_WEBHOOK_URL.');
  }
  for (const repo of [repository, ...repositories]) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`Invalid repository: ${repo}`);
  }
  const until = now();
  const initial = Date.parse(env.INITIAL_SINCE ?? '');
  if (!Number.isFinite(initial) || initial > until.getTime()) {
    throw new Error('INITIAL_SINCE must be a timestamp in the past.');
  }
  const webhook = new URL(env.DISCORD_WEBHOOK_URL);
  if (webhook.protocol !== 'https:') throw new Error('The Discord webhook must use HTTPS.');
  webhook.searchParams.set('wait', 'true');

  async function github(path, { method = 'GET', body, allow404 = false } = {}) {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return { data: await response.json(), next: response.headers.get('link')?.includes('rel="next"') };
  }

  const statePath = `/repos/${repository}/contents/${STATE_FILE}`;
  const branch = await github(`/repos/${repository}/git/ref/heads/${STATE_BRANCH}`, { allow404: true });
  let state;
  let fileSha;

  async function save() {
    try {
      const { data } = await github(statePath, {
        method: 'PUT',
        body: {
          message: 'Update repository monitor state',
          branch: STATE_BRANCH,
          content: Buffer.from(`${JSON.stringify(state, null, 2)}\n`).toString('base64'),
          ...(fileSha ? { sha: fileSha } : {}),
        },
      });
      fileSha = data.content.sha;
    } catch {
      const error = new Error('Could not save monitor state. Stopping to avoid further unrecorded notifications.');
      error.persistenceFailure = true;
      throw error;
    }
  }

  function entryAt(timestamp) {
    return { since: timestamp, checked_until: timestamp, sent: {} };
  }

  if (!branch) {
    state = { version: 1, repositories: Object.fromEntries(repositories.map(repo => [repo, entryAt(new Date(initial).toISOString())])) };
    // Publish the branch only after its state file exists in a complete commit.
    const { data: tree } = await github(`/repos/${repository}/git/trees`, {
      method: 'POST', body: { tree: [{ path: STATE_FILE, mode: '100644', type: 'blob', content: `${JSON.stringify(state, null, 2)}\n` }] },
    });
    const { data: commit } = await github(`/repos/${repository}/git/commits`, {
      method: 'POST', body: { message: 'Initialize repository monitor state', tree: tree.sha, parents: [] },
    });
    await github(`/repos/${repository}/git/refs`, {
      method: 'POST', body: { ref: `refs/heads/${STATE_BRANCH}`, sha: commit.sha },
    });
    const { data: file } = await github(`${statePath}?ref=${STATE_BRANCH}`);
    fileSha = file.sha;
  } else {
    const { data: file } = await github(`${statePath}?ref=${STATE_BRANCH}`);
    fileSha = file.sha;
    state = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    if (state.version !== 1 || !state.repositories || typeof state.repositories !== 'object') {
      throw new Error('Invalid monitor state; refusing to reset notification history.');
    }
  }

  async function notify(item, repo) {
    const isPR = Boolean(item.pull_request);
    const { data: latest } = await github(`/repos/${repo}/${isPR ? 'pulls' : 'issues'}/${item.number}`);
    const current = { ...item, ...latest, pull_request: item.pull_request };
    for (let attempt = 0; attempt < 4; attempt++) {
      let response;
      try {
        response = await fetchImpl(webhook.toString(), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildDiscordPayload(current, repo, now())), signal: AbortSignal.timeout(30_000),
        });
      } catch {
        // Avoid logging a fetch error containing the secret webhook URL.
        throw new Error('Discord delivery failed or timed out; checkpoint was not advanced.');
      }
      if (response.ok) return;
      if (response.status === 429 && attempt < 3) {
        const { retry_after: seconds } = await response.json();
        if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 60) {
          await sleep(Math.ceil(seconds * 1000) + 100);
          continue;
        }
      }
      throw new Error(`Discord returned HTTP ${response.status}; checkpoint was not advanced.`);
    }
  }

  const failed = [];
  for (const repo of repositories) {
    try {
      if (!state.repositories[repo]) {
        // A repository added later starts with its most recent day.
        state.repositories[repo] = entryAt(new Date(Math.max(initial, until.getTime() - DAY)).toISOString());
        await save();
      }
      const entry = state.repositories[repo];
      const checked = Date.parse(entry.checked_until);
      const floor = Date.parse(entry.since);
      if (!Number.isFinite(checked) || !Number.isFinite(floor) || checked < floor || checked > until.getTime()
          || !entry.sent || typeof entry.sent !== 'object') {
        throw new Error('Invalid repository checkpoint; refusing to reset it.');
      }
      // Recheck one day for boundary/visibility races, without resending saved IDs.
      const since = new Date(Math.max(floor, checked - DAY));
      const items = new Map();
      for (let page = 1; ; page++) {
        const params = new URLSearchParams({ state: 'all', sort: 'created', direction: 'desc',
          since: new Date(since.getTime() - 1000).toISOString(), per_page: '100', page: String(page) });
        const { data, next } = await github(`/repos/${repo}/issues?${params}`);
        for (const item of data) {
          const created = Date.parse(item.created_at);
          if (created >= since.getTime() && created < until.getTime()) items.set(String(item.number), item);
        }
        if (!next) break;
      }
      const ordered = [...items.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.number - b.number);
      let count = 0;
      for (const item of ordered) {
        const id = String(item.number); // Issues and PRs share a repository's number sequence.
        if (Object.hasOwn(entry.sent, id)) continue;
        if (item.pull_request && item.user?.login === 'dependabot[bot]') continue;
        await notify(item, repo);
        entry.sent[id] = item.created_at;
        await save(); // Persist after every acknowledged message, before sending another.
        count++;
      }
      entry.checked_until = until.toISOString();
      // IDs older than the overlap cannot be fetched again; keep state bounded.
      const retainSince = Math.max(floor, until.getTime() - DAY);
      for (const [id, created] of Object.entries(entry.sent)) {
        if (Date.parse(created) < retainSince) delete entry.sent[id];
      }
      await save();
      log.log(`${repo}: sent ${count}; checked through ${entry.checked_until}`);
    } catch (error) {
      if (error.persistenceFailure) throw error;
      failed.push(repo);
      log.error(`${repo}: ${error.message}`);
    }
  }
  if (failed.length) throw new Error(`Checks failed for: ${failed.join(', ')}. Rerun to resume.`);
  return state;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  monitor().catch(error => { console.error(error.message); process.exitCode = 1; });
}
