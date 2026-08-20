import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import {
	getLatestArticles,
	getLiveNews,
	getMacroCalendar,
	searchArticles,
} from "./wscn";

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
		version: "1.1.0",
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
				return asToolResult({
					source: "WallStreetCN / 华尔街见闻",
					articles: await getLatestArticles(limit),
				});
			} catch (error) {
				return asToolError(error);
			}
		},
	);

	server.registerTool(
		"get_live_news",
		{
			description:
				"获取华尔街见闻7×24财经快讯。可按指定北京时间日期或最近N小时抓取，并支持频道与重要性过滤。",
			inputSchema: z.object({
				channel: z.enum(["要闻", "美股", "A股", "港股", "外汇", "商品", "债券", "科技"]).default("要闻"),
				date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("指定北京时间自然日，格式YYYY-MM-DD；提供后优先于hours"),
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
				return asToolResult({
					source: "WallStreetCN / 华尔街见闻",
					query,
					articles: await searchArticles(query, limit),
				});
			} catch (error) {
				return asToolError(error);
			}
		},
	);

	server.registerTool(
		"get_macro_calendar",
		{
			description:
				"获取华尔街见闻宏观经济日历。支持北京时间日期区间、最低重要性和国家筛选；返回事件时间、国家、指标、今值、预期、前值、修正值、单位和数据解读链接。适合查询今天、明天、本周或未来10天重要宏观数据。",
			inputSchema: z.object({
				start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("开始日期，北京时间 YYYY-MM-DD；默认今天"),
				end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("结束日期，北京时间 YYYY-MM-DD；默认等于开始日期，单次最多31天"),
				min_importance: z.number().int().min(0).max(5).default(1).describe("最低重要性，默认1；通常2或3适合筛重要事件"),
				countries: z.array(z.string().min(1)).max(20).optional().describe("可选国家筛选，例如 [\"美国\", \"中国\"]，也可传国家代码如 US、CN"),
			}),
		},
		async ({ start_date, end_date, min_importance, countries }) => {
			try {
				return asToolResult(
					await getMacroCalendar({
						startDate: start_date,
						endDate: end_date,
						minImportance: min_importance,
						countries,
					}),
				);
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
