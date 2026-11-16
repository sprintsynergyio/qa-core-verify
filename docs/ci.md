# CI

This page is an example a team can copy.

Static checks do not open a browser. Run them on every pull request. Runtime checks open a browser. Run those on a schedule or from a manual trigger, not on every pull request. The example workflow is [examples/github-action.yml](../examples/github-action.yml).

## Static Checks

The static command reads spec files. It does not run Playwright and it does not need Chromium.

```sh
node dist/cli.js <project-dir>
```

Exit code `0` means no finding at or above `failOn`. The default `failOn` is `error`. Exit code `1` means a finding is at or above that level. Exit code `2` is a tool or setup error.

`--json` prints only the JSON report on stdout.

## Runtime Checks

`--only locator`, `--only inversion`, and `--only faults` copy the suite to a temp directory and run Playwright there. The original files are not written. The run uses the suite's own Playwright, from that suite's `node_modules`. Install Chromium from the suite folder, after `npm ci` in that folder, so the browser matches the suite's Playwright. The Ubuntu 24.04 pin applies only when that Playwright refuses Ubuntu 26.04. Playwright 1.60.0 does.

```sh
cd <suite>
npm ci
npx playwright install --with-deps chromium
node /path/to/qa-core-verify/dist/cli.js . --only locator
node /path/to/qa-core-verify/dist/cli.js . --only faults
```

`--only inversion` can be a long job. It runs the suite once, then once per green test, then once per assertion. `--max-runs <n>` caps the mutant runs. The plan line is printed before those runs.

A schedule or `workflow_dispatch` is the right place for these commands. A pull request job that runs them on every push will repeat the same browser runs.

## Checkout

The simplest setup is `npm install --save-dev qa-core-verify` in the suite, then `npx qa-core-verify .` in the workflow. The example instead checks out this public repository next to the suite and builds it, so a job can pin a tag or a commit. No token is needed for that checkout.

Build from the checkout and call `node .qa-core-verify/dist/cli.js`.

## This Repository

The workflow in `.github/workflows/ci.yml` typechecks and tests this repo on Node 22 and Node 24, on Ubuntu 24.04. `ubuntu-latest` is Ubuntu 26.04, and Playwright 1.60.0 refuses to install Chromium there. The job installs Chromium for the local fixture tests. It does not call SauceDemo. The live SauceDemo job runs only from `workflow_dispatch`.

`.github/workflows/publish.yml` runs on a `v*` tag push. It checks that the tag matches the `package.json` version, refuses to publish from a private repository, and runs `npm publish --provenance --access public` with the `NPM_TOKEN` secret. No sibling repository has this workflow. qa-core-heal, qa-core-flaky, and qa-core-prcheck only have CI.
