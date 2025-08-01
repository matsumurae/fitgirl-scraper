const log = require("@vladmandic/pilogger");
const fs = require("fs");

// Configure page with common settings
async function configurePage(page) {
    await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    });
}

// Fetch HTML content of a URI using Puppeteer with retries
async function fetchHtml(uri, browser, attempt = 1) {
    let page = null;
    const maxRetries = parseInt(process.env.MAX_RETRIES);
    const retryDelay = parseInt(process.env.RETRY_DELAY);
    const timeout = parseInt(process.env.TIMEOUT);
    try {
        page = await browser.newPage();
        await configurePage(page);
        await page.goto(uri, { waitUntil: "networkidle2", timeout });
        const html = await page.content();
        await page.close();
        return html;
    } catch (err) {
        if (page) {
            await page.close();
        }
        if (err.message.includes("net::ERR_CONNECTION_REFUSED")) {
            log.error("Connection refused by server", { uri, attempt });
            if (attempt < maxRetries) {
                log.info(
                    `Retrying ${uri} (attempt ${attempt + 1}/${maxRetries})`
                );
                await new Promise((resolve) => setTimeout(resolve, retryDelay));
                return fetchHtml(uri, browser, attempt + 1);
            }
            log.error("All retries failed for", { uri });
            return "";
        }
        log.warn("fetch error", { uri, attempt, error: err.message });
        if (attempt < maxRetries) {
            log.info(`Retrying ${uri} (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            return fetchHtml(uri, browser, attempt + 1);
        }
        log.error("fetch failed after retries", { uri, error: err.message });
        return "";
    }
}

// Load game database from JSON
async function loadFile(file = process.env.FILE, logMessage = null) {
    try {
        if (!fs.existsSync(file)) {
            log.warn(`${file} does not exist, creating empty file…`);
            fs.writeFileSync(file, JSON.stringify([]));
            return [];
        }
        const res = fs.readFileSync(file);
        const data = JSON.parse(res);
        const filtered = data.filter((d) => d.id);
        const today = new Date().toISOString().split("T")[0];
        let notChecked = 0;

        for (const game of filtered) {
            game.date = new Date(game.date);
            game.verified = game.verified === true && game.size > 0;
            game.size = Math.round(10 * game.size) / 10;
            if (game.lastChecked && game.lastChecked.split("T")[0] !== today) {
                notChecked++;
            }
        }

        log.data(
            `🌀 Loading JSON… There's ${filtered.length} games ${notChecked} not checked today`
        );

        log.data(
            `DDL links: ${
                filtered.filter(
                    (g) => g.direct && Object.keys(g.direct).length > 0
                ).length
            }. Missing DDL: ${
                filtered.filter((g) => g.verified && !g.direct).length
            }`
        );
        return filtered;
    } catch (err) {
        log.error(`⚠️  Failed to load ${file}. Error: ${err.message}`);
        return [];
    }
}

// Save game database to JSON
async function saveFile(data, file = process.env.FILE, options = {}) {
    try {
        const { logMessage, isSingleGame = false } = options;
        let games = [];

        // If saving a single game, load existing games and check for duplicates
        if (isSingleGame) {
            if (fs.existsSync(file)) {
                const existingData = fs.readFileSync(file, "utf8");
                games = JSON.parse(existingData);
            }

            // Check for duplicates using the 'link' property
            if (!games.find((g) => g.link === data.link)) {
                games.push(data);
                fs.writeFileSync(file, JSON.stringify(games, null, 2));
                log.info(`🔥 Saved ${data.name} to ${file}`);
            } else {
                log.debug(`‼️ ${data.name} game already exists. Skipping…`);
                return;
            }
        } else {
            // Save entire array of games
            games = data;
            fs.writeFileSync(file, JSON.stringify(games, null, 2));

            // Generate default log message for array of games
            const today = new Date().toISOString().split("T")[0];
            const notChecked = games.filter(
                (g) => !g.lastChecked || g.lastChecked.split("T")[0] !== today
            ).length;

            const defaultLogMessage = `✅ Saved ${file}. ${games.length} games, ${notChecked} not checked today`;
            const finalLogMessage = logMessage || defaultLogMessage;

            log.data(
                finalLogMessage,
                logMessage
                    ? {}
                    : {
                          ddlLinks: games.filter(
                              (g) =>
                                  g.direct && Object.keys(g.direct).length > 0
                          ).length,
                      }
            );
        }
    } catch (err) {
        log.error(`⚠️ Save ${file} failed. Error: ${err.message}`);
    }
}

module.exports = {
    configurePage,
    fetchHtml,
    loadFile,
    saveFile,
};
