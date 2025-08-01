require("dotenv").config();
const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const log = require("@vladmandic/pilogger");

puppeteer.use(StealthPlugin());

const file = process.env.FILE;
const maxRetries = parseInt(process.env.MAX_RETRIES);
const retryDelay = parseInt(process.env.RETRY_DELAY);
const timeout = parseInt(process.env.TIMEOUT);
const progressFile = "progress.json"; // New file to store progress

// Load progress from JSON
async function loadProgress() {
    try {
        if (!fs.existsSync(progressFile)) {
            log.warn(
                "loadProgress: progress file does not exist, starting from 0",
                { progressFile }
            );
            return { lastCheckedIndex: 0 };
        }
        const res = fs.readFileSync(progressFile);
        const data = JSON.parse(res);
        log.data("loadProgress", {
            progressFile,
            lastCheckedIndex: data.lastCheckedIndex,
        });
        return data;
    } catch (err) {
        log.error(`⚠️ Failed to load ${progressFile}. Error: ${err.message}`);
        return { lastCheckedIndex: 0 };
    }
}

// Save progress to JSON
async function saveProgress(index) {
    try {
        const json = JSON.stringify({ lastCheckedIndex: index }, null, 2);
        fs.writeFileSync(progressFile, json);
        log.data("saveProgress", { progressFile, lastCheckedIndex: index });
    } catch (err) {
        log.error(`⚠️ Save ${progressFile} failed. Error: ${err.message}`);
    }
}

// Load game database from JSON (unchanged)
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
        const today = new Date().toISOString().split("T")[0];
        for (const game of filtered) {
            game.date = new Date(game.date);
            game.verified = game.verified === true && game.size > 0;
            game.size = Math.round(10 * game.size) / 10;
        }
        const notChecked = filtered.filter(
            (g) => !g.lastChecked || g.lastChecked.split("T")[0] !== today
        ).length;
        log.data("load", { file, games: filtered.length, notChecked });
        return filtered;
    } catch (err) {
        log.error(`⚠️ Failed to load ${file}. Error: ${err.message}`);
        return [];
    }
}

// Save game database to JSON (unchanged)
async function save(games) {
    try {
        const json = JSON.stringify(games, null, 2);
        fs.writeFileSync(file, json);
        const today = new Date().toISOString().split("T")[0];
        const notChecked = games.filter(
            (g) => !g.lastChecked || g.lastChecked.split("T")[0] !== today
        ).length;
        log.data("save", {
            games: games.length,
            verified: games.filter((g) => g.verified).length,
            notChecked,
        });
    } catch (err) {
        log.error(`⚠️ Save ${file} failed. Error: ${err.message}`);
    }
}

