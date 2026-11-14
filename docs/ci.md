# CI

Private, internal review build. Not released. This page is an example a team can copy. It is not a claim that a package is on a registry.

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

This repository is private. A workflow in another repository checks it out with a token that can read `github.com/sprintsynergyio/qa-core-verify`. `GITHUB_TOKEN` from the other repository cannot read this one. The example calls that secret `QA_CORE_VERIFY_TOKEN`.

Build from the checkout and call `node .qa-core-verify/dist/cli.js`. Do not `npm install qa-core-verify`. The package is not published. `package.json` keeps `"private": true`.

## This Repository

The workflow in `.github/workflows/ci.yml` typechecks and tests this repo on Node 22 and Node 24, on Ubuntu 24.04. `ubuntu-latest` is Ubuntu 26.04, and Playwright 1.60.0 refuses to install Chromium there. The job installs Chromium for the local fixture tests. It does not call SauceDemo. The live SauceDemo job runs only from `workflow_dispatch`.

`.github/workflows/publish.yml` is prepared for a later tag push. It is not used while `"private": true` stays set. It refuses to publish while the repository is private, so `npm publish --provenance` does not run. No sibling repository has this workflow. qa-core-heal, qa-core-flaky, and qa-core-prcheck only have CI.
