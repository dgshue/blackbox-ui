# blackbox-ui

A web UI sidecar for configuring the [Prometheus Blackbox Exporter](https://github.com/prometheus/blackbox_exporter).

Build probe modules with a point-and-click form builder or edit the raw YAML directly — blackbox-ui writes the config file the exporter reads, takes an automatic backup on every save, and live-reloads blackbox via its `/-/reload` endpoint. Then test any module against a real target without leaving the page.

## Features

- **Point-and-click module builder** for every blackbox prober: `http`, `tcp`, `dns`, `icmp`, `grpc`, and `unix` — every documented option of blackbox exporter v0.28.0, with inline help and defaults.
- **Raw YAML editor** (CodeMirror) with live syntax checking, for hand-tuning or options the forms don't cover.
- **Save & reload in one click** — writes the shared config file atomically and POSTs `/-/reload` to blackbox; reload errors from blackbox are surfaced verbatim.
- **Automatic backups** before every save, with one-click restore (which also takes a backup, so restores are never destructive).
- **Probe testing** — run any module against a target straight from the UI and see `probe_success`, duration, and the full debug log.
- **Validation** — YAML syntax plus a structural check against the blackbox config schema (unknown options, wrong types, missing required fields).
- **Safe by design** — unmodeled/hand-written YAML keys survive form edits; concurrent-edit detection prevents silently clobbering changes made outside the UI.

## Quick start

```yaml
# docker-compose.yml
services:
  blackbox:
    image: prom/blackbox-exporter:v0.28.0
    restart: unless-stopped
    command:
      - --config.file=/config/blackbox.yml
    ports:
      - "9115:9115"
    cap_add:
      - NET_RAW # ICMP probes
    sysctls:
      net.ipv4.ping_group_range: "0 2147483647"
    volumes:
      - blackbox-config:/config
    depends_on:
      blackbox-ui:
        condition: service_healthy

  blackbox-ui:
    image: ghcr.io/dgshue/blackbox-ui:latest
    restart: unless-stopped
    environment:
      CONFIG_PATH: /config/blackbox.yml
      BLACKBOX_URL: http://blackbox:9115
    ports:
      - "9116:8080"
    volumes:
      - blackbox-config:/config

volumes:
  blackbox-config:
```

```
docker compose up -d
```

Open **http://localhost:9116** — blackbox-ui seeds a starter config (`http_2xx`, `tcp_connect`, `icmp`, …) on first run, which is why `blackbox` waits for the sidecar to be healthy before starting.

## How it works

```
                 shared volume
┌──────────────┐  /config/blackbox.yml  ┌────────────────────┐
│  blackbox-ui │ ─────── writes ──────► │  blackbox exporter │
│    :8080     │                        │       :9115        │
│              │ ── POST /-/reload ───► │                    │
└──────────────┘                        └────────────────────┘
```

blackbox-ui is a *sidecar*: it needs nothing more than (1) a volume shared with the exporter containing the config file and (2) HTTP access to the exporter for reloads, status, and probe tests. It works just as well alongside an existing blackbox deployment — mount your current config location and point `BLACKBOX_URL` at it.

### Adding to an existing blackbox exporter

```yaml
  blackbox-ui:
    image: ghcr.io/dgshue/blackbox-ui:latest
    environment:
      CONFIG_PATH: /config/blackbox.yml   # wherever your blackbox config lives
      BLACKBOX_URL: http://blackbox:9115
      SEED_DEFAULT_CONFIG: "false"        # don't create a file if yours is missing
    volumes:
      - /path/to/your/blackbox/config:/config
    ports:
      - "9116:8080"
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP port the UI listens on |
| `CONFIG_PATH` | `/config/blackbox.yml` | Path of the blackbox config file to manage |
| `BLACKBOX_URL` | `http://blackbox:9115` | Base URL of the blackbox exporter (reload/status/probe) |
| `PUBLIC_BLACKBOX_URL` | – | Browser-reachable blackbox URL; adds an "Open blackbox" link |
| `SEED_DEFAULT_CONFIG` | `true` | Write a starter config if `CONFIG_PATH` doesn't exist |
| `BACKUP_DIR` | `<config dir>/.backups` | Where pre-save backups are stored |
| `BACKUP_KEEP` | `20` | Number of backups to retain |
| `BASIC_AUTH_USERNAME` / `BASIC_AUTH_PASSWORD` | – | Enable HTTP basic auth when both are set |
| `READ_ONLY` | `false` | Disable all writes (view-only mode) |

## HTTP API

Everything the UI does is available as a small JSON API:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/config` | Current file content + mtime |
| `PUT` | `/api/config` | `{raw, reload?, baseMtime?, force?}` → validate, backup, write, reload |
| `POST` | `/api/validate` | `{raw}` → syntax + structural validation results |
| `POST` | `/api/reload` | Trigger a blackbox reload |
| `GET` | `/api/backups` | List backups |
| `POST` | `/api/backups/:name/restore` | Restore a backup (backs up current first) and reload |
| `GET` | `/api/probe?module=&target=` | Proxy a debug probe through blackbox |
| `GET` | `/api/status` | App, config-file, and blackbox health/version status |
| `GET` | `/api/schema` | The module schema driving the form builder |
| `GET` | `/healthz` | Liveness (used by the container healthcheck) |

## Scraping the probes with Prometheus

blackbox-ui manages the *exporter's* config. Your Prometheus still scrapes blackbox as usual:

```yaml
scrape_configs:
  - job_name: blackbox-http
    metrics_path: /probe
    params:
      module: [http_2xx]   # any module you built in the UI
    static_configs:
      - targets: ["https://example.com", "https://grafana.com"]
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: blackbox:9115
```

## Security notes

- The UI has **no authentication by default** — it is meant for trusted networks. Set `BASIC_AUTH_USERNAME`/`BASIC_AUTH_PASSWORD`, or put it behind your reverse proxy / SSO (Traefik, Authelia, etc.). `READ_ONLY=true` gives you a safe dashboard-only deployment.
- Secrets typed into module forms (passwords, bearer tokens) are stored in the blackbox config file, exactly as if you had written the YAML by hand. Prefer `*_file` variants where possible.
- The container runs as root by default so it can write config volumes that other images initialized (see below).

### Permissions

The blackbox exporter image runs as `nobody` and only needs to *read* the config; blackbox-ui needs to *write* it. With a named volume this works out of the box (files are written world-readable, `0644`). If you bind-mount a host directory and want blackbox-ui to run unprivileged, align ownership yourself and run with `user: "<uid>:<gid>"`.

## Development

```bash
npm install
CONFIG_PATH=./tmp/blackbox.yml BLACKBOX_URL=http://localhost:9115 npm run dev
# UI on http://localhost:8080
npm test
```

No build step — the frontend is plain HTML/CSS/JS served by Express; CodeMirror and js-yaml are served from `node_modules`.

## Versioning & releases

Releases follow [semver](https://semver.org) (`MAJOR.MINOR.PATCH`). Pushing a tag like `v0.1.0` builds and publishes multi-arch images (amd64/arm64) to GHCR:

- `ghcr.io/dgshue/blackbox-ui:0.1.0` — exact version
- `ghcr.io/dgshue/blackbox-ui:0.1` — latest patch of a minor
- `ghcr.io/dgshue/blackbox-ui:latest` — latest release

See [CHANGELOG.md](CHANGELOG.md).

## License

[Apache-2.0](LICENSE) — same as the Prometheus ecosystem. Not affiliated with the Prometheus project.
