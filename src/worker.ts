import mcpApp from "./index";

const LIVE_API = "https://api-one.wallstcn.com/apiv1/content/lives";
const ARTICLE_API = "https://api-one-wscn.awtmt.com/apiv1/content/information-flow";

const CHANNELS: Record<string, string> = {
	"要闻": "global-channel",
	"美股": "us-stock-channel",
	"A股": "a-stock-channel",
	"港股": "hk-stock-channel",
	"外汇": "forex-channel",
	"商品": "commodity-channel",
	"债券": "bond-channel",
	"科技": "tech-channel",
};

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

async function fetchJson(url: URL) {
	const response = await fetch(url.toString(), {
		headers: {
			Accept: "application/json",
			"User-Agent": "Mozilla/5.0 (compatible; WallStreetCN-MCP/1.0)",
		},
	});
	if (!response.ok) throw new Error(`WallStreetCN upstream HTTP ${response.status}`);
	return (await response.json()) as any;
}

function stripHtml(value: unknown): string {
	if (typeof value !== "string") return "";
	return value
		.replace(/<\/p>\s*<p[^>]*>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.trim();
}

function beijingTime(unixSeconds: number): string {
	return new Date((unixSeconds + 8 * 60 * 60) * 1000)
		.toISOString()
		.slice(0, 19)
		.replace("T", " ");
}

function parseBeijingDate(date: string) {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!match) throw new Error("date must be YYYY-MM-DD");
	const startMs =
		Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0) -
		8 * 60 * 60 * 1000;
	const start = Math.floor(startMs / 1000);
	return { start, end: start + 24 * 60 * 60 - 1 };
}

function parsePositiveInt(value: string | null, fallback: number, min: number, max: number) {
	const parsed = value == null ? fallback : Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(max, parsed));
}

function parseBool(value: string | null) {
	return value === "1" || value === "true" || value === "yes";
}

function parseLiveItem(item: any) {
	const ts = Number(item?.display_time ?? 0);
	const content = item?.content_more
		? stripHtml(`${item?.content ?? ""}\n${item.content_more}`)
		: stripHtml(item?.content_text ?? item?.content ?? "");
	return {
		id: item?.id ?? null,
		title: item?.title ?? "",
		content,
		url: item?.uri ?? (item?.id ? `https://wallstreetcn.com/livenews/${item.id}` : ""),
		score: Number(item?.score ?? 1),
		importance:
			Number(item?.score ?? 1) >= 3
				? "非常重要"
				: Number(item?.score ?? 1) >= 2
					? "重要"
					: "普通",
		published_at_unix: ts || null,
		published_at_beijing: ts ? beijingTime(ts) : null,
		article: item?.article
			? {
					id: item.article.id ?? null,
					title: item.article.title ?? "",
					url: item.article.uri ?? "",
				}
			: null,
		is_calendar: Boolean(item?.is_calendar),
		wscn_ticker: item?.wscn_ticker ?? null,
	};
}

async function handleLive(url: URL) {
	const channelName = url.searchParams.get("channel") ?? "要闻";
	const channel = CHANNELS[channelName] ?? channelName;
	const importantOnly = parseBool(url.searchParams.get("important_only"));
	const maxItems = parsePositiveInt(url.searchParams.get("max_items"), 200, 1, 500);
	const hours = parsePositiveInt(url.searchParams.get("hours"), 24, 1, 168);
	const date = url.searchParams.get("date");
	const now = Math.floor(Date.now() / 1000);
	const range = date ? parseBeijingDate(date) : { start: now - hours * 3600, end: now };

	const results: ReturnType<typeof parseLiveItem>[] = [];
	let cursor: string | null = null;
	let pages = 0;
	let reachedStart = false;
	const maxPages = 30;

	while (pages < maxPages && !reachedStart) {
		const upstream = new URL(LIVE_API);
		upstream.searchParams.set("channel", channel);
		upstream.searchParams.set("client", "pc");
		upstream.searchParams.set("limit", "50");
		if (cursor) upstream.searchParams.set("cursor", cursor);
		else upstream.searchParams.set("first_page", "true");

		const data = await fetchJson(upstream);
		const items = Array.isArray(data?.data?.items) ? data.data.items : [];
		pages += 1;
		if (items.length === 0) break;

		for (const item of items) {
			const ts = Number(item?.display_time ?? 0);
			if (!ts || ts > range.end) continue;
			if (ts < range.start) {
				reachedStart = true;
				break;
			}
			if (importantOnly && Number(item?.score ?? 1) < 2) continue;
			results.push(parseLiveItem(item));
			if (results.length >= maxItems) {
				return jsonResponse({
					source: "WallStreetCN / 华尔街见闻 7×24 快讯",
					channel: channelName,
					range_beijing: { start: beijingTime(range.start), end: beijingTime(range.end) },
					important_only: importantOnly,
					returned: results.length,
					truncated: true,
					items: results,
				});
			}
		}

		cursor = data?.data?.next_cursor ? String(data.data.next_cursor) : null;
		if (!cursor) break;
	}

	return jsonResponse({
		source: "WallStreetCN / 华尔街见闻 7×24 快讯",
		channel: channelName,
		range_beijing: { start: beijingTime(range.start), end: beijingTime(range.end) },
		important_only: importantOnly,
		returned: results.length,
		truncated: pages >= maxPages && !reachedStart,
		items: results,
	});
}

async function handleArticles(url: URL) {
	const limit = parsePositiveInt(url.searchParams.get("limit"), 20, 1, 50);
	const upstream = new URL(ARTICLE_API);
	upstream.searchParams.set("channel", "global");
	upstream.searchParams.set("accept", "article");
	upstream.searchParams.set("limit", String(limit));
	const data = await fetchJson(upstream);
	const items = Array.isArray(data?.data?.items) ? data.data.items : [];
	const articles = items
		.map((item: any) => item?.resource ?? item)
		.filter((item: any) => item?.title)
		.map((item: any) => {
			const ts = Number(item?.display_time ?? item?.publish_time ?? item?.created_at ?? 0);
			return {
				id: item?.id ?? null,
				title: item?.title ?? "",
				summary: stripHtml(item?.content_short ?? item?.summary ?? item?.content ?? ""),
				url: item?.uri ?? item?.url ?? "",
				author: item?.author?.display_name ?? item?.author?.name ?? "",
				published_at_unix: ts || null,
				published_at_beijing: ts ? beijingTime(ts) : null,
			};
		});
	return jsonResponse({ source: "WallStreetCN / 华尔街见闻", returned: articles.length, articles });
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
					endpoints: {
						live: "/api/live?channel=要闻&hours=24&important_only=true&max_items=200",
						by_date: "/api/live?channel=要闻&date=2026-08-20&important_only=true&max_items=300",
						articles: "/api/articles?limit=20",
					},
				});
			}
			if (request.method === "GET" && url.pathname === "/api/live") return await handleLive(url);
			if (request.method === "GET" && url.pathname === "/api/articles") return await handleArticles(url);
		} catch (error) {
			return jsonResponse(
				{ error: error instanceof Error ? error.message : String(error) },
				502,
			);
		}

		return mcpApp.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
