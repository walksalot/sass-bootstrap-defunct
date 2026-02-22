#!/usr/bin/env node

import process from 'node:process';
import { pathToFileURL } from 'node:url';

const API_BASE = process.env.GITHUB_API_URL || 'https://api.github.com';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    args[key] = value;
  }
  return args;
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

function shortSha(sha) {
  return sha ? sha.slice(0, 7) : 'unknown';
}

function isSuccessfulConclusion(conclusion) {
  return conclusion === 'success' || conclusion === 'skipped';
}

function withPagination(path, page) {
  return `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`;
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function githubRequest(path, { token, method = 'GET' } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'merge-eligibility-script',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed (${response.status}) for ${path}: ${body.slice(0, 400)}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function githubList(path, { token, maxPages = 20 } = {}) {
  const allItems = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const data = await githubRequest(withPagination(path, page), { token });
    if (!Array.isArray(data) || data.length === 0) {
      break;
    }

    allItems.push(...data);
    if (data.length < 100) {
      break;
    }
  }

  return allItems;
}

function latestRunsByName(checkRuns) {
  const byName = new Map();

  for (const run of checkRuns) {
    const existing = byName.get(run.name);
    if (!existing) {
      byName.set(run.name, run);
      continue;
    }

    const existingTime = new Date(existing.started_at || existing.completed_at || 0).getTime();
    const currentTime = new Date(run.started_at || run.completed_at || 0).getTime();
    if (currentTime >= existingTime) {
      byName.set(run.name, run);
    }
  }

  return byName;
}

function decision(reason, details, requiresWorkflowSafety) {
  return {
    eligible: reason === 'safe_to_merge',
    reason,
    details,
    requires_workflow_safety: requiresWorkflowSafety
  };
}

function runStatusSummary(run) {
  if (!run) {
    return 'missing';
  }
  return `${run.status}/${run.conclusion || 'none'}`;
}

export function evaluateMergeEligibilitySnapshot({
  pr,
  prNumber,
  expectedHeadSha,
  requireWorkflowSafety = false,
  workflowFilesChanged = false,
  checkRuns = []
}) {
  if (!pr || pr.state !== 'open') {
    return decision('pr_not_open', `PR #${prNumber} is not open.`, false);
  }

  if (expectedHeadSha && pr.head.sha !== expectedHeadSha) {
    return decision(
      'sha_mismatch',
      `PR head changed from ${shortSha(expectedHeadSha)} to ${shortSha(pr.head.sha)}.`,
      false
    );
  }

  const labelNames = (pr.labels || []).map(label => label.name);
  if (labelNames.includes('no-auto-merge')) {
    return decision('no_auto_merge_label', 'PR has the no-auto-merge label.', false);
  }

  if (pr.mergeable === null) {
    return decision('pending_checks', 'GitHub mergeability is still being calculated.', false);
  }

  if (pr.mergeable === false || pr.mergeable_state === 'dirty') {
    return decision('merge_conflict', `PR currently has merge conflicts with ${pr.base?.ref || 'the base branch'}.`, false);
  }

  if (pr.mergeable_state === 'behind') {
    return decision(
      'behind_main',
      `PR branch is behind ${pr.base?.ref || 'the base branch'} and needs update.`,
      false
    );
  }

  const requiresWorkflowSafety = Boolean(requireWorkflowSafety && workflowFilesChanged);
  const byName = latestRunsByName(checkRuns);

  const automationGateRun = byName.get('Automation Gate');
  const reviewRun = byName.get('review');
  const workflowSafetyRun = byName.get('Workflow Safety');

  if (!automationGateRun) {
    return decision(
      'pending_checks',
      'Automation Gate check has not started yet.',
      requiresWorkflowSafety
    );
  }

  if (automationGateRun.status !== 'completed') {
    return decision(
      'pending_checks',
      'Automation Gate check is still running.',
      requiresWorkflowSafety
    );
  }

  if (requiresWorkflowSafety) {
    if (!workflowSafetyRun) {
      return decision(
        'workflow_safety_missing',
        'Workflow Safety check is required for workflow-file changes but is missing.',
        requiresWorkflowSafety
      );
    }
    if (workflowSafetyRun.status !== 'completed') {
      return decision(
        'pending_checks',
        'Workflow Safety check is still running.',
        requiresWorkflowSafety
      );
    }
    if (!isSuccessfulConclusion(workflowSafetyRun.conclusion)) {
      return decision(
        'workflow_safety_failed',
        `Workflow Safety check failed with conclusion ${workflowSafetyRun.conclusion}.`,
        requiresWorkflowSafety
      );
    }
  }

  if (!isSuccessfulConclusion(automationGateRun.conclusion)) {
    if (reviewRun && reviewRun.status === 'completed' && !isSuccessfulConclusion(reviewRun.conclusion)) {
      return decision(
        'review_failed',
        `review check failed with conclusion ${reviewRun.conclusion}.`,
        requiresWorkflowSafety
      );
    }

    return decision(
      'pending_checks',
      `Automation Gate failed with conclusion ${automationGateRun.conclusion || 'none'}.`,
      requiresWorkflowSafety
    );
  }

  return decision(
    'safe_to_merge',
    `All required checks passed on ${shortSha(pr.head.sha)} (Automation Gate=${runStatusSummary(automationGateRun)}, review=${runStatusSummary(reviewRun)}).`,
    requiresWorkflowSafety
  );
}

export async function evaluateMergeEligibility({
  owner,
  repo,
  prNumber,
  expectedHeadSha,
  requireWorkflowSafety = false,
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
}) {
  if (!token) {
    throw new Error('Missing GitHub token. Set GITHUB_TOKEN or GH_TOKEN.');
  }
  if (!owner || !repo || !prNumber) {
    throw new Error('Missing required inputs: owner, repo, prNumber.');
  }

  let pr = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    pr = await githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}`, { token });
    if (pr.mergeable !== null) {
      break;
    }
    await sleep(1500);
  }

  const prFiles = await githubList(`/repos/${owner}/${repo}/pulls/${prNumber}/files`, { token });
  const workflowFilesChanged = prFiles.some(file => file.filename.startsWith('.github/workflows/'));

  const checkRunsResponse = await githubRequest(`/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`, { token });
  const checkRuns = Array.isArray(checkRunsResponse?.check_runs) ? checkRunsResponse.check_runs : [];
  return evaluateMergeEligibilitySnapshot({
    pr,
    prNumber,
    expectedHeadSha,
    requireWorkflowSafety,
    workflowFilesChanged,
    checkRuns
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(
      'Usage: node .github/scripts/merge-eligibility.mjs --owner <owner> --repo <repo> --pr-number <number> --head-sha <sha> --require-workflow-safety <true|false>\n'
    );
    return;
  }

  const owner = args.owner;
  const repo = args.repo;
  const prNumber = Number.parseInt(args['pr-number'] || args.pr_number, 10);
  const expectedHeadSha = args['head-sha'] || args.head_sha;
  const requireWorkflowSafety = parseBoolean(
    args['require-workflow-safety'] || args.require_workflow_safety,
    false
  );

  const result = await evaluateMergeEligibility({
    owner,
    repo,
    prNumber,
    expectedHeadSha,
    requireWorkflowSafety
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
