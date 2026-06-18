#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const SPEC_URL = 'https://www.conventionalcommits.org/en/v1.0.0/';
const ZERO_SHA = /^0{40}$/;
const HEADER_RE = /^(?<type>[a-z][a-z0-9-]*)(?:\((?<scope>[A-Za-z0-9._/-]+)\))?(?<breaking>!)?: (?<description>\S.*)$/;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function hasArg(name) {
  return process.argv.includes(name);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function validateMessage(message, label) {
  const normalized = message.replace(/\r\n/g, '\n').trimEnd();
  const [header = '', secondLine] = normalized.split('\n');
  const errors = [];

  if (!HEADER_RE.test(header)) {
    errors.push(
      'header must match "<type>[optional scope][!]: <description>"; example: "feat(voice): add hold-space dictation"',
    );
  }

  if (secondLine !== undefined && secondLine !== '') {
    errors.push('body/footer content must be separated from the header by a blank line');
  }

  if (errors.length === 0) {
    return [];
  }

  return [
    `${label}: ${header || '<empty message>'}`,
    ...errors.map((error) => `  - ${error}`),
  ];
}

function commitsForRange(range) {
  if (!range || ZERO_SHA.test(range)) {
    return [];
  }

  const output = git(['log', '--no-merges', '--format=%H%x1f%B%x1e', range]).trim();
  if (!output) {
    return [];
  }

  return output
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, ...messageParts] = record.split('\x1f');
      return { hash, message: messageParts.join('\x1f').trimEnd() };
    });
}

const explicitMessage = argValue('--message');
if (explicitMessage !== undefined) {
  const label = argValue('--label') ?? 'message';
  const errors = validateMessage(explicitMessage, label);
  if (errors.length > 0) {
    console.error(`Conventional Commits 1.0.0 validation failed. See ${SPEC_URL}\n`);
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(`${label} follows Conventional Commits 1.0.0.`);
  process.exit(0);
}

let range = argValue('--range') ?? process.env.COMMIT_RANGE;
if (!range && hasArg('--head')) {
  range = argValue('--head');
}

if (!range) {
  console.error('Missing commit range. Pass --range "base..head" or set COMMIT_RANGE.');
  process.exit(2);
}

const commits = commitsForRange(range);
if (commits.length === 0) {
  console.log(`No non-merge commits to validate in range ${range}.`);
  process.exit(0);
}

const failures = [];
for (const commit of commits) {
  failures.push(...validateMessage(commit.message, commit.hash.slice(0, 12)));
}

if (failures.length > 0) {
  console.error(`Conventional Commits 1.0.0 validation failed for range ${range}. See ${SPEC_URL}\n`);
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log(`Validated ${commits.length} non-merge commit(s) in ${range}.`);
