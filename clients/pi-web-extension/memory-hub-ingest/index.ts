// Pi 扩展入口：每轮 agent 结束时把增量对话文本推给 memory-hub 的 /api/ingest。
// 逻辑全在 ./core.mjs；这里只负责挂钩子。类型用 import type（jiti 转译时整行擦除，不产生运行时依赖）。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMemoryHubIngest } from "./core.mjs";

export default function (pi: ExtensionAPI) {
	const ingest = createMemoryHubIngest();
	if (!ingest) return; // 未配令牌 / 子 agent 进程：已 warn，不注册任何钩子

	// 处理函数都是同步的（只入队），pi 会 await 返回值，所以不会拖慢收尾。
	pi.on("session_start", (event, ctx) => { ingest.onSessionStart(event, ctx); });
	pi.on("agent_end", (event, ctx) => { ingest.onAgentEnd(event, ctx); });
	pi.on("session_shutdown", (event, ctx) => { ingest.onSessionShutdown(event, ctx); });
}
