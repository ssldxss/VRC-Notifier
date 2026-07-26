// VRChat pipeline WebSocket 客户端
// 把"本工具 <-> VRChat"的实时通道从 REST 轮询改成 ws 事件驱动。
// 认证:用现有登录后的 auth cookie 调 GET /auth 换 pipeline token,token 放 ws URL(?auth=),握手不带 cookie。
// 保活:协议级 Ping/Pong 10s,无应用层心跳(VRChat pipeline 沉默是常态)。
// 重连:断线 5s 重新换 token 重连,不重新登录;换 token 失败(401)判定 session 失效,触发游戏登录检测,不重连。
// 去重:与上一帧原始字符串比对,相同丢弃(照搬 VRCX lastWebSocketMessage)。
// 参考:vrcx-web/spike/Spike.cs + vrcx/src/services/websocket.js
const WebSocket = require('ws');

const PIPELINE_WS_BASE = 'wss://pipeline.vrchat.cloud';
const PING_INTERVAL_MS = 10 * 1000; // 协议级 Ping/Pong 10s
const RECONNECT_DELAY_MS = 5 * 1000; // 断线 5s 重连

// per-user ws 连接状态: Map<userId, {ws, lastMessage, pingTimer, reconnectTimer, displayName, stopped}>
const wsConnections = new Map();

/**
 * 创建 pipeline ws 管理器。依赖通过 opts 注入,避免与 server.js 循环依赖。
 * @param {object} opts
 *   - getSession(userId): 返回 {api, cookieJar, ...} 或 null
 *   - deleteSession(userId): 清除会话(userSessions.delete)
 *   - onGameLogin(userId, displayName): session 失效时触发(沿用 sendGameLoginEvent)
 *   - onMessage(userId, raw, parsed): 事件处理回调(第 3 组实现 applyFriendChange)
 *   - userAgent: ws 握手 User-Agent
 *   - log(msg): 日志函数
 * @returns {{getPipelineToken, connectPipeline, disconnectPipeline, isConnected}}
 */
