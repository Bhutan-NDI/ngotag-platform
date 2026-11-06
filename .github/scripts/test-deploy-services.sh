#!/usr/bin/env bash

# Exercises deploy-services.sh against fake aws and docker commands.

set -euo pipefail

script=$(pwd)/.github/scripts/deploy-services.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

digest_a=sha256:$(printf 'a%.0s' $(seq 64))
digest_b=sha256:$(printf 'c%.0s' $(seq 64))
mkdir -p "$work/bin" "$work/state"

cat > "$work/bin/aws" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
state=$FAKE_STATE
echo "$*" >> "$state/calls"
arg() { local key=$1; shift; while [ "$#" -gt 0 ]; do [ "$1" = "$key" ] && { echo "$2"; return; }; shift; done; }
service_family() { case "$1" in svc-a) echo family-a ;; svc-b) echo family-b ;; esac; }
desired() { if [ "${FAKE_STOPPED_SERVICE:-}" = "$1" ]; then echo 0; else echo 2; fi; }
case "$2" in
  describe-services)
    service=$(arg --services "$@")
    family=$(service_family "$service")
    current=$(cat "$state/$service.td" 2>/dev/null || echo "arn:aws:ecs:region:account:task-definition/${FAKE_FAMILY_OVERRIDE:-$family}:1")
    rollout=COMPLETED
    if [ -f "$state/$service.updated" ]; then
      polls=$(( $(cat "$state/$service.polls" 2>/dev/null || echo 0) + 1 ))
      echo "$polls" > "$state/$service.polls"
      if [ "$polls" -lt 2 ]; then rollout=IN_PROGRESS; fi
      if [ "${FAKE_FAIL_SERVICE:-}" = "$service" ] && [ "$polls" -ge 2 ]; then
        rollout=FAILED
      fi
    fi
    count=$(desired "$service")
    jq -n --arg td "$current" --arg rollout "$rollout" --argjson count "$count" '{
      status: "ACTIVE", taskDefinition: $td, desiredCount: $count, runningCount: $count, pendingCount: 0,
      deploymentConfiguration: {maximumPercent: 200, minimumHealthyPercent: 100,
        deploymentCircuitBreaker: {enable: false, rollback: false}, alarms: {alarmNames: [], enable: false, rollback: false}},
      deployments: [{status: "PRIMARY", taskDefinition: $td, rolloutState: $rollout}]}'
    ;;
  describe-task-definition)
    td=$(arg --task-definition "$@")
    family=${td#*task-definition/}; family=${family%%:*}
    jq -n --arg family "$family" --arg sidecar "${FAKE_SIDECAR:-}" '{
      taskDefinitionArn: "arn", revision: 1, status: "ACTIVE", family: $family,
      containerDefinitions: ([{name: "app", image: "old"}] + (if $sidecar == "" then [] else [{name: "sidecar", image: $sidecar}] end))}'
    ;;
  register-task-definition)
    file=$(arg --cli-input-json "$@"); file=${file#file://}
    family=$(jq -r .family "$file")
    cp "$file" "$state/registered-$family.json"
    echo "arn:aws:ecs:region:account:task-definition/$family:2"
    ;;
  update-service)
    service=$(arg --service "$@")
    arg --task-definition "$@" > "$state/$service.td"
    arg --deployment-configuration "$@" > "$state/$service.config"
    touch "$state/$service.updated"
    ;;
  list-tasks)
    service=$(arg --service-name "$@")
    echo "$service" > "$state/last-service"
    if [ "$(desired "$service")" -eq 0 ]; then echo None; else printf 'task-1\ttask-2\n'; fi
    ;;
  describe-tasks)
    service=$(cat "$state/last-service")
    td=$(cat "$state/$service.td")
    case "$service" in svc-a) digest=$FAKE_DIGEST_A ;; *) digest=$FAKE_DIGEST_B ;; esac
    digest=${FAKE_TASK_DIGEST:-$digest}
    jq -n --arg td "$td" --arg digest "$digest" '{tasks: [
      {taskDefinitionArn: $td, lastStatus: "RUNNING", containers: [{name: "app", imageDigest: $digest}]},
      {taskDefinitionArn: $td, lastStatus: "RUNNING", containers: [{name: "app", imageDigest: $digest}]}]}'
    ;;
  *) echo "unexpected aws call: $*" >&2; exit 1 ;;
esac
FAKE

cat > "$work/bin/docker" <<'FAKE'
#!/usr/bin/env bash
case "$*" in
  *"--raw multi-arch:v1") echo '{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}}]}' ;;
  *"--raw amd64-only:v1") echo '{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"platform":{"os":"linux","architecture":"amd64"}}]}' ;;
  *) echo "unexpected docker call: $*" >&2; exit 1 ;;
esac
FAKE
chmod +x "$work/bin/aws" "$work/bin/docker"

