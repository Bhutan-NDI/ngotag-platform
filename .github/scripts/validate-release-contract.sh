#!/bin/sh

set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <release-contract>" >&2
  exit 2
fi

contract=$1

test -f "$contract" || {
  echo "release contract does not exist: $contract" >&2
  exit 1
}

# Every service is released on its own. QA releases come from develop, Stage
# from main, and Prod only promotes the image Stage runs. Every service is
# published for the same single platform. A release only checks the database
# schema. Migrations are applied by a separate operation (make <env>-<target>):
# one task from the template service's (API gateway's) image and task definition.
jq -e '
  def name: type == "string" and test("^[a-z][a-z0-9-]{0,62}$");
  .schema_version == 1 and
  (keys == ["ci", "environments", "migration", "release", "schema_version", "services"]) and
  (.release | keys == ["image_tag_prefix", "platform", "tag_prefix", "title"]) and
  .release.tag_prefix == "platform/{service}/v" and
  .release.image_tag_prefix == "platform-" and
  .release.platform == "linux/arm64" and
  (.release.title | type == "string" and length > 0) and
  (.services | type == "object" and length > 0) and
  all(.services | to_entries[];
    (.key | name) and
    (.value | keys - ["legacy_name"] == ["app", "dockerfile"]) and
    (.value.app | name) and
    ((.value.legacy_name // .key) | name) and
    (.value.dockerfile | type == "string" and test("^Dockerfiles/Dockerfile\\.[a-z0-9-]+$"))) and
  (.migration | keys == ["deploy_command", "status_command", "target", "template_service"]) and
  (.migration.template_service as $service | .services | has($service)) and
  (.migration.target | name) and
  (.migration.target as $target | .services | has($target) | not) and
  (.migration.status_command | type == "string" and test("prisma migrate status")) and
  (.migration.deploy_command | type == "string" and test("prisma migrate deploy")) and
  (.environments | keys == ["prod", "qa", "stage"]) and
  ([.environments | to_entries[] | select(
    .value.tag_prefix != ("platform-" + .key + "-") or
    (.value.allowed_branch | test("^(develop|main)$") | not) or
    (.value.channel | IN("qa", "rc", "stable") | not) or
    (.value.legacy_release_pattern | type == "string" and contains("{legacy}") | not)
  )] | length == 0) and
  .environments.qa.allowed_branch == "develop" and
  .environments.qa.channel == "qa" and
  (.environments.qa | has("promote_from") | not) and
  .environments.stage.allowed_branch == "main" and
  .environments.stage.channel == "rc" and
  (.environments.stage | has("promote_from") | not) and
  .environments.prod.allowed_branch == "main" and
  .environments.prod.channel == "stable" and
  .environments.prod.promote_from == "stage" and
  (.ci | keys == ["app_slug", "check_name"]) and
  (.ci.check_name | type == "string" and length > 0) and
  (.ci.app_slug | type == "string" and length > 0)
' "$contract" >/dev/null || {
  echo "release contract failed validation: $contract" >&2
  exit 1
}

# Every service must name the Dockerfile that builds it, and that Dockerfile must
# build the named application.
jq -r '.services | to_entries[] | [.key, .value.dockerfile, .value.app] | @tsv' "$contract" |
  while IFS="$(printf '\t')" read -r service dockerfile app; do
    test -f "$dockerfile" || { echo "service $service: $dockerfile does not exist" >&2; exit 1; }
    grep -Eq "pnpm run build ${app}([[:space:]]|\$)" "$dockerfile" || {
      echo "service $service: $dockerfile does not build $app" >&2
      exit 1
    }
  done
