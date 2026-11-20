#!/bin/sh

set -eu

script=.github/scripts/check-release-notes.sh
notes=$(mktemp)
trap 'rm -f "$notes"' EXIT HUP INT TERM
export PUBLIC_TEXT="NGOTAG Platform Bhutan-NDI/ngotag-platform"

accepts() {
  mode=$1
  printf '%s\n' "$2" > "$notes"
  shift 2
  sh "$script" "$mode" "$notes" "$@" || { echo "rejected clean $mode notes" >&2; exit 1; }
}

rejects() {
  mode=$1
  description=$2
  printf '%s\n' "$3" > "$notes"
  shift 3
  if sh "$script" "$mode" "$notes" "$@" 2>/dev/null; then
    echo "accepted $mode notes containing $description" >&2
    exit 1
  fi
}

# A commit SHA with a run of exactly 12 decimal digits is not an account ID.
authored='## NGOTAG Platform v1.0.0-rc.1 (release candidate)

**Source commit:** `a123456789012b5c78759a0000000000000000ff`'
generated='## What'"'"'s Changed
* fix(issuance): pass NATS payload to offer handlers by @someone in https://github.com/Bhutan-NDI/ngotag-platform/pull/105
* fix: pin base image sha256:abc and register the task definition for linux/arm64 by @someone in https://github.com/Bhutan-NDI/ngotag-platform/pull/106
* feat(mobile-verifier): platform-admin roles for verifier users by @someone in https://github.com/Bhutan-NDI/ngotag-platform/pull/109

**Full Changelog**: https://github.com/Bhutan-NDI/ngotag-platform/compare/qa/api-gateway/v0.0.41...platform/v1.0.0-qa.1'

# Short, generic or public names never block a release; distinctive names are matched as whole words.
names='PRIVATE_CLUSTER PRIVATE_GATEWAY_TDF user ngotag-platform platform'
# shellcheck disable=SC2086
accepts authored "$authored" $names
# shellcheck disable=SC2086
accepts generated "$generated" $names
accepts generated "* fix: PRIVATE_GATEWAY_TDFS cleanup" PRIVATE_GATEWAY_TDF

rejects authored "an account ID" "$authored
Account 123456789012"
rejects generated "an account ID" "$generated (123456789012)"
rejects generated "an ARN" "$generated arn:aws:iam::role/x"
rejects generated "a registry" "$generated 1.dkr.ecr.ap-southeast-1.amazonaws.com/x"
rejects generated "a bucket" "$generated s3://bucket/key"
rejects generated "a subnet" "$generated subnet-0123456789abcdef0"
rejects generated "a security group" "$generated (sg-0123abcd)"
rejects generated "a file system" "$generated fs-027dfce09a9626534"
rejects generated "a commit image tag" "$generated platform-api-gateway-aaaaaaaaaaaa"
rejects generated "a version image tag" "$generated platform-geo-location-1.0.0-aaaaaaaaaaaa"
rejects generated "a legacy image tag" "$generated API-GATEWAY_V_41"
rejects authored "a digest" "$authored sha256:abc"
rejects authored "a task definition" "$authored new task definition"
rejects authored "a task definition family" "$authored QA-TASKDEF:3"
rejects authored "an architecture" "$authored linux/arm64"
rejects authored "an image repository tag" "$authored example-services:x"
rejects authored "a private cluster name" "$authored on private_cluster" PRIVATE_CLUSTER
rejects generated "a private task definition family" "$generated
* fix PRIVATE_GATEWAY_TDF restarts" other-name PRIVATE_GATEWAY_TDF

echo "check-release-notes: all tests passed"
