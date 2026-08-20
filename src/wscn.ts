const ARTICLE_API = "https://api-one-wscn.awtmt.com/apiv1/content/information-flow";
const SEARCH_API = "https://api-one-wscn.awtmt.com/apiv1/search/article";
const LIVE_API = "https://api-one.wallstcn.com/apiv1/content/lives";
const MACRO_API = "https://api-one-wscn.awtmt.com/apiv1/finance/macrodatas";

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

const MACRO_ASSET_SUFFIX: Record<string, string> = {
	CA: "CA10YR.OTC",
	CN: "USDCNH.OTC",
	DE: "DE30.OTC",
	FR: "FR40.OTC",
	IT: "EURUSD.OTC",
	JP: "USDJPY.OTC",
	UK: "UK100.OTC",
	US: "DXY.OTC",
};

async function fetchJson(url: URL) {
	const response = await fetch(url.toString(), {
		headers: {
			Accept: "application/json",
			"User-Agent": "Mozilla/5.0 (compatible; WallStreetCN-MCP/1.1)",
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

export function beijingTime(unixSeconds: number): string {
	return new Date((unixSeconds + 8 * 60 * 60) * 1000)
		.toISOString()
		.slice(0, 19)
		.replace("T", " ");
}

export function currentBeijingDate(): string {
	return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function parseBeijingDay(date: string): { start: number; end: number } {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!match) throw new Error("日期必须使用 YYYY-MM-DD 格式");
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const utcDay = new Date(Date.UTC(year, month - 1, day));
	if (
		utcDay.getUTCFullYear() !== year ||
		utcDay.getUTCMonth() !== month - 1 ||
		utcDay.getUTCDate() !== day
	) {
		throw new Error(`无效日期：${date}`);
	}
	const start = Math.floor((Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1000) / 1000);
	return { start, end: start + 24 * 60 * 60 - 1 };
}

function valueOrNull(value: unknown) {
	return value === undefined || value === null || value === "" ? null : value;
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

export async function getLatestArticles(limit = 20) {
	const url = new URL(ARTICLE_API);
	url.searchParams.set("channel", "global");
	url.searchParams.set("accept", "article");
	url.searchParams.set("limit", String(limit));
	const json = await fetchJson(url);
	const items = Array.isArray(json?.data?.items) ? json.data.items : [];
	return items.map(parseArticle).filter((item: any) => item.title);
}

export async function searchArticles(query: string, limit = 20) {
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

export async function getLiveNews(options: {
	channel?: string;
	date?: string;
	hours?: number;
	importantOnly?: boolean;
	maxItems?: number;
}) {
	const channelName = options.channel ?? "要闻";
	const channel = CHANNELS[channelName] ?? channelName;
	const hours = options.hours ?? 24;
	const importantOnly = options.importantOnly ?? false;
	const maxItems = options.maxItems ?? 200;
	const now = Math.floor(Date.now() / 1000);
	const range = options.date ? parseBeijingDay(options.date) : { start: now - hours * 3600, end: now };

	const results: ReturnType<typeof parseLiveItem>[] = [];
	let cursor: string | null = null;
	let pages = 0;
	let reachedStart = false;
	let upstreamItems = 0;
	const maxPages = 30;

	while (pages < maxPages && !reachedStart) {
		const url = new URL(LIVE_API);
		url.searchParams.set("channel", channel);
		url.searchParams.set("client", "pc");
		url.searchParams.set("limit", "50");
		if (cursor) url.searchParams.set("cursor", cursor);
		else url.searchParams.set("first_page", "true");

		const json = await fetchJson(url);
		const items = Array.isArray(json?.data?.items) ? json.data.items : [];
		pages += 1;
		upstreamItems += items.length;
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
				return {
					source: "WallStreetCN / 华尔街见闻 7×24 快讯",
					channel: channelName,
					range_beijing: { start: beijingTime(range.start), end: beijingTime(range.end) },
					important_only: importantOnly,
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
		channel: channelName,
		range_beijing: { start: beijingTime(range.start), end: beijingTime(range.end) },
		important_only: importantOnly,
		returned: results.length,
		pages_fetched: pages,
		upstream_items_scanned: upstreamItems,
		truncated: pages >= maxPages && !reachedStart,
		items: results,
	};
}

function parseMacroItem(item: any) {
	const ts = Number(item?.public_date ?? item?.timestamp ?? item?.display_time ?? 0);
	const countryId = String(item?.country_id ?? "");
	const ticker = String(item?.wscn_ticker ?? item?.ticker ?? "");
	const suffix = MACRO_ASSET_SUFFIX[countryId];
	const actual = valueOrNull(item?.actual);
	const forecast = valueOrNull(item?.forecast);
	const previous = valueOrNull(item?.previous);
	const revised = valueOrNull(item?.revised);
	return {
		id: item?.id ?? null,
		country: item?.country ?? "",
		country_id: countryId,
		currency: item?.currency ?? "",
		title: item?.title ?? "",
		importance: Number(item?.importance ?? item?.stars ?? 0),
		importance_stars: "★".repeat(Math.max(0, Number(item?.importance ?? item?.stars ?? 0))),
		event_time_unix: ts || null,
		event_time_beijing: ts ? beijingTime(ts) : null,
		status: actual !== null ? "released" : "scheduled",
		actual,
		forecast,
		previous,
		revised,
		unit: item?.unit ?? "",
		influence: item?.influence ?? "",
		remark: item?.remark ?? "",
		wscn_ticker: ticker || null,
		calendar_key: item?.calendar_key ?? "",
		uri: item?.uri ?? "",
		data_analysis_url:
			ticker && suffix ? `https://wallstreetcn.com/data-analyse/${ticker}/${suffix}` : null,
	};
}

export async function getMacroCalendar(options: {
	startDate?: string;
	endDate?: string;
	minImportance?: number;
	countries?: string[];
} = {}) {
	const startDate = options.startDate ?? currentBeijingDate();
	const endDate = options.endDate ?? startDate;
	const startRange = parseBeijingDay(startDate);
	const endRange = parseBeijingDay(endDate);
	if (endRange.end < startRange.start) throw new Error("end_date 不能早于 start_date");
	if (endRange.end - startRange.start > 31 * 24 * 60 * 60) {
		throw new Error("单次宏观日历查询最多支持31天");
	}

	const url = new URL(MACRO_API);
	url.searchParams.set("start", String(startRange.start));
	url.searchParams.set("end", String(endRange.end));
	const json = await fetchJson(url);
	const rawItems = Array.isArray(json?.data?.items) ? json.data.items : [];
	const minImportance = options.minImportance ?? 1;
	const countrySet = new Set((options.countries ?? []).map((value) => value.trim()).filter(Boolean));
	const items = rawItems
		.map(parseMacroItem)
		.filter((item: any) => item.importance >= minImportance)
		.filter(
			(item: any) =>
				countrySet.size === 0 || countrySet.has(item.country) || countrySet.has(item.country_id),
		)
		.sort((a: any, b: any) => (a.event_time_unix ?? 0) - (b.event_time_unix ?? 0));

	return {
		source: "WallStreetCN / 华尔街见闻宏观日历",
		range_beijing: { start: startDate, end: endDate },
		min_importance: minImportance,
		countries: countrySet.size ? Array.from(countrySet) : "all",
		returned: items.length,
		items,
	};
}
