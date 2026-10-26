// The browser's random id: how long it lasts, and the notice for `ids: persistent`.
const { sleep, launch, openHost, openPhone, check } = require("./lib");

const HOUR = 3600 * 1000;
const stored = (p) => p.evaluate(() => localStorage.getItem("livepoll_device"));
const parsed = async (p) => { try { return JSON.parse(await stored(p)); } catch (e) { return null; } };
const setStored = (p, value) => p.evaluate((v) => localStorage.setItem("livepoll_device", v), value);
async function reload(p) {
  await p.reload({ waitUntil: "networkidle0" });
  await p.waitForFunction(() => !/Reading deck/.test(document.getElementById("status").textContent));
  await sleep(300);
}
const noticeShown = (p) => p.$eval("#idNotice", (n) => !n.hidden);

(async () => {
  const browser = await launch();
  try {
    // --- default (`session`): the id expires 12 hours after it was last used
    await openHost(browser, "test.html");
    const p = await openPhone(browser, "test.html");
    const first = await parsed(p);
    check(first && /^[a-z0-9]{16}$/.test(first.id) && typeof first.t === "number", "phone stores {id, t}: " + (await stored(p)));
    check(!(await noticeShown(p)), "no persistent-id notice on a session deck");

    await setStored(p, JSON.stringify({ id: first.id, t: Date.now() - 1 * HOUR }));
    await reload(p);
    const sameDay = await parsed(p);
    check(sameDay.id === first.id, "id kept within 12 hours");
    check(Date.now() - sameDay.t < 60 * 1000, "using it refreshes its time");

    await setStored(p, JSON.stringify({ id: first.id, t: Date.now() - 13 * HOUR }));
    await reload(p);
    const nextWeek = await parsed(p);
    check(nextWeek.id && nextWeek.id !== first.id, "id replaced after 12 hours");

    await setStored(p, "oldstyleid12345x");
    await reload(p);
    const upgraded = await parsed(p);
    check(upgraded && upgraded.id !== "oldstyleid12345x", "an id from before expiry is replaced");

    // --- the deck reads and writes the same format
    const host = await openHost(browser, "test.html");
    const hostId = await host.evaluate(() => Livepoll.deviceId());
    const hostStored = await host.evaluate(() => JSON.parse(localStorage.getItem("livepoll_device")));
    check(hostStored && hostStored.id === hostId, "deck stores the same {id, t} format");

    // --- `ids: persistent`: the id lasts, and participants are told
    await openHost(browser, "test3.html");
    const q = await openPhone(browser, "test3.html");
    check(await noticeShown(q), "persistent-id notice shown");
    const kept = await parsed(q);
    await setStored(q, JSON.stringify({ id: kept.id, t: Date.now() - 30 * 24 * HOUR }));
    await reload(q);
    check((await parsed(q)).id === kept.id, "persistent deck keeps the id after 30 days");

    for (const [name, page] of [["phone", p], ["host", host], ["persistent phone", q]]) {
      check(page.errors.length === 0, name + " has no errors: " + page.errors.join(" | "));
    }
  } catch (e) {
    console.log("FAIL: exception", e);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
