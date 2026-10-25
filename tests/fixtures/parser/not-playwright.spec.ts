function test(title, fn) {
  fn();
}

test('not a playwright test', () => {});
