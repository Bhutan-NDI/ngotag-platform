# ECS release automation (NGOTAG)

This describes how NGOTAG releases the platform services to its ECS environments.
This public repository holds the workflow and its checks, but no infrastructure
topology, account identifiers or runtime settings; those live in restricted
operations repositories and protected GitHub Environments.

## Release flow

Each service is released on its own, when it changes. The services and their
Dockerfiles are listed in `.github/platform-release-contract.json`; the private
manifest of each environment chooses which of them that environment runs.

| Environment | Source                 | Image                                     | GitHub Release                                |
| ----------- | ---------------------- | ----------------------------------------- | --------------------------------------------- |
| QA          | current `develop` head | built for `linux/arm64`                   | pre-release `platform/<service>/vX.Y.Z-qa.N`  |
| Stage       | current `main` head    | built for `linux/arm64`                   | pre-release `platform/<service>/vX.Y.Z-rc.N`  |
| Prod        | the commit Stage runs  | Stage's image, copied unchanged by digest | release `platform/<service>/vX.Y.Z`           |

A DevOps operator starts every release from a clean checkout of the environment's
branch, naming the environment and the service:

```sh
export DEPLOYMENT_CONFIG_REPOSITORY=<owner>/<manifest repository>
make qa-agent           # agent service to QA, from develop
make qa-connection      # connection service to QA, from develop
make stage-agent        # agent service to Stage, from main
make prod-agent         # promotes the agent image Stage runs to Prod; asks for confirmation
make help               # lists the services
```

Several services are released by naming several targets (`make qa-user
qa-organization`); each is its own release, one after another. Releases to the
same environment never overlap: the workflow queues them.

Make checks the branch, a clean tree, that the local head matches the remote, the
service, the private deployment manifest, and that the `Validate` CI check passed
for the exact commit. It then pushes an immutable trigger tag
(`platform-<environment>-<service>-<manifest commit>-<source commit>-<UTC time>`,
with `-migrate` appended for a migration release) and watches the workflow
(`DEPLOY_WAIT=false` skips watching). Pushing trigger tags by hand or running the
workflow any other way is not an approved release path: a tag ruleset lets only
release operators create `platform-*` tags, and each GitHub Environment accepts
only its own trigger tags.

`make prod-<service>` promotes the service's release candidate recorded in Stage's
private ledger; it never builds. It shows the release candidate and commit and asks
the operator to type `prod` (or pass `CONFIRM=prod`).

## Database migrations

Service images never change the database schema when they start. Every release
first runs `prisma migrate status` once, as a standalone task from the released
image, before the service changes. If the database lacks a migration that image
carries (or the check fails), the release stops with nothing deployed. A database
that is ahead of the image is fine, so a service released from an older commit
than the last migration still deploys.

A release that adds migrations is started with `MIGRATE=true`, usually on the
first service that needs them:

1. Stop the writer services (the API gateway and seed) by setting their desired
   count to 0.
2. Run `make <environment>-<service> MIGRATE=true`; Make asks the operator to
   type `migrate`.
3. The workflow checks that every writer is stopped and that no other migration
   task runs, then runs `prisma migrate deploy` and `prisma migrate status` once.
   A failure stops the release with nothing deployed; recover from the database
   backups instead of retrying.
4. The service rolls out. The writer services stay stopped (a released API gateway
   receives its new revision but stays stopped); start them again after the smoke
   checks.

The migration output can contain connection details, so the public log shows only
the result; the task output is in the task's CloudWatch log.

## What the workflow does

1. A job without secrets validates the trigger tag against
   `.github/platform-release-contract.json`: the environment, that QA and Stage use
   the current branch head, and that Prod promotes a commit on `main`.
2. QA and Stage: a native arm64 runner builds one single-platform `linux/arm64`
   image of the service and starts it, without network access, to prove that Node
   runs on arm64, the entry point exists, the native Prisma query engine and bcrypt
   load, and the Prisma CLI and schema are present. Nothing is pushed otherwise.
   The image tag names the service and the source commit, so a retry reuses the
   same image.
3. The deploy job resolves the release version, then builds the complete release
   notes and checks them for infrastructure identifiers. It changes nothing in ECS
   until this check passes.
4. Prod: the workflow proves that the Stage service runs the release candidate's
   image digest on ARM64 (a stopped Stage service by its task definition) and
   copies that image, byte for byte, into the Prod image repository.
5. The image is checked to be this commit's arm64 build, and the database schema
   is checked or migrated (see above).
6. The service is checked before it changes: active, expected task definition
   family, no deployment in progress, and every kept sidecar image available for
   arm64.
7. The service gets a copy of its current task definition with only the image
   replaced and the CPU architecture set to ARM64; environment files, volumes,
   roles, CPU, memory, sidecars and the desired count stay as they are. It is
   updated with the deployment circuit breaker and rollback enabled, and the
   release succeeds only after ECS reports the rollout COMPLETED and every running
   task runs the released image digest. On a failure ECS rolls the service back
   and no release is published. The rollout does not start unless its full window
   fits in both the job's remaining time and the AWS session.
8. The GitHub Release is created as a draft with the notes checked in step 3,
   checked again, and published; the live notes are checked once more.
9. The private manifest records, under the service, the version, release, image
   tag and digest, task definition, source and manifest commits, migration mode and
   time of the deployment. Other services' records are kept.

AWS access uses short-lived GitHub OIDC credentials from a role per environment
that trusts only that environment's trigger tags, may update only that
environment's platform services and run only its migration task. Private
repository access and release publishing use GitHub App tokens scoped to a single
repository and revoked after the job.

## Versions and release notes

Every service has its own version series. QA and Stage publish pre-releases of the
service's next stable version: the larger of the manifest's `next_version` and the
service's latest stable release plus one patch. Raising `next_version` in the
private manifest selects a new minor or major version for every service's next
release. Prod publishes the stable version of the release candidate it promotes and
never re-releases a version. A retried deployment reuses the release it already
published.

Release notes follow the standard format only: the heading with the component,
version and release type, the source commit, GitHub's generated change list since
the previous release of the same series, and the changelog link. Images, digests,
registries, accounts, clusters, services, task definitions, architectures and
storage or network identifiers are never published; they are kept only in the
private ledger. The release tags and trigger tags match no other workflow trigger
in this repository; CI enforces this.

## Changing the automation

`make release-check` runs every check that CI runs for the release automation. Keep
the workflow trigger globs and the resolver concurrency mapping synchronized with
the release contract; CI rejects drift. A new service needs a contract entry (its
Dockerfile and application; `make help` and the Make targets follow it) and an
entry in each private manifest that should run it.