jq -n --arg a "$digest_a" --arg b "$digest_b" '[
  {name: "first", service: "svc-a", container: "app", task_definition_family: "family-a",
   image: "registry/repo:platform-first-aaaaaaaaaaaa", image_digest: $a},
  {name: "second", service: "svc-b", container: "app", task_definition_family: "family-b",
   image: "registry/repo:platform-second-aaaaaaaaaaaa", image_digest: $b}
]' > "$work/release.json"

run() {
  rm -rf "$work/state" && mkdir -p "$work/state"
  PATH="$work/bin:$PATH" FAKE_STATE="$work/state" FAKE_DIGEST_A="$digest_a" FAKE_DIGEST_B="$digest_b" \
    CLUSTER=cluster RELEASE_FILE="$work/release.json" CPU_ARCHITECTURE=ARM64 RESULT_FILE="$work/result.json" \
    POLL_SECONDS=0 ROLLOUT_ATTEMPTS=5 "$@" bash "$script"
}

fail() { echo "$1" >&2; exit 1; }

# Successful rollout of both services, in order, each with its own image.
run env > "$work/out" 2>&1 || { cat "$work/out" >&2; fail "successful rollout failed"; }
jq -e '. == {first: "arn:aws:ecs:region:account:task-definition/family-a:2", second: "arn:aws:ecs:region:account:task-definition/family-b:2"}' \
  "$work/result.json" >/dev/null || fail "unexpected result file"
jq -e '.runtimePlatform == {cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX"}
  and .containerDefinitions[0].image == "registry/repo:platform-first-aaaaaaaaaaaa" and (has("revision") | not)' \
  "$work/state/registered-family-a.json" >/dev/null || fail "unexpected registered task definition for family-a"
jq -e '.containerDefinitions[0].image == "registry/repo:platform-second-aaaaaaaaaaaa"' \
  "$work/state/registered-family-b.json" >/dev/null || fail "unexpected registered task definition for family-b"
jq -e '.deploymentCircuitBreaker == {enable: true, rollback: true} and .maximumPercent == 200
  and .minimumHealthyPercent == 100 and .alarms.enable == false' "$work/state/svc-a.config" >/dev/null \
  || fail "deployment configuration was not preserved with the circuit breaker enabled"
grep -q -- '--desired-count' "$work/state/calls" && fail "a desired count was changed"
first_update=$(grep -n 'update-service.*svc-a' "$work/state/calls" | cut -d: -f1)
second_register=$(grep -n 'register-task-definition.*' "$work/state/calls" | sed -n 2p | cut -d: -f1)
[ "$first_update" -lt "$second_register" ] || fail "second service was registered before the first rolled out"

# A stopped service gets the new task definition and stays stopped.
run env FAKE_STOPPED_SERVICE=svc-a > "$work/out" 2>&1 || { cat "$work/out" >&2; fail "stopped service rollout failed"; }
grep -q 'service first: task definition updated; the service stays stopped' "$work/out" \
  || fail "stopped service was not reported"

# A failed rollout stops before the next service changes.
if run env FAKE_FAIL_SERVICE=svc-a > "$work/out" 2>&1; then fail "failed rollout was accepted"; fi
grep -q 'rolled it back' "$work/out" || fail "failed rollout was not reported"
grep -q 'update-service.*svc-b' "$work/state/calls" && fail "second service changed after a failure"

# Tasks running a different digest fail verification.
if run env FAKE_TASK_DIGEST="sha256:$(printf 'b%.0s' $(seq 64))" > "$work/out" 2>&1; then
  fail "wrong running digest was accepted"
fi

# Preflight problems stop the run before any change.
if run env FAKE_FAMILY_OVERRIDE=other > "$work/out" 2>&1; then fail "foreign task definition family was accepted"; fi
grep -q 'update-service\|register-task-definition' "$work/state/calls" && fail "a change was made after a failed preflight"
run env FAKE_SIDECAR=multi-arch:v1 > "$work/out" 2>&1 || { cat "$work/out" >&2; fail "multi-arch sidecar was rejected"; }
if run env FAKE_SIDECAR=amd64-only:v1 > "$work/out" 2>&1; then fail "amd64-only sidecar was accepted"; fi
grep -q 'update-service\|register-task-definition' "$work/state/calls" && fail "a change was made after a failed sidecar check"
jq '.[1].image_digest = "sha256:short"' "$work/release.json" > "$work/bad-release.json"
if run env RELEASE_FILE="$work/bad-release.json" > "$work/out" 2>&1; then fail "invalid image digest was accepted"; fi
grep -q 'update-service\|register-task-definition' "$work/state/calls" && fail "a change was made with an invalid digest"

# A service whose rollout window does not fit before the deadline is not changed.
if run env ROLLOUT_DEADLINE="$(($(date +%s) + 30))" > "$work/out" 2>&1; then fail "rollout past the deadline was accepted"; fi
grep -q 'not enough time left' "$work/out" || fail "deadline stop was not reported"
grep -q 'update-service\|register-task-definition' "$work/state/calls" && fail "a service changed after the deadline check"

echo "deploy-services: all tests passed"
