#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

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

function parseFiles(args) {
  if (args['files-json']) {
    const parsed = JSON.parse(args['files-json']);
    if (!Array.isArray(parsed)) {
      throw new Error('--files-json must be a JSON array of paths');
    }
    return parsed;
  }

  if (args.files) {
    return String(args.files)
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }

  return [];
}

function collectPermissionEntries(content) {
  const entries = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const permissionsMatch = line.match(/^(\s*)permissions:\s*(.*)$/);
    if (!permissionsMatch) {
      continue;
    }

    const baseIndent = permissionsMatch[1].length;
    const inlineValue = permissionsMatch[2].trim().toLowerCase();
    if (inlineValue === 'write-all') {
      entries.push({ scope: '*', value: 'write-all', line: i + 1 });
    }

    for (let j = i + 1; j < lines.length; j += 1) {
      const nextLine = lines[j];
      if (!nextLine.trim() || nextLine.trim().startsWith('#')) {
        continue;
      }

      const indent = nextLine.length - nextLine.trimStart().length;
      if (indent <= baseIndent) {
        break;
      }

      const entryMatch = nextLine.match(/^\s*([A-Za-z0-9-]+):\s*([A-Za-z-]+)\s*$/);
      if (entryMatch) {
        entries.push({ scope: entryMatch[1], value: entryMatch[2].toLowerCase(), line: j + 1 });
      }
    }
  }

  return entries;
}

function checkPermissionsPolicy(fileName, content, violations) {
  const allowedWriteScopesByFile = {
    'claude-auto-fix.yml': new Set(['contents', 'pull-requests', 'issues', 'id-token', 'actions', 'checks']),
    'claude-assistant.yml': new Set(['contents', 'pull-requests', 'issues', 'id-token', 'actions']),
    'codex-assistant.yml': new Set(['contents', 'pull-requests', 'issues', 'id-token', 'actions']),
    'retry-stale-prs.yml': new Set(['contents', 'pull-requests', 'issues', 'checks']),
    'claude-code-review.yml': new Set(['contents', 'pull-requests', 'issues', 'id-token', 'actions']),
    'retry-review-failures.yml': new Set(['actions', 'checks', 'contents', 'pull-requests', 'issues']),
    'refresh-open-pr-branches.yml': new Set(['contents', 'pull-requests', 'issues']),
    'branch-hygiene.yml': new Set(['contents']),
    'automation-canary.yml': new Set(['contents', 'pull-requests', 'issues']),
    'automation-gate.yml': new Set([])
  };

  const entries = collectPermissionEntries(content);

  for (const entry of entries) {
    if (entry.value === 'write-all') {
      violations.push(`${fileName}:${entry.line} uses permissions: write-all, which is not allowed.`);
      continue;
    }

    if (entry.value !== 'write') {
      continue;
    }

    const allowedScopes = allowedWriteScopesByFile[fileName];
    if (!allowedScopes || !allowedScopes.has(entry.scope)) {
      violations.push(
        `${fileName}:${entry.line} grants write permission to '${entry.scope}', which is outside policy for this workflow.`
      );
    }
  }
}

