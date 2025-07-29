const fs = require("fs");
const puppeteer = require("puppeteer");
const log = require("@vladmandic/pilogger");

// Configurable
const file = "fitgirl.json";
const debug = true; // Enabled for better debugging

// Internal counter
let id = 1;

// Fetch HTML content of a URI using Puppeteer
async function html(uri, browser) {
    try {
        const page = await browser.newPage();
        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        );
        await page.goto(uri, { waitUntil: "networkidle2", timeout: 30000 });
        const html = await page.content();
        await page.close();
        return html;
    } catch (err) {
        log.warn("fetch error", { uri, error: err.message, stack: err.stack });
        return "";
    }
}

// Fetch details for a given game
async function details(game, browser) {
    if (game.verified) return [game, false];
    const page = await browser.newPage();
    try {
        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        );
        await page.goto(game.link, {
            waitUntil: "networkidle2",
            timeout: 30000,
        });

        // More flexible date selector
        const date = await page.evaluate(() => {
            const dateEl = document.querySelector(
                "time, .entry-date, .post-date, [datetime]"
            );
            if (dateEl && dateEl.getAttribute("datetime")) {
                return dateEl.getAttribute("datetime");
            }
            return null;
        });
        if (date) {
            game.date = new Date(date);
        } else {
            log.warn("details: no date found", {
                id: game.id,
                game: game.name,
            });
            game.date = new Date();
        }

        // Flexible content selector
        const contentText = await page.evaluate(() => {
            const content = document.querySelector(
                ".entry-content, .post-content, article, .content"
            );
            return content
                ? content.textContent.replace(/\n+/g, "\n").split("\n")
                : [];
        });
        if (!contentText.length) {
            log.warn("details: no content found", {
                id: game.id,
                game: game.name,
            });
            await page.close();
            return [game, false];
        }

        // Process content lines
        for (const line of contentText) {
            if (line.match(/genres|tags/i))
                game.tags = line
                    .replace(/.*genres|tags.*?:/i, "")
                    .trim()
                    .split(", ")
                    .filter(Boolean);
            if (line.match(/compan(y|ies)/i))
                game.creator = line
                    .replace(/.*compan(y|ies).*?:/i, "")
                    .trim()
                    .split(", ")
                    .filter(Boolean);
            if (line.match(/original size/i))
                game.original = line.replace(/.*original size.*?:/i, "").trim();
            if (line.match(/repack size/i))
                game.packed = line
                    .replace(/.*repack size.*?:/i, "")
                    .replace(/\[.*\]/, "")
                    .trim();
        }

        // Parse sizes
        const packed = game.packed
            ? Number(
                  game.packed.replace(",", ".").match(/(\d+(\.\d+)?)/)?.[0] || 0
              )
            : 0;
        const original = game.original
            ? Number(
                  game.original.replace(",", ".").match(/(\d+(\.\d+)?)/)?.[0] ||
                      0
              )
            : 0;
        game.size = Math.max(packed, original);
        if (game?.size > 0 && game.original?.includes("MB")) game.size /= 1024;
        game.verified = game.size > 0;

        log.data("details", {
            id: game.id,
            verified: game.verified,
            game: game.name,
            link: game.link,
            size: game.size,
        });

        if (!game.verified && debug) {
            log.debug("content lines", contentText);
            log.debug("sizes", { packed, original });
            log.debug("game", game);
        }

        // Find magnet link
        const magnet = await page.evaluate(() => {
            const href = document.querySelector('a[href*="magnet"]');
            return href ? href.getAttribute("href") : null;
        });
        if (magnet) game.magnet = magnet;

        await page.close();
        return [game, game.verified];
    } catch (err) {
        log.warn("details error", {
            id: game.id,
            game: game.name,
            error: err.message,
        });
        await page.close();
        return [game, false];
    }
}

// Load game database from JSON
async function load() {
    try {
        if (!fs.existsSync(file)) {
            log.warn("load: file does not exist, creating empty file", {
                file,
            });
            fs.writeFileSync(file, JSON.stringify([]));
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
        });
    } catch (err) {
        log.error("save failed", { file, error: err.message });
    }
}

// Update list of games
async function update(games, browser) {
    const content = await html(
        "https://fitgirl-repacks.site/all-my-repacks-a-z",
        browser
    );
    if (!content) {
        log.error("update failed: no content");
        return games;
    }

    const page = await browser.newPage();
    try {
        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        );
        await page.goto("https://fitgirl-repacks.site/all-my-repacks-a-z", {
            waitUntil: "networkidle2",
            timeout: 30000,
        });

        // Extract number of pages
        const numPages = await page.evaluate(() => {
            const lcp = document.body.innerHTML.match(/lcp_page0=[0-9]+/g);
            return lcp
                ? Number(lcp[lcp.length - 1]?.replace("lcp_page0=", "") || 0)
                : 1;
        });
        log.data("pages", { total: numPages });

        let newGames = [];
        for (let i = 1; i <= numPages; i++) {
            await new Promise((resolve) => setTimeout(resolve, 1000)); // 1-second delay to avoid rate-limiting
            const pageUrl = `https://fitgirl-repacks.site/all-my-repacks-a-z/?lcp_page0=${i}`;
            await page.goto(pageUrl, {
                waitUntil: "networkidle2",
                timeout: 30000,
            });

            // Flexible game list selector
            const gamesElements = await page.evaluate(() => {
                const elements = document.querySelectorAll(
                    "#lcp_instance_0 li, .game-list li, .post-list li"
                );
                return Array.from(elements)
                    .map((el) => {
                        const a = el.querySelector("a");
                        return { name: a?.textContent.trim(), link: a?.href };
                    })
                    .filter((item) => item.name && item.link);
            });

            for (const { name, link } of gamesElements) {
                if (!games.find((game) => game.name === name)) {
                    newGames.push({ id: id++, name, link });
                }
            }
        }

        const updated = [...games, ...newGames];
        log.data("details", {
            pages: numPages,
            existing: games.length,
            new: newGames.length,
            total: updated.length,
            todo: updated.filter((g) => !g.verified).length,
        });

        await page.close();
        return updated;
    } catch (err) {
        log.error("update failed", { error: err.message });
        await page.close();
        return games;
    }
}

// Main function
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
        const updated = await update(games, browser);
        if (games.length !== updated.length) await save(updated);
        for (let i = 0; i < updated.length; i++) {
            const [game, update] = await details(updated[i], browser);
            updated[i] = game;
            if (update) await save(updated);
        }
        await save(updated);
    } finally {
        await browser.close();
    }
}

if (require.main === module) {
    main();
} else {
    exports.load = load;
    exports.save = save;
    exports.update = update;
    exports.details = details;
}
