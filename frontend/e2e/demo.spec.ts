import { test, expect } from '@playwright/test';

test('real verified data: configure, screen, select, and assess a parcel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('BROWSER PAGEERROR:', err.stack));
  page.on('response', response => { if(response.status()>=400) console.log('HTTP ERROR:',response.status(),response.url()); });
  await page.goto('/gridplanner/');
  await page.waitForTimeout(800);
  console.log('PAGE URL:',page.url(),'TITLE:',await page.title(),'BODY:',(await page.locator('body').innerText()).slice(0,900),'ROOT:',(await page.locator('#root').innerHTML()).slice(0,500));
  await expect(page.getByText('VERIFIED SAMPLE')).toBeVisible();
  await expect(page.locator('.candidate-row')).toHaveCount(25, { timeout: 20_000 });
  await page.locator('#capacity').fill('2');
  await page.getByRole('button', { name: /screen verified sample/i }).click();
  const first = page.locator('.candidate-row').first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page.locator('.assessment')).toBeVisible();
  await expect(page.getByText('Gross area threshold passed')).toBeVisible();
  await expect(page.getByText('Grid connection not evaluated')).toBeVisible();
  await expect(page.getByRole('button', { name: /export assessment/i })).toBeVisible();
  await page.screenshot({ path: 'test-results/gridseeker-assessment.png', fullPage: true });
});

test('demo mode does not claim live availability and filters genuine parcels', async ({ page }) => {
  await page.goto('/gridplanner/');
  await expect(page.locator('.candidate-row')).toHaveCount(25, { timeout: 20_000 });
  await page.locator('#minimum').fill('2000');
  await page.getByRole('button', { name: /screen verified sample/i }).click();
  await expect(page.getByText('No parcels in this view meet the current filter.')).toBeVisible();
  await expect(page.getByText('VERIFIED SAMPLE')).toBeVisible();
});
