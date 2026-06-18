#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

package_name="$(node -p "require('./package.json').name")"
package_version="$(node -p "require('./package.json').version")"

echo "Publishing ${package_name}@${package_version} to npm."
echo "Use an npm granular access token with read/write package access and 2FA publish bypass enabled."
echo "The token will not be written to this repository."
echo

read -rsp "NPM token: " NPM_TOKEN
echo

if [[ -z "${NPM_TOKEN}" ]]; then
  echo "Error: token is empty." >&2
  exit 1
fi

tmpnpmrc="$(mktemp)"
cleanup() {
  rm -f "${tmpnpmrc}"
  unset NPM_TOKEN
}
trap cleanup EXIT

printf '//registry.npmjs.org/:_authToken=%s\n' "${NPM_TOKEN}" > "${tmpnpmrc}"
chmod 600 "${tmpnpmrc}"

echo "Checking npm identity..."
npm --userconfig "${tmpnpmrc}" whoami

echo "Running package tests..."
npm test

echo "Publishing..."
npm --userconfig "${tmpnpmrc}" publish --access public

echo "Published version:"
npm view "${package_name}" version
