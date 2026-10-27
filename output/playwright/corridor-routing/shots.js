async (page) => {
  // Regions: [name, node id, screen offset from the node at Fit, wheel clicks].
  const prefix = await page.evaluate(() => window.__shotPrefix || 'shot');
  const regions = [
    ['fit', null, [0, 0], 0],
    ['agent-fan', 'agent:example-agent', [0, -110], 5],
    ['cognito-fan', 'resource:cognito', [10, -150], 5],
    ['client-env', 'client-envfile', [-30, -150], 5],
    ['websocket-input', 'resource:enableWebSocketApi', [80, -60], 5],
    ['http-gateway', 'gateway:http', [120, -40], 5],
  ];
  const out = {};
  for (const [name, id, [dx, dy], clicks] of regions) {
    await page.mouse.move(800, 500);
    await page.getByRole('button', { name: /fit/i }).first().click();
    await page.waitForTimeout(600);
    if (id) {
      const at = await page.evaluate((id) => window.__studioLandscape.screenOf(id), id);
      const rect = await page.locator('canvas').first().boundingBox();
      const x = rect.x + at.building.x + dx, y = rect.y + at.building.y + dy;
      await page.mouse.move(x, y);
      for (let i = 0; i < clicks; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(50); }
      await page.waitForTimeout(600);
    }
    await page.mouse.move(5, 945);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `output/playwright/corridor-routing/${prefix}-${name}.png` });
    out[name] = await page.evaluate(() => window.__studioLandscape.camera());
  }
  return out;
}
