import { expect, type Locator, type Page } from '@playwright/test';

export class InventoryPage {
  constructor(private readonly page: Page) {}

  title(): Locator {
    return this.page.getByTestId('title');
  }

  async assertTitle(): Promise<void> {
    await expect(this.title()).toHaveText('Products');
  }
}
