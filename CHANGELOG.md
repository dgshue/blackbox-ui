# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-11

### Added

- Point-and-click module builder covering all blackbox exporter v0.28.0 probers
  (`http`, `tcp`, `dns`, `icmp`, `grpc`, `unix`) and their documented options.
- Raw YAML editor (CodeMirror) with live syntax checking.
- Save with atomic file replace, automatic timestamped backups, retention
  pruning, and one-click restore.
- Live reload of blackbox exporter via `POST /-/reload` with surfaced errors.
- Probe testing against real targets with debug log output.
- YAML syntax + structural schema validation (errors and warnings).
- Concurrent-edit detection (refuses to clobber files changed on disk).
- Optional HTTP basic auth and read-only mode.
- Default starter config seeded on first run.
- Dockerfile, compose example, CI and GHCR release workflows.

[Unreleased]: https://github.com/dgshue/blackbox-ui/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dgshue/blackbox-ui/releases/tag/v0.1.0
