#!/bin/sh

set -eu

script=.github/scripts/validate-deployment-manifest.sh
contract=.github/platform-release-contract.json
manifest=$(mktemp)
trap 'rm -f "$manifest"' EXIT HUP INT TERM

valid() {
  jq -n --arg environment "$1" --arg branch "$2" '{
    schema_version: 1, environment: $environment, enabled: true,
    release: ({deployed: {}} + (if $environment == "prod" then {} else {next_version: "1.0.0"} end)),
    deployment: {
      allowed_branch: $branch, aws_region: "ap-southeast-1", cluster: "EXAMPLE_CLUSTER",
      ecr_repository: "example-services", cpu_architecture: "ARM64",
      services: [
        {name: "user", service: "user-service", container: "user", task_definition_family: "USER_TDF"},
        {name: "api-gateway", service: "gateway-service", container: "gateway", task_definition_family: "GATEWAY_TDF"}
      ],
      migration: {task_definition_family: "MIGRATION_TDF", writers: ["gateway-service", "seed"]}}}'
}

accepts() {
  printf '%s\n' "$3" > "$manifest"
  sh "$script" "$contract" "$1" "$manifest" 2>/dev/null || { echo "rejected a valid $1 manifest ($2)" >&2; exit 1; }
}

rejects() {
  printf '%s\n' "$3" > "$manifest"
  if sh "$script" "$contract" "$1" "$manifest" 2>/dev/null; then
    echo "accepted an invalid $1 manifest: $2" >&2
    exit 1
  fi
}

qa=$(valid qa develop)
accepts qa "baseline" "$qa"
accepts stage "baseline" "$(valid stage main)"
accepts prod "baseline" "$(valid prod main)"
accepts qa "with a deployed record" "$(printf '%s' "$qa" | jq '.release.deployed.user = {version: "1.0.0-qa.1"}')"
accepts qa "with a migration record" "$(printf '%s' "$qa" | jq '.release.deployed.migrate = {commit: "x"}')"
rejects qa "a null ledger" "$(printf '%s' "$qa" | jq '.release.deployed = null')"
rejects qa "a ledger for an unknown service" "$(printf '%s' "$qa" | jq '.release.deployed.marketplace = {}')"

rejects qa "wrong environment" "$(valid stage develop)"
rejects qa "wrong branch" "$(valid qa main)"
rejects stage "QA branch" "$(valid stage develop)"
rejects qa "disabled" "$(printf '%s' "$qa" | jq '.enabled = false')"
rejects qa "x86 architecture" "$(printf '%s' "$qa" | jq '.deployment.cpu_architecture = "X86_64"')"
rejects qa "missing next_version" "$(printf '%s' "$qa" | jq 'del(.release.next_version)')"
rejects qa "invalid next_version" "$(printf '%s' "$qa" | jq '.release.next_version = "1.0"')"
rejects prod "own next_version" "$(valid prod main | jq '.release.next_version = "1.0.0"')"
rejects qa "no services" "$(printf '%s' "$qa" | jq '.deployment.services = []')"
rejects qa "unknown service" "$(printf '%s' "$qa" | jq '.deployment.services[0].name = "marketplace"')"
rejects qa "duplicate ECS service" "$(printf '%s' "$qa" | jq '.deployment.services[1].service = "user-service"')"
rejects qa "duplicate name" "$(printf '%s' "$qa" | jq '.deployment.services[1].name = "user"')"
rejects qa "duplicate family" "$(printf '%s' "$qa" | jq '.deployment.services[1].task_definition_family = "USER_TDF"')"
rejects qa "unsafe service name" "$(printf '%s' "$qa" | jq '.deployment.services[0].service = "x; rm -rf /"')"
rejects qa "unknown deployment key" "$(printf '%s' "$qa" | jq '.deployment.secret = "x"')"
rejects qa "unknown service key" "$(printf '%s' "$qa" | jq '.deployment.services[0].image = "x"')"
rejects qa "invalid region" "$(printf '%s' "$qa" | jq '.deployment.aws_region = "nowhere"')"
rejects qa "no migration template service" "$(printf '%s' "$qa" | jq 'del(.deployment.services[1])')"
rejects qa "migration service not a writer" "$(printf '%s' "$qa" | jq '.deployment.migration.writers = ["seed"]')"
rejects qa "no writers" "$(printf '%s' "$qa" | jq '.deployment.migration.writers = []')"
rejects qa "migration family of a service" "$(printf '%s' "$qa" | jq '.deployment.migration.task_definition_family = "USER_TDF"')"
rejects qa "unknown migration key" "$(printf '%s' "$qa" | jq '.deployment.migration.command = "x"')"

echo "validate-deployment-manifest: all tests passed"
