const { sleep, launch, newPage, check } = require("./lib");
(async () => {
  const browser = await launch();
  const page = await newPage(browser, { viewport: { width: 1200, height: 800 } });
  await page.goto("http://localhost:8080/index.html?print-pdf", { waitUntil: "networkidle0" });
  await sleep(2500);
  check(page.errors.length === 0, "print-pdf has no errors: " + page.errors.join(" | "));
  const pages = await page.$$eval(".pdf-page", (p) => p.length);
  check(pages > 10, "pdf pages laid out: " + pages);
  // speaker view preview iframe (receiver) shows no restore banner
  const r = await newPage(browser, { viewport: { width: 1200, height: 800 } });
  await r.goto("http://localhost:8080/index.html", { waitUntil: "networkidle0" });
  await r.evaluate(() => localStorage.setItem("livepoll-autosave:" + location.pathname, JSON.stringify({ version: 1, saved: Date.now(), responses: 3, exported: false, data: {} })));
  await r.goto("http://localhost:8080/index.html?receiver", { waitUntil: "networkidle0" });
  await sleep(1500);
  check(!(await r.$("#livepoll-restore")), "no restore banner in a receiver frame");
  await r.goto("http://localhost:8080/index.html", { waitUntil: "networkidle0" });
  await sleep(1500);
  check(!!(await r.$("#livepoll-restore")), "restore banner on the deck itself");
  await browser.close();
})();
