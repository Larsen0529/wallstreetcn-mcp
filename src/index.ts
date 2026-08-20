import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

const ARTICLE_API = "https://api-one-wscn.awtmt.com/apiv1/content/information-flow";
const SEARCH_API = "https://api-one-wscn.awtmt.com/apiv1/search/article";
const LIVE_API = "https://api-one.wallstcn.com/apiv1/content/lives";

const CHANNELS = {
	"要闻": "global-channel",
	"美股": "us-stock-channel",
	"A股": "a-stock-channel",
	"港股": "hk-stock-channel",
	"外汇": "forex-channel",
	"商品": "commodity-channel",
	"债券": "bond-channel",
	"科技": "tech-channel",
} as const;

type ChannelName = keyof typeof CHANNELS;

async function fetchJson(url: URL) {
	const response = await fetch(url.toString(), {
		headers: {
			Accept: "application/json",
			"User-Agent": "Mozilla/5.0 (compatible; WallStreetCN-MCP/1.0)",
		},
	});

	if (!response.ok) {
		throw new Error(`Upstream API returned HTTP ${response.status}`);
	}

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

function parseBeijingDate(date: string): { start: number; end: number } {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!match) throw new Error("date 必须使用 YYYY-MM-DD 格式");

	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const startMs = Date.UTC(year, month - 1, day, 0, 0, 0) - 8 * 60 * 60 * 1000;
	const start = Math.floor(startMs / 1000);
	return { start, end: start + 24 * 60 * 60 - 1 };
}

function parseArticle(item: any) {
	const resource = item?.resource ?? item ?? {};
	const ts = Number(resource.display_time ?? resource.publish_time ?? resource.created_at ?? 0);
	return {
		id: resource.id ?? item?.id ?? null,
		title: resource.title ?? "",
		summary: stripHtml(resource.content_short ?? resource.summary ?? resource.content ?? ""),
		url: resource.uri ?? resource.url ?? "",
		author: resource.author?.display_name ?? resource.author?.name ?? "",
		published_at_unix: Number.isFinite(ts) && ts > 0 ? ts : null,
		published_at_beijing: Number.isFinite(ts) && ts > 0 ? beijingTime(ts) : null,
	};
}

async function getLatestArticles(limit: number) {
	const url = new URL(ARTICLE_API);
	url.searchParams.set("channel", "global");
	url.searchParams.set("accept", "article");
	url.searchParams.set("limit", String(limit));
	const json = await fetchJson(url);
	const items = Array.isArray(json?.data?.items) ? json.data.items : [];
	return items.map(parseArticle).filter((item: any) => item.title);
}

async function searchArticles(query: string, limit: number) {
	const url = new URL(SEARCH_API);
	url.searchParams.set("query", query);
	url.searchParams.set("limit", String(limit));
	const json = await fetchJson(url);
	const candidates = json?.data?.items ?? json?.data?.articles ?? json?.data ?? [];
	const items = Array.isArray(candidates) ? candidates : [];
	return items.map(parseArticle).filter((item: any) => item.title);
}

function parseLiveItem(item: any) {
	const ts = Number(item?.display_time ?? 0);
	const fullContent = item?.content_more
		? stripHtml(`${item?.content ?? ""}\n${item.content_more}`)
		: stripHtml(item?.content_text ?? item?.content ?? "");
	const article = item?.article
		? {
				id: item.article.id ?? null,
				title: item.article.title ?? "",
				url: item.article.uri ?? "",
			}
		: null;

	return {
		id: item?.id ?? null,
		title: item?.title ?? "",
		content: fullContent,
		url: item?.uri ?? (item?.id ? `https://wallstreetcn.com/livenews/${item.id}` : ""),
		score: Number(item?.score ?? 1),
		importance: Number(item?.score ?? 1) >= 3 ? "非常重要" : Number(item?.score ?? 1) >= 2 ? "重要" : "普通",
		published_at_unix: ts || null,
		published_at_beijing: ts ? beijingTime(ts) : null,
		article,
		is_calendar: Boolean(item?.is_calendar),
		wscn_ticker: item?.wscn_ticker ?? null,
	};
}

