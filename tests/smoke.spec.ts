import { test, expect } from '@playwright/test';

test('GET /api/catalog/catalogbrands returns a non-empty array', async ({ request }) => {
  const response = await request.get('/api/catalog/catalogbrands?api-version=1.0');

  expect(response.status()).toBe(200);

  const brands = await response.json();
  expect(Array.isArray(brands)).toBe(true);
  expect(brands.length).toBeGreaterThan(0);
});