function createPipelineManager(opts) {
    const { getSession, deleteSession, onGameLogin, onMessage, userAgent, log } = opts;
    const logger = log || ((msg) => console.log(`[${new Date().toISOString()}] ${msg}`));
    const processingChains = new Map(); // #2 per-user 事件处理串行队列(避免并发竞态)

    // 2.2 用 session.api 调 GET /auth 换 pipeline token
    // 返回 {status, token}:status = 'ok'(有 token)/ 'error'(任何失败,含 401/网络错,5s 重试不清会话)
    // 默认 cookies 不失效:不判 session 失效,失败一律重试
    async function getPipelineToken(userId) {
        const session = getSession(userId);
        if (!session || !session.api) return { status: 'error' };
        try {
            const res = await session.api.get('/auth');
            logger(`[ws] GET /auth userId=${userId} status=${res.status} body=${JSON.stringify(res.data).slice(0, 300)}`);
            if (res.status !== 200 || !res.data || !res.data.token) {
                return { status: 'error' };
            }
            return { status: 'ok', token: res.data.token };
        } catch (e) {
            logger(`[ws] GET /auth 网络错误 userId=${userId}: ${e.message}`);
            return { status: 'error' };
        }
    }

    // 2.3 + 2.4 + 2.5 + 2.6 + 2.7 连接(含保活/重连/失效检测/去重)
    async function connectPipeline(userId, displayName) {
        // 已连接则跳过
        const existing = wsConnections.get(userId);
        if (existing && existing.ws && existing.ws.readyState === WebSocket.OPEN) {
            return;
        }

        // 换 token(2.2);失败一律 5s 重试,不判 session 失效(默认 cookies 不失效)
        const result = await getPipelineToken(userId);
        if (result.status !== 'ok') {
            logger(`[ws] 换 token 失败 userId=${userId},5s 后重试(不清会话,不触发游戏登录)`);
            if (existing && existing.stopped) return;
            setTimeout(() => {
                if (getSession(userId) && !(wsConnections.get(userId)?.stopped)) {
                    connectPipeline(userId, displayName);
                }
            }, RECONNECT_DELAY_MS);
            return;
        }
        const token = result.token;

        const ws = new WebSocket(`${PIPELINE_WS_BASE}/?auth=${token}`, {
            headers: { 'User-Agent': userAgent }
        });

        const conn = {
            ws,
            lastMessage: '',
            pingTimer: null,
            reconnectTimer: null,
            displayName,
            stopped: false
        };
        wsConnections.set(userId, conn);

        ws.on('open', () => {
            logger(`[ws] 已连接 userId=${userId}`);
            // 2.4 保活:协议级 Ping/Pong 10s,无应用层心跳
            if (conn.pingTimer) clearInterval(conn.pingTimer);
            conn.pingTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    try {
                        ws.ping();
                    } catch (e) {
                        /* ignore */
                    }
                }
            }, PING_INTERVAL_MS);
        });

        ws.on('message', (data) => {
            const raw = data.toString();
            logger(`[ws] 收到消息 userId=${userId} raw=${raw.slice(0, 500)}`);
            // 2.7 消息去重:与上一帧原始字符串比对
            if (raw === conn.lastMessage) return;
            conn.lastMessage = raw;

            // 3.1 帧解析(双层 JSON:{type, content(string), err},content 二次解析)
            let parsed = null;
            try {
                parsed = JSON.parse(raw);
                if (parsed && typeof parsed.content === 'string') {
                    parsed.content = JSON.parse(parsed.content);
                }
            } catch (e) {
                logger(`[ws] 帧解析失败 userId=${userId}: ${e.message}`);
                return;
            }
            // 事件处理回调(第 3 组实现)
            if (!onMessage) return;
            // #2 per-user 串行:事件按序处理,避免同一好友多事件并发竞态
            const prev = processingChains.get(userId) || Promise.resolve();
            processingChains.set(userId, prev
                .then(() => onMessage(userId, raw, parsed))
                .catch((e) => logger(`[ws] onMessage 错误 userId=${userId}: ${e.message}`)));
        });

        ws.on('close', () => {
            if (conn.pingTimer) {
                clearInterval(conn.pingTimer);
                conn.pingTimer = null;
            }
            // 主动断开(disconnectPipeline 设 stopped=true)不重连
            if (conn.stopped) {
                wsConnections.delete(userId);
                return;
            }
            // 2.5 断线 5s 重连(重新换 token,不重新登录)
            logger(`[ws] 断开 userId=${userId},5s 后重连`);
            conn.reconnectTimer = setTimeout(() => {
                conn.reconnectTimer = null;
                const session = getSession(userId);
                if (!session) {
                    // 已登出,不重连
                    wsConnections.delete(userId);
                    return;
                }
                connectPipeline(userId, displayName);
            }, RECONNECT_DELAY_MS);
        });

        ws.on('error', (err) => {
            logger(`[ws] 错误 userId=${userId}: ${err.message}`);
            // close 会处理重连
        });
    }

    // 主动断开(登出时调用,不重连)
    function disconnectPipeline(userId) {
        const conn = wsConnections.get(userId);
        if (!conn) return;
        conn.stopped = true;
        if (conn.pingTimer) clearInterval(conn.pingTimer);
        if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
        try {
            conn.ws.close();
        } catch (e) {
            /* ignore */
        }
        wsConnections.delete(userId);
        logger(`[ws] 主动断开 userId=${userId}`);
    }

    function isConnected(userId) {
        const conn = wsConnections.get(userId);
        return !!(conn && conn.ws && conn.ws.readyState === WebSocket.OPEN);
    }

    return { getPipelineToken, connectPipeline, disconnectPipeline, isConnected };
}

module.exports = { createPipelineManager };