async function getLiveNews(options: {
	channel: ChannelName;
	date?: string;
	hours: number;
	importantOnly: boolean;
	maxItems: number;
}) {
	const now = Math.floor(Date.now() / 1000);
	const range = options.date
		? parseBeijingDate(options.date)
		: { start: now - options.hours * 60 * 60, end: now };

	const results: ReturnType<typeof parseLiveItem>[] = [];
	let cursor: string | null = null;
	let pages = 0;
	let reachedStart = false;
	let upstreamItems = 0;
	const maxPages = 30;

	while (pages < maxPages && !reachedStart) {
		const url = new URL(LIVE_API);
		url.searchParams.set("channel", CHANNELS[options.channel]);
		url.searchParams.set("client", "pc");
		url.searchParams.set("limit", "50");
		if (cursor) url.searchParams.set("cursor", cursor);
		else url.searchParams.set("first_page", "true");

		const json = await fetchJson(url);
		const items = Array.isArray(json?.data?.items) ? json.data.items : [];
		upstreamItems += items.length;
		pages += 1;

		if (items.length === 0) break;

		for (const item of items) {
			const ts = Number(item?.display_time ?? 0);
			if (!ts) continue;
			if (ts > range.end) continue;
			if (ts < range.start) {
				reachedStart = true;
				break;
			}
			if (options.importantOnly && Number(item?.score ?? 1) < 2) continue;
			results.push(parseLiveItem(item));
			if (results.length >= options.maxItems) {
				return {
					source: "WallStreetCN / 华尔街见闻 7×24 快讯",
					channel: options.channel,
					range_beijing: {
						start: beijingTime(range.start),
						end: beijingTime(range.end),
					},
					important_only: options.importantOnly,
					returned: results.length,
					pages_fetched: pages,
					upstream_items_scanned: upstreamItems,
					truncated: true,
					items: results,
				};
			}
		}

		cursor = json?.data?.next_cursor ? String(json.data.next_cursor) : null;
		if (!cursor) break;
	}

	return {
		source: "WallStreetCN / 华尔街见闻 7×24 快讯",
		channel: options.channel,
		range_beijing: {
			start: beijingTime(range.start),
			end: beijingTime(range.end),
		},
		important_only: options.importantOnly,
		returned: results.length,
		pages_fetched: pages,
		upstream_items_scanned: upstreamItems,
		truncated: pages >= maxPages && !reachedStart,
		items: results,
	};
}

function asToolResult(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
	};
}

function asToolError(error: unknown) {
	return {
		isError: true,
		content: [
			{
				type: "text" as const,
				text: `华尔街见闻数据获取失败：${error instanceof Error ? error.message : String(error)}`,
			},
		],
	};
}

function createServer() {
	const server = new McpServer({
		name: "WallStreetCN Finance",
		version: "1.0.0",
	});

	server.registerTool(
		"get_latest_articles",
		{
			description: "获取华尔街见闻最新财经文章，返回标题、摘要、链接、作者和北京时间。",
			inputSchema: z.object({
				limit: z.number().int().min(1).max(50).default(20).describe("返回文章数量，默认20，最多50"),
			}),
		},
		async ({ limit }) => {
			try {
				return asToolResult({ source: "WallStreetCN / 华尔街见闻", articles: await getLatestArticles(limit) });
			} catch (error) {
				return asToolError(error);
			}
		},
	);

	server.registerTool(
		"get_live_news",
		{
			description:
				"获取华尔街见闻7×24财经快讯。可按指定北京时间日期（适合“昨天”）或最近N小时抓取，并支持美股、要闻、科技等频道和仅保留重要快讯。",
			inputSchema: z.object({
				channel: z.enum(["要闻", "美股", "A股", "港股", "外汇", "商品", "债券", "科技"]).default("要闻"),
				date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("指定北京时间自然日，格式YYYY-MM-DD。提供后优先于hours"),
				hours: z.number().int().min(1).max(168).default(24).describe("未提供date时，向前抓取多少小时，默认24"),
				important_only: z.boolean().default(false).describe("是否只保留score>=2的重要/非常重要快讯"),
				max_items: z.number().int().min(1).max(500).default(200).describe("最多返回多少条，默认200，最多500"),
			}),
		},
		async ({ channel, date, hours, important_only, max_items }) => {
			try {
				return asToolResult(
					await getLiveNews({
						channel,
						date,
						hours,
						importantOnly: important_only,
						maxItems: max_items,
					}),
				);
			} catch (error) {
				return asToolError(error);
			}
		},
	);

	server.registerTool(
		"search_articles",
		{
			description: "按关键词搜索华尔街见闻文章，例如 NVDA、英伟达、美联储、CPI、人工智能。",
			inputSchema: z.object({
				query: z.string().min(1).max(100).describe("搜索关键词"),
				limit: z.number().int().min(1).max(50).default(20).describe("最多返回数量，默认20"),
			}),
		},
		async ({ query, limit }) => {
			try {
				return asToolResult({ source: "WallStreetCN / 华尔街见闻", query, articles: await searchArticles(query, limit) });
			} catch (error) {
				return asToolError(error);
			}
		},
	);

	return server;
}

const handler = createMcpHandler(createServer);

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return handler(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
