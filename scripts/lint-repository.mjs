#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';

const requiredFiles = [
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'SUPPORT.md',
  'docs/INSTALLATION.md',
  'docs/USAGE.md',
  'docs/CONFIGURATION.md',
  'docs/PRIVACY.md',
  'docs/TROUBLESHOOTING.md',
  'docs/PUBLISHING.md',
  '.github/workflows/ci.yml',
  '.github/workflows/changelog.yml',
];

const errors = [];
for (const file of requiredFiles) {
  if (!existsSync(file)) {
    errors.push(`missing required repository file: ${file}`);
  }
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.license !== 'MIT') {
  errors.push('package.json license must be MIT');
}

for (const keyword of ['pi-package', 'pi-extension']) {
  if (!pkg.keywords?.includes(keyword)) {
    errors.push(`package.json keywords must include ${keyword}`);
  }
}

if (!Array.isArray(pkg.pi?.extensions) || pkg.pi.extensions.length === 0) {
  errors.push('package.json must declare pi.extensions');
} else {
  for (const extensionPath of pkg.pi.extensions) {
    if (!existsSync(extensionPath)) {
      errors.push(`declared Pi extension does not exist: ${extensionPath}`);
    }
  }
}

for (const publishedPath of ['extensions', 'README.md', 'LICENSE']) {
  if (!pkg.files?.includes(publishedPath)) {
    errors.push(`package.json files should include ${publishedPath}`);
  }
}

for (const scriptName of ['lint', 'test', 'smoke', 'doctor', 'pack:dry', 'lint:commits']) {
  if (!pkg.scripts?.[scriptName]) {
    errors.push(`package.json scripts must include ${scriptName}`);
  }
}

if (errors.length > 0) {
  console.error('Repository lint failed:\n');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Repository lint passed.');
