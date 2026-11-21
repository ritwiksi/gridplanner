import { test, expect } from '@playwright/test';

// Only run this test with LIVE_GIS_E2E=1: requires external public ArcGIS availability.
// Test actual browser CORS behavior, NOT a mocked backend or canned GeoJSON.
test('live map search retrieves authentic NYS parcels and wetland decisions from browser', async ({ page }) => {
  test.skip(!process.env.LIVE_GIS_E2E, 'Opt-in external GIS integration smoke test');
  test.setTimeout(180_000);
  page.on('pageerror', e => console.error('Browser page error:', e.message));
  page.on('console', m => { if (m.type() === 'error') console.error('Browser console:', m.text()); });
  await page.goto('/gridplanner/');
  await expect(page.locator('.source-chip').getByText('VERIFIED SAMPLE', { exact: true })).toBeVisible({timeout:15000});
  await page.locator('#radius').fill('8');
  await page.getByRole('button', { name: /find live sites/i }).click();
  // The application must switch to LIVE GIS based on independent HTTP calls.
  await expect(page.locator('.source-chip.live'), 'Error: ' + (await page.locator('.error-note').textContent().catch(() => 'none'))).toBeVisible({timeout:120000});
  const sites = page.locator('.candidate-row');
  const count = await sites.count();
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(32);
  await sites.first().click();
  await expect(page.locator('.assessment')).toBeVisible();
  await expect(page.getByText('Grid connection not evaluated')).toBeVisible();
  console.log('Verified browser-direct ArcGIS search with',count,'authentic screened candidates');
  await page.screenshot({path:'test-results/gridseeker-live-gis.png',fullPage:true});
});
