# Observed Faulty User Behaviour

Observed on 2026-10-27. The login page at https://www.saucedemo.com/ listed these usernames: `standard_user`, `locked_out_user`, `problem_user`, `performance_glitch_user`, `error_user`, and `visual_user`. The same page showed the password `secret_sauce`.

`tests/good` was run once for each username with `SAUCE_USER` set and `SAUCE_PASSWORD` left at its default. The command was Playwright 1.60.0, one worker, retries 0.

## standard_user

4 passed.

## locked_out_user

3 failed, 1 passed.

`login lands on the inventory page` stayed on `https://www.saucedemo.com/` and did not reach `inventory.html`.

`add to cart updates the cart badge` timed out waiting for the Sauce Labs Backpack Add to cart button.

`checkout overview shows the backpack item total` timed out waiting for that same button.

`locked out user sees the error` passed. That test types `locked_out_user` itself.

## problem_user

1 failed, 3 passed.

`checkout overview shows the backpack item total` stayed on `https://www.saucedemo.com/checkout-step-one.html` after Continue. It did not reach `checkout-step-two.html`.

The login, cart badge, and locked out tests passed.

## performance_glitch_user

4 passed.

The PR 08 review re-run saw the login based tests take about 5.5 seconds each for this user and about 0.4 seconds for `standard_user`. A fault run sets the `page` fixture action timeout to 8 seconds. A login that is that slow can fail under a fault even though this observed run passed.

## error_user

4 passed.

## visual_user

4 passed.

## What The Fault File Uses

`qa-core-verify.faults.json` includes a `user-swap` for `problem_user` because that user broke a test in `tests/good`. `locked_out_user` also broke tests in `tests/good`. It is not a fault entry. The cart and checkout tests waited for a button that was not there, and that wait used the project test timeout.

The same file has `locked-out-error`, a `change-text` fault on `[data-test='error']` with the replacement text `not the locked out message`. `expectedToBreak` names `locked out user sees the error`. On 2026-11-14, three `--only faults` runs each failed that test on this fault with `Error: expect(locator).toHaveText(expected) failed`. The row was `trusted`. The other three tests in `tests/good` passed this fault.

Inventory images on the inventory page were a mix of inline `data:image/png` sources and `/assets/*.jpg` files. On the same date a `block-request` fault for `**/assets/*.jpg` was run through the checker. It broke no test that had passed the baseline, including every test in `tests/good`. That entry is not in the fault file.
