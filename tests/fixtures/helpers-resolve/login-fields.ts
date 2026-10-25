import { type Locator, type Page } from '@playwright/test';

export class LoginFields {
  readonly title: Locator;
  readonly banner = this.page.getByRole('alert');
  readonly ready = true;

  constructor(private readonly page: Page) {
    this.title = this.page.getByTestId('title');
  }

  get status(): Locator {
    return this.page.getByTestId('status');
  }

  get label() {
    return this.page.getByTestId('title').textContent();
  }
}
