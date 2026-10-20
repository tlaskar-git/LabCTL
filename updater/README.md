# labctl-updater

Small sidecar that updates the `labctl` container. It has no npm dependencies. It talks to the Docker Engine API over
the unix socket, so it runs as root and must never publish a port.

## Network

The sidecar is attached only to the `labctl-internal` network, which is `internal: true`. It has no published port and
no route to the internet. `labctl` is on both `default` and `labctl-internal`, so the server reaches the sidecar at
`http://labctl-updater:8080` (`LABCTL_UPDATER_URL`) and the sidecar reaches `http://labctl:7700` for health and backup.

The sidecar needs no egress. The Docker daemon on the host does the fetching:

- Image mode: the daemon pulls `ghcr.io/tlaskar-git/labctl:<tag>` through the mounted socket. The GitHub release check
  runs in the `labctl` container, not here.
- Git mode: the daemon builds from a remote git context through the Engine API. The sidecar runs no `git` binary.

This needs Docker Engine 25 or later (API 1.44), which accepts several networks when a container is created.

## Environment variable names

| Name | Purpose |
|---|---|
| `LABCTL_UPDATER_SECRET` | Required. Every request except `GET /healthz` must send it in the `X-Updater-Secret` header. |
| `LABCTL_URL` | labctl base URL on the Compose network. Default `http://labctl:7700`. |
| `LABCTL_CONTAINER` | Container to recreate. Default `labctl`. |
| `LABCTL_IMAGE` | Image repository. Default `ghcr.io/tlaskar-git/labctl`. |
| `LABCTL_DATA_DIR` | Data folder mounted in the sidecar, for the file-copy backup. Default `/data`. |
| `LABCTL_REPO_DIR` | Optional. Switches git mode to the mounted-checkout fallback (see below). |

## Endpoints

| Request | Effect |
|---|---|
| `POST /update` `{"image_tag":"v1.2.3"}` | Record the current image, pull the tag, back up, recreate, wait up to 90 s for `/api/health` to report the new version, otherwise recreate from the previous image id and report `rolled_back`. |
| `POST /update-git` `{"repo"?, "ref"?}` | Git mode: the daemon builds `server/Dockerfile` from the remote git context, the sidecar backs up, recreates `labctl` from the new image and waits for `/api/health`. On failure it recreates from the previous image id, as in image mode. |
| `POST /rollback` | Recreate the container from the previous image id of the last run. |
| `GET /status` | State (`idle`, `running`, `succeeded`, `rolled_back`, `failed`) and timestamped steps. |
| `GET /healthz` | Liveness, no secret needed. |

The backup step calls `POST /api/backup/run` on labctl with the same secret header. If that call fails it copies
`labctl.db`, `labctl.db-wal` and `labctl.db-shm` to `backups/pre-update-<timestamp>/` in the data folder.

## Git mode

Primary (remote context): the sidecar calls `POST /build?remote=<repo>#<ref>&dockerfile=server/Dockerfile&t=ghcr.io/tlaskar-git/labctl:git`
on the Engine API. The daemon on the host fetches the source, so the sidecar needs no egress and no `git`. The server
sends the repo and ref from the settings `update_git_repo` (default `https://github.com/tlaskar-git/LabCTL.git`) and
`update_git_ref` (default `main`). Set them with `PUT /api/updates/mode` (`git_repo`, `git_ref`). Both the server and
the sidecar check them against a strict allowlist: `https` only, host `github.com`, `<owner>/<name>` only, and a ref
of letters, digits, `.`, `_`, `-` and `/` that starts with a letter or digit and holds no `..`. The health check
accepts any healthy answer, because the new version is not known before the build.

Fallback (mounted checkout): set `LABCTL_REPO_DIR` and mount the checkout at the same path as on the host. The sidecar
then runs `docker compose build labctl` and `docker compose up -d --no-deps labctl` from that checkout. It does not
run `git pull`. The host must keep the checkout current, for example with a cron job or a deploy hook. Use this for
private forks or hosts whose daemon cannot reach the repository. The rollback is the same as in image mode.

The previous image stays on disk as an untagged image until you prune. Do not run `docker image prune` during an update.

## Tests

`node --test updater` runs the state machine against a fake Docker client. `package.json` names the test file as
`main` only so that the directory form of that command works.
