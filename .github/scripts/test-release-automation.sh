#!/bin/sh

# Runs every release-automation check. Needs bash, jq, and mikefarah yq v4
# (preinstalled on GitHub-hosted Ubuntu runners).

set -eu

scripts=.github/scripts
contract=.github/platform-release-contract.json

for script in "$scripts"/*.sh; do
  case "$(head -n 1 "$script")" in
    *bash*) bash -n "$script" ;;
    *) sh -n "$script" ;;
  esac
done

sh "$scripts/validate-release-contract.sh" "$contract"
sh "$scripts/validate-workflow-contract.sh" "$contract" .github/workflows/deploy-platform.yml .github/workflows
sh "$scripts/test-resolve-release-version.sh"
sh "$scripts/test-render-task-definition.sh"
sh "$scripts/test-check-release-notes.sh"
sh "$scripts/test-deployment-manifest.sh"
sh "$scripts/test-selectors.sh"
sh "$scripts/test-wait-for-ci.sh"
sh "$scripts/test-ecr-image-digest.sh"
bash "$scripts/test-deploy-services.sh"
bash "$scripts/test-run-migration.sh"
bash "$scripts/test-promote-stage-images.sh"

echo "release automation: all checks passed"
