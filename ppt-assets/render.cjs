const { chromium } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

(async () => {
  const dir = path.resolve(__dirname, "svg");
  const out = path.resolve(__dirname, "png");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".svg")).sort();
  const browser = await chromium.launch({ channel: "msedge" });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
  });
  for (const f of files) {
    const url = "file:///" + path.join(dir, f).replace(/\\/g, "/");
    await page.goto(url);
    await page.waitForTimeout(250);
    const target = path.join(out, f.replace(/\.svg$/, ".png"));
    await page.screenshot({ path: target, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
    console.log("rendered", path.basename(target));
  }
  await browser.close();
})();
