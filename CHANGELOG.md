# Changelog

## Unreleased

- Treat an awaited or returned Promise.all, Promise.allSettled, and test.step as waiting for the assertion inside it.
- Follow locator and page read fields on a page object, including constructor assignments, initializers, and getters.
- Flag every unawaited async matcher, including expect.poll, without requiring the subject to be a locator or a page.
- Do not flag a loop over a non-empty array literal, or over a const in the same test bound to one.
- Add static weak assertion rules QCV-W000 through QCV-W010, with one file per rule and good and bad fixtures.
- Follow one relative import into a helper or page object. A second import is QCV-W000 when the call could be an assertion or a locator.
- Scaffold the TypeScript CLI, the spec inventory parser, and rule QCV-W001 Test Has No Assertion.
- Do not inventory a test call inside a hook callback or a timer callback.
- Add a SauceDemo demo suite, an expected-findings manifest, and a golden test for active findings.
