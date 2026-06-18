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

echo "Verifying published version from npm registry..."
for attempt in {1..10}; do
  if published_version="$(npm --userconfig "${tmpnpmrc}" view "${package_name}" version 2>/dev/null)"; then
    echo "Published version: ${published_version}"
    exit 0
  fi

  echo "npm registry has not exposed ${package_name} yet; retry ${attempt}/10..."
  sleep 6
done

echo "Publish was accepted, but npm view still returned 404 after waiting."
echo "Access status:"
npm --userconfig "${tmpnpmrc}" access get status "${package_name}" || true
echo
echo "This usually means npm registry propagation is lagging. Try again in a few minutes:"
echo "  npm view ${package_name} version"
