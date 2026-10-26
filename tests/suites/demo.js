const { sleep, launch, openHost, openPhone, gotoSlide, check } = require("./lib");
const OUT = require("./lib").OUT + "shots/";
(async () => {
  const browser = await launch();
  try {
    const host = await openHost(browser, "index.html");
    const p = await openPhone(browser, "index.html");
    await p.waitForSelector("#nickInput"); await p.type("#nickInput", "Tester"); await p.click("#nickForm button[type=submit]");
    await gotoSlide(host, "Spot the outlier");
    await p.waitForFunction(() => { const im = document.querySelector("#hotFrame img"); return im && im.naturalWidth > 0; });
    const box = await (await p.$("#hotFrame")).boundingBox();
    await p.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.8);
    await p.click("#hotSubmit");
    await sleep(800);
    await host.evaluate(() => Reveal.nextFragment());
    await sleep(800);
    check(/1 of 1 inside/.test(await host.$eval(".lp-hot-score", (e) => e.textContent)), "demo hotspot answer matches the outlier");
    await host.screenshot({ path: OUT + "40-demo-hotspot.png" });
    for (const t of ["Peer instruction", "How many?", "What should we revisit?", "Pick every prime", "Your questions", "Leaderboard"]) {
      await gotoSlide(host, t);
      await host.screenshot({ path: OUT + "41-demo-" + t.replace(/\W+/g, "-") + ".png" });
    }
    check(host.errors.length === 0 && p.errors.length === 0, "no errors: " + host.errors.concat(p.errors).join(" | "));
  } catch (e) { console.log("FAIL", e); process.exitCode = 1; } finally { await browser.close(); }
})();
