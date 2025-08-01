# Fitgirl scraper

This originally came from [fitgirl](https://github.com/vladmandic/fitgirl) but as of today, it doesn't work. That's why I took the project and…

1. Redo it to use puppeteer to imitate a real browser
2. Add DDL links (FuckingFast and DataNodes) to the JSON
3. Update the code to retrieve newest games
4. Keep the number of pages to avoid re-checking every time
5. **Search** now uses the local JSON data instead of scraping again (saving time)

## How to install

1. `npm i`
1. Add your `.env` file with

```env
FILE=games.json
BASE_URL=https://fitgirl-repacks.site/
MAX_RETRIES=3
RETRY_DELAY=30000
TIMEOUT=60000
```

## How to use it

### Want to check if any local game had updates?

> Use `npm run date`

This will update:

-   Date
-   lastChecked to know when was the last fetch
-   Magnet link
-   Direct links (datanodes and fuckingfast)

### Want to check if there's any new game?

> Use `npm run fetch` and follow with `npm run compare`

**Be patient! This takes a bit of time.**

1. `fetchAll.js` scrape all Fitgirl repacks from A to Z and adds them to a JSON (which you also have it available on the repo).
2. Then, `compare.js` checks which games aren't on `games.json` and fetch the data on her website to add them.

You can start from a specific point if it stopped. State will be saved each time it goes to next page, but you can use `--start-index=100` if you want to do it manually.

If you want to check how many new games are, use `npm run count` after running `npm run fetch` and it'll show something like this:

```
Loaded 3253 games from games.json
Reading games.json… It has 3253 and 3251 verified.
✅ complete.json loaded correctly! It has 5873 games.
🔥 3253 on games.json and 3251 verified.
✨ 5873 on complete.json
📝 2667 on temp.json
⚠️ 2669 missing games.
```

### Want to find a specific game?

> Use `npm run find <name>`.

This will show a list of games that match your search.

### Why there's `ddl.js`

It was made to add the DDL links from FuckingFast and Datanodes to the FitGirl repacks database. The original code doesn't allow to add ANY new info if it's a verified game… So I just added empty "direct" and checked all games to add the ones that had those providers.

## Changes

-   I've kept `pilogger` because it looks so cool to see all that colors on console… Pretty easy to check each info.
-   Removed `jquery` and `jsdom` as they didn't serve now… Changed with **puppeteer**.
-   Added `dotenv` to keep static info easily available.
-   Added `lastChecked` on JSON to know when was the last time `fixDate` was run.
