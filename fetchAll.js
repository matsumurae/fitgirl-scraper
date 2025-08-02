require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const log = require("@vladmandic/pilogger");
const yargs = require("yargs");
const { Worker } = require("worker_threads");
const AsyncLock = require("async-lock");
const {
    configurePage,
    fetchHtml,
    loadFile,
    saveFile,
    details,
} = require("./utils");

// Add stealth plugin to Puppeteer
puppeteer.use(StealthPlugin());

// Command-line arguments
const argv = yargs
    .option("start-index", {
        type: "number",
        default: 1,
        description: "Starting page index",
    })
    .option("all", {
        type: "boolean",
        default: false,
        description: "Scrape all A-Z content",
    }).argv;

// Configurable
const baseUrl = process.env.BASE_URL;
const fullUrl = `${baseUrl}all-my-repacks-a-z`;
const file = process.env.FILE;
const maxRetries = parseInt(process.env.MAX_RETRIES);
const retryDelay = parseInt(process.env.RETRY_DELAY);
const timeout = parseInt(process.env.TIMEOUT);
const cacheFile = "cache.json";
let cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));

// Update cache with new page count
async function updateCachePageCount(browser) {
    try {
        const page = await browser.newPage();
        await configurePage(page);
        await page.goto(fullUrl, {
            waitUntil: "networkidle2",
            timeout: timeout,
        });

        const lastPageNum = await page.evaluate(() => {
            const paginator = document.querySelector(".lcp_paginator");
            if (!paginator) return null;
            const links = paginator.querySelectorAll("a");
            if (links.length < 2) return 1;
            const penultimateLink = links[links.length - 2];
            return parseInt(penultimateLink.getAttribute("title")) || 1;
        });

        if (lastPageNum && lastPageNum !== cache.pages) {
            cache.pages = lastPageNum;
            cache.lastChecked = new Date().toISOString();
            fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
            log.info(
                `⚡️ Updated cache. ${lastPageNum} is last page and ${cache.lastChecked} is last game checked.`
            );
        } else if (!lastPageNum) {
            log.warn("Could not determine page count");
        }

        await page.close();
        return lastPageNum || cache.pages;
    } catch (err) {
        log.error("Failed to update cache page count", { error: err.message });
        return cache.pages;
    }
}

// Save current page number to state.json
async function saveState(pageNum) {
    try {
        const state = { currentPage: pageNum };
        fs.writeFileSync("state.json", JSON.stringify(state, null, 2));
        log.debug("Saved state", { currentPage: pageNum });
    } catch (err) {
        log.error("Save state failed", { error: err.message });
    }
}

// Load current page number from state.json
function loadState() {
    try {
        if (fs.existsSync("state.json")) {
            const state = JSON.parse(fs.readFileSync("state.json", "utf8"));
            return state.currentPage || argv.startIndex;
        }
        return argv.startIndex;
    } catch (err) {
        log.error("Load state failed, using start-index", {
            error: err.message,
            startIndex: argv.startIndex,
        });
        return argv.startIndex;
    }
}