function checkModelPolicy(fileName, content, violations) {
  const allowedModels = new Set(['claude-opus-4-6', 'gpt-5.3-codex']);
  const usesClaudeAction = /uses:\s*anthropics\/claude-code-action@/m.test(content);
  const usesCodexAction = /uses:\s*openai\/codex-action@/m.test(content);
  const claudeModelMatches = [...content.matchAll(/--model\s+([A-Za-z0-9._:-]+)/g)];
  const codexModelMatches = [...content.matchAll(/^\s*model:\s*['"]?([A-Za-z0-9._:-]+)['"]?\s*$/gm)];
  const codexEffortMatches = [...content.matchAll(/^\s*effort:\s*['"]?([A-Za-z0-9._:-]+)['"]?\s*$/gm)];

  if (usesClaudeAction && claudeModelMatches.length === 0) {
    violations.push(
      `${fileName} uses anthropics/claude-code-action but does not declare an explicit --model value.`
    );
  }

  if (usesCodexAction && codexModelMatches.length === 0) {
    violations.push(`${fileName} uses openai/codex-action but does not declare an explicit model value.`);
  }

  if (usesCodexAction && codexEffortMatches.length === 0) {
    violations.push(`${fileName} uses openai/codex-action but does not declare an explicit effort value.`);
  }

  for (const modelMatch of [...claudeModelMatches, ...codexModelMatches]) {
    const model = modelMatch[1].toLowerCase();
    if (!allowedModels.has(model)) {
      violations.push(
        `${fileName} uses disallowed model '${modelMatch[1]}'. Allowed models: claude-opus-4-6, gpt-5.3-codex.`
      );
    }
  }

  for (const effortMatch of codexEffortMatches) {
    const effort = effortMatch[1].toLowerCase();
    if (effort !== 'xhigh') {
      violations.push(`${fileName} uses disallowed effort '${effortMatch[1]}'. Allowed effort: xhigh.`);
    }
  }
}

function checkToolPolicy(fileName, content, violations) {
  if (!content.includes('Bash(*)')) {
    return;
  }

  if (!content.includes('workflow-policy: allow-bash-star')) {
    violations.push(
      `${fileName} includes Bash(*) but is missing an explicit policy marker comment: workflow-policy: allow-bash-star.`
    );
  }
}

function checkMergeBypassPolicy(fileName, content, violations) {
  const hasDirectMergeCall = content.includes('pulls.merge(') || /\bgh\s+pr\s+merge\b/.test(content);
  if (!hasDirectMergeCall) {
    return;
  }

  if (!content.includes('merge-eligibility.mjs')) {
    violations.push(
      `${fileName} contains direct merge logic but does not reference .github/scripts/merge-eligibility.mjs.`
    );
  }
}

function checkMergeEligibilityReferencePolicy(fileName, content, violations) {
  const mergeCapableWorkflows = new Set(['claude-auto-fix.yml', 'retry-stale-prs.yml']);
  if (!mergeCapableWorkflows.has(fileName)) {
    return;
  }

  if (!content.includes('merge-eligibility.mjs')) {
    violations.push(
      `${fileName} is merge-capable but does not reference .github/scripts/merge-eligibility.mjs.`
    );
  }
}

function checkReviewWorkflowPolicy(fileName, content, violations) {
  if (fileName !== 'claude-code-review.yml') {
    return;
  }

  if (/^\s*plugin_marketplaces:\s*/m.test(content)) {
    violations.push(`${fileName} reintroduces plugin_marketplaces, which is not allowed by policy.`);
  }
  if (/^\s*plugins:\s*/m.test(content)) {
    violations.push(`${fileName} reintroduces plugins, which is not allowed by policy.`);
  }
  if (/^\s*settings:\s*/m.test(content)) {
    violations.push(`${fileName} reintroduces settings input, which is blocked by policy.`);
  }
  if (/\/code-review\b/.test(content)) {
    violations.push(`${fileName} reintroduces slash-command review prompts, which are not allowed by policy.`);
  }
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const files = parseFiles(args);

  if (files.length === 0) {
    console.log('No workflow files provided to policy checker; nothing to validate.');
    return;
  }

  const violations = [];

  for (const workflowFile of files) {
    if (!fs.existsSync(workflowFile)) {
      violations.push(`${workflowFile}: file not found.`);
      continue;
    }

    const content = fs.readFileSync(workflowFile, 'utf8');
    const fileName = path.basename(workflowFile);

    checkPermissionsPolicy(fileName, content, violations);
    checkModelPolicy(fileName, content, violations);
    checkToolPolicy(fileName, content, violations);
    checkMergeBypassPolicy(fileName, content, violations);
    checkMergeEligibilityReferencePolicy(fileName, content, violations);
    checkReviewWorkflowPolicy(fileName, content, violations);
  }

  if (violations.length > 0) {
    console.error('Workflow policy violations found:');
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log(`Workflow policy check passed for ${files.length} file(s).`);
}

run();
