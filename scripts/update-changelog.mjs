#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CHANGELOG = 'CHANGELOG.md';
const HEADER_RE = /^(?<type>[a-z][a-z0-9-]*)(?:\((?<scope>[A-Za-z0-9._/-]+)\))?(?<breaking>!)?: (?<description>\S.*)$/;
const CATEGORY_ORDER = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
const TYPE_TO_CATEGORY = new Map([
  ['feat', 'Added'],
  ['fix', 'Fixed'],
  ['security', 'Security'],
  ['deprecate', 'Deprecated'],
  ['deprecated', 'Deprecated'],
  ['remove', 'Removed'],
  ['removed', 'Removed'],
  ['perf', 'Changed'],
  ['refactor', 'Changed'],
  ['style', 'Changed'],
  ['docs', 'Changed'],
  ['test', 'Changed'],
  ['build', 'Changed'],
  ['ci', 'Changed'],
  ['chore', 'Changed'],
  ['revert', 'Changed'],
]);

function git(args, fallback = '') {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

function latestTag() {
  return git(['describe', '--tags', '--abbrev=0']);
}

function commitRecords(range) {
  const output = git(['log', '--no-merges', '--reverse', '--format=%H%x1f%s%x1f%b%x1e', range]);
  if (!output) {
    return [];
  }

  return output
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, subject = '', body = ''] = record.split('\x1f');
      return { hash, subject, body };
    });
}

function entryForCommit({ hash, subject, body }, existingText) {
  if (/\[skip changelog\]/i.test(`${subject}\n${body}`)) {
    return undefined;
  }

  const short = hash.slice(0, 12);
  if (existingText.includes(short)) {
    return undefined;
  }

  const match = subject.match(HEADER_RE);
  if (!match?.groups) {
    return undefined;
  }

  const { type, scope, breaking, description } = match.groups;
  const category = TYPE_TO_CATEGORY.get(type) ?? 'Changed';
  const repo = process.env.GITHUB_REPOSITORY;
  const ref = repo
    ? `([${short}](https://github.com/${repo}/commit/${hash}))`
    : `(${short})`;
  const scopePrefix = scope ? `**${scope}:** ` : '';
  const breakingPrefix = breaking || /^BREAKING[ -]CHANGE:/m.test(body) ? '**BREAKING:** ' : '';

  return {
    category,
    line: `- ${breakingPrefix}${scopePrefix}${description} ${ref}`,
  };
}

function findUnreleasedSection(text) {
  const marker = '## [Unreleased]';
  let start = text.indexOf(marker);
  if (start === -1) {
    const trimmed = text.trimEnd();
    const nextText = `${trimmed}\n\n${marker}\n\n`;
    return {
      text: nextText,
      start: nextText.indexOf(marker),
      end: nextText.length,
    };
  }

  const afterStart = start + marker.length;
  const nextVersionOffset = text.slice(afterStart).search(/^## \[/m);
  const end = nextVersionOffset === -1 ? text.length : afterStart + nextVersionOffset;
  return { text, start, end };
}

function appendToCategory(section, category, lines) {
  if (lines.length === 0) {
    return section;
  }

  const block = `${lines.join('\n')}\n`;
  const heading = `### ${category}`;
  const headingIndex = section.indexOf(heading);

  if (headingIndex === -1) {
    const separator = section.endsWith('\n\n') ? '' : section.endsWith('\n') ? '\n' : '\n\n';
    return `${section}${separator}${heading}\n\n${block}`;
  }

  const contentStart = headingIndex + heading.length;
  const nextHeadingOffset = section.slice(contentStart).search(/^### /m);
  const insertAt = nextHeadingOffset === -1 ? section.length : contentStart + nextHeadingOffset;
  const before = section.slice(0, insertAt).trimEnd();
  const after = section.slice(insertAt).replace(/^\n+/, '\n\n');
  return `${before}\n${block}${after}`;
}

let changelog = readFileSync(CHANGELOG, 'utf8');
const tag = latestTag();
const range = tag ? `${tag}..HEAD` : 'HEAD';
const records = commitRecords(range);
const entries = new Map(CATEGORY_ORDER.map((category) => [category, []]));

for (const record of records) {
  const entry = entryForCommit(record, changelog);
  if (!entry) {
    continue;
  }
  entries.get(entry.category)?.push(entry.line);
}

if ([...entries.values()].every((lines) => lines.length === 0)) {
  console.log(`No new changelog entries for ${range}.`);
  process.exit(0);
}

const sectionInfo = findUnreleasedSection(changelog);
changelog = sectionInfo.text;
let section = changelog.slice(sectionInfo.start, sectionInfo.end).trimEnd() + '\n\n';

for (const category of CATEGORY_ORDER) {
  section = appendToCategory(section, category, entries.get(category) ?? []);
}

const updated = `${changelog.slice(0, sectionInfo.start)}${section.trimEnd()}\n${changelog.slice(sectionInfo.end).replace(/^\n*/, '\n')}`;
writeFileSync(CHANGELOG, updated.endsWith('\n') ? updated : `${updated}\n`);
console.log(`Updated ${CHANGELOG} from ${range}.`);
