const { launch, openHost, openPhone, check } = require("./lib");
(async () => {
  const browser = await launch();
  const host = await openHost(browser, "index.html");
  const p = await openPhone(browser, "index.html");
  check(await p.$eval("#bar", (b) => b.hidden), "signals/reactions bar hidden by default");
  check(!(await host.$("#livepoll-signals")), "no signals section in the presenter's panel");
  check(!/lost/.test(await host.$eval("#livepoll-live", (e) => e.textContent)), "no signals line in the live display");
  await browser.close();
})();
