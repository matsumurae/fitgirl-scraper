// This code was made to add the DDL links from FuckingFast and Datanodes to the FitGirl repacks database.
// It uses Puppeteer to scrape the FitGirl repacks site and extract direct download links.
// This was made because: the original code doesn't check already verified games, it doesn't retry on failure, and it doesn't save the direct links to the database.
require("dotenv").config();

const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const log = require("@vladmandic/pilogger");

// Add stealth plugin to Puppeteer
puppeteer.use(StealthPlugin());

// Configurable
const file = process.env.FILE;
const baseUrl = process.env.BASE_URL;
const maxRetries = parseInt(process.env.MAX_RETRIES);
const retryDelay = parseInt(process.env.RETRY_DELAY);

// Load game database from JSON
async function load() {
    try {
        if (!fs.existsSync(file)) {
            log.warn("load: file does not exist, creating empty file", {
                file,
            });
            fs.writeFileSync(file, JSON.stringify([]));
            return [];
        }
        const res = fs.readFileSync(file);
        const data = JSON.parse(res);
        const filtered = data.filter((d) => d.id);
        for (const game of filtered) {
            game.date = new Date(game.date);
            game.verified = game.verified === true && game.size > 0;
            game.size = Math.round(10 * game.size) / 10;
        }
        log.data("load", {
            file,
            games: filtered.length,
            verified: filtered.filter((g) => g.verified).length,
            withDirect: filtered.filter(
                (g) => g.direct && Object.keys(g.direct).length > 0
            ).length,
            missingDirect: filtered.filter((g) => g.verified && !g.direct)
                .length,
        });
        return filtered;
    } catch (err) {
        log.error("load failed", { file, error: err.message });
        return [];
    }
}

// Save game database to JSON
async function save(games) {
    try {
        const json = JSON.stringify(games, null, 2);
        fs.writeFileSync(file, json);
        log.data("save", {
            games: games.length,
            verified: games.filter((g) => g.verified).length,
            withDirect: games.filter((g) => g.direct).length,
        });
    } catch (err) {
        log.error("save failed", { file, error: err.message });
    }
}

async function fetchDirectLinks(game, browser, attempt = 1) {
    if (!game.verified || game.direct) return [game, false]; // Skip if not verified or already has direct links
    const page = await browser.newPage();
    try {
        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        );
        await page.goto(game.link, {
            waitUntil: "networkidle2",
            timeout: 60000,
        });

        // Get direct links without modifying game directly
        const directLinks = await page.evaluate(() => {
            const directLinks = {};
            const ddl = Array.from(document.querySelectorAll("h3")).find((el) =>
                el.textContent.includes("Download Mirrors (Direct Links)")
            );
            if (ddl) {
                const ul =
                    Array.from(ddl.parentElement.children).find(
                        (el) => el.tagName === "UL" && el !== ddl
                    ) || null;
                if (ul) {
                    const items = ul.querySelectorAll("li");
                    for (const item of items) {
                        const text = item.textContent.toLowerCase();
                        let host = null;
                        if (text.includes("datanodes")) {
                            host = "datanodes";
                        } else if (text.includes("fuckingfast")) {
                            host = "fuckingfast";
                        }
                        if (host) {
                            directLinks[host] = directLinks[host] || [];
                            const spoilerContent = item.querySelector(
                                ".su-spoiler-content"
                            );
                            if (spoilerContent) {
                                const spoilerLinks = Array.from(
                                    spoilerContent.querySelectorAll("a")
                                ).map((a) => a.href);
                                directLinks[host].push(...spoilerLinks);
                            }
                        }
                    }
                }
            }
            return directLinks || null;
        });

        // Create new game object with direct links
        const updatedGame = { ...game, direct: directLinks };

        log.data("fetchDirectLinks", {
            id: game.id,
            game: game.name,
            link: game.link,
            direct: directLinks,
        });

        if (!directLinks && debug) {
            log.debug("no direct links found", {
                id: game.id,
                game: game.name,
            });
        }

        await page.close();
        return [updatedGame, !!directLinks];
    } catch (err) {
        log.warn("fetchDirectLinks error", {
            id: game.id,
            game: game.name,
            error: err.message,
            attempt,
        });
        if (attempt < maxRetries) {
            log.info(
                `Retrying ${game.link} (attempt ${attempt + 1}/${maxRetries})`
            );
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            await page.close();
            return fetchDirectLinks(game, browser, attempt + 1);
        }
        await page.close();
        return [game, false];
    }
}

// Main function to update direct links
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
        const games = await load();
        let updatedCount = 0;
        for (let i = 0; i < games.length; i++) {
            const [game, updated] = await fetchDirectLinks(games[i], browser);
            games[i] = game;
            if (updated) {
                updatedCount++;
                await save(games); // Save after each successful update
            }
        }
        log.data("update complete", {
            totalGames: games.length,
            updatedDirectLinks: updatedCount,
        });
        if (updatedCount === 0) {
            log.info("No games needed direct link updates");
        }
    } finally {
        await browser.close();
    }
}

if (require.main === module) {
    main();
} else {
    exports.load = load;
    exports.save = save;
    exports.fetchDirectLinks = fetchDirectLinks;
}
