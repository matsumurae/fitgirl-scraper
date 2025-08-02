const { parentPort } = require("worker_threads");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { details } = require("./utils");

puppeteer.use(StealthPlugin());

parentPort.on("message", async (game) => {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--ignore-certificate-errors",
            ],
        });

        const [updatedGame, verified] = await details(game, browser);
        parentPort.postMessage({ game: updatedGame, verified, error: null });
    } catch (err) {
        parentPort.postMessage({ game, verified: false, error: err.message });
    } finally {
        if (browser) await browser.close();
    }
});