// Scrape newest games from page 1
async function scrapeNewestGames(browser) {
    const page = await browser.newPage();
    let currentPageUrl = baseUrl;
    let hasNextPage = true;
    const maxWorkers = 4;
    const activeWorkers = new Set();

    const processGame = (game) => {
        return new Promise((resolve, reject) => {
            const worker = new Worker("./worker.js");
            activeWorkers.add(worker);
            worker.postMessage(game);
            worker.on("message", (msg) => {
                activeWorkers.delete(worker);
                worker.terminate();
                resolve(msg);
            });
            worker.on("error", (err) => {
                activeWorkers.delete(worker);
                worker.terminate();
                reject(err);
            });
        });
    };

    try {
        await configurePage(page);

        while (hasNextPage) {
            // Navigate to the current page
            await page.goto(currentPageUrl, {
                waitUntil: "networkidle2",
                timeout: timeout,
            });
            await new Promise((resolve) => setTimeout(resolve, retryDelay));

            // Step 2: Select all articles and extract data
            const articles = await page.evaluate(() => {
                const articleNodes = document.querySelectorAll("article");
                return Array.from(articleNodes)
                    .slice(1) // Skip the first article
                    .map((article) => {
                        const time = article.querySelector("time.entry-date");
                        const titleLink =
                            article.querySelector(".entry-title > a");
                        return {
                            timestamp: time?.getAttribute("datetime"),
                            name: titleLink?.textContent.trim(),
                            link: titleLink?.href,
                        };
                    })
                    .filter((item) => item.timestamp && item.name && item.link);
            });

            // Check if the first article's timestamp is older than lastChecked
            const lastChecked = new Date(cache.lastChecked);
            if (
                articles.length > 0 &&
                new Date(articles[0].timestamp) <= lastChecked
            ) {
                log.info(
                    `🛑 Stopping pagination: First game on page is older than ${lastChecked.toISOString()}`
                );
                break;
            }

            log.data(
                `🔥 Found ${articles.length} games on page ${currentPageUrl}`
            );

            // Load existing games from games.json
            const existingGames = await loadFile(file);
            const existingLinks = new Set(
                existingGames.map((game) => game.link)
            );
            let maxId =
                existingGames.length > 0
                    ? Math.max(...existingGames.map((g) => g.id))
                    : 0;

            // Step 3: Filter articles newer than cache.lastChecked
            const newArticles = articles.filter(
                (article) => new Date(article.timestamp) > lastChecked
            );

            log.data(
                `🔎 Found ${
                    newArticles.length
                } new games since ${lastChecked.toISOString()} on page ${currentPageUrl}`
            );

            // Process new games with workers
            for (const { name, link, timestamp } of newArticles) {
                if (!existingLinks.has(link)) {
                    const game = {
                        id: ++maxId,
                        name,
                        link,
                        timestamp,
                    };
                    log.info(`🔎 Found new game: ${game.name} (${game.link})`);

                    // Wait for available worker
                    if (activeWorkers.size >= maxWorkers) {
                        await new Promise((resolve) => {
                            const checkWorkers = setInterval(() => {
                                if (activeWorkers.size < maxWorkers) {
                                    clearInterval(checkWorkers);
                                    resolve();
                                }
                            }, 100);
                        });
                    }

                    try {
                        const result = await processGame(game);
                        if (result.error) {
                            log.warn(
                                `Skipping ${game.name} due to error: ${result.error}`
                            );
                            continue;
                        }

                        const newGame = {
                            id: result.game.id,
                            name: result.game.name,
                            link: result.game.link,
                            date: result.game.date || new Date().toISOString(),
                            tags: result.game.tags || [],
                            creator: result.game.creator || [],
                            original: result.game.original || "",
                            packed: result.game.packed || "",
                            size: result.game.size || 0,
                            verified: result.verified || false,
                            magnet: result.game.magnet || null,
                            direct: result.game.direct || {},
                            lastChecked:
                                result.game.lastChecked ||
                                new Date().toISOString(),
                        };

                        const shouldSave =
                            newGame.verified ||
                            newGame.size > 0 ||
                            newGame.magnet ||
                            Object.keys(newGame.direct).length > 0;

                        await lock.acquire("file-save", async () => {
                            if (shouldSave) {
                                await saveFile(newGame, file, {
                                    isSingleGame: true,
                                });
                                log.info(
                                    `✅ Saved new game: ${newGame.name} to ${file}`
                                );
                            } else {
                                log.warn(
                                    `⚠️ Skipping save for ${newGame.name}: incomplete data`
                                );
                            }
                        });
                    } catch (err) {
                        log.error(
                            `Worker error for ${game.name}: ${err.message}`
                        );
                    }
                } else {
                    log.debug(
                        `Game already exists in games.json: ${name} (${link})`
                    );
                }
            }

            // Check for next page
            const nextPageLink = await page.evaluate(() => {
                const nextButton = document.querySelector(".pagination .next");
                return nextButton ? nextButton.href : null;
            });

            if (nextPageLink) {
                log.info(`🔗 Found next page: ${nextPageLink}`);
                currentPageUrl = nextPageLink;
            } else {
                log.info("🛑 No next page found, stopping pagination");
                hasNextPage = false;
            }
        }

        // Update lastChecked timestamp
        cache.lastChecked = new Date().toISOString();
        fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
        log.info(`⚡️ Updated lastChecked to ${cache.lastChecked}`);

        await page.close();
    } catch (err) {
        log.error("Newest games scraping failed", { error: err.message });
        await page.close();
    } finally {
        // Wait for all workers to finish and terminate
        while (activeWorkers.size > 0) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
}

// Main scraping function for all pages
async function scrapeAll() {
    log.configure({ inspect: { breakLength: 500 } });
    log.headerJson();

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--ignore-certificate-errors",
        ],
    });

    try {
        // Update cache page count
        const cachedNumPages = await updateCachePageCount(browser);

        let startPage = loadState();
        let id = 1;
        let games = [];
        if (fs.existsSync("complete.json")) {
            games = JSON.parse(fs.readFileSync("complete.json", "utf8"));
            id = games.length > 0 ? Math.max(...games.map((g) => g.id)) + 1 : 1;
        }

        // Iterate through all pages starting from startPage
        for (let pageNum = startPage; pageNum <= cachedNumPages; pageNum++) {
            const pageUrl = `${fullUrl}/?lcp_page0=${pageNum}#lcp_instance_0`;
            const content = await fetchHtml(pageUrl, browser);
            if (!content) {
                log.error("No content fetched for page", { pageNum });
                continue;
            }

            const page = await browser.newPage();
            try {
                await configurePage(page);
                await page.goto(pageUrl, {
                    waitUntil: "networkidle2",
                    timeout: timeout,
                });
                await new Promise((resolve) => setTimeout(resolve, retryDelay));

                // Extract games
                const gamesElements = await page.evaluate(() => {
                    const list = document.querySelector("ul.lcp_catlist");
                    if (!list) return [];
                    const items = list.querySelectorAll("li a");
                    return Array.from(items)
                        .map((a) => ({
                            name: a.textContent.trim(),
                            link: a.href,
                        }))
                        .filter((item) => item.name && item.link);
                });

                log.data(
                    `🔥 Scraped page ${pageNum} with ${gamesElements.length} games`
                );

                // Process each game individually
                for (const { name, link } of gamesElements) {
                    const game = {
                        id: id++,
                        name,
                        link,
                        page: pageNum,
                    };
                    log.info(`🔎 Found game: ${game.name}`);
                    await saveFile(game, "complete.json", {
                        isSingleGame: true,
                    });
                }

                await saveState(pageNum + 1);
                await page.close();
            } catch (err) {
                log.error("Page processing failed", {
                    pageNum,
                    error: err.message,
                });
                await page.close();
            }
        }

        log.data(`🔥 Scraping complete!`);
    } finally {
        await browser.close();
    }
}

// Main execution
async function main() {
    log.configure({ inspect: { breakLength: 500 } });
    log.headerJson();

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--ignore-certificate-errors",
        ],
    });

    try {
        if (argv.all) {
            await scrapeAll();
        } else {
            await scrapeNewestGames(browser);
        }
    } finally {
        await browser.close();
    }
}

if (require.main === module) {
    main();
}
