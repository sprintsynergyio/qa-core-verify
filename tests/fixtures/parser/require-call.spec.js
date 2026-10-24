const pw = require('@playwright/test');

pw('require default call', async () => {
  await pw.expect(true).toBe(true);
});

pw.test.skip('require skip', async () => {});
