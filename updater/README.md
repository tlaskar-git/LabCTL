# labctl-updater

Small sidecar that updates the `labctl` container. It has no npm dependencies. It talks to the Docker Engine API over
the unix socket, so it runs as root and must never publish a port.

## Environment variable names

| Name | Purpose |
|---|---|
| `LABCTL_UPDATER_SECRET` | Required. Every request except `GET /healthz` must send it in the `X-Updater-Secret` header. |
| `LABCTL_URL` | labctl base URL on the Compose network. Default `http://labctl:7700`. |
| `LABCTL_CONTAINER` | Container to recreate. Default `labctl`. |
| `LABCTL_IMAGE` | Image repository. Default `ghcr.io/tlaskar-git/labctl`. |
| `LABCTL_DATA_DIR` | Data folder mounted in the sidecar, for the file-copy backup. Default `/data`. |
| `LABCTL_REPO_DIR` | Git mode only: the checkout, mounted at the same path as on the host. |

## Endpoints

| Request | Effect |
|---|---|
| `POST /update` `{"image_tag":"v1.2.3"}` | Record the current image, pull the tag, back up, recreate, wait up to 90 s for `/api/health` to report the new version, otherwise recreate from the previous image id and report `rolled_back`. |
| `POST /update-git` | Git mode: `git pull --ff-only`, compose build and up, health check, reset to the previous commit on failure. |
| `POST /rollback` | Recreate the container from the previous image id of the last run. |
| `GET /status` | State (`idle`, `running`, `succeeded`, `rolled_back`, `failed`) and timestamped steps. |
| `GET /healthz` | Liveness, no secret needed. |

The backup step calls `POST /api/backup/run` on labctl with the same secret header. If that call fails it copies
`labctl.db`, `labctl.db-wal` and `labctl.db-shm` to `backups/pre-update-<timestamp>/` in the data folder.

## Tests

`node --test updater` runs the state machine against a fake Docker client. `package.json` names the test file as
`main` only so that the directory form of that command works.