async function checkTimestampsAgainstWebsite(
    fix = false,
    attempt = 1,
    startIndex = null
) {
    log.headerJson();
    const games = await load();
    const progress = await loadProgress();
    let startFrom =
        startIndex !== null ? startIndex : progress.lastCheckedIndex;
    if (startFrom >= games.length) {
        log.info("No games left to check, resetting progress", {
            startFrom,
            totalGames: games.length,
        });
        startFrom = 0;
        await saveProgress(0);
    }

    let mismatchCount = 0;
    let invalidJsonDateCount = 0;
    let noWebsiteDateCount = 0;
    let fixedCount = 0;
    let matchCount = 0;
    let dataChangesCount = 0;
    let skippedCount = 0;
    const today = new Date().toISOString().split("T")[0];

    const browser = await puppeteer.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--ignore-certificate-errors",
        ],
    });

    try {
        for (let i = startFrom; i < games.length; i++) {
            const game = games[i];

            // Skip games checked today
            if (game.lastChecked && game.lastChecked.split("T")[0] === today) {
                // log.debug("skipping game, already checked today", {
                //     id: game.id,
                //     game: game.name,
                //     lastChecked: game.lastChecked,
                // });
                skippedCount++;
                await saveProgress(i + 1); // Update progress even for skipped games
                continue;
            }

            const jsonDate = game.date ? new Date(game.date) : null;

            // Check if JSON date is valid
            if (!jsonDate || isNaN(jsonDate.getTime())) {
                log.warn("invalid JSON date", {
                    id: game.id,
                    game: game.name,
                    jsonDate: game.date,
                });
                invalidJsonDateCount++;
            }

            // Scrape website for timestamp and data
            const page = await browser.newPage();
            try {
                await page.setUserAgent(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
                );
                await page.goto(game.link, {
                    waitUntil: "networkidle2",
                    timeout: timeout,
                });

                // Get timestamp
                const websiteDate = await page.evaluate(() => {
                    const dateEl = document.querySelector("time.entry-date");
                    return dateEl && dateEl.getAttribute("datetime")
                        ? dateEl.getAttribute("datetime")
                        : null;
                });

                if (!websiteDate) {
                    log.warn("no date found on website", {
                        id: game.id,
                        game: game.name,
                        link: game.link,
                    });
                    noWebsiteDateCount++;
                    await page.close();
                    await saveProgress(i + 1); // Update progress
                    continue;
                }

                const parsedWebsiteDate = new Date(websiteDate);
                if (isNaN(parsedWebsiteDate.getTime())) {
                    log.warn("invalid website date", {
                        id: game.id,
                        game: game.name,
                        websiteDate,
                    });
                    noWebsiteDateCount++;
                    await page.close();
                    await saveProgress(i + 1); // Update progress
                    continue;
                }

                // Compare timestamps
                const jsonDateStr = jsonDate
                    ? jsonDate.toISOString().split(".")[0]
                    : null;
                const websiteDateStr = parsedWebsiteDate
                    .toISOString()
                    .split(".")[0];
                let dataChanges = null;

                if (jsonDateStr !== websiteDateStr) {
                    log.warn("date mismatch", {
                        id: game.id,
                        game: game.name,
                        jsonDate: game.date,
                        websiteDate,
                    });
                    mismatchCount++;

                    // Update date regardless of other conditions
                    games[i] = {
                        ...game,
                        date: parsedWebsiteDate,
                        lastChecked: new Date().toISOString(),
                    };
                    fixedCount++;
                    log.info(
                        `${game.name} updated. ${parsedWebsiteDate} new date.`
                    );
                    await save(games); // Save immediately after date update

                    // Scrape magnet and direct links
                    const websiteData = await page.evaluate(() => {
                        const directLinks = {};
                        const magnet =
                            Array.from(
                                document.querySelectorAll("a[href^='magnet:']")
                            ).map((a) => a.href)[0] || null;

                        const ddl = Array.from(
                            document.querySelectorAll("h3")
                        ).find((el) =>
                            el.textContent.includes(
                                "Download Mirrors (Direct Links)"
                            )
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
                                    if (text.includes("datanodes"))
                                        host = "datanodes";
                                    else if (text.includes("fuckingfast"))
                                        host = "fuckingfast";
                                    if (host) {
                                        directLinks[host] =
                                            directLinks[host] || [];
                                        const spoilerContent =
                                            item.querySelector(
                                                ".su-spoiler-content"
                                            );
                                        if (spoilerContent) {
                                            const spoilerLinks = Array.from(
                                                spoilerContent.querySelectorAll(
                                                    "a"
                                                )
                                            ).map((a) => a.href);
                                            directLinks[host].push(
                                                ...spoilerLinks
                                            );
                                        }
                                    }
                                }
                            }
                        }

                        return { magnet, direct: directLinks };
                    });

                    // Compare game data
                    dataChanges = {};
                    if (game.magnet !== websiteData.magnet) {
                        dataChanges.magnet = {
                            json: game.magnet,
                            website: websiteData.magnet,
                        };
                    }
                    if (
                        JSON.stringify(game.direct || {}) !==
                        JSON.stringify(websiteData.direct)
                    ) {
                        dataChanges.direct = {
                            json: game.direct || {},
                            website: websiteData.direct,
                        };
                    }

                    if (Object.keys(dataChanges).length > 0) {
                        dataChangesCount++;
                        log.warn("game data changed", {
                            id: game.id,
                            game: game.name,
                            changes: dataChanges,
                        });
                        games[i] = {
                            ...games[i], // Keep the updated date
                            magnet: websiteData.magnet,
                            direct: websiteData.direct,
                        };
                        log.info(`${game.name} updated. New data:`, {
                            magnet: websiteData.magnet,
                            direct: websiteData.direct,
                        });
                        await save(games); // Save again if data changes
                    }

                    // Additional fixes if requested
                    if (fix) {
                        log.info(`${game.name} fixed`);
                    }
                } else {
                    log.debug("date match", {
                        id: game.id,
                        game: game.name,
                        date: game.date,
                    });
                    games[i] = {
                        ...game,
                        lastChecked: new Date().toISOString(),
                    };
                    await save(games);
                    matchCount++;
                }

                await page.close();
                await saveProgress(i + 1); // Update progress after successful processing
            } catch (err) {
                log.warn("error scraping website", {
                    id: game.id,
                    game: game.name,
                    error: err.message,
                    attempt,
                });
                if (attempt < maxRetries) {
                    log.info(
                        `Retrying ${game.link} (attempt ${
                            attempt + 1
                        }/${maxRetries})`
                    );
                    await new Promise((resolve) =>
                        setTimeout(resolve, retryDelay)
                    );
                    await page.close();
                    return await checkTimestampsAgainstWebsite(
                        fix,
                        attempt + 1,
                        i
                    ); // Retry from the current index
                }
                await page.close();
                await saveProgress(i + 1); // Update progress even on failure
                continue;
            }
        }

        // Reset progress when all games are processed
        await saveProgress(0);
        log.info("All games processed, progress reset", {
            totalGames: games.length,
        });

        log.data("summary", {
            totalGames: games.length,
            matchedDates: matchCount,
            mismatchedDates: mismatchCount,
            invalidJsonDates: invalidJsonDateCount,
            noWebsiteDates: noWebsiteDateCount,
            fixedGames: fixedCount,
            gamesWithDataChanges: dataChangesCount,
            skippedGames: skippedCount,
            startedFromIndex: startFrom,
        });

        return {
            total: games.length,
            matched: matchCount,
            mismatched: mismatchCount,
            invalidJson: invalidJsonDateCount,
            noWebsite: noWebsiteDateCount,
            fixed: fixedCount,
            dataChanges: dataChangesCount,
            skipped: skippedCount,
            startedFromIndex: startFrom,
        };
    } finally {
        await browser.close();
    }
}

// Main function to check timestamps and update game data
async function main() {
    log.configure({ inspect: { breakLength: 500 } });
    log.headerJson();

    // Check timestamps and game data against website
    const timestampResults = await checkTimestampsAgainstWebsite(false); // Set to true to fix additional data if needed
    if (timestampResults.mismatched > 0 || timestampResults.invalidJson > 0) {
        log.info(
            "Timestamp or data issues detected. Run with fix=true or --fix for additional fixes."
        );
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    let startIndex = null;
    const indexArg = args.find((arg) => arg.startsWith("--start-index="));
    if (indexArg) {
        startIndex = parseInt(indexArg.split("=")[1], 10);
        if (isNaN(startIndex) || startIndex < 0) {
            log.error("Invalid --start-index value, starting from 0");
            startIndex = null;
        }
    }

    if (args.includes("--check-timestamps")) {
        checkTimestampsAgainstWebsite(
            args.includes("--fix"),
            1,
            startIndex
        ).then(() => process.exit());
    } else {
        main();
    }
} else {
    exports.load = load;
    exports.save = save;
    exports.loadProgress = loadProgress;
    exports.saveProgress = saveProgress;
    exports.checkTimestampsAgainstWebsite = checkTimestampsAgainstWebsite;
}
