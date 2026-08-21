import mcpApp from "./index";
import { getArticleDetail } from "./article";
import {
	getLatestArticles,
	getLiveNews,
	getMacroCalendar,
	searchArticles,
} from "./wscn";

const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"access-control-allow-origin": "*",
	"cache-control": "no-store",
};

function jsonResponse(data: unknown, status = 200) {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: JSON_HEADERS,
	});
}

function parsePositiveInt(value: string | null, fallback: number, min: number, max: number) {
	const parsed = value == null ? fallback : Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

function parseBool(value: string | null) {
	return value === "1" || value === "true" || value === "yes";
}

async function handleLive(url: URL) {
	return jsonResponse(
		await getLiveNews({
			channel: url.searchParams.get("channel") ?? "要闻",
			date: url.searchParams.get("date") ?? undefined,
			hours: parsePositiveInt(url.searchParams.get("hours"), 24, 1, 168),
			importantOnly: parseBool(url.searchParams.get("important_only")),
			maxItems: parsePositiveInt(url.searchParams.get("max_items"), 200, 1, 500),
		}),
	);
}

async function handleArticles(url: URL) {
	const limit = parsePositiveInt(url.searchParams.get("limit"), 20, 1, 50);
	const articles = await getLatestArticles(limit);
	return jsonResponse({
		source: "WallStreetCN / 华尔街见闻",
		returned: articles.length,
		articles,
	});
}

async function handleArticleDetail(url: URL) {
	const articleId = (url.searchParams.get("id") ?? "").trim() || undefined;
	const articleUrl = (url.searchParams.get("url") ?? "").trim() || undefined;
	if (!articleId && !articleUrl) return jsonResponse({ error: "id or url is required" }, 400);
	return jsonResponse(
		await getArticleDetail({
			articleId,
			articleUrl,
			maxChars: parsePositiveInt(url.searchParams.get("max_chars"), 2400, 500, 3000),
		}),
	);
}

async function handleSearch(url: URL) {
	const query = (url.searchParams.get("query") ?? "").trim();
	if (!query) return jsonResponse({ error: "query is required" }, 400);
	const limit = parsePositiveInt(url.searchParams.get("limit"), 20, 1, 50);
	const articles = await searchArticles(query, limit);
	return jsonResponse({
		source: "WallStreetCN / 华尔街见闻",
		query,
		returned: articles.length,
		articles,
	});
}

async function handleMacroCalendar(url: URL) {
	const countries = (url.searchParams.get("countries") ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	return jsonResponse(
		await getMacroCalendar({
			startDate: url.searchParams.get("start_date") ?? undefined,
			endDate: url.searchParams.get("end_date") ?? undefined,
			minImportance: parsePositiveInt(url.searchParams.get("min_importance"), 1, 0, 5),
			countries: countries.length ? countries : undefined,
		}),
	);
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return new Response(null, {
				status: 204,
				headers: {
					"access-control-allow-origin": "*",
					"access-control-allow-methods": "GET, OPTIONS",
					"access-control-allow-headers": "content-type",
				},
			});
		}

		try {
			if (request.method === "GET" && url.pathname === "/") {
				return jsonResponse({
					name: "WallStreetCN Finance API + MCP",
					mcp: "/mcp",
					mcp_tools: [
						"get_latest_articles",
						"get_article_detail",
						"get_live_news",
						"search_articles",
						"get_macro_calendar",
					],
					endpoints: {
						live: "/api/live?channel=要闻&hours=24&important_only=true&max_items=200",
						by_date: "/api/live?channel=要闻&date=2026-08-20&important_only=true&max_items=300",
						articles: "/api/articles?limit=20",
						article_detail: "/api/article-detail?id=3776236&max_chars=2400",
						search: "/api/search?query=英伟达&limit=20",
						macro_calendar: "/api/macro-calendar?start_date=2026-08-21&end_date=2026-08-30&min_importance=2&countries=美国,中国",
					},
				});
			}
			if (request.method === "GET" && url.pathname === "/api/live") return await handleLive(url);
			if (request.method === "GET" && url.pathname === "/api/articles") return await handleArticles(url);
			if (request.method === "GET" && url.pathname === "/api/article-detail") return await handleArticleDetail(url);
			if (request.method === "GET" && url.pathname === "/api/search") return await handleSearch(url);
			if (request.method === "GET" && url.pathname === "/api/macro-calendar") return await handleMacroCalendar(url);
		} catch (error) {
			return jsonResponse(
				{ error: error instanceof Error ? error.message : String(error) },
				502,
			);
		}

		return mcpApp.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
