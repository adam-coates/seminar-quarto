const { sleep, launch, openHost, openPhone, gotoSlide, check } = require("./lib");

(async () => {
  const browser = await launch();
  try {
    const host = await openHost(browser);
    await gotoSlide(host, "Which language do you use most?");
    const phone = await openPhone(browser);
    await phone.waitForSelector("button[data-value='B']", { timeout: 10000 });
    await phone.click("button[data-value='B']");
    await sleep(800);
    const n = await host.$eval('.voters[data-poll="lang"]', (e) => e.textContent);
    check(n === "1", "host counts one voter, got " + n);
    const fill = await host.$eval('.lp-row[data-value="B"] .lp-n', (e) => e.textContent);
    check(fill === "1", "bar B shows 1, got " + fill);
    check(host.errors.length === 0, "host has no errors: " + host.errors.join(" | "));
    check(phone.errors.length === 0, "phone has no errors: " + phone.errors.join(" | "));
  } finally {
    await browser.close();
  }
})();
