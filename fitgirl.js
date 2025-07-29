const fs = require("fs");
const JSDOM = require("jsdom").JSDOM;
const window = new JSDOM("").window;
const $ = require("jquery")(window);
const log = require("@vladmandic/pilogger");

// Configurable
const file = "fitgirl.json";
const debug = true; // Enabled for better debugging

// Internal counter
let id = 1;

// Fetch HTML content of a URI
async function html(uri) {
    try {
        const res = await fetch(uri);
        if (!res?.ok) {
            log.warn("fetch failed", { uri, status: res?.status });
            return "";
        }
        const blob = await res.blob();
        const html = await blob.text();
        return html;
    } catch (err) {
        log.warn("fetch error", { uri, error: err.message });
        return "";
    }
}

// Fetch details for a given game
async function details(game) {
    if (game.verified) return [game, false];
    const page = await html(game.link);
    if (!page) {
        log.warn("details failed: no page content", {
            id: game.id,
            game: game.name,
        });
        return [game, false];
    }

    // More flexible date selector
    const dateEl = $(page).find("time, .entry-date, .post-date, [datetime]");
    let date;
    if (dateEl.length > 0) {
        date = dateEl.filter("[datetime]").first();
        game.date = new Date($(date).attr("datetime"));
    } else {
        log.warn("details: no date found", { id: game.id, game: game.name });
        game.date = new Date();
    }

    // Flexible content selector
    const content = $(page).find(
        ".entry-content, .post-content, article, .content"
    );
    if (!content.length) {
        log.warn("details: no content found", { id: game.id, game: game.name });
        return [game, false];
    }

    // Process content lines
    const text = content.text().replace(/\n+/g, "\n").split("\n");
    for (const line of text) {
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
        ? Number(game.packed.replace(",", ".").match(/(\d+(\.\d+)?)/)?.[0] || 0)
        : 0;
    const original = game.original
        ? Number(
              game.original.replace(",", ".").match(/(\d+(\.\d+)?)/)?.[0] || 0
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
        log.debug("content lines", text);
        log.debug("sizes", { packed, original });
        log.debug("game", game);
    }

    // Find magnet link
    const hrefs = content.find('a[href*="magnet"]');
    if (hrefs.length) game.magnet = hrefs.first().attr("href");

    return [game, game.verified];
}

// Load game database from JSON
async function load() {
    try {
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
async function update(games) {
    const content = await html(
        "https://fitgirl-repacks.site/all-my-repacks-a-z"
    );
    if (!content) {
        log.error("update failed: no content");
        return games;
    }

    // Extract number of pages
    const lcp = content.match(/lcp_page0=[0-9]+/g);
    const numPages = lcp
        ? Number(lcp[lcp.length - 1]?.replace("lcp_page0=", "") || 0)
        : 1;
    log.data("pages", { total: numPages });

    let newGames = [];
    for (let i = 1; i <= numPages; i++) {
        const page = await html(
            `https://fitgirl-repacks.site/all-my-repacks-a-z/?lcp_page0=${i}`
        );
        if (!page) continue;

        // Flexible game list selector
        const gamesElements = $(page).find(
            "#lcp_instance_0 li, .game-list li, .post-list li"
        );
        for (const li of gamesElements) {
            const a = $(li).find("a").first();
            const name = a.text().trim();
            const link = a.attr("href");
            if (name && link && !games.find((game) => game.name === name)) {
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
    return updated;
}

// Main function
async function main() {
    log.configure({ inspect: { breakLength: 500 } });
    log.headerJson();
    const games = await load();
    const updated = await update(games);
    if (games.length !== updated.length) await save(updated);
    for (let i = 0; i < updated.length; i++) {
        const [game, update] = await details(updated[i]);
        updated[i] = game;
        if (update) await save(updated);
    }
    await save(updated);
}

if (require.main === module) {
    main();
} else {
    exports.load = load;
    exports.save = save;
    exports.update = update;
    exports.details = details;
}
