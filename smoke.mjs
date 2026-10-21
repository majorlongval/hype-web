import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const url = process.argv[2] ?? "http://127.0.0.1:8080/?disc=http";
const seconds = Number(process.argv[3] ?? 30);
const shots = (process.argv[4] ?? "").split(",").filter(Boolean).map(Number);
const keys = JSON.parse(process.argv[5] ?? "[]");
const candidates = [process.env.CHROME, `${homedir()}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`, "/opt/pw-browsers/chromium"];
const executablePath = candidates.find((p) => p && existsSync(p));
const launch = { executablePath, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] };
const viewport = { width: 1280, height: 960 };
const browser = process.env.PROFILE
  ? await chromium.launchPersistentContext(process.env.PROFILE, { ...launch, viewport })
  : await chromium.launch(launch);
const page = await browser.newPage(process.env.PROFILE ? undefined : { viewport });
page.on("console", (m) => console.log(`[console.${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(url);
if (process.env.ISO) await page.setInputFiles("#iso", process.env.ISO);
await page.click("#play");
const t0 = Date.now();
let k = 0;
for (let s = 1; s <= seconds; s++) {
  await page.waitForTimeout(1000);
  while (k < keys.length && keys[k][0] <= s) {
    const [, key, hold] = keys[k++];
    await page.keyboard.down(key);
    await page.waitForTimeout(hold ?? 120);
    await page.keyboard.up(key);
    console.log(`[key] ${key} at ${s}s`);
  }
  if (shots.includes(s)) await page.screenshot({ path: `/tmp/hype-${s}.png` });
  if (s % 5 === 0) console.log(`[t=${s}] ${await page.textContent("#stats")} | ${await page.textContent("#status")}`);
}
console.log("---- page log ----");
console.log(await page.textContent("#log"));
await page.screenshot({ path: "/tmp/hype-final.png" });
const stored = await page.evaluate(async () => {
  const out = [];
  const walk = async (dir, prefix) => {
    for await (const [name, h] of dir.entries()) {
      if (h.kind === "file") out.push(`${prefix}${decodeURIComponent(name)} (${(await h.getFile()).size} bytes)`);
      else await walk(h, `${prefix}${name}/`);
    }
  };
  await walk(await navigator.storage.getDirectory(), "");
  return out;
});
console.log(`---- browser storage (${stored.length} files) ----\n${stored.join("\n")}`);
await browser.close();
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
