#!/bin/sh

# Validates one environment file of the private deployment manifest
# (platform/environments/<environment>.json). The manifest names the ECS
# cluster, services, containers, task definition families and the migration
# task, which never appear in this public repository, and records the last
# deployed release.

set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <release-contract> <environment> <manifest>" >&2
  exit 2
fi

contract=$1
environment=$2
manifest=$3

test -f "$contract" || { echo "release contract does not exist: $contract" >&2; exit 1; }
test -f "$manifest" || { echo "deployment manifest does not exist" >&2; exit 1; }

jq -e --arg environment "$environment" --slurpfile contract "$contract" '
  def name: type == "string" and test("^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$");
  def semver: type == "string" and test("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$");
  $contract[0] as $c
  | $c.environments[$environment] as $policy
  | $policy != null and
    .schema_version == 1 and
    .environment == $environment and
    .enabled == true and
    (.release | type == "object") and
    (if $policy.channel == "stable"
      then (.release | keys == ["deployed"])
      else (.release | keys == ["deployed", "next_version"]) and (.release.next_version | semver) end) and
    (.release.deployed == null or (.release.deployed | type == "object")) and
    (.deployment | keys == ["allowed_branch", "aws_region", "cluster", "cpu_architecture", "ecr_repository", "migration", "services"]) and
    .deployment.allowed_branch == $policy.allowed_branch and
    (.deployment.aws_region | type == "string" and test("^[a-z]{2}(-[a-z]+)+-[0-9]$")) and
    (.deployment.cluster | name) and
    (.deployment.ecr_repository | name) and
    .deployment.cpu_architecture == "ARM64" and
    (.deployment.services | type == "array" and length > 0) and
    all(.deployment.services[];
      keys == ["container", "name", "service", "task_definition_family"] and
      (.name as $service | $c.services | has($service)) and
      (.service | name) and (.container | name) and (.task_definition_family | name)) and
    (.deployment.services | map(.name) | unique | length) == (.deployment.services | length) and
    (.deployment.services | map(.service) | unique | length) == (.deployment.services | length) and
    (.deployment.services | map(.task_definition_family) | unique | length) == (.deployment.services | length) and
    (.deployment.migration | keys == ["task_definition_family", "writers"]) and
    (.deployment.migration.task_definition_family | name) and
    (.deployment.migration.task_definition_family as $family
      | .deployment.services | all(.task_definition_family != $family)) and
    (.deployment.migration.writers | type == "array" and length > 0 and all(.[]; name)) and
    (.deployment.migration.writers | unique | length) == (.deployment.migration.writers | length) and
    # The migration runs from the migration service image, and that service must
    # be stopped while the schema changes.
    ([.deployment.services[] | select(.name == $c.migration.service)] | length == 1) and
    ([.deployment.services[] | select(.name == $c.migration.service) | .service][0] as $writer
      | .deployment.migration.writers | index($writer) != null)
' "$manifest" >/dev/null || {
  echo "deployment manifest for $environment failed validation" >&2
  exit 1
}
