# SauceDemo Demo Suite

This suite targets [SauceDemo](https://www.saucedemo.com), a free practice app. It is not a client project. The tests in `tests/good` check login, the cart badge, the locked out user, and one checkout item total. The tests in `tests/ai-style` are deliberately weak. Each weak spot has a `SEEDED` comment on the line above it. `expected-findings.json` lists those spots. `active` means the static checker reports that finding. `pending` means the static command does not report it. QCV-F002, QCV-F003, and QCV-F004 run under `--only faults`, not under the static command. QCV-F004 warns when the test stays green under every fault other than blank-app. QCV-L002, QCV-L003, and QCV-L004 are checked by `--only locator`, which opens a browser. The static command below does not run them.

`qa-core-verify.faults.json` is the fault file for `--only faults`. `FAULTS.md` records the SauceDemo users that were run and what the good tests did. The fault file lists a user only when that run broke a test in `tests/good`. It also changes the text of `[data-test='error']` so `locked out user sees the error` fails that fault.

One seeded test is skipped, so Playwright does not run it. The manifest records the reason.

## How To Run

From the repository root, after installing dependencies:

```sh
npx playwright install chromium
npm run demo:saucedemo -- tests/good
```

`SAUCE_USER` defaults to `standard_user`. `SAUCE_PASSWORD` defaults to `secret_sauce`, the password SauceDemo prints on its login page. Set either variable to use another demo user.

## Checker

This command does not open a browser. It reports the static weak assertion rules in [docs/rules.md](../../docs/rules.md). `tests/good` is written to stay clear of those rules. The checker writes `report.json`, `report.md`, and `report.html` under `.qa-core/verify` in this folder.

The locator check does open a browser:

```sh
node dist/cli.js example-project/saucedemo --only locator
```

The fault check opens a browser too. It reads `qa-core-verify.faults.json` in this folder:

```sh
node dist/cli.js example-project/saucedemo --only faults
```

```sh
npm run build
node dist/cli.js example-project/saucedemo
```
