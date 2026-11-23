.PHONY: help release-check

DEPLOY_WAIT ?= true
DEPLOYMENT_CONFIG_REPOSITORY ?=
CONFIRM ?=

# A DevOps operator releases one service to one environment at a time:
#   make qa-<service>     releases the service from the current develop head to QA
#   make stage-<service>  releases it from the current main head to Stage as a release candidate
#   make prod-<service>   promotes the exact image Stage runs to Prod (asks for confirmation)
# for example `make qa-agent`, `make stage-connection`, `make prod-agent`.
# Database migrations are a separate operation that deploys no service:
#   make qa-migrate | stage-migrate | prod-migrate
# runs one task with the API gateway image and the Prisma migrate command after
# the writer services are stopped. `make help` lists the services. Each target
# pins the private manifest commit and the source commit in an immutable trigger
# tag; .github/workflows/deploy-platform.yml repeats every check before it
# obtains AWS credentials. See docs/ecs-release-automation.md.
help:
	@echo "Release one service:  make qa-<service> | stage-<service> | prod-<service>"
	@echo "Apply migrations:     make qa-$$(jq -r '.migration.target' .github/platform-release-contract.json) | stage-... | prod-..."
	@echo "Services: $$(jq -r '.services | keys | join(" ")' .github/platform-release-contract.json)"

qa-% stage-% prod-%:
	@DEPLOY_ENV="$(firstword $(subst -, ,$@))" SERVICE="$*" DEPLOY_WAIT="$(DEPLOY_WAIT)" \
		CONFIRM="$(CONFIRM)" DEPLOYMENT_CONFIG_REPOSITORY="$(DEPLOYMENT_CONFIG_REPOSITORY)" \
		sh .github/scripts/trigger-release.sh

# Validates the release automation; CI runs the same checks.
release-check:
	@sh .github/scripts/test-release-automation.sh
