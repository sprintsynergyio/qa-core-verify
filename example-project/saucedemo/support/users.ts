// Defaults are the SauceDemo demo user and the password printed on the login page.
// Checked on 2026-10-25. Set SAUCE_USER or SAUCE_PASSWORD to use another demo user.
export function sauceUser(): string {
  return process.env.SAUCE_USER ?? 'standard_user';
}

export function saucePassword(): string {
  return process.env.SAUCE_PASSWORD ?? 'secret_sauce';
}
