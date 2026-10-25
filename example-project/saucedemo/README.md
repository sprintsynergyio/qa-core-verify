# SauceDemo Demo Suite

This suite targets [SauceDemo](https://www.saucedemo.com), a free practice app. It is not a client project. The tests in `tests/good` check login, the cart badge, the locked out user, and one checkout item total. The tests in `tests/ai-style` are deliberately weak. Each weak spot has a `SEEDED` comment on the line above it. `expected-findings.json` lists those spots. `active` means the checker already reports that finding. `pending` means the rule is not built yet.

One seeded test is skipped, so Playwright does not run it. The manifest records the reason.

## How To Run

From the repository root, after installing dependencies:

```sh
npx playwright install chromium
npm run demo:saucedemo -- tests/good
```

`SAUCE_USER` defaults to `standard_user`. `SAUCE_PASSWORD` defaults to `secret_sauce`, the password SauceDemo prints on its login page. Set either variable to use another demo user.

## Checker

This command does not open a browser. It reports tests that have no assertion.

```sh
npm run build
node dist/cli.js example-project/saucedemo
```
