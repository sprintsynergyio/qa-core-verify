# qa-core-verify

qa-core-verify audits a Playwright test suite, often one written by an AI, and reports whether each test can be trusted to go red when the feature breaks. This repository is work in progress, private, internal use only. It stays private until v0.1 review.

## Quick Start

Clone this repository and run the checker from that clone. This version reads spec files with the TypeScript parser. It does not run the tests, it does not execute spec code, and it does not open a browser. The install can skip the Playwright browser download.

```sh
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
npm run build
node dist/cli.js <project-dir>
```

`node dist/cli.js --help` prints the options. Pass spec paths or globs after the project directory to limit the scan. `--json` prints the raw findings array. That JSON format is unstable.

An optional `qa-core-verify.config.json` in the project directory can name assertion helpers. A call that matches `assertFunctionNames` or `assertFunctionPatterns` counts as an assertion for QCV-W001. Patterns are regular expressions, the same idea as eslint-plugin-playwright `expect-expect`.

```json
{
  "assertFunctionNames": ["assertLoggedIn"],
  "assertFunctionPatterns": ["^assert.*"]
}
```

## Rules

- QCV-W001 Test Has No Assertion (error)

## Demo Suite

The folder `example-project/saucedemo` is a Playwright suite for [SauceDemo](https://www.saucedemo.com), a free practice app. It has a few honest tests and deliberately weak tests. The weak spots are marked with `SEEDED` comments and listed in `expected-findings.json`. See [example-project/saucedemo/README.md](example-project/saucedemo/README.md).

```sh
npx playwright install chromium
npm run demo:saucedemo -- tests/good
```

`npm test` includes a golden test that reads that manifest. The golden test does not open a browser. To print the current findings:

```sh
npm run build
node dist/cli.js example-project/saucedemo
```

## License

MIT. Copyright 2026 Muhammad Usman. See [LICENSE](LICENSE).
