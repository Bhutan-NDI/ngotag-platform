#!/usr/bin/env bash

# Exercises promote-stage-images.sh against fake aws and skopeo commands.

set -euo pipefail

script=$(pwd)/.github/scripts/promote-stage-images.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

digest_a=sha256:$(printf 'a%.0s' $(seq 64))
digest_b=sha256:$(printf 'b%.0s' $(seq 64))

cat > "$work/bin/aws" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
state=$FAKE_STATE
echo "$*" >> "$state/calls"
arg() { local key=$1; shift; while [ "$#" -gt 0 ]; do [ "$1" = "$key" ] && { echo "$2"; return; }; shift; done; }
case "$2" in
  describe-images)
    repository=$(arg --repository-name "$@"); tag=$(arg --image-ids "$@"); tag=${tag#imageTag=}
    if [ -f "$state/image-$repository-$tag" ]; then cat "$state/image-$repository-$tag"
    else echo "An error occurred (ImageNotFoundException) when calling the DescribeImages operation" >&2; exit 254; fi
    ;;
  describe-services)
    service=$(arg --services "$@")
    count=1; [ "$service" = stage-b ] && count=${FAKE_B_DESIRED:-1}
    jq -n --arg td "td-$service" --argjson count "$count" '{status: "ACTIVE", taskDefinition: $td, desiredCount: $count,
      deployments: [{status: "PRIMARY", taskDefinition: $td, rolloutState: "COMPLETED"}]}'
    ;;
  describe-task-definition)
    td=$(arg --task-definition "$@"); service=${td#td-}
    case "$service" in stage-a) digest=$FAKE_DIGEST_A ;; *) digest=$FAKE_DIGEST_B ;; esac
    jq -n --arg image "${FAKE_TD_IMAGE:-registry/stage-repo@$digest}" --arg arch "${FAKE_ARCH:-ARM64}" \
      '{runtimePlatform: {cpuArchitecture: $arch}, containerDefinitions: [{name: "app", image: $image}]}'
    ;;
  list-tasks) echo task-1 ;;
  describe-tasks)
    jq -n --arg digest "${FAKE_RUNNING_DIGEST:-$FAKE_DIGEST_A}" '{tasks: [{containers: [{name: "app", imageDigest: $digest}]}]}'
    ;;
  *) echo "unexpected aws call: $*" >&2; exit 1 ;;
esac
FAKE

cat > "$work/bin/skopeo" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
echo "skopeo $*" >> "$FAKE_STATE/calls"
source=${*: -2:1}; target=${*: -1}
digest=${source##*@}; target=${target#docker://registry/}
echo "$digest" > "$FAKE_STATE/image-${target%%:*}-${target#*:}"
FAKE
chmod +x "$work/bin/aws" "$work/bin/skopeo"

jq -n '[{name: "a", service: "stage-a", container: "app", task_definition_family: "A"},
        {name: "b", service: "stage-b", container: "app", task_definition_family: "B"}]' > "$work/source-services.json"
jq -n '[{name: "a", service: "prod-a", container: "app", task_definition_family: "PA"},
        {name: "b", service: "prod-b", container: "app", task_definition_family: "PB"}]' > "$work/target-services.json"
jq -n --arg a "$digest_a" --arg b "$digest_b" '{
  a: {image_tag: "platform-a-aaaaaaaaaaaa", image_digest: $a},
  b: {image_tag: "platform-b-aaaaaaaaaaaa", image_digest: $b}}' > "$work/deployed.json"

run() {
  rm -rf "$work/state" && mkdir -p "$work/state"
  echo "$digest_a" > "$work/state/image-stage-repo-platform-a-aaaaaaaaaaaa"
  echo "$digest_b" > "$work/state/image-stage-repo-platform-b-aaaaaaaaaaaa"
  PATH="$work/bin:$PATH" FAKE_STATE="$work/state" FAKE_DIGEST_A="$digest_a" FAKE_DIGEST_B="$digest_b" REGISTRY=registry \
    SOURCE_CLUSTER=stage SOURCE_SERVICES_FILE="$work/source-services.json" SOURCE_DEPLOYED_FILE="$work/deployed.json" \
    SOURCE_REPOSITORY=stage-repo TARGET_SERVICES_FILE="$work/target-services.json" TARGET_REPOSITORY=prod-repo \
    TARGET_TAG_SUFFIX=1.0.0-aaaaaaaaaaaa IMAGE_TAG_PREFIX=platform- "$@" bash "$script"
}

fail() { echo "$1" >&2; exit 1; }

# Service b is stopped in Stage: its task definition is the proof.
run env FAKE_B_DESIRED=0 FAKE_RUNNING_DIGEST= > "$work/out" 2>&1 || { cat "$work/out" >&2; fail "promotion failed"; }
test "$(cat "$work/state/image-prod-repo-platform-a-1.0.0-aaaaaaaaaaaa")" = "$digest_a" || fail "a was not copied by digest"
test "$(cat "$work/state/image-prod-repo-platform-b-1.0.0-aaaaaaaaaaaa")" = "$digest_b" || fail "b was not copied by digest"
grep -q 'Stage service b is stopped' "$work/out" || fail "stopped Stage service was not reported"

# Running Stage tasks with another digest, or an x86 Stage task definition, block the copy.
if run env FAKE_RUNNING_DIGEST="$digest_b" > "$work/out" 2>&1; then fail "a Stage digest mismatch was accepted"; fi
grep -q skopeo "$work/state/calls" && fail "an image was copied after a failed check"
if run env FAKE_B_DESIRED=0 FAKE_ARCH=X86_64 > "$work/out" 2>&1; then fail "an x86 Stage service was accepted"; fi
grep -q skopeo "$work/state/calls" && fail "an image was copied after a failed architecture check"

# A migration image is proven by the Stage ledger and its ECR tag, not by the Stage services.
run env PROVE_STAGE_SERVICES=false FAKE_RUNNING_DIGEST="$digest_b" > "$work/out" 2>&1 \
  || { cat "$work/out" >&2; fail "a migration image promotion failed"; }
grep -q 'describe-services' "$work/state/calls" && fail "a migration promotion checked the Stage services"
test "$(cat "$work/state/image-prod-repo-platform-a-1.0.0-aaaaaaaaaaaa")" = "$digest_a" || fail "migration image not copied by digest"

# A Stage task definition that pins a tag instead of the digest is not proof.
if run env FAKE_B_DESIRED=0 FAKE_TD_IMAGE=registry/stage-repo:platform-b-aaaaaaaaaaaa > "$work/out" 2>&1; then
  fail "a tag-pinned Stage task definition was accepted"
fi
grep -q skopeo "$work/state/calls" && fail "an image was copied for a tag-pinned Stage service"

# A Prod service without a Stage release, or a moved Stage tag, blocks the copy.
jq 'del(.b)' "$work/deployed.json" > "$work/partial.json"
if run env FAKE_B_DESIRED=0 SOURCE_DEPLOYED_FILE="$work/partial.json" > "$work/out" 2>&1; then
  fail "a service without a Stage release was accepted"
fi
grep -q skopeo "$work/state/calls" && fail "an image was copied for an incomplete Stage release"

echo "promote-stage-images: all tests passed"
