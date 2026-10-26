// Renders assets/icon.svg to a 1024px PNG for `tauri icon`.
import { webkit } from "@playwright/test";
import { readFileSync } from "node:fs";

const svg = readFileSync("assets/icon.svg", "utf8");
const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`);
await page.screenshot({ path: "assets/icon.png", omitBackground: true });
await browser.close();
