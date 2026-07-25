const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const axiosCookieJarSupport = require('axios-cookiejar-support').default;
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5270;

// VRChat API 配置
const VRC_API_BASE = 'https://api.vrchat.cloud/api/1';
const USER_AGENT = 'VRChatFriendMonitor/1.0 (https://github.com/shanyaojinjn/vrc-notifier)';

// 中间件
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 确保数据目录存在
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// SQLite 数据库初始化
const db = new sqlite3.Database(path.join(dataDir, 'vrchat.db'));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vrchat_user_id TEXT UNIQUE,
    username TEXT,
    display_name TEXT,
    avatar_url TEXT,
    auth_token TEXT,
    email TEXT,
    smtp_host TEXT,
    smtp_port INTEGER,
    smtp_secure INTEGER,
    smtp_user TEXT,
    smtp_pass TEXT,
    monitor_enabled INTEGER DEFAULT 1,
    check_interval INTEGER DEFAULT 5,
    email_subject_template TEXT DEFAULT '[VRC-Notifier] {changeType}: {friendName}',
    email_body_template TEXT DEFAULT NULL,
    gotify_enabled INTEGER DEFAULT 0,
    gotify_server_url TEXT,
    gotify_app_token TEXT,
    gotify_priority INTEGER DEFAULT 5,
    gotify_title_template TEXT DEFAULT '[VRC-Notifier] {changeType}: {friendName}',
    gotify_message_template TEXT DEFAULT '好友 {friendName} {changeType}\n\n状态: {oldStatus} → {newStatus}\n世界: {newWorld}\n\n时间: {timestamp}',
    ntfy_enabled INTEGER DEFAULT 0,
    ntfy_server_url TEXT DEFAULT 'https://ntfy.sh',
    ntfy_topic TEXT,
    ntfy_priority INTEGER DEFAULT 3,
    ntfy_title_template TEXT DEFAULT '[VRC-Notifier] {changeType}: {friendName}',
    ntfy_message_template TEXT DEFAULT '好友 {friendName} {changeType}\n\n状态: {oldStatus} → {newStatus}\n世界: {newWorld}\n\n时间: {timestamp}',
    status_only_mode INTEGER DEFAULT 0,  -- 仅监控好友状态模式（0=关闭，1=开启）
    remember_me INTEGER DEFAULT 0,       -- 记住我功能（0=关闭，1=开启）
    cookie_data TEXT,                    -- 加密的cookie数据（用于自动登录）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // 检查并添加新字段（兼容旧数据库）
  db.all("PRAGMA table_info(users)", [], (err, rows) => {
    if (err) {
      console.error('检查表结构失败:', err);
      return;
    }
    
    const columns = rows.map(row => row.name);
    
    // 添加 email_subject_template 字段
    if (!columns.includes('email_subject_template')) {
      db.run(`ALTER TABLE users ADD COLUMN email_subject_template TEXT DEFAULT '[VRC-Notifier] {changeType}: {friendName}'`, (err) => {
        if (err) console.error('添加 email_subject_template 字段失败:', err);
        else console.log('[OK] 已添加 email_subject_template 字段');
      });
    }
    
    // 添加 email_body_template 字段
    if (!columns.includes('email_body_template')) {
      db.run(`ALTER TABLE users ADD COLUMN email_body_template TEXT DEFAULT NULL`, (err) => {
        if (err) console.error('添加 email_body_template 字段失败:', err);
        else console.log('[OK] 已添加 email_body_template 字段');
      });
    }
    
    // 添加 Gotify 相关字段
    if (!columns.includes('gotify_enabled')) {
      db.run(`ALTER TABLE users ADD COLUMN gotify_enabled INTEGER DEFAULT 0`, (err) => {
        if (err) console.error('添加 gotify_enabled 字段失败:', err);
        else console.log('[OK] 已添加 gotify_enabled 字段');
      });
    }
    if (!columns.includes('gotify_server_url')) {
      db.run(`ALTER TABLE users ADD COLUMN gotify_server_url TEXT`, (err) => {
        if (err) console.error('添加 gotify_server_url 字段失败:', err);
        else console.log('[OK] 已添加 gotify_server_url 字段');
      });
    }
    if (!columns.includes('gotify_app_token')) {
      db.run(`ALTER TABLE users ADD COLUMN gotify_app_token TEXT`, (err) => {
        if (err) console.error('添加 gotify_app_token 字段失败:', err);
        else console.log('[OK] 已添加 gotify_app_token 字段');
      });
    }
    if (!columns.includes('gotify_priority')) {
      db.run(`ALTER TABLE users ADD COLUMN gotify_priority INTEGER DEFAULT 5`, (err) => {
        if (err) console.error('添加 gotify_priority 字段失败:', err);
        else console.log('[OK] 已添加 gotify_priority 字段');
      });
    }
    if (!columns.includes('gotify_title_template')) {
      db.run(`ALTER TABLE users ADD COLUMN gotify_title_template TEXT DEFAULT '[VRC-Notifier] {changeType}: {friendName}'`, (err) => {
        if (err) console.error('添加 gotify_title_template 字段失败:', err);
        else console.log('[OK] 已添加 gotify_title_template 字段');
      });
    }
    if (!columns.includes('gotify_message_template')) {
      db.run(`ALTER TABLE users ADD COLUMN gotify_message_template TEXT DEFAULT '好友 {friendName} {changeType}\n\n状态: {oldStatus} → {newStatus}\n世界: {newWorld}\n\n时间: {timestamp}'`, (err) => {
        if (err) console.error('添加 gotify_message_template 字段失败:', err);
        else console.log('[OK] 已添加 gotify_message_template 字段');
      });
    }
    // 添加 NTFY 相关字段
    if (!columns.includes('ntfy_enabled')) {
      db.run(`ALTER TABLE users ADD COLUMN ntfy_enabled INTEGER DEFAULT 0`, (err) => {
        if (err) console.error('添加 ntfy_enabled 字段失败:', err);
        else console.log('[OK] 已添加 ntfy_enabled 字段');
      });
    }
    if (!columns.includes('ntfy_server_url')) {
      db.run(`ALTER TABLE users ADD COLUMN ntfy_server_url TEXT DEFAULT 'https://ntfy.sh'`, (err) => {
        if (err) console.error('添加 ntfy_server_url 字段失败:', err);
        else console.log('[OK] 已添加 ntfy_server_url 字段');
      });
    }
    if (!columns.includes('ntfy_topic')) {
      db.run(`ALTER TABLE users ADD COLUMN ntfy_topic TEXT`, (err) => {
        if (err) console.error('添加 ntfy_topic 字段失败:', err);
        else console.log('[OK] 已添加 ntfy_topic 字段');
      });
    }
    if (!columns.includes('ntfy_priority')) {
      db.run(`ALTER TABLE users ADD COLUMN ntfy_priority INTEGER DEFAULT 3`, (err) => {
        if (err) console.error('添加 ntfy_priority 字段失败:', err);
        else console.log('[OK] 已添加 ntfy_priority 字段');
      });
    }
    if (!columns.includes('ntfy_title_template')) {
      db.run(`ALTER TABLE users ADD COLUMN ntfy_title_template TEXT DEFAULT '[VRC-Notifier] {changeType}: {friendName}'`, (err) => {
        if (err) console.error('添加 ntfy_title_template 字段失败:', err);
        else console.log('[OK] 已添加 ntfy_title_template 字段');
      });
    }
    if (!columns.includes('ntfy_message_template')) {
      db.run(`ALTER TABLE users ADD COLUMN ntfy_message_template TEXT DEFAULT '好友 {friendName} {changeType}\n\n状态: {oldStatus} → {newStatus}\n世界: {newWorld}\n\n时间: {timestamp}'`, (err) => {
        if (err) console.error('添加 ntfy_message_template 字段失败:', err);
        else console.log('[OK] 已添加 ntfy_message_template 字段');
      });
    }
    // 添加 status_only_mode 字段（仅监控好友状态模式）
    if (!columns.includes('status_only_mode')) {
      db.run(`ALTER TABLE users ADD COLUMN status_only_mode INTEGER DEFAULT 0`, (err) => {
        if (err) console.error('添加 status_only_mode 字段失败:', err);
        else console.log('[OK] 已添加 status_only_mode 字段（仅监控好友状态模式）');
      });
    }
    
    // 添加 remember_me 字段（记住我功能）
    if (!columns.includes('remember_me')) {
      db.run(`ALTER TABLE users ADD COLUMN remember_me INTEGER DEFAULT 0`, (err) => {
        if (err) console.error('添加 remember_me 字段失败:', err);
        else console.log('[OK] 已添加 remember_me 字段（记住我功能）');
      });
    }
    
    // 添加 cookie_data 字段（加密的cookie数据）
    if (!columns.includes('cookie_data')) {
      db.run(`ALTER TABLE users ADD COLUMN cookie_data TEXT`, (err) => {
        if (err) console.error('添加 cookie_data 字段失败:', err);
        else console.log('[OK] 已添加 cookie_data 字段（自动登录）');
      });
    }
    
    // 添加 saved_username 字段（保存的用户名，用于自动填充）
    if (!columns.includes('saved_username')) {
      db.run(`ALTER TABLE users ADD COLUMN saved_username TEXT`, (err) => {
        if (err) console.error('添加 saved_username 字段失败:', err);
        else console.log('[OK] 已添加 saved_username 字段（保存用户名）');
      });
    }
    
    // 添加通用 Webhook 相关字段
    if (!columns.includes('webhook_enabled')) {
      db.run(`ALTER TABLE users ADD COLUMN webhook_enabled INTEGER DEFAULT 0`, (err) => {
        if (err) console.error('添加 webhook_enabled 字段失败:', err);
      });
    }
    if (!columns.includes('webhook_url')) {
      db.run(`ALTER TABLE users ADD COLUMN webhook_url TEXT`, (err) => {
        if (err) console.error('添加 webhook_url 字段失败:', err);
      });
    }
    if (!columns.includes('webhook_method')) {
      db.run(`ALTER TABLE users ADD COLUMN webhook_method TEXT DEFAULT 'POST'`, (err) => {
        if (err) console.error('添加 webhook_method 字段失败:', err);
      });
    }
    if (!columns.includes('webhook_headers')) {
      db.run(`ALTER TABLE users ADD COLUMN webhook_headers TEXT`, (err) => {
        if (err) console.error('添加 webhook_headers 字段失败:', err);
      });
    }
    if (!columns.includes('webhook_body_template')) {
      db.run(`ALTER TABLE users ADD COLUMN webhook_body_template TEXT`, (err) => {
        if (err) console.error('添加 webhook_body_template 字段失败:', err);
      });
    }
    if (!columns.includes('webhook_content_type')) {
      db.run(`ALTER TABLE users ADD COLUMN webhook_content_type TEXT DEFAULT 'application/json'`, (err) => {
        if (err) console.error('添加 webhook_content_type 字段失败:', err);
      });
    }
  });

  db.run(`CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    friend_vrchat_id TEXT,
    display_name TEXT,
    avatar_url TEXT,
    status TEXT,
    state TEXT,
    world_id TEXT,
    world_name TEXT,
    status_description TEXT,       -- 自定义状态文字
    last_seen DATETIME,
    pending_status TEXT,           -- 待确认的状态（防抖动机制）
    pending_count INTEGER DEFAULT 0, -- 连续检测次数（防抖动机制）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, friend_vrchat_id)
  )`);

  // 好友监控配置表
  db.run(`CREATE TABLE IF NOT EXISTS friend_monitor_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    friend_vrchat_id TEXT,
    monitor_enabled INTEGER DEFAULT 0,
    notify_online INTEGER DEFAULT 1,
    notify_offline INTEGER DEFAULT 1,
    notify_status_change INTEGER DEFAULT 1,
    notify_world_change INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, friend_vrchat_id)
  )`);

  // 检查并添加防抖动相关字段（兼容旧数据库）
  db.all("PRAGMA table_info(friends)", [], (err, rows) => {
    if (err) {
      console.error('检查 friends 表结构失败:', err);
      return;
    }
    
    const columns = rows.map(row => row.name);
    
    // 添加 pending_status 字段
    if (!columns.includes('pending_status')) {
      db.run(`ALTER TABLE friends ADD COLUMN pending_status TEXT`, (err) => {
        if (err) console.error('添加 pending_status 字段失败:', err);
        else console.log('[OK] 已添加 pending_status 字段（防抖动机制）');
      });
    }
    
    // 添加 pending_count 字段
    if (!columns.includes('pending_count')) {
      db.run(`ALTER TABLE friends ADD COLUMN pending_count INTEGER DEFAULT 0`, (err) => {
        if (err) console.error('添加 pending_count 字段失败:', err);
        else console.log('[OK] 已添加 pending_count 字段（防抖动机制）');
      });
    }
    
    // 添加 status_description 字段（自定义状态）
    if (!columns.includes('status_description')) {
      db.run(`ALTER TABLE friends ADD COLUMN status_description TEXT`, (err) => {
        if (err) console.error('添加 status_description 字段失败:', err);
        else console.log('[OK] 已添加 status_description 字段（自定义状态）');
      });
    }
    
    // 添加 platform 字段（平台信息）
    if (!columns.includes('platform')) {
      db.run(`ALTER TABLE friends ADD COLUMN platform TEXT`, (err) => {
        if (err) console.error('添加 platform 字段失败:', err);
        else console.log('[OK] 已添加 platform 字段（平台信息）');
      });
    }
  });

  // 系统设置表
  db.run(`CREATE TABLE IF NOT EXISTS system_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE,
    value TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

// 初始化访问密钥
async function initAccessKey() {
  const accessKey = await new Promise((resolve, reject) => {
    db.get('SELECT value FROM system_settings WHERE key = ?', ['access_key'], (err, row) => {
      if (err) reject(err);
      else resolve(row ? row.value : null);
    });
  });

  if (!accessKey) {
    // 生成32位随机密钥
    const newKey = crypto.randomBytes(32).toString('hex').toUpperCase();
    await new Promise((resolve, reject) => {
      db.run('INSERT INTO system_settings (key, value) VALUES (?, ?)', ['access_key', newKey], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    return newKey;
  }
  return accessKey;
}

// 获取访问密钥启用状态
async function isAccessKeyEnabled() {
  const result = await new Promise((resolve, reject) => {
    db.get('SELECT value FROM system_settings WHERE key = ?', ['access_key_enabled'], (err, row) => {
      if (err) reject(err);
      else resolve(row ? row.value : '1'); // 默认启用
    });
  });
  return result === '1';
}

// 用户会话缓存
const userSessions = new Map();

// 会话过期时间（30天）
const SESSION_EXPIRE_TIME = 30 * 24 * 60 * 60 * 1000;

// API 请求频率限制配置（严格遵循VRChat API规范，留有安全余量）
// 官方限制：用户资料≤1次/分钟，好友状态≤5次/分钟，世界信息≤10次/分钟
// 本程序使用更保守的值，确保无论如何都不会触发官方限制
const API_RATE_LIMITS = {
  userProfile: { maxRequests: 1, windowMs: 60 * 1000 },      // 用户资料：≤1次/分钟（与官方一致）
  friendStatus: { maxRequests: 2, windowMs: 60 * 1000 },      // 好友状态：≤2次/分钟（官方5次，留有余量）
  worldInfo: { maxRequests: 6, windowMs: 60 * 1000 }          // 世界信息：≤6次/分钟（官方10次，留有余量）
};

// 全局API限流保护 - 当触发限流时暂停所有请求
const globalRateLimitProtection = {
  isPaused: false,           // 是否处于暂停状态
  pauseEndTime: 0,           // 暂停结束时间
  pauseDuration: 60 * 1000,  // 基础暂停60秒
  lastTriggerTime: 0,        // 上次触发限流的时间
  triggerCount: 0,           // 连续触发次数统计
  maxTriggers: 3,            // 最大连续触发次数，超过则停止监控
  isStopped: false           // 是否已完全停止监控
};

// 重置限流保护状态（每天重置一次）
function resetRateLimitProtection() {
  const now = Date.now();
  const lastTrigger = globalRateLimitProtection.lastTriggerTime;
  // 如果距离上次触发超过1小时，重置计数
  if (lastTrigger > 0 && (now - lastTrigger) > 60 * 60 * 1000) {
    console.log('[限流保护] 距离上次限流已超过1小时，重置连续触发计数');
    globalRateLimitProtection.triggerCount = 0;
    globalRateLimitProtection.isStopped = false;
  }
}

// API 请求记录和缓存
const apiCache = new Map();       // 缓存API响应
const CACHE_TTL = {
  userProfile: 60 * 1000,        // 用户资料缓存1分钟
  friendStatus: 30 * 1000,       // 好友状态缓存30秒（2次/分钟）
  worldInfo: 10 * 60 * 1000      // 世界信息缓存10分钟
};

// 世界信息轮询索引 - 按用户隔离
const worldPollIndex = new Map();  // Map<userId, {currentIndex: number, lastPollTime: number}>

// 好友列表缓存 - 按用户隔离，实现秒开效果
const friendsListCache = new Map();  // Map<userId, {friends: [], timestamp: number, permanent: boolean}>
const FRIENDS_LIST_CACHE_TTL = 365 * 24 * 60 * 60 * 1000;  // 好友列表缓存1年（永久缓存，直到手动刷新）

// 用户登录时间记录 - 用于冷却期控制
const userLoginTime = new Map();  // Map<userId, loginTimestamp>
const userRefreshTime = new Map();  // Map<userId, lastRefreshTimestamp>
const REFRESH_COOLDOWN = 60 * 1000;  // 登录或刷新后1分钟冷却期（1分钟内不检查监控）

// 世界变化缓存 - 用于批量发送世界变化通知
const worldChangeBuffer = new Map();  // Map<userId, {changes: [], lastPollRound: number}>

// 请求队列（用于控制并发）- 按用户ID隔离
const requestQueues = new Map();  // Map<userId, Map<type, RateLimiter>>

// API 限流器类
class RateLimiter {
  constructor(type) {
    this.type = type;
    this.config = API_RATE_LIMITS[type];
    this.requests = [];
    this.waiting = [];  // 等待队列
    this.processing = false;
    this.triggeredLimit = false;  // 是否已触发限流
  }

  async checkLimit() {
    // 限流暂时禁用(ws 改造测试期):直接放行,不限制请求频率、不触发全局暂停
    return true;
  }

  async processQueue() {
    if (this.processing || this.waiting.length === 0) return;
    this.processing = true;

    while (this.waiting.length > 0) {
      const now = Date.now();
      
      // 检查全局暂停状态
      if (globalRateLimitProtection.isPaused) {
        const remainingPause = globalRateLimitProtection.pauseEndTime - now;
        if (remainingPause > 0) {
          console.log(`[全局限流] 系统处于暂停状态，剩余 ${Math.ceil(remainingPause/1000)} 秒`);
          await this.sleep(Math.min(remainingPause, 5000));
          continue;
        } else {
          // 暂停结束
          globalRateLimitProtection.isPaused = false;
          console.log('[全局限流] 暂停结束，恢复正常请求');
        }
      }
      
      const windowStart = now - this.config.windowMs;
      
      // 清理过期的请求记录
      this.requests = this.requests.filter(time => time > windowStart);
      
      // 检查是否超过限制
      if (this.requests.length >= this.config.maxRequests) {
        // 触发全局限流保护
        if (!this.triggeredLimit) {
          this.triggeredLimit = true;
          this.triggerGlobalProtection();
        }
        
        const oldestRequest = this.requests[0];
        const waitTime = Math.min(oldestRequest + this.config.windowMs - now, 5000);
        if (waitTime > 0) {
          console.log(`[限流] ${this.type} 达到限制，等待 ${waitTime}ms，队列长度: ${this.waiting.length}`);
          await this.sleep(waitTime);
          continue;
        }
      } else {
        // 重置触发标记
        this.triggeredLimit = false;
      }
      
      // 处理下一个请求
      const next = this.waiting.shift();
      if (next) {
        this.requests.push(Date.now());
        next.resolve(true);
      }
    }

    this.processing = false;
  }
  
  // 触发全局保护机制
  triggerGlobalProtection() {
    const now = Date.now();
    
    // 如果已经在暂停中，不重复触发
    if (globalRateLimitProtection.isPaused) return;
    
    // 检查是否已经超过最大触发次数
    if (globalRateLimitProtection.triggerCount >= globalRateLimitProtection.maxTriggers - 1) {
      // 第三次触发，完全停止监控
      globalRateLimitProtection.isStopped = true;
      globalRateLimitProtection.triggerCount++;
      
      const stopMessage = `[API限流保护] 连续触发限流保护3次，系统已完全停止监控以保护账号安全！请检查配置或稍后再试。`;
      console.log('\n' + '!'.repeat(80));
      console.log(stopMessage);
      console.log('!'.repeat(80) + '\n');
      
      // 广播停止监控事件给所有连接的客户端
      broadcastRateLimitEvent({
        type: 'rate_limit_stopped',
        apiType: this.type,
        triggerCount: globalRateLimitProtection.triggerCount,
        message: '连续触发限流保护3次，系统已完全停止监控以保护您的账号安全。请检查配置或1小时后再试。',
        timestamp: formatLocalTime()
      });
      
      // 发送通知给所有用户
      sendRateLimitNotificationToAllUsers(this.type, 'stopped');
      return;
    }
    
    // 计算暂停时间（第一次60秒，第二次120秒）
    const pauseMultiplier = globalRateLimitProtection.triggerCount + 1;
    const currentPauseDuration = globalRateLimitProtection.pauseDuration * pauseMultiplier;
    
    globalRateLimitProtection.isPaused = true;
    globalRateLimitProtection.pauseEndTime = now + currentPauseDuration;
    globalRateLimitProtection.lastTriggerTime = now;
    globalRateLimitProtection.triggerCount++;
    
    const pauseSeconds = currentPauseDuration / 1000;
    const triggerMessage = `[API限流保护] 第${globalRateLimitProtection.triggerCount}次触发限流保护！类型: ${this.type}，系统暂停${pauseSeconds}秒`;
    console.log('\n' + '='.repeat(80));
    console.log(triggerMessage);
    console.log('='.repeat(80) + '\n');
    
    // 广播限流事件给所有连接的客户端
    broadcastRateLimitEvent({
      type: 'rate_limit_triggered',
      apiType: this.type,
      pauseDuration: pauseSeconds,
      triggerCount: globalRateLimitProtection.triggerCount,
      message: `检测到API请求频率过高，系统已自动暂停${pauseSeconds}秒以保护您的账号安全（第${globalRateLimitProtection.triggerCount}次触发）`,
      timestamp: new Date().toISOString()
    });
    
    // 发送通知给所有用户
    sendRateLimitNotificationToAllUsers(this.type, 'triggered', pauseSeconds);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// 获取限流器实例 - 按用户ID和API类型隔离
function getRateLimiter(userId, type) {
  if (!requestQueues.has(userId)) {
    requestQueues.set(userId, new Map());
  }
  const userQueues = requestQueues.get(userId);
  if (!userQueues.has(type)) {
    userQueues.set(type, new RateLimiter(type));
  }
  return userQueues.get(type);
}

// 带缓存的API请求
async function cachedApiRequest(api, endpoint, type, cacheKey, userId) {
  // 如果没有提供userId，从cacheKey中提取
  if (!userId && cacheKey) {
    const parts = cacheKey.split('_');
    if (parts.length > 1) {
      userId = parts[parts.length - 1];
    }
  }
  
  // 如果没有userId，使用全局限流（不推荐）
  const limiter = getRateLimiter(userId || 'global', type);
  const cacheConfig = CACHE_TTL[type];
  
  // 检查缓存
  const cached = apiCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < cacheConfig) {
    console.log(`[缓存命中] ${endpoint}`);
    return cached.data;
  }
  
  // 等待限流
  await limiter.checkLimit();
  
  // 执行请求
  console.log(`[API请求] ${endpoint} (${type})`);
  const response = await api.get(endpoint);
  
  // 缓存结果
  apiCache.set(cacheKey, {
    data: response,
    timestamp: Date.now(),
    type: type
  });
  
  return response;
}

// 清理过期缓存
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of apiCache.entries()) {
    const maxAge = CACHE_TTL[value.type] || 60000;
    if (now - value.timestamp > maxAge * 2) {
      apiCache.delete(key);
    }
  }
}, 5 * 60 * 1000); // 每5分钟清理一次

// 加密配置
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const ENCRYPTION_IV_LENGTH = 16;

// 加密函数
function encrypt(text) {
  if (!text) return null;
  try {
    const iv = crypto.randomBytes(ENCRYPTION_IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
  } catch (e) {
    console.error('加密失败:', e.message);
    return null;
  }
}

// 解密函数
function decrypt(encryptedText) {
  if (!encryptedText) return null;
  try {
    const parts = encryptedText.split(':');
    if (parts.length !== 2) return null;
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('解密失败:', e.message);
    return null;
  }
}

// 格式化本地时间（用于日志显示）
function formatLocalTime(date = new Date()) {
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

// 定期清理过期会话
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of userSessions.entries()) {
    if (session.createdAt && (now - session.createdAt > SESSION_EXPIRE_TIME)) {
      console.log(`会话过期，清理用户: ${userId}`);
      // 发送会话过期通知到各平台
      sendSessionExpiredEvent(userId, 'session_expired');
      userSessions.delete(userId);
    }
  }
}, 60 * 60 * 1000); // 每小时清理一次

// 创建带 cookie 支持的 axios 实例
function createAxiosInstance(cookieJar) {
  const instance = axios.create({
    baseURL: VRC_API_BASE,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    jar: cookieJar,
    withCredentials: true,
    validateStatus: () => true
  });
  
  axiosCookieJarSupport(instance);
  return instance;
}

// 保存用户的 cookie 到数据库（用于记住我功能）
async function saveUserCookies(userId, cookieJar, username = null) {
  try {
    // 获取所有 cookies
    const cookies = await cookieJar.getCookies(VRC_API_BASE);
    if (!cookies || cookies.length === 0) {
      console.log(`[记住我] 用户 ${userId} 没有 cookies 可保存`);
      return false;
    }
    
    // 序列化 cookies
    const cookieData = JSON.stringify(cookies.map(c => c.toJSON()));
    
    // 加密存储
    const encryptedCookieData = encrypt(cookieData);
    
    // 保存到数据库（同时保存 cookie 和用户名）
    const updates = ['cookie_data = ?', 'remember_me = 1', 'updated_at = CURRENT_TIMESTAMP'];
    const params = [encryptedCookieData];
    
    if (username) {
      updates.push('saved_username = ?');
      params.push(username);
    }
    
    params.push(userId);
    
    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE users SET ${updates.join(', ')} WHERE vrchat_user_id = ?`,
        params,
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
    
    console.log(`[记住我] 已保存用户 ${userId} 的登录凭据${username ? ' 和用户名' : ''}`);
    return true;
  } catch (e) {
    console.error(`[记住我] 保存用户 ${userId} 的 cookies 失败:`, e.message);
    return false;
  }
}

// 从数据库恢复用户的 cookie（用于自动登录）
async function loadUserCookies(userId) {
  try {
    // 从数据库获取加密的 cookie 数据
    const user = await new Promise((resolve, reject) => {
      db.get(
        'SELECT cookie_data, remember_me FROM users WHERE vrchat_user_id = ?',
        [userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
    
    if (!user || !user.remember_me || !user.cookie_data) {
      console.log(`[记住我] 用户 ${userId} 没有保存的登录凭据`);
      return null;
    }
    
    // 解密 cookie 数据
    const decryptedCookieData = decrypt(user.cookie_data);
    if (!decryptedCookieData) {
      console.error(`[记住我] 解密用户 ${userId} 的 cookies 失败`);
      return null;
    }
    
    // 解析 cookies
    const cookieArray = JSON.parse(decryptedCookieData);
    
    // 创建新的 CookieJar 并恢复 cookies
    const cookieJar = new CookieJar();
    for (const cookieData of cookieArray) {
      try {
        await cookieJar.setCookie(
          `${cookieData.key}=${cookieData.value}; Domain=${cookieData.domain}; Path=${cookieData.path}`,
          VRC_API_BASE
        );
      } catch (e) {
        console.error(`[记住我] 恢复 cookie 失败:`, e.message);
      }
    }
    
    console.log(`[记住我] 已恢复用户 ${userId} 的登录凭据`);
    return cookieJar;
  } catch (e) {
    console.error(`[记住我] 加载用户 ${userId} 的 cookies 失败:`, e.message);
    return null;
  }
}

// 清除用户的保存的 cookie（用户退出登录时调用）
async function clearUserCookies(userId) {
  try {
    await new Promise((resolve, reject) => {
      db.run(
        'UPDATE users SET cookie_data = NULL, remember_me = 0, updated_at = CURRENT_TIMESTAMP WHERE vrchat_user_id = ?',
        [userId],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
    
    console.log(`[记住我] 已清除用户 ${userId} 的登录凭据`);
    return true;
  } catch (e) {
    console.error(`[记住我] 清除用户 ${userId} 的 cookies 失败:`, e.message);
    return false;
  }
}

// 通用 Webhook 推送函数
async function sendWebhookNotification(user, notificationData) {
  if (!user.webhook_enabled || !user.webhook_url) {
    console.log(`用户 ${user.display_name} 未配置通用 Webhook，跳过推送`);
    return false;
  }

  try {
    const {
      friendName,
      oldStatus,
      newStatus,
      oldWorld,
      newWorld,
      changeType,
      timestamp,
      avatarUrl,
      eventType,
      oldStatusDescription,
      newStatusDescription
    } = notificationData;

    // 准备模板变量
    const templateVars = {
      '{friendName}': friendName || '',
      '{oldStatus}': oldStatus || '未知',
      '{newStatus}': newStatus || '未知',
      '{oldWorld}': oldWorld || '未知',
      '{newWorld}': newWorld || '未知',
      '{changeType}': changeType || '',
      '{timestamp}': timestamp || new Date().toLocaleString('zh-CN'),
      '{avatarUrl}': avatarUrl || '',
      '{eventType}': eventType || 'status_change',
      '{oldStatusDescription}': oldStatusDescription || '无',
      '{newStatusDescription}': newStatusDescription || '无',
      '{oldPlatform}': notificationData.oldPlatformDisplay || getPlatformDisplayName(notificationData.oldPlatform || 'unknown'),
      '{newPlatform}': notificationData.newPlatformDisplay || getPlatformDisplayName(notificationData.newPlatform || 'unknown')
    };

    // 解析并构建请求头
    let headers = {
      'Content-Type': user.webhook_content_type || 'application/json'
    };
    
    // 如果用户配置了自定义请求头，解析并合并
    if (user.webhook_headers) {
      try {
        const customHeaders = JSON.parse(user.webhook_headers);
        headers = { ...headers, ...customHeaders };
      } catch (e) {
        console.error('解析自定义请求头失败:', e.message);
      }
    }

    // 构建请求体
    let body;
    const method = (user.webhook_method || 'POST').toUpperCase();
    
    if (user.webhook_body_template) {
      // 使用用户自定义模板
      body = user.webhook_body_template;
      for (const [key, value] of Object.entries(templateVars)) {
        body = body.replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value);
      }
      
      // 尝试解析为 JSON（如果内容类型是 application/json）
      if (headers['Content-Type'] === 'application/json') {
        try {
          body = JSON.parse(body);
        } catch (e) {
          // 不是有效的 JSON，保持原样
        }
      }
    } else {
      // 使用默认模板
      body = {
        event: eventType || 'status_change',
        timestamp: templateVars['{timestamp}'],
        friend: {
          name: friendName,
          avatar: avatarUrl
        },
        change: {
          type: changeType,
          oldStatus: oldStatus,
          newStatus: newStatus,
          oldWorld: oldWorld,
          newWorld: newWorld,
          oldStatusDescription: oldStatusDescription,
          newStatusDescription: newStatusDescription
        }
      };
    }

    // 发送请求
    const config = {
      method: method,
      url: user.webhook_url,
      headers: headers,
      timeout: 10000 // 10秒超时
    };

    // GET 请求不发送 body
    if (method !== 'GET') {
      config.data = body;
    }

    const response = await axios(config);
    
    console.log(`通用 Webhook 推送成功: ${user.webhook_url} (状态: ${response.status})`);
    return true;
  } catch (e) {
    console.error('发送通用 Webhook 推送失败:', e.message);
    return false;
  }
}

// 渲染 Gotify 模板
function renderGotifyTemplate(template, variables) {
  if (!template) return '';
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    const placeholder = `{${key}}`;
    result = result.split(placeholder).join(value || '');
  }
  return result;
}

// 生成智能 Gotify 推送标题
function generateGotifyTitle(friendName, changeType, oldStatus, newStatus, oldWorld, newWorld) {
  // 根据变化类型生成直观的标题
  switch (changeType) {
    case '上线':
      return `${friendName} 上线了`;
    case '下线':
      return `${friendName} 下线了`;
    case 'web端上线':
      return `${friendName} 从web端上线了`;
    case '下线至web端':
      return `${friendName} 下线至web端`;
    case '切换世界':
      // 世界变化时显示从哪切换到哪
      const oldWorldShort = oldWorld && oldWorld !== '-' ? truncateString(oldWorld, 15) : '未知世界';
      const newWorldShort = newWorld && newWorld !== '-' ? truncateString(newWorld, 15) : '未知世界';
      return `${friendName}: ${oldWorldShort} → ${newWorldShort}`;
    case '状态变化':
      // 状态变化时显示具体状态变化
      return `${friendName}: ${oldStatus} → ${newStatus}`;
    default:
      return `${friendName} ${changeType}`;
  }
}

// RFC 2047 编码函数：将中文标题编码为 =?UTF-8?B?Base64?= 格式
function encodeRfc2047(text) {
  if (!text) return '';

  // 检查是否包含非 ASCII 字符
  const hasNonAscii = /[^\x00-\x7F]/.test(text);

  if (!hasNonAscii) {
    // 纯 ASCII 字符，直接返回
    return text;
  }

  // 使用 Base64 编码（RFC 2047 格式）
  // 格式: =?UTF-8?B?Base64EncodedText?=
  const base64 = Buffer.from(text, 'utf8').toString('base64');
  return `=?UTF-8?B?${base64}?=`;
}

// 格式化日期为横杠连接形式，避免被识别为电话号码
// 格式: YYYY-MM-DD HH:mm:ss
function formatDateSafe(date) {
  if (!date) date = new Date();
  if (typeof date === 'string') date = new Date(date);

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// 获取平台显示名称（用于自定义模板）
// 支持的平台: web, standalonewindows, android, ios, standalonelinux
function getPlatformDisplayName(platform) {
  const platformMap = {
    'web': '网页端',
    'standalonewindows': 'Windows客户端',
    'android': '安卓客户端',
    'ios': 'iOS客户端',
    'standalonelinux': 'Linux客户端',
    'unknown': '未知平台',
    'offline': '离线'
  };
  return platformMap[platform] || platform;
}

// 生成智能 Gotify 推送内容
function generateGotifyMessage(friendName, changeType, oldStatus, newStatus, oldWorld, newWorld, timestamp, oldStatusDescription, newStatusDescription) {
  let message = '';

  switch (changeType) {
    case '上线':
      message = `${friendName} 刚刚上线了！\n\n`;
      message += `当前状态: ${newStatus}\n`;
      if (newWorld && newWorld !== '-') {
        message += `所在世界: ${newWorld}\n`;
      }
      if (newStatusDescription) {
        message += `自定义状态: ${newStatusDescription}\n`;
      }
      break;
    case '下线':
      message = `${friendName} 刚刚下线了\n\n`;
      message += `之前状态: ${oldStatus}\n`;
      if (oldWorld && oldWorld !== '-') {
        message += `之前所在: ${oldWorld}\n`;
      }
      if (oldStatusDescription) {
        message += `自定义状态: ${oldStatusDescription}\n`;
      }
      break;
    case '切换世界':
      message = `${friendName} 切换到了新的世界\n\n`;
      message += `世界变化:\n`;
      message += `  从: ${oldWorld && oldWorld !== '-' ? oldWorld : '未知'}\n`;
      message += `  到: ${newWorld && newWorld !== '-' ? newWorld : '未知'}\n`;
      if (oldStatus !== newStatus) {
        message += `\n状态: ${oldStatus} → ${newStatus}\n`;
      }
      if (newStatusDescription) {
        message += `自定义状态: ${newStatusDescription}\n`;
      }
      break;
    case '状态变化':
      message = `${friendName} 的状态发生了变化\n\n`;
      message += `状态变化: ${oldStatus} → ${newStatus}\n`;
      if (newWorld && newWorld !== '-') {
        message += `所在世界: ${newWorld}\n`;
      }
      if (newStatusDescription) {
        message += `自定义状态: ${newStatusDescription}\n`;
      }
      break;
    case 'web端上线':
      // 默认模板不显示平台信息，只在自定义模板中使用 {oldPlatform}/{newPlatform}
      message = `${friendName} 从web端上线了！\n\n`;
      message += `当前状态: ${newStatus}\n`;
      if (newWorld && newWorld !== '-') {
        message += `所在世界: ${newWorld}\n`;
      }
      if (newStatusDescription) {
        message += `自定义状态: ${newStatusDescription}\n`;
      }
      break;
    case '下线至web端':
      // 默认模板不显示平台信息，只在自定义模板中使用 {oldPlatform}/{newPlatform}
      message = `${friendName} 下线至web端\n\n`;
      message += `之前状态: ${oldStatus}\n`;
      if (oldWorld && oldWorld !== '-') {
        message += `之前所在: ${oldWorld}\n`;
      }
      if (oldStatusDescription) {
        message += `自定义状态: ${oldStatusDescription}\n`;
      }
      break;
    default:
      message = `${friendName} ${changeType}\n\n`;
      message += `状态: ${oldStatus} → ${newStatus}\n`;
  }

  message += `\n时间: ${timestamp}`;
  return message;
}

// 字符串截断辅助函数
function truncateString(str, maxLength) {
  if (!str || str.length <= maxLength) return str || '';
  return str.substring(0, maxLength) + '...';
}

// 发送 Gotify 推送通知
async function sendGotifyNotification(user, title, message, priority = 5, extras = null) {
  if (!user.gotify_enabled || !user.gotify_server_url || !user.gotify_app_token) {
    console.log(`用户 ${user.display_name} 未配置 Gotify，跳过推送`);
    return false;
  }

  try {
    const gotifyUrl = user.gotify_server_url.replace(/\/$/, '') + '/message';

    const payload = {
      title: title,
      message: message,
      priority: priority
    };

    // 添加 extras 如果提供了
    if (extras) {
      payload.extras = extras;
    }

    const response = await axios.post(gotifyUrl, payload, {
      params: {
        token: user.gotify_app_token
      },
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });

    if (response.status === 200) {
      console.log(`Gotify 推送已发送: ${title}`);
      return true;
    } else {
      console.error('Gotify 推送失败:', response.status, response.data);
      return false;
    }
  } catch (e) {
    console.error('发送 Gotify 推送失败:', e.message);
    return false;
  }
}

// 发送 NTFY 推送通知
async function sendNtfyNotification(user, title, message, priority = 3, tags = null) {
  if (!user.ntfy_enabled || !user.ntfy_server_url || !user.ntfy_topic) {
    console.log(`用户 ${user.display_name} 未配置 NTFY，跳过推送`);
    return false;
  }

  try {
    // 构建 NTFY URL: https://ntfy.sh/mytopic
    const ntfyUrl = user.ntfy_server_url.replace(/\/$/, '') + '/' + encodeURIComponent(user.ntfy_topic);

    // 根据 RFC 7230，HTTP header 值必须是可见 ASCII 字符 (0x21-0x7E) 或空格 (0x20) 或 tab (0x09)
    // 但为了支持 Unicode，我们使用 encodeURIComponent 来编码标题
    // 或者使用 Buffer 转换为 UTF-8 字节序列
    
    // 首先清理 title - 移除所有控制字符
    let cleanTitle = title
      .replace(/[\x00-\x1F\x7F]/g, ' ')  // 替换控制字符为空格
      .replace(/\s+/g, ' ')  // 合并多个空格
      .trim()
      .substring(0, 250);  // 限制长度

    // 如果标题为空，使用默认标题
    if (!cleanTitle) {
      cleanTitle = 'VRC-Notifier';
    }

    // 清理 message - 移除控制字符但保留换行符
    let cleanMessage = message || '';
    cleanMessage = cleanMessage.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // 准备 headers
    const headers = {};
    headers['Content-Type'] = 'text/plain';
    const encodedTitle = encodeRfc2047(cleanTitle) || 'VRC-Notifier';
    headers['Title'] = encodedTitle;
    const ntfyPriority = Math.max(1, Math.min(5, priority));
    headers['Priority'] = String(ntfyPriority);
    if (tags) {
      const tagStr = Array.isArray(tags) ? tags.join(',') : String(tags);
      headers['Tags'] = tagStr.replace(/[^\x20-\x7E,]/g, '');
    }

    console.log(`[NTFY] 发送: ${cleanTitle}`);

    const response = await axios.post(ntfyUrl, cleanMessage, {
      headers: headers,
      timeout: 10000
    });

    if (response.status === 200 || response.status === 204) {
      console.log(`[NTFY] 成功`);
      return true;
    } else {
      console.error('[NTFY] 失败:', response.status);
      return false;
    }
  } catch (e) {
    console.error('[NTFY] 发送推送失败:', e.message);
    console.error('[NTFY] Error stack:', e.stack);
    return false;
  }
}

// 发送邮件通知
async function sendEmailNotification(user, params) {
  // 支持两种调用方式：对象参数或单独参数
  let friend, oldStatus, newStatus, oldWorld, newWorld, changeType, oldStatusDescription, newStatusDescription;
  
  if (typeof params === 'object' && params !== null) {
    // 对象参数方式
    friend = params.friend;
    oldStatus = params.oldStatus;
    newStatus = params.newStatus;
    oldWorld = params.oldWorld;
    newWorld = params.newWorld;
    changeType = params.changeType;
    oldStatusDescription = params.oldStatusDescription;
    newStatusDescription = params.newStatusDescription;
  } else {
    // 单独参数方式（向后兼容）
    friend = params;
    oldStatus = arguments[2];
    newStatus = arguments[3];
    oldWorld = arguments[4];
    newWorld = arguments[5];
  }
  
  if (!user.smtp_host || !user.smtp_user || !user.smtp_pass) {
    console.log(`用户 ${user.display_name} 未配置 SMTP，跳过邮件通知`);
    return false;
  }

  // 解密 SMTP 密码
  const decryptedPass = decrypt(user.smtp_pass);
  if (!decryptedPass) {
    console.error(`用户 ${user.display_name} 的 SMTP 密码解密失败`);
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: user.smtp_host,
    port: user.smtp_port || 587,
    secure: user.smtp_secure === 1,
    auth: {
      user: user.smtp_user,
      pass: decryptedPass
    }
  });

  const timestamp = new Date().toLocaleString('zh-CN');
  
  // 分析变化类型
  let notificationChangeType = changeType || '状态变化';
  let changeDescription = '';
  let changeDetails = [];
  
  // 自定义状态变化
  if (changeType === '自定义状态') {
    notificationChangeType = '自定义状态更新';
    changeDescription = `${friend.display_name} 更新了自定义状态`;
    changeDetails.push({ label: '之前状态', before: oldStatusDescription || '无', after: newStatusDescription || '无' });
    changeDetails.push({ label: '当前状态', before: '-', after: newStatus });
  }
  // 上线检测
  else if (oldStatus === 'offline' && newStatus !== 'offline') {
    notificationChangeType = '好友上线';
    changeDescription = `${friend.display_name} 刚刚上线了`;
    changeDetails.push({ label: '当前状态', before: '离线', after: newStatus });
    if (newWorld && newWorld !== '未知') {
      changeDetails.push({ label: '所在世界', before: '-', after: newWorld });
    }
    // 显示自定义状态（如果有）
    if (newStatusDescription) {
      changeDetails.push({ label: '自定义状态', before: '-', after: newStatusDescription });
    }
  }
  // 下线检测
  else if (oldStatus !== 'offline' && newStatus === 'offline') {
    notificationChangeType = '好友下线';
    changeDescription = `${friend.display_name} 刚刚下线了`;
    changeDetails.push({ label: '状态变化', before: oldStatus, after: '离线' });
    if (oldWorld && oldWorld !== '未知') {
      changeDetails.push({ label: '之前所在', before: oldWorld, after: '-' });
    }
  }
  // 世界变化
  else if (oldWorld !== newWorld && newWorld && oldWorld) {
    notificationChangeType = '切换世界';
    changeDescription = `${friend.display_name} 切换到了新的世界`;
    changeDetails.push({ label: '所在世界', before: oldWorld, after: newWorld });
    if (oldStatus !== newStatus) {
      changeDetails.push({ label: '状态变化', before: oldStatus, after: newStatus });
    }
    // 显示自定义状态（如果有）
    if (newStatusDescription) {
      changeDetails.push({ label: '自定义状态', before: oldStatusDescription || '无', after: newStatusDescription });
    }
  }
  // 状态变化
  else if (oldStatus !== newStatus) {
    notificationChangeType = '状态更新';
    changeDescription = `${friend.display_name} 的状态发生了变化`;
    changeDetails.push({ label: '状态变化', before: oldStatus, after: newStatus });
    if (oldWorld && newWorld && oldWorld !== '未知') {
      changeDetails.push({ label: '所在世界', before: oldWorld, after: newWorld });
    }
    // 显示自定义状态（如果有）
    if (newStatusDescription) {
      changeDetails.push({ label: '自定义状态', before: oldStatusDescription || '无', after: newStatusDescription });
    }
  }
  
  // 构建变化详情HTML
  let changeDetailsHtml = changeDetails.map(detail => `
    <tr>
      <td style="padding: 12px 15px; border-bottom: 1px solid #e5e7eb; color: #6b7280; width: 30%;">${detail.label}</td>
      <td style="padding: 12px 15px; border-bottom: 1px solid #e5e7eb;">
        <span style="color: #9ca3af; text-decoration: line-through;">${detail.before}</span>
        <span style="color: #3b82f6; margin: 0 10px;">→</span>
        <span style="color: #10b981; font-weight: 500;">${detail.after}</span>
      </td>
    </tr>
  `).join('');

  // 使用自定义邮件模板
  let subject = user.email_subject_template || '[VRC-Notifier] {changeType}: {friendName}';
  let html = user.email_body_template || getDefaultEmailTemplate();
  
  // 替换模板变量
  const templateVars = {
    '{friendName}': friend.display_name,
    '{oldStatus}': oldStatus || '未知',
    '{newStatus}': newStatus || '未知',
    '{oldWorld}': oldWorld || '未知',
    '{newWorld}': newWorld || '未知',
    '{timestamp}': timestamp,
    '{avatarUrl}': friend.avatar_url || 'https://assets.vrchat.com/www/images/default-avatar.png',
    '{changeType}': notificationChangeType,
    '{changeDescription}': changeDescription,
    '{changeDetailsHtml}': changeDetailsHtml,
    '{oldStatusDescription}': oldStatusDescription || '无',
    '{newStatusDescription}': newStatusDescription || '无',
    '{oldPlatform}': getPlatformDisplayName(params.oldPlatform || 'unknown'),
    '{newPlatform}': getPlatformDisplayName(params.newPlatform || 'unknown')
  };
  
  for (const [key, value] of Object.entries(templateVars)) {
    subject = subject.replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value);
    html = html.replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value);
  }

  const mailOptions = {
    from: `"vrc-notifier" <${user.smtp_user}>`,
    to: user.email,
    subject: subject,
    html: html
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`邮件通知已发送给 ${user.email}: 好友 ${friend.display_name} ${changeType}`);
    return true;
  } catch (e) {
    console.error('发送邮件失败:', e.message);
    return false;
  }
}

// 批量发送邮件通知
async function sendBatchEmailNotification(user, statusChanges) {
  if (!user.smtp_host || !user.smtp_user || !user.smtp_pass) {
    console.log(`用户 ${user.display_name} 未配置 SMTP，跳过邮件通知`);
    return false;
  }

  // 解密 SMTP 密码
  const decryptedPass = decrypt(user.smtp_pass);
  if (!decryptedPass) {
    console.error(`用户 ${user.display_name} 的 SMTP 密码解密失败`);
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: user.smtp_host,
    port: user.smtp_port || 587,
    secure: user.smtp_secure === 1,
    auth: {
      user: user.smtp_user,
      pass: decryptedPass
    }
  });

  const timestamp = new Date().toLocaleString('zh-CN');
  
  // 构建批量变化详情HTML
  let changesHtml = statusChanges.map((change, index) => {
    const { friend, oldStatus, newStatus, oldWorld, newWorld, changeType } = change;
    
    let details = [];
    if (oldStatus !== newStatus) {
      details.push(`状态: ${oldStatus} → ${newStatus}`);
    }
    if (oldWorld !== newWorld && newWorld) {
      details.push(`世界: ${oldWorld || '-'} → ${newWorld}`);
    }
    
    return `
      <tr>
        <td style="padding: 15px; border-bottom: 1px solid #e5e7eb; vertical-align: top;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <img src="${friend.avatar_url || 'https://via.placeholder.com/48'}" alt="${friend.display_name}" style="width: 48px; height: 48px; border-radius: 50%; border: 2px solid #e5e7eb;">
            <div>
              <div style="font-weight: 600; color: #1f2937; font-size: 16px;">${friend.display_name}</div>
              <div style="color: #6b7280; font-size: 13px; margin-top: 4px;">${details.join(' | ')}</div>
            </div>
          </div>
        </td>
        <td style="padding: 15px; border-bottom: 1px solid #e5e7eb; vertical-align: middle; text-align: right;">
          <span style="display: inline-block; background-color: ${getChangeTypeColor(changeType)}; color: #ffffff; padding: 6px 14px; border-radius: 12px; font-size: 12px; font-weight: 500;">${changeType}</span>
        </td>
      </tr>
    `;
  }).join('');

  // 统计信息
  const onlineCount = statusChanges.filter(c => c.changeType === '上线').length;
  const offlineCount = statusChanges.filter(c => c.changeType === '下线').length;
  const statusChangeCount = statusChanges.filter(c => c.changeType === '状态变化').length;
  const worldChangeCount = statusChanges.filter(c => c.changeType === '切换世界').length;
  
  let summaryText = [];
  if (onlineCount > 0) summaryText.push(`${onlineCount}人上线`);
  if (offlineCount > 0) summaryText.push(`${offlineCount}人下线`);
  if (statusChangeCount > 0) summaryText.push(`${statusChangeCount}人状态变化`);
  if (worldChangeCount > 0) summaryText.push(`${worldChangeCount}人切换世界`);

  const subject = `[VRC-Notifier] 好友状态批量更新: ${summaryText.join('，')} (${statusChanges.length}人)`;
  
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>vrc-notifier 好友状态通知</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f4f6; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #3b82f6 0%, #60a5fa 100%); padding: 30px 40px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">vrc-notifier</h1>
              <p style="margin: 8px 0 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">好友状态批量更新</p>
            </td>
          </tr>
          
          <!-- Summary -->
          <tr>
            <td style="padding: 30px 40px 20px 40px;">
              <div style="background-color: #f0f9ff; border-radius: 12px; padding: 20px; text-align: center;">
                <div style="font-size: 32px; font-weight: 700; color: #3b82f6; margin-bottom: 8px;">${statusChanges.length}</div>
                <div style="color: #6b7280; font-size: 14px;">位好友状态发生变化</div>
                <div style="margin-top: 12px; color: #374151; font-size: 13px;">${summaryText.join('，')}</div>
              </div>
            </td>
          </tr>
          
          <!-- Changes List -->
          <tr>
            <td style="padding: 0 40px 40px 40px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 12px; overflow: hidden;">
                <thead>
                  <tr>
                    <th colspan="2" style="background-color: #f9fafb; padding: 15px 20px; text-align: left; color: #374151; font-size: 14px; font-weight: 600; border-bottom: 2px solid #e5e7eb;">变化详情</th>
                  </tr>
                </thead>
                <tbody>
                  ${changesHtml}
                </tbody>
              </table>
              
              <!-- Timestamp -->
              <div style="text-align: center; margin-top: 25px; padding-top: 25px; border-top: 1px solid #e5e7eb;">
                <p style="margin: 0; color: #9ca3af; font-size: 13px;">通知时间: ${timestamp}</p>
              </div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f9fafb; padding: 20px 40px; text-align: center; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0; color: #9ca3af; font-size: 12px;">此邮件由 vrc-notifier 自动发送</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const mailOptions = {
    from: `"vrc-notifier" <${user.smtp_user}>`,
    to: user.email,
    subject: subject,
    html: html
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`批量邮件通知已发送给 ${user.email}: ${statusChanges.length} 位好友状态变化`);
    return true;
  } catch (e) {
    console.error('发送批量邮件失败:', e.message);
    return false;
  }
}

// 获取变化类型对应的颜色
function getChangeTypeColor(changeType) {
  const colors = {
    '上线': '#10b981',
    '下线': '#6b7280',
    '状态变化': '#f59e0b',
    '切换世界': '#3b82f6'
  };
  return colors[changeType] || '#6b7280';
}

// 默认邮件模板
function getDefaultEmailTemplate() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>vrc-notifier 好友状态通知</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f4f6; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #3b82f6 0%, #60a5fa 100%); padding: 30px 40px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600;">vrc-notifier</h1>
              <p style="margin: 8px 0 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">好友状态监控通知</p>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <!-- Change Type Badge -->
              <div style="text-align: center; margin-bottom: 30px;">
                <span style="display: inline-block; background-color: #dbeafe; color: #3b82f6; padding: 8px 20px; border-radius: 20px; font-size: 14px; font-weight: 500;">{changeType}</span>
              </div>
              
              <!-- Friend Info -->
              <div style="text-align: center; margin-bottom: 30px;">
                <img src="{avatarUrl}" alt="{friendName}" style="width: 100px; height: 100px; border-radius: 50%; border: 3px solid #e5e7eb; margin-bottom: 15px;">
                <h2 style="margin: 0; color: #1f2937; font-size: 22px; font-weight: 600;">{friendName}</h2>
                <p style="margin: 10px 0 0 0; color: #6b7280; font-size: 16px;">{changeDescription}</p>
              </div>
              
              <!-- Change Details -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f9fafb; border-radius: 12px; overflow: hidden; margin: 25px 0;">
                <thead>
                  <tr>
                    <th colspan="2" style="background-color: #f3f4f6; padding: 15px; text-align: left; color: #374151; font-size: 14px; font-weight: 600; border-bottom: 1px solid #e5e7eb;">变化详情</th>
                  </tr>
                </thead>
                <tbody>
                  {changeDetailsHtml}
                </tbody>
              </table>
              
              <!-- Timestamp -->
              <div style="text-align: center; margin-top: 25px; padding-top: 25px; border-top: 1px solid #e5e7eb;">
                <p style="margin: 0; color: #9ca3af; font-size: 13px;">通知时间: {timestamp}</p>
              </div>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="background-color: #f9fafb; padding: 20px 40px; text-align: center; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0; color: #9ca3af; font-size: 12px;">此邮件由 vrc-notifier 自动发送</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// 检查被监控好友的状态变化
async function checkFriendStatus(user) {
  if (!user.vrchat_user_id) {
    return;
  }

  const session = userSessions.get(user.vrchat_user_id);
  if (!session) {
    return;
  }

  // 冷却期已移除:ws 模式登录时基线对齐取代(checkFriendStatus 仍由 cron 调用,第7组删除)

  try {
    // 检查用户是否开启仅监控好友状态模式
    const statusOnlyMode = user.status_only_mode === 1;
    
    // 获取被监控的好友列表（普通模式最多5个，仅状态模式无限制）
    const monitorConfigs = await new Promise((resolve, reject) => {
      const sql = statusOnlyMode 
        ? 'SELECT * FROM friend_monitor_config WHERE user_id = ? AND monitor_enabled = 1'
        : 'SELECT * FROM friend_monitor_config WHERE user_id = ? AND monitor_enabled = 1';
      db.all(
        sql,
        [user.id],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    if (monitorConfigs.length === 0) {
      return;
    }

    const modeText = statusOnlyMode ? '[仅状态模式]' : '[标准模式]';
    console.log(`[${formatLocalTime()}] ${modeText} 检查用户 ${user.display_name} 的 ${monitorConfigs.length} 个被监控好友`);

    // 获取被监控好友的数据库记录
    const monitoredFriendIds = monitorConfigs.map(c => c.friend_vrchat_id);
    const dbFriends = await new Promise((resolve, reject) => {
      db.all(
        `SELECT * FROM friends WHERE user_id = ? AND friend_vrchat_id IN (${monitoredFriendIds.map(() => '?').join(',')})`,
        [user.id, ...monitoredFriendIds],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    const dbFriendMap = new Map(dbFriends.map(f => [f.friend_vrchat_id, f]));
    const monitorConfigMap = new Map(monitorConfigs.map(c => [c.friend_vrchat_id, c]));

    // 获取在线好友列表（只获取一次，用于检查被监控好友的状态）
    const friendsCacheKey = `friends_${user.vrchat_user_id}`;
    const friendsRes = await cachedApiRequest(session.api, '/auth/user/friends', 'friendStatus', friendsCacheKey, user.vrchat_user_id);
    if (friendsRes.status !== 200) {
      console.error('获取好友列表失败:', friendsRes.status);
      
      // 如果是401错误，检测是否为登录游戏导致的会话失效
      if (friendsRes.status === 401) {
        console.error(`[游戏登录检测] 用户 ${user.display_name} 可能已登录 VRChat 游戏`);
        console.error(`[说明] VRChat 不允许同一账号同时在游戏和第三方工具中保持登录状态`);
        console.error(`[说明] 当您登录游戏时，本工具的会话将自动失效，这是正常行为`);
        console.error(`[说明] 退出游戏后，您需要重新登录本工具以恢复监控`);
        
        // 发送SSE通知给前端（特殊类型：游戏登录导致）
        sendGameLoginEvent(user.vrchat_user_id, user.display_name);
        
        // 发送邮件/Gotify通知
        const notifyTitle = '[VRC-Notifier] 工具已暂停 - 检测到登录状态变化';
        const notifyMessage = `您好 ${user.display_name}，\n\n检测到您的账号在另一个位置登录（可能是VRChat游戏或其他设备），本工具已自动暂停运行。\n\n原因说明：\nVRChat检测到您的账号IP地址发生变化，出于安全考虑自动使之前的登录会话失效。这是VRChat的安全机制，不是工具故障。\n\n解决方案：\n1. 方案一（推荐）：将本工具部署在与游戏相同的网络环境下（同一IP地址），然后先启动游戏，再启动本工具\n2. 方案二：退出游戏后，访问本工具网页重新登录即可恢复监控\n\n注意：\n如果需要在玩游戏时使用本工具监控好友，请确保工具和游戏的IP地址相同，并先开游戏再开工具。`;
        
        // 发送Gotify通知（如果配置了）
        if (user.gotify_enabled) {
          await sendGotifyNotification(user, notifyTitle, notifyMessage, 5);
        }

        // 发送NTFY通知（如果配置了）
        if (user.ntfy_enabled) {
          await sendNtfyNotification(user, notifyTitle, notifyMessage, 4, null);
        }

        // 发送邮件通知（如果配置了）
        if (user.email && user.smtp_host) {
          try {
            const transporter = nodemailer.createTransport({
              host: user.smtp_host,
              port: user.smtp_port || 587,
              secure: user.smtp_secure === 1,
              auth: {
                user: user.smtp_user,
                pass: decrypt(user.smtp_pass)
              }
            });
            
            await transporter.sendMail({
              from: `"VRC-Notifier" <${user.smtp_user}>`,
              to: user.email,
              subject: notifyTitle,
              text: notifyMessage,
              html: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
                <h2 style="color: #f59e0b;">工具已暂停</h2>
                <p>您好 <strong>${user.display_name}</strong>，</p>
                <p>检测到您的账号在另一个位置登录（可能是VRChat游戏或其他设备），本工具已自动暂停运行。</p>
                
                <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0;">
                  <h3 style="margin: 0 0 10px 0; color: #92400e;">原因说明</h3>
                  <p style="margin: 0; color: #78350f;">VRChat检测到您的账号IP地址发生变化，出于安全考虑自动使之前的登录会话失效。这是VRChat的安全机制，不是工具故障。</p>
                </div>
                
                <h3 style="color: #374151;">解决方案</h3>
                <div style="background: #dbeafe; border-left: 4px solid #3b82f6; padding: 15px; margin: 15px 0; border-radius: 0 8px 8px 0;">
                  <p style="margin: 0 0 10px 0; color: #1e40af;"><strong>方案一（推荐）：</strong></p>
                  <p style="margin: 0; color: #1e3a8a;">将本工具部署在与游戏相同的网络环境下（同一IP地址），然后先启动游戏，再启动本工具</p>
                </div>
                <div style="background: #f3f4f6; border-left: 4px solid #6b7280; padding: 15px; margin: 15px 0; border-radius: 0 8px 8px 0;">
                  <p style="margin: 0 0 10px 0; color: #374151;"><strong>方案二：</strong></p>
                  <p style="margin: 0; color: #4b5563;">退出游戏后，访问本工具网页重新登录即可恢复监控</p>
                </div>
                
                <div style="background: #fee2e2; border-left: 4px solid #ef4444; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0;">
                  <p style="margin: 0; color: #991b1b;"><strong>注意：</strong>如果需要在玩游戏时使用本工具监控好友，请确保工具和游戏的IP地址相同，并先开游戏再开工具。</p>
                </div>
              </div>`
            });
            
            console.log(`[游戏登录检测] 已发送邮件通知给用户 ${user.display_name}`);
          } catch (e) {
            console.error(`[游戏登录检测] 发送邮件通知失败:`, e.message);
          }
        }
        
        // 清除用户会话
        userSessions.delete(user.vrchat_user_id);
        console.log(`[游戏登录检测] 已清除用户 ${user.display_name} 的会话，等待重新登录`);
      }
      
      return;
    }

    // 构建好友状态映射表
    const onlineFriendsMap = new Map();
    for (const friend of friendsRes.data || []) {
      onlineFriendsMap.set(friend.id, friend);
    }

    // 收集所有状态变化的好友
    const statusChanges = [];

    // 获取世界信息轮询索引（仅状态模式下跳过世界轮询）
    let pollInfo = worldPollIndex.get(user.vrchat_user_id);
    if (!pollInfo) {
      pollInfo = { currentIndex: 0, lastPollTime: 0 };
      worldPollIndex.set(user.vrchat_user_id, pollInfo);
    }
    
    // 检查是否可以进行世界信息轮询（每10秒一个好友，仅状态模式下禁用）
    const now = Date.now();
    const canPollWorld = !statusOnlyMode && (now - pollInfo.lastPollTime >= 10000); // 10秒间隔，仅状态模式禁用
    let worldPolledThisCheck = false;
    
    if (statusOnlyMode) {
      console.log(`[仅状态模式] 跳过世界信息轮询，仅监控好友在线状态`);
    }
    
    // 收集不在线的好友ID，用于统一输出日志
    const skippedOfflineFriends = [];
    
    // 只检查被监控的好友
    for (let i = 0; i < monitorConfigs.length; i++) {
      const config = monitorConfigs[i];
      const friendId = config.friend_vrchat_id;
      let dbFriend = dbFriendMap.get(friendId);
      
      // 如果数据库中没有这个好友，从在线好友列表中获取并创建记录
      if (!dbFriend) {
        const onlineFriend = onlineFriendsMap.get(friendId);
        if (onlineFriend) {
          console.log(`[自动添加] 被监控的好友 ${friendId} 不在数据库中，从API数据创建记录`);

          // 创建好友记录
          const location = onlineFriend.location || 'offline';
          const worldId = location !== 'offline' ? location.split(':')[0] : null;

          // 获取头像URL
          let avatarUrl = onlineFriend.profilePicOverride ||
                          onlineFriend.currentAvatarImageUrl ||
                          onlineFriend.currentAvatarThumbnailImageUrl ||
                          onlineFriend.userIcon;
          if (!avatarUrl || avatarUrl.includes('robot') || avatarUrl.includes('default')) {
            avatarUrl = onlineFriend.profilePicOverride || onlineFriend.userIcon || 'https://assets.vrchat.com/www/images/default-avatar.png';
          }

          // 获取自定义状态
          const statusDescription = onlineFriend.statusDescription || null;

          // 插入数据库
          // 初始状态设为好友当前实际状态，platform 记录当前平台
          // world_name 初始为 null，等待第一轮轮询获取真实世界名称后再更新
          const initialStatus = onlineFriend.status || 'offline';
          const initialPlatform = onlineFriend.platform || 'unknown';
          const newFriendId = await new Promise((resolve, reject) => {
            db.run(
              `INSERT INTO friends (user_id, friend_vrchat_id, display_name, avatar_url, status, state, world_id, world_name, status_description, platform, last_seen)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [user.id, friendId, onlineFriend.displayName, avatarUrl,
               initialStatus,
               location === 'offline' ? 'offline' : 'online',
               worldId, null, statusDescription, initialPlatform, new Date().toISOString()],
              function(err) {
                if (err) {
                  console.error('插入好友记录失败:', err.message);
                  reject(err);
                } else {
                  resolve(this.lastID);
                }
              }
            );
          });

          console.log(`[自动添加] 好友 ${onlineFriend.displayName} 已添加到数据库，初始状态: ${initialStatus}, 平台: ${initialPlatform}`);
          
          // 重新获取刚插入的记录
          dbFriend = await new Promise((resolve, reject) => {
            db.get(
              'SELECT * FROM friends WHERE id = ?',
              [newFriendId],
              (err, row) => {
                if (err) reject(err);
                else resolve(row);
              }
            );
          });
          
        } else {
          // 收集不在线的好友ID，稍后统一输出
          skippedOfflineFriends.push(friendId);
          continue;
        }
      }

      // 从在线好友列表中获取最新状态
      const onlineFriend = onlineFriendsMap.get(friendId);
      
      // 确定新状态
      let newStatus, newWorldId, newWorldName, newLocation, newStatusDescription, newPlatform;

      if (onlineFriend) {
        // 好友在线 - 获取状态
        newStatus = onlineFriend.status || 'active';
        newLocation = onlineFriend.location || 'offline';
        newWorldId = newLocation !== 'offline' ? newLocation.split(':')[0] : null;
        // 获取自定义状态（可能为空）
        newStatusDescription = onlineFriend.statusDescription || null;
        // 获取平台信息
        newPlatform = onlineFriend.platform || 'unknown';
        
        // 获取世界名称（轮询机制）
        newWorldName = null;
        
        // 检查是否是当前轮询的好友
        const isCurrentPollFriend = (i === pollInfo.currentIndex);
        
        // 只有当满足以下条件时才请求世界信息：
        // 1. 有有效的世界ID
        // 2. 到了轮询时间（每10秒）
        // 3. 是当前轮询的好友
        // 4. 状态是 active 或 join me（只有这两个状态能看到世界）
        const canSeeWorld = ['active', 'join me'].includes(newStatus);
        
        if (newWorldId && newWorldId.startsWith('wrld_') &&
            canPollWorld && isCurrentPollFriend && !worldPolledThisCheck && canSeeWorld) {
          try {
            const worldCacheKey = `world_${newWorldId}_${user.vrchat_user_id}`;
            const worldRes = await cachedApiRequest(session.api, `/worlds/${newWorldId}`, 'worldInfo', worldCacheKey, user.vrchat_user_id);
            if (worldRes.status === 200) {
              newWorldName = worldRes.data.name;
              worldPolledThisCheck = true;
              pollInfo.lastPollTime = now;
              console.log(`[世界信息轮询] 用户 ${user.display_name} 的好友 ${dbFriend.display_name}: ${newWorldName} (${pollInfo.currentIndex + 1}/${monitorConfigs.length})`);

              // 检查是否是第一次获取世界名称（数据库中 world_name 为 null）
              // 如果是，静默更新数据库，不发送世界变更通知
              if (dbFriend.world_name === null && newWorldName) {
                console.log(`[初始化世界] 好友 ${dbFriend.display_name} 第一次获取世界名称，静默更新数据库: ${newWorldName}`);
                await new Promise((resolve, reject) => {
                  db.run(
                    'UPDATE friends SET world_name = ? WHERE id = ?',
                    [newWorldName, dbFriend.id],
                    (err) => {
                      if (err) {
                        console.error(`[初始化世界] 更新好友 ${dbFriend.display_name} 世界名称失败:`, err.message);
                        reject(err);
                      } else {
                        console.log(`[初始化世界] 好友 ${dbFriend.display_name} 世界名称已更新为: ${newWorldName}`);
                        resolve();
                      }
                    }
                  );
                });
                // 更新 dbFriend 对象，避免后续判断为状态变化
                dbFriend.world_name = newWorldName;
              }
            }
          } catch (e) {
            console.error(`获取世界 ${newWorldId} 失败:`, e.message);
          }
        } else if (!canSeeWorld && isCurrentPollFriend && canPollWorld && !worldPolledThisCheck) {
          console.log(`[世界信息] 跳过 ${newStatus} 状态的好友 ${dbFriend.display_name}（无法看到世界）`);
        }

        // 如果没有获取到世界名称，使用数据库中的旧值（如果有且世界ID相同）
        if (!newWorldName && dbFriend.world_name && dbFriend.world_id === newWorldId) {
          newWorldName = dbFriend.world_name;
        }
      } else {
        // 好友离线
        newStatus = 'offline';
        newLocation = 'offline';
        newWorldId = null;
        newWorldName = null;
        newStatusDescription = null;
        newPlatform = 'offline';
      }

      const oldStatus = dbFriend.status;
      const oldWorld = dbFriend.world_name;
      const oldStatusDescription = dbFriend.status_description;
      const oldPlatform = dbFriend.platform || 'unknown';
      const pendingStatus = dbFriend.pending_status;
      const pendingCount = dbFriend.pending_count || 0;

      // 判断平台是否变化（用于检测网页端<->游戏切换）
      const wasWebPlatform = oldPlatform === 'web';
      const isWebPlatform = newPlatform === 'web';

      // 检查状态是否变化（包括自定义状态）
      // 同时检查平台变化（网页端<->游戏在线切换）
      const isStatusDifferent = oldStatus !== newStatus || (oldWorld !== newWorldName && newWorldName) || (wasWebPlatform !== isWebPlatform);
      // 检查自定义状态是否变化（无需防抖，直接检测）
      const isStatusDescriptionDifferent = oldStatusDescription !== newStatusDescription;

      // 判断是否为游戏在线状态（active, join me, ask me, busy）- 移到外部作用域
      const isGameOnline = (status) => ['active', 'join me', 'ask me', 'busy'].includes(status);

      if (isStatusDifferent) {
        console.log(`[状态检测] 好友 ${dbFriend.display_name} 检测到状态变化: ${oldStatus} -> ${newStatus}`);

        const wasGameOnline = isGameOnline(oldStatus);
        const isNowGameOnline = isGameOnline(newStatus);
        
        // 判断是否是上下线变化（需要防抖动）
        // 包括：离线<->游戏在线，网页端<->游戏在线（平台切换），离线<->网页端
        const isOnlineOfflineChange = (oldStatus === 'offline' && isNowGameOnline) || 
                                       (wasGameOnline && newStatus === 'offline') ||
                                       (wasWebPlatform && !isWebPlatform && isNowGameOnline) ||
                                       (!wasWebPlatform && isWebPlatform && wasGameOnline) ||
                                       (oldStatus === 'offline' && isWebPlatform) ||
                                       (wasWebPlatform && newStatus === 'offline');
        
        // 防抖动逻辑：只有上下线时才需要连续3次确认
        let shouldNotify = false;
        let confirmedStatus = newStatus;
        let confirmedWorld = newWorldName;
        
        if (isOnlineOfflineChange) {
          // 上下线变化：使用防抖动机制（3次确认）
          console.log(`[防抖动] 好友 ${dbFriend.display_name} 上下线变化，启用防抖动检测`);
          
          if (newStatus === pendingStatus) {
            // 连续检测到相同的新状态，确认变化（需要3次）
            if (pendingCount >= 2) {
              console.log(`[防抖动确认] 好友 ${dbFriend.display_name} 上下线变化已确认(3/3): ${oldStatus} -> ${newStatus}`);
              shouldNotify = true;
            } else {
              console.log(`[防抖动等待] 好友 ${dbFriend.display_name} 等待下次确认 (${pendingCount + 1}/3)`);
            }
          } else {
            // 第一次检测到变化，记录待确认状态
            console.log(`[防抖动记录] 好友 ${dbFriend.display_name} 记录待确认状态: ${newStatus}`);
          }
          
          // 更新待确认状态到数据库
          const newPendingCount = (newStatus === pendingStatus) ? pendingCount + 1 : 1;
          await new Promise((resolve, reject) => {
            db.run(
              `UPDATE friends SET pending_status = ?, pending_count = ? WHERE id = ?`,
              [newStatus, newPendingCount, dbFriend.id],
              (err) => {
                if (err) reject(err);
                else resolve();
              }
            );
          });
          
          // 如果未确认变化，跳过通知
          if (!shouldNotify) {
            continue;
          }
        } else {
          // 非上下线变化（状态之间切换）：直接通知，不防抖
          console.log(`[直接通知] 好友 ${dbFriend.display_name} 状态切换，直接通知: ${oldStatus} -> ${newStatus}`);
          shouldNotify = true;
          
          // 重置防抖动计数（如果有的话）
          if (pendingStatus) {
            await new Promise((resolve, reject) => {
              db.run(
                `UPDATE friends SET pending_status = NULL, pending_count = 0 WHERE id = ?`,
                [dbFriend.id],
                (err) => {
                  if (err) reject(err);
                  else resolve();
                }
              );
            });
          }
        }

        // 使用之前定义的 isGameOnline 函数
        const wasGameOnlineFinal = isGameOnline(oldStatus);
        const isNowGameOnlineFinal = isGameOnline(confirmedStatus);
        
        // 判断变化类型
        let isWorldChange = false;
        let isStatusChange = false;
        let changeType = '';
        
        // 世界改变通知（仅当状态为 active 或 join me 时才通知，仅状态模式下禁用）
        // 注意：世界变化和状态变化可以同时进行，使用独立的 if 判断
        if (!statusOnlyMode && ['active', 'join me'].includes(oldStatus) && ['active', 'join me'].includes(confirmedStatus) && 
            oldWorld !== confirmedWorld && confirmedWorld && config.notify_world_change) {
          isWorldChange = true;
        }
        
        // 上线通知：从离线 -> 游戏在线（四个状态之一）
        if (oldStatus === 'offline' && isNowGameOnlineFinal && config.notify_online) {
          isStatusChange = true;
          changeType = '上线';
        }
        // 下线通知：从游戏在线 -> 离线
        else if (wasGameOnlineFinal && confirmedStatus === 'offline' && config.notify_offline) {
          isStatusChange = true;
          changeType = '下线';
        }
        // 平台切换通知：从网页端 -> 游戏在线
        else if (wasWebPlatform && !isWebPlatform && confirmedStatus !== 'offline' && config.notify_online) {
          isStatusChange = true;
          changeType = 'web端上线';
          console.log(`[平台切换] 好友 ${dbFriend.display_name} 从web端上线至游戏`);
        }
        // 平台切换通知：从游戏在线 -> 网页端
        else if (!wasWebPlatform && isWebPlatform && wasGameOnlineFinal && config.notify_offline) {
          isStatusChange = true;
          changeType = '下线至web端';
          console.log(`[平台切换] 好友 ${dbFriend.display_name} 下线至web端`);
        }
        // 从离线 -> 网页端：终端显示但不通知用户
        else if (oldStatus === 'offline' && isWebPlatform && !isNowGameOnlineFinal) {
          console.log(`[网页端上线] 好友 ${dbFriend.display_name} 从离线变为网页端在线，终端显示但不通知用户`);
          isStatusChange = false;
        }
        // 从网页端 -> 离线：终端显示但不通知用户
        else if (wasWebPlatform && confirmedStatus === 'offline') {
          console.log(`[网页端下线] 好友 ${dbFriend.display_name} 从网页端变为离线，终端显示但不通知用户`);
          isStatusChange = false;
        }
        // 状态改变通知：游戏在线状态之间的切换（active <-> join me <-> ask me <-> busy）
        else if (wasGameOnlineFinal && isNowGameOnlineFinal && oldStatus !== confirmedStatus && config.notify_status_change) {
          isStatusChange = true;
          changeType = '状态变化';
        }
        // 网页端内部状态变化不通知
        else if (wasWebPlatform && isWebPlatform && oldStatus !== newStatus) {
          console.log(`[网页端状态变化] 好友 ${dbFriend.display_name} 网页端内部状态变化: ${oldStatus} -> ${newStatus}，跳过通知`);
          isStatusChange = false;
        }

        // 状态变化立即发送单条邮件和Gotify推送
        if (isStatusChange) {
          console.log(`[邮件通知] 好友 ${dbFriend.display_name} ${changeType}，发送单条通知`);
          await sendEmailNotification(user, {
            friend: dbFriend,
            oldStatus,
            newStatus,
            oldWorld,
            newWorld: newWorldName,
            changeType,
            oldStatusDescription,
            newStatusDescription,
            oldPlatform,
            newPlatform
          });
          
          // 发送 Gotify 推送（使用智能标题，让用户一眼看到变化）
          const timestamp = new Date().toLocaleString('zh-CN');
          // NTFY 使用横杠格式时间，避免被识别为电话号码
          const ntfyTimestamp = formatDateSafe(new Date());

          // 使用智能标题生成（如果用户没有自定义模板）
          let gotifyTitle, gotifyMessage;
          const userTitleTemplate = user.gotify_title_template;
          const userMessageTemplate = user.gotify_message_template;
          
          if (!userTitleTemplate || userTitleTemplate === '[VRC-Notifier] {changeType}: {friendName}') {
            // 使用智能标题（默认情况）
            gotifyTitle = generateGotifyTitle(
              dbFriend.display_name,
              changeType,
              oldStatus,
              newStatus,
              oldWorld,
              newWorldName
            );
          } else {
            // 使用用户自定义模板
            const templateVars = {
              friendName: dbFriend.display_name,
              changeType: changeType,
              oldStatus: oldStatus || '未知',
              newStatus: newStatus || '未知',
              oldWorld: oldWorld || '-',
              newWorld: newWorldName || '-',
              oldStatusDescription: oldStatusDescription || '无',
              newStatusDescription: newStatusDescription || '无',
              timestamp: timestamp,
              oldPlatform: getPlatformDisplayName(oldPlatform || 'unknown'),
              newPlatform: getPlatformDisplayName(newPlatform || 'unknown')
            };
            gotifyTitle = renderGotifyTemplate(userTitleTemplate, templateVars);
          }

          if (!userMessageTemplate || userMessageTemplate.includes('{friendName}')) {
            // 使用智能消息内容（默认情况）
            gotifyMessage = generateGotifyMessage(
              dbFriend.display_name,
              changeType,
              oldStatus,
              newStatus,
              oldWorld,
              newWorldName,
              timestamp,
              oldStatusDescription,
              newStatusDescription
            );
          } else {
            // 使用用户自定义模板
            const templateVars = {
              friendName: dbFriend.display_name,
              changeType: changeType,
              oldStatus: oldStatus || '未知',
              newStatus: newStatus || '未知',
              oldWorld: oldWorld || '-',
              newWorld: newWorldName || '-',
              oldStatusDescription: oldStatusDescription || '无',
              newStatusDescription: newStatusDescription || '无',
              timestamp: timestamp,
              oldPlatform: getPlatformDisplayName(oldPlatform || 'unknown'),
              newPlatform: getPlatformDisplayName(newPlatform || 'unknown')
            };
            gotifyMessage = renderGotifyTemplate(userMessageTemplate, templateVars);
          }
          
          // 构建 extras 支持 Markdown 格式
          const extras = {
            'client::display': {
              'contentType': 'text/markdown'
            }
          };
          
          await sendGotifyNotification(user, gotifyTitle, gotifyMessage, user.gotify_priority || 5, extras);

          // 发送 NTFY 推送（使用 NTFY 自己的模板）
          if (user.ntfy_enabled) {
            const ntfyTitleTemplate = user.ntfy_title_template;
            const ntfyMessageTemplate = user.ntfy_message_template;
            let ntfyTitle, ntfyMessage;
            
            // 生成 NTFY 标题（使用 RFC 2047 编码支持中文）
            if (!ntfyTitleTemplate || ntfyTitleTemplate === '[VRC-Notifier] {changeType}: {friendName}') {
              ntfyTitle = generateGotifyTitle(
                dbFriend.display_name,
                changeType,
                oldStatus,
                newStatus,
                oldWorld,
                newWorldName
              );
            } else {
              const templateVars = {
                friendName: dbFriend.display_name,
                changeType: changeType,
                oldStatus: oldStatus || '未知',
                newStatus: newStatus || '未知',
                oldWorld: oldWorld || '-',
                newWorld: newWorldName || '-',
                oldStatusDescription: oldStatusDescription || '无',
                newStatusDescription: newStatusDescription || '无',
                timestamp: ntfyTimestamp,
                ntfyTimestamp: ntfyTimestamp,
                oldPlatform: getPlatformDisplayName(oldPlatform || 'unknown'),
                newPlatform: getPlatformDisplayName(newPlatform || 'unknown')
              };
              ntfyTitle = renderGotifyTemplate(ntfyTitleTemplate, templateVars);
            }

            // 生成 NTFY 消息
            if (!ntfyMessageTemplate || ntfyMessageTemplate.includes('{friendName}')) {
              ntfyMessage = generateGotifyMessage(
                dbFriend.display_name,
                changeType,
                oldStatus,
                newStatus,
                oldWorld,
                newWorldName,
                ntfyTimestamp,
                oldStatusDescription,
                newStatusDescription
              );
            } else {
              const templateVars = {
                friendName: dbFriend.display_name,
                changeType: changeType,
                oldStatus: oldStatus || '未知',
                newStatus: newStatus || '未知',
                oldWorld: oldWorld || '-',
                newWorld: newWorldName || '-',
                oldStatusDescription: oldStatusDescription || '无',
                newStatusDescription: newStatusDescription || '无',
                timestamp: ntfyTimestamp,
                ntfyTimestamp: ntfyTimestamp,
                oldPlatform: getPlatformDisplayName(oldPlatform || 'unknown'),
                newPlatform: getPlatformDisplayName(newPlatform || 'unknown')
              };
              ntfyMessage = renderGotifyTemplate(ntfyMessageTemplate, templateVars);
            }
            
            // 不使用图标标签，保持简洁
            await sendNtfyNotification(user, ntfyTitle, ntfyMessage, user.ntfy_priority || 3, null);
          }

          // 发送通用 Webhook 推送
          const eventType = oldStatus === 'offline' ? 'friend_online' :
                           newStatus === 'offline' ? 'friend_offline' : 'status_change';
          await sendWebhookNotification(user, {
            friendName: dbFriend.display_name,
            oldStatus,
            newStatus,
            oldWorld,
            newWorld: newWorldName,
            changeType,
            oldStatusDescription,
            newStatusDescription,
            timestamp: new Date().toLocaleString('zh-CN'),
            avatarUrl: dbFriend.avatar_url,
            eventType: eventType,
            oldPlatform: oldPlatform || 'unknown',
            newPlatform: newPlatform || 'unknown',
            oldPlatformDisplay: getPlatformDisplayName(oldPlatform || 'unknown'),
            newPlatformDisplay: getPlatformDisplayName(newPlatform || 'unknown')
          });
        }

        // 世界变化缓存到缓冲区，等待轮询完一轮后批量发送
        // 注意：世界变化和状态变化可以同时进行，使用独立的 if 判断
        // 但如果已经有状态变化通知，世界变化信息已经包含在状态通知中，不再单独缓存
        if (isWorldChange && !isStatusChange) {
          let buffer = worldChangeBuffer.get(user.id);
          if (!buffer) {
            buffer = { changes: [], lastPollRound: 0 };
            worldChangeBuffer.set(user.id, buffer);
          }
          buffer.changes.push({
            friend: dbFriend,
            oldStatus,
            newStatus,
            oldWorld,
            newWorld: newWorldName,
            changeType: '切换世界',
            oldStatusDescription,
            newStatusDescription
          });
          console.log(`[世界变化缓存] 好友 ${dbFriend.display_name} 世界变化已缓存，当前缓存 ${buffer.changes.length} 个变化`);
        } else if (isWorldChange && isStatusChange) {
          console.log(`[世界变化] 好友 ${dbFriend.display_name} 同时有状态变化，世界信息已包含在状态通知中`);
        }

        // 检查是否同时有自定义状态变化（状态变化时也要检查）
        // 排除从离线到上线的情况（此时 oldStatusDescription 为 null，会误判为变化）
        const isFromOfflineToOnlineInStatusChange = oldStatus === 'offline' && isNowGameOnlineFinal;
        if (isStatusDescriptionDifferent && newStatus !== 'offline' && !isFromOfflineToOnlineInStatusChange) {
          console.log(`[自定义状态变化] 好友 ${dbFriend.display_name} 同时有自定义状态变化: "${oldStatusDescription || '无'}" -> "${newStatusDescription || '无'}"`);
          
          // 发送自定义状态变化通知
          const timestamp = new Date().toLocaleString('zh-CN');
          const customChangeType = '自定义状态';
          
          // 发送邮件通知
          await sendEmailNotification(user, {
            friend: dbFriend,
            oldStatus,
            newStatus,
            oldWorld,
            newWorld: newWorldName,
            changeType: customChangeType,
            oldStatusDescription,
            newStatusDescription,
            oldPlatform,
            newPlatform
          });
          
          // 发送 Gotify 推送
          let customGotifyTitle, customGotifyMessage;
          const userTitleTemplate = user.gotify_title_template;
          const userMessageTemplate = user.gotify_message_template;
          
          if (!userTitleTemplate || userTitleTemplate === '[VRC-Notifier] {changeType}: {friendName}') {
            // 使用智能标题（默认情况）
            customGotifyTitle = `${dbFriend.display_name} 更新了自定义状态`;
          } else {
            // 使用用户自定义模板
            const templateVars = {
              friendName: dbFriend.display_name,
              changeType: customChangeType,
              oldStatus: oldStatus || '未知',
              newStatus: newStatus || '未知',
              oldWorld: oldWorld || '-',
              newWorld: newWorldName || '-',
              oldStatusDescription: oldStatusDescription || '无',
              newStatusDescription: newStatusDescription || '无',
              timestamp: timestamp
            };
            customGotifyTitle = renderGotifyTemplate(userTitleTemplate, templateVars);
          }
          
          if (!userMessageTemplate || userMessageTemplate.includes('{friendName}')) {
            // 使用智能消息内容（默认情况）
            const oldDesc = oldStatusDescription || '无';
            const newDesc = newStatusDescription || '无';
            customGotifyMessage = `${dbFriend.display_name} 更新了自定义状态\n\n` +
                           `之前: ${oldDesc}\n` +
                           `现在: ${newDesc}\n\n` +
                           `当前状态: ${newStatus}\n` +
                           `时间: ${timestamp}`;
          } else {
            // 使用用户自定义模板
            const templateVars = {
              friendName: dbFriend.display_name,
              changeType: customChangeType,
              oldStatus: oldStatus || '未知',
              newStatus: newStatus || '未知',
              oldWorld: oldWorld || '-',
              newWorld: newWorldName || '-',
              oldStatusDescription: oldStatusDescription || '无',
              newStatusDescription: newStatusDescription || '无',
              timestamp: timestamp
            };
            customGotifyMessage = renderGotifyTemplate(userMessageTemplate, templateVars);
          }
          
          // 构建 extras 支持 Markdown 格式
          const customExtras = {
            'client::display': {
              'contentType': 'text/markdown'
            }
          };
          
          await sendGotifyNotification(user, customGotifyTitle, customGotifyMessage, user.gotify_priority || 5, customExtras);

          // 发送 NTFY 推送（使用 NTFY 自己的模板）
          if (user.ntfy_enabled) {
            const ntfyTitleTemplate = user.ntfy_title_template;
            const ntfyMessageTemplate = user.ntfy_message_template;
            let ntfyTitle, ntfyMessage;
            
            // 生成 NTFY 标题
            if (!ntfyTitleTemplate || ntfyTitleTemplate === '[VRC-Notifier] {changeType}: {friendName}') {
              ntfyTitle = `${dbFriend.display_name} 更新了自定义状态`;
            } else {
              const templateVars = {
                friendName: dbFriend.display_name,
                changeType: customChangeType,
                oldStatus: oldStatus || '未知',
                newStatus: newStatus || '未知',
                oldWorld: oldWorld || '-',
                newWorld: newWorldName || '-',
                oldStatusDescription: oldStatusDescription || '无',
                newStatusDescription: newStatusDescription || '无',
                timestamp: timestamp
              };
              ntfyTitle = renderGotifyTemplate(ntfyTitleTemplate, templateVars);
            }
            
            // 生成 NTFY 消息
            if (!ntfyMessageTemplate || ntfyMessageTemplate.includes('{friendName}')) {
              const oldDesc = oldStatusDescription || '无';
              const newDesc = newStatusDescription || '无';
              const ntfyCustomTimestamp = formatDateSafe(new Date());
              ntfyMessage = `${dbFriend.display_name} 更新了自定义状态\n\n` +
                             `之前: ${oldDesc}\n` +
                             `现在: ${newDesc}\n\n` +
                             `当前状态: ${newStatus}\n` +
                             `时间: ${ntfyCustomTimestamp}`;
            } else {
              const templateVars = {
                friendName: dbFriend.display_name,
                changeType: customChangeType,
                oldStatus: oldStatus || '未知',
                newStatus: newStatus || '未知',
                oldWorld: oldWorld || '-',
                newWorld: newWorldName || '-',
                oldStatusDescription: oldStatusDescription || '无',
                newStatusDescription: newStatusDescription || '无',
                timestamp: timestamp
              };
              ntfyMessage = renderGotifyTemplate(ntfyMessageTemplate, templateVars);
            }
            
            await sendNtfyNotification(user, ntfyTitle, ntfyMessage, user.ntfy_priority || 3, null);
          }

          // 发送通用 Webhook 推送
          await sendWebhookNotification(user, {
            friendName: dbFriend.display_name,
            oldStatus,
            newStatus,
            oldWorld,
            newWorld: newWorldName,
            oldStatusDescription,
            newStatusDescription,
            changeType: customChangeType,
            timestamp: new Date().toLocaleString('zh-CN'),
            avatarUrl: dbFriend.avatar_url,
            eventType: 'status_description_change',
            oldPlatform: oldPlatform || 'unknown',
            newPlatform: newPlatform || 'unknown',
            oldPlatformDisplay: getPlatformDisplayName(oldPlatform || 'unknown'),
            newPlatformDisplay: getPlatformDisplayName(newPlatform || 'unknown')
          });
        }

        // 更新好友信息（确认状态变化后，重置防抖动计数）
        await new Promise((resolve, reject) => {
          db.run(
            `UPDATE friends SET status = ?, state = ?, world_id = ?, world_name = ?, status_description = ?, platform = ?, last_seen = ?, pending_status = NULL, pending_count = 0
             WHERE id = ?`,
            [confirmedStatus, newLocation === 'offline' ? 'offline' : 'online', newWorldId, confirmedWorld, newStatusDescription,
             newPlatform, new Date().toISOString(), dbFriend.id],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        });
      } else {
        // 状态没有变化，检查是否需要重置防抖动计数（如果当前状态与待确认状态不一致）
        if (pendingStatus && oldStatus !== pendingStatus && oldStatus === newStatus) {
          // 状态恢复到了原来的状态，重置防抖动
          console.log(`[防抖动重置] 好友 ${dbFriend.display_name} 状态恢复，重置防抖动计数`);
          await new Promise((resolve, reject) => {
            db.run(
              `UPDATE friends SET pending_status = NULL, pending_count = 0 WHERE id = ?`,
              [dbFriend.id],
              (err) => {
                if (err) reject(err);
                else resolve();
              }
            );
          });
        }
        
        // 检查自定义状态是否变化（无需防抖，直接通知）
        // 排除从离线到上线的情况（此时 oldStatusDescription 为 null，newStatusDescription 为用户设置的值，会误判为变化）
        const isNowGameOnlineForCheck = isGameOnline(newStatus);
        const isFromOfflineToOnline = oldStatus === 'offline' && isNowGameOnlineForCheck;
        if (isStatusDescriptionDifferent && newStatus !== 'offline' && !isFromOfflineToOnline) {
          console.log(`[自定义状态变化] 好友 ${dbFriend.display_name} 自定义状态变化: "${oldStatusDescription || '无'}" -> "${newStatusDescription || '无'}"`);
          
          // 发送自定义状态变化通知
          const timestamp = new Date().toLocaleString('zh-CN');
          const changeType = '自定义状态';
          
          // 发送邮件通知
          await sendEmailNotification(user, {
            friend: dbFriend,
            oldStatus,
            newStatus,
            oldWorld,
            newWorld: newWorldName,
            changeType,
            oldStatusDescription,
            newStatusDescription,
            oldPlatform,
            newPlatform
          });
          
          // 发送 Gotify 推送
          let gotifyTitle, gotifyMessage;
          const userTitleTemplate = user.gotify_title_template;
          const userMessageTemplate = user.gotify_message_template;
          
          if (!userTitleTemplate || userTitleTemplate === '[VRC-Notifier] {changeType}: {friendName}') {
            // 使用智能标题（默认情况）
            gotifyTitle = `${dbFriend.display_name} 更新了自定义状态`;
          } else {
            // 使用用户自定义模板
            const templateVars = {
              friendName: dbFriend.display_name,
              changeType: changeType,
              oldStatus: oldStatus || '未知',
              newStatus: newStatus || '未知',
              oldWorld: oldWorld || '-',
              newWorld: newWorldName || '-',
              oldStatusDescription: oldStatusDescription || '无',
              newStatusDescription: newStatusDescription || '无',
              timestamp: timestamp
            };
            gotifyTitle = renderGotifyTemplate(userTitleTemplate, templateVars);
          }
          
          if (!userMessageTemplate || userMessageTemplate.includes('{friendName}')) {
            // 使用智能消息内容（默认情况）
            const oldDesc = oldStatusDescription || '无';
            const newDesc = newStatusDescription || '无';
            gotifyMessage = `${dbFriend.display_name} 更新了自定义状态\n\n` +
                           `之前: ${oldDesc}\n` +
                           `现在: ${newDesc}\n\n` +
                           `当前状态: ${newStatus}\n` +
                           `时间: ${timestamp}`;
          } else {
            // 使用用户自定义模板
            const templateVars = {
              friendName: dbFriend.display_name,
              changeType: changeType,
              oldStatus: oldStatus || '未知',
              newStatus: newStatus || '未知',
              oldWorld: oldWorld || '-',
              newWorld: newWorldName || '-',
              oldStatusDescription: oldStatusDescription || '无',
              newStatusDescription: newStatusDescription || '无',
              timestamp: timestamp
            };
            gotifyMessage = renderGotifyTemplate(userMessageTemplate, templateVars);
          }
          
          // 构建 extras 支持 Markdown 格式
          const extras = {
            'client::display': {
              'contentType': 'text/markdown'
            }
          };
          
          await sendGotifyNotification(user, gotifyTitle, gotifyMessage, user.gotify_priority || 5, extras);
          
          // 发送 NTFY 推送
          const ntfyTimestamp = formatDateSafe(new Date());
          const ntfyTitle = `${dbFriend.display_name} 更新了自定义状态`;
          const oldDesc = oldStatusDescription || '无';
          const newDesc = newStatusDescription || '无';
          const ntfyMessage = `${dbFriend.display_name} 更新了自定义状态\n\n` +
                             `之前: ${oldDesc}\n` +
                             `现在: ${newDesc}\n\n` +
                             `当前状态: ${newStatus}\n` +
                             `时间: ${ntfyTimestamp}`;
          await sendNtfyNotification(user, ntfyTitle, ntfyMessage, user.ntfy_priority || 3, null);
          
          // 发送通用 Webhook 推送
          await sendWebhookNotification(user, {
            friendName: dbFriend.display_name,
            oldStatus,
            newStatus,
            oldWorld,
            newWorld: newWorldName,
            oldStatusDescription,
            newStatusDescription,
            changeType,
            timestamp: new Date().toLocaleString('zh-CN'),
            avatarUrl: dbFriend.avatar_url,
            eventType: 'status_description_change',
            oldPlatform: oldPlatform || 'unknown',
            newPlatform: newPlatform || 'unknown',
            oldPlatformDisplay: getPlatformDisplayName(oldPlatform || 'unknown'),
            newPlatformDisplay: getPlatformDisplayName(newPlatform || 'unknown')
          });
          
          // 更新数据库中的自定义状态
          await new Promise((resolve, reject) => {
            db.run(
              `UPDATE friends SET status_description = ? WHERE id = ?`,
              [newStatusDescription, dbFriend.id],
              (err) => {
                if (err) reject(err);
                else resolve();
              }
            );
          });
        }
      }
    }

    // 统一输出不在线的好友日志（避免刷屏）
    if (skippedOfflineFriends.length > 0) {
      console.log(`已跳过 ${skippedOfflineFriends.length} 个不在线的监控好友`);
    }

    // 更新世界信息轮询索引（每10秒移动到下一个好友，无论是否成功获取世界信息）
    if (canPollWorld) {
      const previousIndex = pollInfo.currentIndex;
      pollInfo.currentIndex = (pollInfo.currentIndex + 1) % monitorConfigs.length;
      console.log(`[世界信息轮询] 下次将检查好友索引 ${pollInfo.currentIndex + 1}/${monitorConfigs.length}`);
      
      // 检查是否完成了一轮轮询（回到了第一个好友）
      if (pollInfo.currentIndex === 0 && previousIndex === monitorConfigs.length - 1) {
        console.log(`[世界变化] 完成一轮轮询，检查是否有缓存的世界变化`);
        const buffer = worldChangeBuffer.get(user.id);
        if (buffer && buffer.changes.length > 0) {
          if (buffer.changes.length === 1) {
            // 只有1个世界变化，使用单条发送（与邮件逻辑一致）
            console.log(`[邮件通知] 只有1个世界变化，发送单条通知`);
            await sendEmailNotification(user, buffer.changes[0]);
            
            // 发送 Gotify 推送（使用智能标题，让用户一眼看到世界变化）
            const change = buffer.changes[0];
            const timestamp = new Date().toLocaleString('zh-CN');
            // NTFY 使用横杠格式时间，避免被识别为电话号码
            const ntfyTimestamp = formatDateSafe(new Date());

            // 使用智能标题生成（如果用户没有自定义模板）
            let gotifyTitle, gotifyMessage;
            const userTitleTemplate = user.gotify_title_template;
            const userMessageTemplate = user.gotify_message_template;
            
            if (!userTitleTemplate || userTitleTemplate === '[VRC-Notifier] {changeType}: {friendName}') {
              // 使用智能标题（默认情况）- 世界变化时标题直接显示世界变化
              gotifyTitle = generateGotifyTitle(
                change.friend.display_name,
                change.changeType,
                change.oldStatus,
                change.newStatus,
                change.oldWorld,
                change.newWorld
              );
            } else {
              // 使用用户自定义模板
              const templateVars = {
                friendName: change.friend.display_name,
                changeType: change.changeType,
                oldStatus: change.oldStatus || '未知',
                newStatus: change.newStatus || '未知',
                oldWorld: change.oldWorld || '-',
                newWorld: change.newWorld || '-',
                oldStatusDescription: change.oldStatusDescription || '无',
                newStatusDescription: change.newStatusDescription || '无',
                timestamp: timestamp
              };
              gotifyTitle = renderGotifyTemplate(userTitleTemplate, templateVars);
            }

            if (!userMessageTemplate || userMessageTemplate.includes('{friendName}')) {
              // 使用智能消息内容（默认情况）
              gotifyMessage = generateGotifyMessage(
                change.friend.display_name,
                change.changeType,
                change.oldStatus,
                change.newStatus,
                change.oldWorld,
                change.newWorld,
                timestamp,
                change.oldStatusDescription,
                change.newStatusDescription
              );
            } else {
              // 使用用户自定义模板
              const templateVars = {
                friendName: change.friend.display_name,
                changeType: change.changeType,
                oldStatus: change.oldStatus || '未知',
                newStatus: change.newStatus || '未知',
                oldWorld: change.oldWorld || '-',
                newWorld: change.newWorld || '-',
                oldStatusDescription: change.oldStatusDescription || '无',
                newStatusDescription: change.newStatusDescription || '无',
                timestamp: timestamp
              };
              gotifyMessage = renderGotifyTemplate(userMessageTemplate, templateVars);
            }
            
            const extras = {
              'client::display': {
                'contentType': 'text/markdown'
              }
            };
            
            await sendGotifyNotification(user, gotifyTitle, gotifyMessage, user.gotify_priority || 5, extras);

            // 发送 NTFY 推送（单个世界变化，使用 NTFY 自己的模板）
            if (user.ntfy_enabled) {
              const ntfyTitleTemplate = user.ntfy_title_template;
              const ntfyMessageTemplate = user.ntfy_message_template;
              let ntfyTitle, ntfyMessage;
              
              // 生成 NTFY 标题（使用 RFC 2047 编码支持中文）
              if (!ntfyTitleTemplate || ntfyTitleTemplate === '[VRC-Notifier] {changeType}: {friendName}') {
                ntfyTitle = generateGotifyTitle(
                  change.friend.display_name,
                  change.changeType,
                  change.oldStatus,
                  change.newStatus,
                  change.oldWorld,
                  change.newWorld
                );
              } else {
                const templateVars = {
                  friendName: change.friend.display_name,
                  changeType: change.changeType,
                  oldStatus: change.oldStatus || '未知',
                  newStatus: change.newStatus || '未知',
                  oldWorld: change.oldWorld || '-',
                  newWorld: change.newWorld || '-',
                  oldStatusDescription: change.oldStatusDescription || '无',
                  newStatusDescription: change.newStatusDescription || '无',
                  timestamp: ntfyTimestamp,
                  ntfyTimestamp: ntfyTimestamp
                };
                ntfyTitle = renderGotifyTemplate(ntfyTitleTemplate, templateVars);
              }

              // 生成 NTFY 消息
              if (!ntfyMessageTemplate || ntfyMessageTemplate.includes('{friendName}')) {
                ntfyMessage = generateGotifyMessage(
                  change.friend.display_name,
                  change.changeType,
                  change.oldStatus,
                  change.newStatus,
                  change.oldWorld,
                  change.newWorld,
                  ntfyTimestamp,
                  change.oldStatusDescription,
                  change.newStatusDescription
                );
              } else {
                const templateVars = {
                  friendName: change.friend.display_name,
                  changeType: change.changeType,
                  oldStatus: change.oldStatus || '未知',
                  newStatus: change.newStatus || '未知',
                  oldWorld: change.oldWorld || '-',
                  newWorld: change.newWorld || '-',
                  oldStatusDescription: change.oldStatusDescription || '无',
                  newStatusDescription: change.newStatusDescription || '无',
                  timestamp: ntfyTimestamp,
                  ntfyTimestamp: ntfyTimestamp
                };
                ntfyMessage = renderGotifyTemplate(ntfyMessageTemplate, templateVars);
              }
              
              await sendNtfyNotification(user, ntfyTitle, ntfyMessage, user.ntfy_priority || 3, null);
            }

            // 发送通用 Webhook 推送（单个世界变化）
            await sendWebhookNotification(user, {
              friendName: change.friend.display_name,
              oldStatus: change.oldStatus,
              newStatus: change.newStatus,
              oldWorld: change.oldWorld,
              newWorld: change.newWorld,
              changeType: change.changeType,
              oldStatusDescription: change.oldStatusDescription,
              newStatusDescription: change.newStatusDescription,
              timestamp: timestamp,
              avatarUrl: change.friend.avatar_url,
              eventType: 'world_change'
            });
          } else {
            // 多个世界变化，批量发送（与邮件逻辑一致，轮询完一圈后批量发送）
            console.log(`[邮件通知] 有 ${buffer.changes.length} 个世界变化，批量发送`);
            await sendBatchEmailNotification(user, buffer.changes);

            // 发送批量 Gotify 推送（智能标题显示批量信息）
            const timestamp = new Date().toLocaleString('zh-CN');
            // NTFY 使用横杠格式时间，避免被识别为电话号码
            const ntfyTimestamp = formatDateSafe(new Date());

            // 批量标题 - 简洁明了显示批量变化（英文避免 NTFY HTTP Header 问题）
            const batchTitle = `${buffer.changes.length} friends switched worlds`;

            // 批量消息内容 - 使用Markdown格式清晰展示
            let batchMessage = `**共有 ${buffer.changes.length} 位好友切换了世界**\n\n`;
            buffer.changes.forEach((change, index) => {
              const oldWorldShort = truncateString(change.oldWorld && change.oldWorld !== '-' ? change.oldWorld : '未知', 20);
              const newWorldShort = truncateString(change.newWorld && change.newWorld !== '-' ? change.newWorld : '未知', 20);
              batchMessage += `${index + 1}. **${change.friend.display_name}**\n`;
              batchMessage += `   ${oldWorldShort} → ${newWorldShort}\n\n`;
            });
            batchMessage += ` ${timestamp}`;

            // NTFY 批量消息使用横杠格式时间
            let ntfyBatchMessage = `**共有 ${buffer.changes.length} 位好友切换了世界**\n\n`;
            buffer.changes.forEach((change, index) => {
              const oldWorldShort = truncateString(change.oldWorld && change.oldWorld !== '-' ? change.oldWorld : '未知', 20);
              const newWorldShort = truncateString(change.newWorld && change.newWorld !== '-' ? change.newWorld : '未知', 20);
              ntfyBatchMessage += `${index + 1}. **${change.friend.display_name}**\n`;
              ntfyBatchMessage += `   ${oldWorldShort} → ${newWorldShort}\n\n`;
            });
            ntfyBatchMessage += ` ${ntfyTimestamp}`;

            const extras = {
              'client::display': {
                'contentType': 'text/markdown'
              }
            };

            await sendGotifyNotification(user, batchTitle, batchMessage, user.gotify_priority || 5, extras);

            // 发送批量 NTFY 推送（使用 NTFY 自己的模板或默认批量消息）
            if (user.ntfy_enabled) {
              const ntfyTitleTemplate = user.ntfy_title_template;
              const ntfyMessageTemplate = user.ntfy_message_template;
              let ntfyTitle, ntfyMessage;
              
              // 批量通知通常使用默认格式，因为涉及多个好友
              if (!ntfyTitleTemplate || ntfyTitleTemplate === '[VRC-Notifier] {changeType}: {friendName}') {
                ntfyTitle = batchTitle;
              } else {
                // 如果用户设置了自定义模板，使用第一个好友的信息作为代表
                const firstChange = buffer.changes[0];
                const templateVars = {
                  friendName: firstChange.friend.display_name,
                  changeType: '批量世界变化',
                  oldStatus: firstChange.oldStatus || '未知',
                  newStatus: firstChange.newStatus || '未知',
                  oldWorld: firstChange.oldWorld || '-',
                  newWorld: firstChange.newWorld || '-',
                  oldStatusDescription: firstChange.oldStatusDescription || '无',
                  newStatusDescription: firstChange.newStatusDescription || '无',
                  timestamp: ntfyTimestamp,
                  ntfyTimestamp: ntfyTimestamp
                };
                ntfyTitle = renderGotifyTemplate(ntfyTitleTemplate, templateVars);
              }

              // 批量消息通常使用默认格式
              if (!ntfyMessageTemplate || ntfyMessageTemplate.includes('{friendName}')) {
                ntfyMessage = ntfyBatchMessage;
              } else {
                // 如果用户设置了自定义模板，使用第一个好友的信息作为代表
                const firstChange = buffer.changes[0];
                const templateVars = {
                  friendName: firstChange.friend.display_name,
                  changeType: '批量世界变化',
                  oldStatus: firstChange.oldStatus || '未知',
                  newStatus: firstChange.newStatus || '未知',
                  oldWorld: firstChange.oldWorld || '-',
                  newWorld: firstChange.newWorld || '-',
                  oldStatusDescription: firstChange.oldStatusDescription || '无',
                  newStatusDescription: firstChange.newStatusDescription || '无',
                  timestamp: ntfyTimestamp,
                  ntfyTimestamp: ntfyTimestamp
                };
                ntfyMessage = renderGotifyTemplate(ntfyMessageTemplate, templateVars);
              }
              
              await sendNtfyNotification(user, ntfyTitle, ntfyMessage, user.ntfy_priority || 3, null);
            }
            
            // 发送批量通用 Webhook 推送
            for (const change of buffer.changes) {
              await sendWebhookNotification(user, {
                friendName: change.friend.display_name,
                oldStatus: change.oldStatus,
                newStatus: change.newStatus,
                oldWorld: change.oldWorld,
                newWorld: change.newWorld,
                changeType: change.changeType,
                oldStatusDescription: change.oldStatusDescription,
                newStatusDescription: change.newStatusDescription,
                timestamp: timestamp,
                avatarUrl: change.friend.avatar_url,
                eventType: 'world_change'
              });
            }
          }
          // 清空缓存
          buffer.changes = [];
        }
      }
    }


  } catch (e) {
    console.error('检查好友状态失败:', e.message);
  }
}

// 定时任务：检查所有有监控好友的用户
async function runMonitorTask() {
  // 重置限流保护状态（检查是否需要重置计数）
  resetRateLimitProtection();

  // 如果监控已完全停止，跳过本次检查
  if (globalRateLimitProtection.isStopped) {
    console.log(`[${formatLocalTime()}] 监控已完全停止（限流保护），跳过本次检查`);
    return;
  }

  // 如果处于暂停状态，跳过本次检查
  if (globalRateLimitProtection.isPaused) {
    const remaining = Math.ceil((globalRateLimitProtection.pauseEndTime - Date.now()) / 1000);
    if (remaining > 0) {
      console.log(`[${formatLocalTime()}] 系统处于限流暂停状态，剩余 ${remaining} 秒，跳过本次检查`);
      return;
    } else {
      // 暂停结束，恢复检查
      globalRateLimitProtection.isPaused = false;
      console.log(`[${formatLocalTime()}] 限流暂停结束，恢复正常监控`);
    }
  }

  // 查询所有有监控好友的用户（只要有一个好友被监控就检查）
  const users = await new Promise((resolve, reject) => {
    db.all(`
      SELECT DISTINCT u.* FROM users u
      INNER JOIN friend_monitor_config fmc ON u.id = fmc.user_id
      WHERE fmc.monitor_enabled = 1
    `, [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });

  if (users.length === 0) {
    return;
  }

  for (const user of users) {
    await checkFriendStatus(user);
  }
}

// 7.1 cron 轮询已移除:改用 ws 事件驱动(见 ws pipeline 集成)。
// runMonitorTask/checkFriendStatus 保留为死代码,不再被调用;其内部防抖/worldPollIndex/worldChangeBuffer 不执行。

// ==================== API 路由 ====================

// 1. 登录
app.post('/api/login', async (req, res) => {
  try {
    const { username, password, code, tempSessionId, rememberMe } = req.body;
    
    if (!username || !password) {
      return res.json({ code: -1, msg: '用户名和密码不能为空' });
    }

    let cookieJar;
    let api;

    // 如果有临时会话ID，使用保存的会话
    if (tempSessionId && userSessions.has(tempSessionId)) {
      console.log('使用临时会话验证验证码...');
      const tempSession = userSessions.get(tempSessionId);
      cookieJar = tempSession.cookieJar;
      api = tempSession.api;
    } else if (tempSessionId && !userSessions.has(tempSessionId)) {
      // 提供了临时会话ID但会话不存在（可能已过期或被清理）
      console.error(`临时会话不存在: ${tempSessionId}`);
      return res.json({
        code: -1,
        msg: '会话已过期，请重新获取验证码'
      });
    } else {
      // 创建新的 cookie jar
      cookieJar = new CookieJar();
      api = createAxiosInstance(cookieJar);
    }

    // 第一步：使用 Basic Auth 登录
    const base64Auth = Buffer.from(`${username}:${password}`).toString('base64');
    
    console.log('尝试登录...');
    const loginRes = await api.get('/auth/user', {
      headers: {
        'Authorization': `Basic ${base64Auth}`
      }
    });

    console.log('登录响应:', loginRes.status, loginRes.data);

    // 检查是否需要 2FA
    if (loginRes.data.requiresTwoFactorAuth) {
      if (!code) {
        // 需要验证码，保存会话等待验证码（不保存密码）
        const newTempSessionId = Date.now().toString();
        userSessions.set(newTempSessionId, {
          cookieJar,
          api,
          username,
          createdAt: Date.now()
          // 注意：不保存 password，安全考虑
        });
        
        return res.json({ 
          code: 1, 
          msg: '验证码已发送至邮箱，请输入6位验证码',
          tempSessionId: newTempSessionId
        });
      } else {
        // 验证 2FA
        console.log('验证 2FA...');
        console.log('验证码:', code, '长度:', code ? code.length : 0);

        const verifyRes = await api.post('/auth/twofactorauth/emailotp/verify', {
          code: code
        });

        console.log('2FA 验证响应:', verifyRes.status, verifyRes.data);

        if (verifyRes.status !== 200) {
          console.error(`验证码验证失败: status=${verifyRes.status}, data=`, verifyRes.data);
          return res.json({ code: -1, msg: '验证码错误或已过期' });
        }
        
        // 验证成功后删除临时会话
        if (tempSessionId) {
          userSessions.delete(tempSessionId);
        }
      }
    }

    // 登录成功，获取用户信息
    const userRes = await api.get('/auth/user');
    if (userRes.status !== 200) {
      return res.json({ code: -1, msg: '获取用户信息失败' });
    }

    const user = userRes.data;
    console.log('登录成功:', user.displayName);

    // 保存用户到数据库
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO users (vrchat_user_id, username, display_name, avatar_url)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(vrchat_user_id) DO UPDATE SET
         username = excluded.username,
         display_name = excluded.display_name,
         avatar_url = excluded.avatar_url,
         updated_at = CURRENT_TIMESTAMP`,
        [user.id, user.username, user.displayName, user.currentAvatarImageUrl],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // 保存会话（添加创建时间用于过期检查）
    userSessions.set(user.id, {
      cookieJar,
      api,
      createdAt: Date.now()
    });

    // 如果勾选了"记住我"，保存 cookies 和用户名到数据库
    if (rememberMe) {
      await saveUserCookies(user.id, cookieJar, username);
    } else {
      // 清除之前保存的 cookies，但保留用户名
      await clearUserCookies(user.id);
    }

    // 记录用户登录时间（用于冷却期控制）
    userLoginTime.set(user.id, Date.now());
    console.log(`[登录] 用户 ${user.displayName} 登录成功${rememberMe ? '（已记住登录状态）' : ''}`);

    return res.json({
      code: 0,
      msg: '登录成功',
      data: {
        userId: user.id,
        displayName: user.displayName,
        avatarUrl: user.currentAvatarImageUrl,
        loginAt: Date.now(),
        rememberMe: !!rememberMe
      }
    });
  } catch (err) {
    console.error('登录失败:', err.message);
    // 脱敏处理：不向客户端暴露详细错误信息
    let userMsg = '登录失败，请检查用户名和密码';
    if (err.message.includes('验证码')) {
      userMsg = '验证码错误或已过期';
    } else if (err.message.includes('network') || err.message.includes('ECONNREFUSED')) {
      userMsg = '网络连接失败，请检查网络';
    }
    return res.json({ code: -1, msg: userMsg });
  }
});

// 1.5 自动登录（使用保存的 cookie）
app.post('/api/auto-login', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.json({ code: -1, msg: '未提供用户ID' });
    }
    
    // 检查是否已有活跃会话
    if (userSessions.has(userId)) {
      console.log(`[自动登录] 用户 ${userId} 已有活跃会话，无需恢复`);
      const session = userSessions.get(userId);
      
      // 验证会话是否有效
      try {
        const userRes = await session.api.get('/auth/user');
        if (userRes.status === 200) {
          const user = userRes.data;
          return res.json({
            code: 0,
            msg: '已登录',
            data: {
              userId: user.id,
              displayName: user.displayName,
              avatarUrl: user.currentAvatarImageUrl,
              fromCache: true
            }
          });
        }
      } catch (e) {
        console.log(`[自动登录] 现有会话已过期，尝试恢复`);
      }
    }
    
    // 尝试从数据库恢复 cookies
    const cookieJar = await loadUserCookies(userId);
    if (!cookieJar) {
      return res.json({ code: -1, msg: '没有保存的登录凭据' });
    }
    
    // 创建 API 实例
    const api = createAxiosInstance(cookieJar);
    
    // 验证 cookie 是否有效
    try {
      const userRes = await api.get('/auth/user');
      if (userRes.status !== 200) {
        console.log(`[自动登录] 保存的 cookie 已过期`);
        await clearUserCookies(userId);
        return res.json({ code: -1, msg: '登录凭据已过期，请重新登录' });
      }
      
      const user = userRes.data;
      console.log(`[自动登录] 用户 ${user.displayName} 自动登录成功`);
      
      // 保存会话
      userSessions.set(user.id, {
        cookieJar,
        api,
        createdAt: Date.now()
      });
      
      // 记录登录时间
      userLoginTime.set(user.id, Date.now());

      // 6.3 + 6.5 自动登录后:写基线 + 连 ws
      try {
        await fetchAndCacheFriends(api, user.id, false, true);
        const dbUser = await getUserByVrcId(user.id);
        if (dbUser && dbUser.monitor_enabled !== 0) {
          pipelineManager.connectPipeline(user.id, user.displayName);
        }
      } catch (e) {
        console.error(`[自动登录] 启动 ws 失败:`, e.message);
      }

      return res.json({
        code: 0,
        msg: '自动登录成功',
        data: {
          userId: user.id,
          displayName: user.displayName,
          avatarUrl: user.currentAvatarImageUrl,
          autoLogin: true
        }
      });
    } catch (e) {
      console.error(`[自动登录] 验证 cookie 失败:`, e.message);
      await clearUserCookies(userId);
      return res.json({ code: -1, msg: '自动登录失败，请重新登录' });
    }
  } catch (err) {
    console.error('[自动登录] 错误:', err.message);
    return res.json({ code: -1, msg: '自动登录失败' });
  }
});

// 1.6 检查保存的登录状态（用于自动填充用户名）
app.get('/api/check-saved-login', async (req, res) => {
  try {
    // 查询数据库中是否有保存了用户名的用户
    const user = await new Promise((resolve, reject) => {
      db.get(
        'SELECT vrchat_user_id, saved_username, remember_me FROM users WHERE saved_username IS NOT NULL ORDER BY updated_at DESC LIMIT 1',
        [],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
    
    if (user && user.saved_username) {
      return res.json({
        code: 0,
        data: {
          username: user.saved_username,
          hasSavedLogin: !!user.remember_me,
          userId: user.vrchat_user_id
        }
      });
    } else {
      return res.json({
        code: 0,
        data: {
          username: null,
          hasSavedLogin: false,
          userId: null
        }
      });
    }
  } catch (err) {
    console.error('[检查保存的登录状态] 错误:', err.message);
    return res.json({ code: -1, msg: '检查失败' });
  }
});

// 2. 获取当前用户信息
app.get('/api/me', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) {
      return res.json({ code: -1, msg: '未提供用户ID' });
    }

    const session = userSessions.get(userId);
    if (!session) {
      return res.json({ code: -1, msg: '未登录或会话已过期' });
    }

    const userRes = await session.api.get('/auth/user');
    if (userRes.status !== 200) {
      return res.json({ code: -1, msg: '获取用户信息失败' });
    }

    const user = userRes.data;
    return res.json({
      code: 0,
      data: {
        displayName: user.displayName,
        username: user.username,
        avatarUrl: user.currentAvatarImageUrl,
        userId: user.id,
        status: user.status,
        state: user.state || (user.location === 'offline' ? 'offline' : 'online')
      }
    });
  } catch (err) {
    console.error('获取用户信息失败:', err.message);
    return res.json({ code: -1, msg: '获取用户信息失败，请重新登录' });
  }
});

// 3. 获取好友列表（只请求一次API获取所有好友）
// 获取好友列表并更新缓存（同时获取在线和离线好友）
// fetchWorldInfo: 是否获取世界信息（登录时不获取，避免API限流）
async function fetchAndCacheFriends(session, userId, fetchWorldInfo = false, upsertBaseline = false) {
  try {
    console.log(`[好友列表] 开始获取用户 ${userId} 的好友列表（在线+离线）${fetchWorldInfo ? '包含世界信息' : '不包含世界信息'}`);
    // 5.1 基线对齐:查 DB user id,循环里顺便 upsert friends 表基线(静默,不通知)
    const dbUser = upsertBaseline ? await getUserByVrcId(userId) : null;
    const dbUserId = dbUser ? dbUser.id : null;
    
    // 同时请求在线和离线好友（2个API请求）
    const onlineCacheKey = `friends_online_${userId}`;
    const offlineCacheKey = `friends_offline_${userId}`;
    
    // 使用Promise.all同时发起两个请求
    const [onlineRes, offlineRes] = await Promise.all([
      cachedApiRequest(session.api, '/auth/user/friends', 'friendStatus', onlineCacheKey, userId),
      cachedApiRequest(session.api, '/auth/user/friends?offline=true', 'friendStatus', offlineCacheKey, userId)
    ]);
    
    if (onlineRes.status !== 200) {
      console.error('获取在线好友列表失败:', onlineRes.status, onlineRes.data);
      return null;
    }

    const onlineFriends = onlineRes.data || [];
    const offlineFriends = (offlineRes.status === 200 && offlineRes.data) ? offlineRes.data : [];
    
    console.log(`[好友列表] 获取到 ${onlineFriends.length} 个在线好友，${offlineFriends.length} 个离线好友`);
    
    // 合并好友列表（使用 Map 去重，在线好友优先）
    const friendsMap = new Map();
    
    // 先添加在线好友
    for (const friend of onlineFriends) {
      friendsMap.set(friend.id, { ...friend, isOnline: true });
    }
    
    // 再添加离线好友（如果不在在线好友列表中）
    for (const friend of offlineFriends) {
      if (!friendsMap.has(friend.id)) {
        friendsMap.set(friend.id, { ...friend, isOnline: false, status: 'offline', location: 'offline' });
      }
    }
    
    const allFriends = Array.from(friendsMap.values());
    console.log(`[缓存更新] 合并后共 ${allFriends.length} 个好友（${onlineFriends.length} 在线，${offlineFriends.length} 离线）`);
    
    // 处理好友数据
    const processedFriends = [];
    let worldRequestCount = 0;
    const MAX_WORLD_REQUESTS = fetchWorldInfo ? 10 : 0; // 登录时不请求世界信息
    
    for (const friend of allFriends.slice(0, 200)) {
      const location = friend.location || 'offline';
      const worldId = location !== 'offline' ? location.split(':')[0] : null;
      
      let worldName = null;
      // 只有在明确需要时才请求世界信息（避免登录时大量API请求）
      if (fetchWorldInfo && worldId && worldId.startsWith('wrld_') && worldRequestCount < MAX_WORLD_REQUESTS) {
        try {
          const worldCacheKey = `world_${worldId}_${userId}`;
          const worldRes = await cachedApiRequest(session.api, `/worlds/${worldId}`, 'worldInfo', worldCacheKey, userId);
          if (worldRes.status === 200) {
            worldName = worldRes.data.name;
            worldRequestCount++;
          }
        } catch (e) {
          console.error(`获取世界 ${worldId} 失败:`, e.message);
        }
      }

      // 获取头像URL（优先级：profilePicOverride > currentAvatarImageUrl > currentAvatarThumbnailImageUrl > userIcon）
      // VRChat Plus用户可能使用profilePicOverride作为自定义头像
      let avatarUrl = friend.profilePicOverride || 
                      friend.currentAvatarImageUrl || 
                      friend.currentAvatarThumbnailImageUrl ||
                      friend.userIcon;
      
      // 如果头像URL包含默认机器人头像的特征，尝试使用其他来源
      if (!avatarUrl || avatarUrl.includes('robot') || avatarUrl.includes('default')) {
        avatarUrl = friend.profilePicOverride || friend.userIcon || 'https://assets.vrchat.com/www/images/default-avatar.png';
      }
      
      processedFriends.push({
        vrchatId: friend.id,
        displayName: friend.displayName,
        avatarUrl: avatarUrl,
        status: friend.status || 'offline',
        state: friend.state || (location === 'offline' ? 'offline' : 'online'),
        worldId: worldId,
        worldName: worldName,
        statusDescription: friend.statusDescription || null,
        lastLogin: friend.last_login,
        lastActivity: friend.last_activity,
        isOnline: friend.isOnline !== false,
        platform: friend.platform || 'unknown'
      });
      // 5.1 基线对齐:upsert friends 表(静默,不通知)
      if (upsertBaseline && dbUserId) {
        await upsertFriend(dbUserId, friend.id, {
          state: friend.state || (location === 'offline' ? 'offline' : 'online'),
          status: friend.status || 'offline',
          location,
          worldId,
          worldName,
          platform: friend.platform || 'unknown',
          statusDescription: friend.statusDescription || null,
          displayName: friend.displayName,
          avatarUrl
        });
      }
    }

    // 更新缓存（标记为永久缓存）
    friendsListCache.set(userId, {
      friends: processedFriends,
      timestamp: Date.now(),
      permanent: true
    });

    return processedFriends;
  } catch (err) {
    console.error('获取好友列表失败:', err.message);
    return null;
  }
}

app.get('/api/friends', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) {
      return res.json({ code: -1, msg: '未提供用户ID' });
    }

    const session = userSessions.get(userId);
    if (!session) {
      return res.json({ code: -1, msg: '未登录或会话已过期' });
    }

    // 检查是否有缓存
    const cached = friendsListCache.get(userId);
    const now = Date.now();
    
    if (cached && (now - cached.timestamp < FRIENDS_LIST_CACHE_TTL)) {
      // 缓存有效，直接返回缓存数据（不再自动后台更新，只有用户手动刷新才更新）
      console.log(`[缓存命中] 返回用户 ${userId} 的好友列表缓存（剩余 ${Math.round((FRIENDS_LIST_CACHE_TTL - (now - cached.timestamp))/1000)} 秒）`);
      
      return res.json({ code: 0, data: { friends: cached.friends, fromCache: true } });
    }

    // 缓存无效或不存在，实时获取
    console.log(`[缓存未命中] 实时获取用户 ${userId} 的好友列表`);
    const friends = await fetchAndCacheFriends(session, userId);
    
    if (friends) {
      return res.json({ code: 0, data: { friends: friends, fromCache: false } });
    } else {
      // 如果实时获取失败，但有过期缓存，返回过期缓存
      if (cached) {
        console.log(`[降级] 返回过期缓存给用户 ${userId}`);
        return res.json({ code: 0, data: { friends: cached.friends, fromCache: true, stale: true } });
      }
      return res.json({ code: -1, msg: '获取好友列表失败，请稍后重试' });
    }
  } catch (err) {
    console.error('获取好友列表失败:', err.message);
    return res.json({ code: -1, msg: '获取好友列表失败，请稍后重试' });
  }
});

// 4. 强制刷新好友列表（手动刷新）
// 首次刷新好友列表（登录后自动调用，不检查冷却期）
app.post('/api/friends/initial-refresh', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) {
      return res.json({ code: -1, msg: '未提供用户ID' });
    }

    const session = userSessions.get(userId);
    if (!session) {
      return res.json({ code: -1, msg: '未登录或会话已过期' });
    }

    console.log(`[首次刷新] 用户 ${userId} 登录后自动刷新好友列表（不获取世界信息）`);
    
    // 强制刷新，忽略缓存，不获取世界信息（避免登录时API限流）
    // 5.1 upsertBaseline=true:登录后写 friends 表基线(静默)
    const friends = await fetchAndCacheFriends(session, userId, false, true);
    
    if (friends) {
      // 6.2 + 6.5 登录/首次刷新后连 ws(基线已写)
      try {
        const dbUser = await getUserByVrcId(userId);
        if (dbUser && dbUser.monitor_enabled !== 0) {
          pipelineManager.connectPipeline(userId, dbUser.display_name);
        }
      } catch (e) {
        console.error(`[首次刷新] 启动 ws 失败:`, e.message);
      }
      return res.json({ code: 0, data: { friends: friends, fromCache: false, refreshed: true } });
    } else {
      return res.json({ code: -1, msg: '刷新好友列表失败，请稍后重试' });
    }
  } catch (err) {
    console.error('首次刷新好友列表失败:', err.message);
    return res.json({ code: -1, msg: '刷新好友列表失败，请稍后重试' });
  }
});

// 手动刷新好友列表（检查冷却期，并记录刷新时间以停止监控60秒）
app.post('/api/friends/refresh', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) {
      return res.json({ code: -1, msg: '未提供用户ID' });
    }

    const session = userSessions.get(userId);
    if (!session) {
      return res.json({ code: -1, msg: '未登录或会话已过期' });
    }

    // 冷却期已移除:刷新时 fetchAndCacheFriends 自动对齐 friends 表基线(5.1)
    // 强制刷新，忽略缓存，不获取世界信息（避免触发API限流）
    const friends = await fetchAndCacheFriends(session, userId, false, true);
    
    if (friends) {
      return res.json({ code: 0, data: { friends: friends, fromCache: false, refreshed: true, cooldownStarted: true } });
    } else {
      return res.json({ code: -1, msg: '刷新好友列表失败，请稍后重试' });
    }
  } catch (err) {
    console.error('刷新好友列表失败:', err.message);
    return res.json({ code: -1, msg: '刷新好友列表失败，请稍后重试' });
  }
});

// 5. 保存用户配置
app.post('/api/settings', async (req, res) => {
  try {
    const {
      userId, email, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass, emailSubjectTemplate, emailBodyTemplate,
      gotifyEnabled, gotifyServerUrl, gotifyAppToken, gotifyPriority, gotifyTitleTemplate, gotifyMessageTemplate,
      ntfyEnabled, ntfyServerUrl, ntfyTopic, ntfyPriority, ntfyTitleTemplate, ntfyMessageTemplate,
      statusOnlyMode,
      webhookEnabled, webhookUrl, webhookMethod, webhookHeaders, webhookBodyTemplate, webhookContentType
    } = req.body;

    if (!userId) {
      return res.json({ code: -1, msg: '未提供用户ID' });
    }

    // 加密 SMTP 密码（如果提供了密码）
    let encryptedSmtpPass = null;
    if (smtpPass && smtpPass.trim() !== '') {
      encryptedSmtpPass = encrypt(smtpPass.trim());
      console.log(`[设置] SMTP密码已加密保存`);
    }

    // 构建更新字段和参数
    let updateFields = [
      'email = ?',
      'smtp_host = ?',
      'smtp_port = ?',
      'smtp_secure = ?',
      'smtp_user = ?',
      'smtp_pass = ?',
      'email_subject_template = ?',
      'email_body_template = ?'
    ];
    let params = [
      email, smtpHost, smtpPort, smtpSecure ? 1 : 0, smtpUser, encryptedSmtpPass, 
      emailSubjectTemplate, emailBodyTemplate
    ];

    // 添加 Gotify 字段（如果提供了）
    if (gotifyEnabled !== undefined) {
      updateFields.push('gotify_enabled = ?');
      params.push(gotifyEnabled ? 1 : 0);
    }
    if (gotifyServerUrl !== undefined) {
      updateFields.push('gotify_server_url = ?');
      params.push(gotifyServerUrl);
    }
    if (gotifyAppToken !== undefined && gotifyAppToken !== '') {
      updateFields.push('gotify_app_token = ?');
      params.push(gotifyAppToken);
    }
    if (gotifyPriority !== undefined) {
      updateFields.push('gotify_priority = ?');
      params.push(gotifyPriority);
    }
    if (gotifyTitleTemplate !== undefined) {
      updateFields.push('gotify_title_template = ?');
      params.push(gotifyTitleTemplate);
    }
    if (gotifyMessageTemplate !== undefined) {
      updateFields.push('gotify_message_template = ?');
      params.push(gotifyMessageTemplate);
    }
    // 添加 NTFY 字段（如果提供了）
    if (ntfyEnabled !== undefined) {
      updateFields.push('ntfy_enabled = ?');
      params.push(ntfyEnabled ? 1 : 0);
    }
    if (ntfyServerUrl !== undefined) {
      updateFields.push('ntfy_server_url = ?');
      params.push(ntfyServerUrl);
    }
    if (ntfyTopic !== undefined && ntfyTopic !== '') {
      updateFields.push('ntfy_topic = ?');
      params.push(ntfyTopic);
    }
    if (ntfyPriority !== undefined) {
      updateFields.push('ntfy_priority = ?');
      params.push(ntfyPriority);
    }
    if (ntfyTitleTemplate !== undefined) {
      updateFields.push('ntfy_title_template = ?');
      params.push(ntfyTitleTemplate);
    }
    if (ntfyMessageTemplate !== undefined) {
      updateFields.push('ntfy_message_template = ?');
      params.push(ntfyMessageTemplate);
    }
    // 添加仅状态模式字段（如果提供了）
    if (statusOnlyMode !== undefined) {
      updateFields.push('status_only_mode = ?');
      params.push(statusOnlyMode ? 1 : 0);
    }
    
    // 添加通用 Webhook 字段（如果提供了）
    if (webhookEnabled !== undefined) {
      updateFields.push('webhook_enabled = ?');
      params.push(webhookEnabled ? 1 : 0);
    }
    if (webhookUrl !== undefined) {
      updateFields.push('webhook_url = ?');
      params.push(webhookUrl);
    }
    if (webhookMethod !== undefined) {
      updateFields.push('webhook_method = ?');
      params.push(webhookMethod);
    }
    if (webhookHeaders !== undefined) {
      updateFields.push('webhook_headers = ?');
      params.push(webhookHeaders);
    }
    if (webhookBodyTemplate !== undefined) {
      updateFields.push('webhook_body_template = ?');
      params.push(webhookBodyTemplate);
    }
    if (webhookContentType !== undefined) {
      updateFields.push('webhook_content_type = ?');
      params.push(webhookContentType);
    }

    updateFields.push('updated_at = CURRENT_TIMESTAMP');
    params.push(userId);

    await new Promise((resolve, reject) => {
      db.run(
        `UPDATE users SET ${updateFields.join(', ')} WHERE vrchat_user_id = ?`,
        params,
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    return res.json({ code: 0, msg: '设置已保存' });
  } catch (err) {
    console.error('保存设置失败:', err.message);
    return res.json({ code: -1, msg: '保存设置失败，请稍后重试' });
  }
});

// 5. 获取用户设置
app.get('/api/settings', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) {
      return res.json({ code: -1, msg: '未提供用户ID' });
    }

    const user = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE vrchat_user_id = ?', [userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!user) {
      return res.json({ code: -1, msg: '未找到用户设置' });
    }

    // 检查是否已设置SMTP密码（用于前端显示）
    const hasSmtpPass = user.smtp_pass && user.smtp_pass.length > 0;
    // 检查是否已设置Gotify Token（用于前端显示）
    const hasGotifyToken = user.gotify_app_token && user.gotify_app_token.length > 0;
    // 检查是否已设置NTFY Topic（用于前端显示）
    const hasNtfyTopic = user.ntfy_topic && user.ntfy_topic.length > 0;

    return res.json({
      code: 0,
      data: {
        email: user.email,
        smtpHost: user.smtp_host,
        smtpPort: user.smtp_port,
        smtpSecure: user.smtp_secure === 1,
        smtpUser: user.smtp_user,
        smtpPass: hasSmtpPass ? '********' : '',  // 返回占位符表示已设置密码
        emailSubjectTemplate: user.email_subject_template || '[VRC-Notifier] {changeType}: {friendName}',
        emailBodyTemplate: user.email_body_template || '',
        gotifyEnabled: user.gotify_enabled === 1,
        gotifyServerUrl: user.gotify_server_url || '',
        gotifyAppToken: hasGotifyToken ? '********' : '',  // 返回占位符表示已设置Token
        gotifyPriority: user.gotify_priority || 5,
        gotifyTitleTemplate: user.gotify_title_template || '[VRC-Notifier] {changeType}: {friendName}',
        gotifyMessageTemplate: user.gotify_message_template || '好友 {friendName} {changeType}\n\n状态: {oldStatus} → {newStatus}\n世界: {newWorld}\n\n时间: {timestamp}',
        ntfyEnabled: user.ntfy_enabled === 1,
        ntfyServerUrl: user.ntfy_server_url || 'https://ntfy.sh',
        ntfyTopic: hasNtfyTopic ? '********' : '',  // 返回占位符表示已设置Topic
        ntfyPriority: user.ntfy_priority || 3,
        ntfyTitleTemplate: user.ntfy_title_template || '[VRC-Notifier] {changeType}: {friendName}',
        ntfyMessageTemplate: user.ntfy_message_template || '好友 {friendName} {changeType}\n\n状态: {oldStatus} → {newStatus}\n世界: {newWorld}\n\n时间: {timestamp}',
        statusOnlyMode: user.status_only_mode === 1,
        // 通用 Webhook 配置
        webhookEnabled: user.webhook_enabled === 1,
        webhookUrl: user.webhook_url || '',
        webhookMethod: user.webhook_method || 'POST',
        webhookHeaders: user.webhook_headers || '',
        webhookBodyTemplate: user.webhook_body_template || '',
        webhookContentType: user.webhook_content_type || 'application/json'
      }
    });
  } catch (err) {
    console.error('获取设置失败:', err.message);
    return res.json({ code: -1, msg: '获取设置失败，请稍后重试' });
  }
});

// 6. 用户登出 - 完全清除服务器端会话
app.post('/api/logout', async (req, res) => {
  try {
    const { userId, clearRememberMe } = req.body;
    
    if (!userId) {
      return res.json({ code: -1, msg: '未提供用户ID' });
    }

    // 检查会话是否存在
    const session = userSessions.get(userId);
    if (session) {
      // 清除 cookie jar 中的所有 cookie
      if (session.cookieJar) {
        try {
          await session.cookieJar.removeAllCookies();
          console.log(`用户 ${userId} 的 cookie 已清除`);
        } catch (e) {
          console.error('清除 cookie 失败:', e.message);
        }
      }
      
      // 6.4 断开 ws
      pipelineManager.disconnectPipeline(userId);
      // 从会话缓存中删除
      userSessions.delete(userId);
      console.log(`用户 ${userId} 已登出，服务器端会话已完全清除`);
    }

    // 同时清理临时会话（如果有）
    for (const [key, value] of userSessions.entries()) {
      if (value.username === userId) {
        userSessions.delete(key);
      }
    }
    
    // 如果请求清除记住我状态，清除保存的 cookies
    if (clearRememberMe) {
      await clearUserCookies(userId);
      console.log(`用户 ${userId} 的记住我状态已清除`);
    }

    return res.json({ 
      code: 0, 
      msg: clearRememberMe ? '登出成功，所有会话信息已清除' : '登出成功',
      data: { cleared: true, rememberMeCleared: !!clearRememberMe }
    });
  } catch (err) {
    console.error('登出失败:', err.message);
    return res.json({ code: -1, msg: '登出失败，请稍后重试' });
  }
});

// 6.5 用户登出并清除所有本地数据（直接删除数据库文件）
app.post('/api/logout-and-clear', async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId) {
      return res.json({ code: -1, msg: '未提供用户ID' });
    }

    console.log(`[清除数据] 用户 ${userId} 请求登出并清除所有本地数据`);

    // 1. 清除服务器端会话
    const session = userSessions.get(userId);
    if (session) {
      if (session.cookieJar) {
        try {
          await session.cookieJar.removeAllCookies();
        } catch (e) {
          console.error('清除 cookie 失败:', e.message);
        }
      }
      // 6.4 断开 ws
      pipelineManager.disconnectPipeline(userId);
      userSessions.delete(userId);
    }

    // 2. 清除所有缓存数据
    friendsListCache.clear();
    userLoginTime.clear();
    userRefreshTime.clear();
    worldPollIndex.clear();
    userSessions.clear();

    // 3. 关闭数据库连接并删除数据库文件
    try {
      console.log('[清除数据] 开始删除数据库文件...');
      
      // 关闭数据库连接
      await new Promise((resolve, reject) => {
        db.close((err) => {
          if (err) {
            console.error('关闭数据库失败:', err.message);
            reject(err);
          } else {
            console.log('[清除数据] 数据库连接已关闭');
            resolve();
          }
        });
      });
      
      // 删除数据库文件
      const dbPath = path.join(DATA_DIR, 'vrchat.db');
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
        console.log(`[清除数据] 数据库文件已删除: ${dbPath}`);
      }
      
      // 重新初始化数据库
      await initDatabase();
      console.log('[清除数据] 数据库已重新初始化');
      
    } catch (dbErr) {
      console.error('删除数据库文件失败:', dbErr.message);
      return res.json({ code: -1, msg: '清除数据库失败: ' + dbErr.message });
    }

    return res.json({ 
      code: 0, 
      msg: '登出成功，所有本地数据已完全清除（数据库文件已重置）',
      data: { cleared: true, allDataRemoved: true, databaseReset: true }
    });
  } catch (err) {
    console.error('登出并清除数据失败:', err.message);
    return res.json({ code: -1, msg: '操作失败，请稍后重试' });
  }
});

// 8. 获取好友监控配置
app.get('/api/friends/monitor-config', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'];
    if (!userId) {
      return res.json({ code: -1, msg: '未提供用户ID' });
    }

    // 获取数据库用户ID
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM users WHERE vrchat_user_id = ?', [userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!user) {
      return res.json({ code: -1, msg: '用户不存在' });
    }

    // 获取所有好友的监控配置
    const configs = await new Promise((resolve, reject) => {
      db.all(
        'SELECT friend_vrchat_id, monitor_enabled, notify_online, notify_offline, notify_status_change, notify_world_change FROM friend_monitor_config WHERE user_id = ?',
        [user.id],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    const configMap = {};
    configs.forEach(config => {
      configMap[config.friend_vrchat_id] = {
        monitorEnabled: config.monitor_enabled === 1,
        notifyOnline: config.notify_online === 1,
        notifyOffline: config.notify_offline === 1,
        notifyStatusChange: config.notify_status_change === 1,
        notifyWorldChange: config.notify_world_change === 1
      };
    });

    return res.json({ code: 0, data: { configs: configMap } });
  } catch (err) {
    console.error('获取监控配置失败:', err.message);
    return res.json({ code: -1, msg: '获取监控配置失败' });
  }
});

// 9. 更新单个好友监控配置
app.post('/api/friends/monitor-config', async (req, res) => {
  try {
    const { userId, friendId, monitorEnabled, notifyOnline, notifyOffline, notifyStatusChange, notifyWorldChange } = req.body;

    if (!userId || !friendId) {
      return res.json({ code: -1, msg: '缺少必要参数' });
    }

    // 获取数据库用户ID
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM users WHERE vrchat_user_id = ?', [userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!user) {
      return res.json({ code: -1, msg: '用户不存在' });
    }

    // 插入或更新配置
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO friend_monitor_config (user_id, friend_vrchat_id, monitor_enabled, notify_online, notify_offline, notify_status_change, notify_world_change)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, friend_vrchat_id) DO UPDATE SET
         monitor_enabled = excluded.monitor_enabled,
         notify_online = excluded.notify_online,
         notify_offline = excluded.notify_offline,
         notify_status_change = excluded.notify_status_change,
         notify_world_change = excluded.notify_world_change,
         updated_at = CURRENT_TIMESTAMP`,
        [
          user.id,
          friendId,
          monitorEnabled ? 1 : 0,
          notifyOnline !== undefined ? (notifyOnline ? 1 : 0) : 1,
          notifyOffline !== undefined ? (notifyOffline ? 1 : 0) : 1,
          notifyStatusChange !== undefined ? (notifyStatusChange ? 1 : 0) : 1,
          notifyWorldChange !== undefined ? (notifyWorldChange ? 1 : 0) : 1
        ],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    return res.json({ code: 0, msg: '监控配置已更新' });
  } catch (err) {
    console.error('更新监控配置失败:', err.message);
    return res.json({ code: -1, msg: '更新监控配置失败' });
  }
});

// 10. 一键全部关闭监控
app.post('/api/friends/monitor-all', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.json({ code: -1, msg: '缺少必要参数' });
    }

    // 获取数据库用户ID
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT id FROM users WHERE vrchat_user_id = ?', [userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!user) {
      return res.json({ code: -1, msg: '用户不存在' });
    }

    // 获取当前已监控的好友列表
    const monitoredFriends = await new Promise((resolve, reject) => {
      db.all(
        'SELECT friend_vrchat_id FROM friend_monitor_config WHERE user_id = ? AND monitor_enabled = 1',
        [user.id],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    let updatedCount = 0;
    for (const friend of monitoredFriends) {
      await new Promise((resolve, reject) => {
        db.run(
          'UPDATE friend_monitor_config SET monitor_enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND friend_vrchat_id = ?',
          [user.id, friend.friend_vrchat_id],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
      updatedCount++;
    }

    return res.json({
      code: 0,
      msg: `已关闭 ${updatedCount} 个好友的监控`,
      data: { updatedCount }
    });
  } catch (err) {
    console.error('批量关闭监控失败:', err.message);
    return res.json({ code: -1, msg: '批量关闭监控失败' });
  }
});

// 11. 发送测试 Gotify 推送
app.post('/api/test-gotify', async (req, res) => {
  try {
    const { userId, gotifyServerUrl, gotifyAppToken, gotifyPriority } = req.body;

    if (!userId) {
      return res.json({ code: -1, msg: '未提供用户ID' });
    }

    // 使用传入的配置或从数据库获取
    let serverUrl = gotifyServerUrl;
    let appToken = gotifyAppToken;
    let priority = gotifyPriority || 5;

    // 如果没有提供配置，从数据库获取
    if (!serverUrl || !appToken) {
      const user = await new Promise((resolve, reject) => {
        db.get('SELECT * FROM users WHERE vrchat_user_id = ?', [userId], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });

      if (!user) {
        return res.json({ code: -1, msg: '用户不存在' });
      }

      serverUrl = serverUrl || user.gotify_server_url;
      appToken = appToken || user.gotify_app_token;
      priority = gotifyPriority !== undefined ? gotifyPriority : (user.gotify_priority || 5);
    }

    if (!serverUrl || !appToken) {
      return res.json({ code: -1, msg: '请先配置 Gotify 服务器地址和应用 Token' });
    }

    try {
      const gotifyUrl = serverUrl.replace(/\/$/, '') + '/message';
      
      const response = await axios.post(gotifyUrl, {
        title: 'VRC-Notifier 测试推送',
        message: '这是一条测试消息！\n\n如果您收到这条消息，说明 Gotify 配置正确。\n\n时间: ' + new Date().toLocaleString('zh-CN'),
        priority: priority
      }, {
        params: {
          token: appToken
        },
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      if (response.status === 200) {
        console.log(`测试 Gotify 推送已发送至 ${serverUrl}`);
        return res.json({ code: 0, msg: '测试推送已发送，请检查您的 Gotify 客户端' });
      } else {
        return res.json({ code: -1, msg: `推送失败: ${response.status}` });
      }
    } catch (e) {
      console.error('发送测试 Gotify 推送失败:', e.message);
      return res.json({ code: -1, msg: `推送失败: ${e.message}` });
    }
  } catch (err) {
    console.error('发送测试 Gotify 推送失败:', err.message);
    return res.json({ code: -1, msg: '发送失败: ' + err.message });
  }
});

// 11.5 发送测试 NTFY 推送
app.post('/api/test-ntfy', async (req, res) => {
  try {
    const { userId, ntfyServerUrl, ntfyTopic, ntfyPriority } = req.body;

    if (!userId) {
      return res.json({ code: -1, msg: '未提供用户ID' });
    }

    // 使用传入的配置或从数据库获取
    let serverUrl = ntfyServerUrl;
    let topic = ntfyTopic;
    let priority = ntfyPriority || 3;

    // 如果没有提供配置，从数据库获取
    if (!serverUrl || !topic) {
      const user = await new Promise((resolve, reject) => {
        db.get('SELECT * FROM users WHERE vrchat_user_id = ?', [userId], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });

      if (!user) {
        return res.json({ code: -1, msg: '用户不存在' });
      }

      serverUrl = serverUrl || user.ntfy_server_url;
      topic = topic || user.ntfy_topic;
      priority = ntfyPriority !== undefined ? ntfyPriority : (user.ntfy_priority || 3);
    }

    if (!serverUrl || !topic) {
      return res.json({ code: -1, msg: '请先配置 NTFY 服务器地址和 Topic' });
    }

    try {
      const ntfyUrl = serverUrl.replace(/\/$/, '') + '/' + encodeURIComponent(topic);

      // 测试推送标题和内容
      // 使用横杠格式时间，避免被识别为电话号码
      const dateStr = formatDateSafe(new Date());

      // 使用中文标题，通过 RFC 2047 编码支持
      const testTitle = 'VRC-Notifier 测试推送';
      const encodedTestTitle = encodeRfc2047(testTitle);
      const testMessage = '这是一条测试消息！\n\n如果您收到这条消息，说明 NTFY 配置正确。\n\n时间: ' + dateStr;

      console.log('[NTFY Test] Sending to:', ntfyUrl);
      console.log('[NTFY Test] Title:', testTitle, '(编码:', encodedTestTitle + ')');
      console.log('[NTFY Test] Message:', testMessage);

      const response = await axios.post(ntfyUrl, testMessage, {
        headers: {
          'Content-Type': 'text/plain',
          'Title': encodedTestTitle,
          'Priority': String(priority),
          'Tags': 'test'
        },
        timeout: 10000
      });

      if (response.status === 200 || response.status === 204) {
        console.log(`测试 NTFY 推送已发送至 ${serverUrl}/${topic}`);
        return res.json({ code: 0, msg: '测试推送已发送，请检查您的 NTFY 客户端' });
      } else {
        return res.json({ code: -1, msg: `推送失败: ${response.status}` });
      }
    } catch (e) {
      console.error('发送测试 NTFY 推送失败:', e.message);
      return res.json({ code: -1, msg: `推送失败: ${e.message}` });
    }
  } catch (err) {
    console.error('发送测试 NTFY 推送失败:', err.message);
    return res.json({ code: -1, msg: '发送失败: ' + err.message });
  }
});

// 12. 发送测试 Webhook
app.post('/api/test-webhook', async (req, res) => {
  try {
    const { userId, webhookUrl, webhookMethod, webhookHeaders, webhookBodyTemplate, webhookContentType } = req.body;
    
    if (!webhookUrl) {
      return res.json({ code: -1, msg: 'Webhook URL 不能为空' });
    }

    // 准备测试数据
    const testData = {
      friendName: '测试好友',
      oldStatus: '离线',
      newStatus: '在线',
      oldWorld: '未知世界',
      newWorld: '测试世界',
      changeType: '好友上线',
      timestamp: new Date().toLocaleString('zh-CN'),
      avatarUrl: 'https://assets.vrchat.com/www/images/default-avatar.png',
      eventType: 'test'
    };

    // 解析请求头
    let headers = {
      'Content-Type': webhookContentType || 'application/json'
    };
    
    if (webhookHeaders) {
      try {
        const customHeaders = JSON.parse(webhookHeaders);
        headers = { ...headers, ...customHeaders };
      } catch (e) {
        console.error('解析自定义请求头失败:', e.message);
      }
    }

    // 构建请求体
    let body;
    const method = (webhookMethod || 'POST').toUpperCase();
    
    if (webhookBodyTemplate) {
      body = webhookBodyTemplate;
      const templateVars = {
        '{friendName}': testData.friendName,
        '{oldStatus}': testData.oldStatus,
        '{newStatus}': testData.newStatus,
        '{oldWorld}': testData.oldWorld,
        '{newWorld}': testData.newWorld,
        '{changeType}': testData.changeType,
        '{timestamp}': testData.timestamp,
        '{avatarUrl}': testData.avatarUrl,
        '{eventType}': testData.eventType
      };
      
      for (const [key, value] of Object.entries(templateVars)) {
        body = body.replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value);
      }
      
      if (headers['Content-Type'] === 'application/json') {
        try {
          body = JSON.parse(body);
        } catch (e) {
          // 不是有效的 JSON，保持原样
        }
      }
    } else {
      body = {
        event: 'test',
        timestamp: testData.timestamp,
        message: '这是一条测试消息',
        friend: {
          name: testData.friendName,
          avatar: testData.avatarUrl
        },
        change: {
          type: testData.changeType,
          oldStatus: testData.oldStatus,
          newStatus: testData.newStatus,
          oldWorld: testData.oldWorld,
          newWorld: testData.newWorld
        }
      };
    }

    // 发送测试请求
    const config = {
      method: method,
      url: webhookUrl,
      headers: headers,
      timeout: 10000
    };

    if (method !== 'GET') {
      config.data = body;
    }

    const response = await axios(config);
    
    console.log(`测试 Webhook 发送成功: ${webhookUrl} (状态: ${response.status})`);
    return res.json({ 
      code: 0, 
      msg: `测试 Webhook 发送成功 (HTTP ${response.status})`,
      data: {
        status: response.status,
        statusText: response.statusText
      }
    });
  } catch (err) {
    console.error('发送测试 Webhook 失败:', err.message);
    return res.json({ code: -1, msg: `发送测试 Webhook 失败: ${err.message}` });
  }
});

// 13. 发送测试邮件
app.post('/api/test-email', async (req, res) => {
  try {
    const { userId, testEmail } = req.body;

    if (!userId) {
      return res.json({ code: -1, msg: '未提供用户ID' });
    }

    // 获取用户配置
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE vrchat_user_id = ?', [userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!user) {
      return res.json({ code: -1, msg: '用户不存在' });
    }

    if (!user.smtp_host || !user.smtp_user || !user.smtp_pass) {
      return res.json({ code: -1, msg: '请先配置 SMTP 服务器信息' });
    }

    // 解密 SMTP 密码
    const decryptedPass = decrypt(user.smtp_pass);
    if (!decryptedPass) {
      return res.json({ code: -1, msg: 'SMTP 密码解密失败' });
    }

    // 创建邮件传输器
    const transporter = nodemailer.createTransport({
      host: user.smtp_host,
      port: user.smtp_port || 587,
      secure: user.smtp_secure === 1,
      auth: {
        user: user.smtp_user,
        pass: decryptedPass
      }
    });

    // 测试邮件内容
    const targetEmail = testEmail || user.email || user.smtp_user;
    const timestamp = new Date().toLocaleString('zh-CN');
    
    // 替换邮件模板变量
    let subject = user.email_subject_template || '[VRChat好友监控] {friendName} 状态更新';
    let html = user.email_body_template || '<h2>好友状态更新通知</h2><p>您的好友 <strong>{friendName}</strong> 状态发生了变化</p>';
    
    subject = subject
      .replace(/{friendName}/g, '测试好友')
      .replace(/{oldStatus}/g, '离线')
      .replace(/{newStatus}/g, '在线')
      .replace(/{oldWorld}/g, '未知世界')
      .replace(/{newWorld}/g, '测试世界')
      .replace(/{timestamp}/g, timestamp);
      
    html = html
      .replace(/{friendName}/g, '测试好友')
      .replace(/{oldStatus}/g, '离线')
      .replace(/{newStatus}/g, '在线')
      .replace(/{oldWorld}/g, '未知世界')
      .replace(/{newWorld}/g, '测试世界')
      .replace(/{timestamp}/g, timestamp);

    // 添加测试标识
    subject = '[测试邮件] ' + subject;
    html = `<div style="border: 2px solid #11998e; padding: 10px; margin-bottom: 20px; background: #e8f5e9;">
      <strong> 这是一封测试邮件</strong><br>
      如果您收到这封邮件，说明您的 SMTP 配置正确！
    </div>` + html;

    // 发送测试邮件
    await transporter.sendMail({
      from: `"VRChat好友监控" <${user.smtp_user}>`,
      to: targetEmail,
      subject: subject,
      html: html
    });

    console.log(`测试邮件已发送至 ${targetEmail}`);
    return res.json({ code: 0, msg: `测试邮件已发送至 ${targetEmail}` });
  } catch (err) {
    console.error('发送测试邮件失败:', err.message);
    return res.json({ code: -1, msg: `发送测试邮件失败: ${err.message}` });
  }
});

// 访问密钥验证 API
app.post('/api/verify-access-key', async (req, res) => {
  const { accessKey } = req.body;
  
  try {
    const enabled = await isAccessKeyEnabled();
    if (!enabled) {
      return res.json({ code: 0, msg: '访问密钥验证已禁用', data: { required: false } });
    }

    const storedKey = await new Promise((resolve, reject) => {
      db.get('SELECT value FROM system_settings WHERE key = ?', ['access_key'], (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.value : null);
      });
    });

    if (!storedKey) {
      return res.json({ code: -1, msg: '访问密钥未配置' });
    }

    if (accessKey === storedKey) {
      return res.json({ code: 0, msg: '验证成功', data: { required: true } });
    } else {
      return res.json({ code: -1, msg: '访问密钥错误' });
    }
  } catch (err) {
    console.error('验证访问密钥失败:', err);
    return res.json({ code: -1, msg: '验证失败' });
  }
});

// 获取访问密钥状态
app.get('/api/access-key-status', async (req, res) => {
  try {
    const enabled = await isAccessKeyEnabled();
    const accessKey = await new Promise((resolve, reject) => {
      db.get('SELECT value FROM system_settings WHERE key = ?', ['access_key'], (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.value : null);
      });
    });
    
    return res.json({ 
      code: 0, 
      data: { 
        enabled, 
        accessKey: accessKey || '' 
      } 
    });
  } catch (err) {
    console.error('获取访问密钥状态失败:', err);
    return res.json({ code: -1, msg: '获取失败' });
  }
});

// 更新访问密钥设置
app.post('/api/access-key-settings', async (req, res) => {
  const { enabled, accessKey } = req.body;
  
  try {
    // 更新启用状态
    await new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ['access_key_enabled', enabled ? '1' : '0'],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });

    // 如果提供了新密钥，更新密钥
    if (accessKey) {
      await new Promise((resolve, reject) => {
        db.run(
          'INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          ['access_key', accessKey],
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    }

    return res.json({ code: 0, msg: '设置已保存' });
  } catch (err) {
    console.error('保存访问密钥设置失败:', err);
    return res.json({ code: -1, msg: '保存失败' });
  }
});

// SSE客户端连接管理
const sseClients = new Map(); // Map<userId, res>

// 广播限流事件给所有连接的客户端
function broadcastRateLimitEvent(event) {
  const eventData = JSON.stringify(event);
  console.log(`[SSE广播] 发送限流事件给 ${sseClients.size} 个客户端`);

  for (const [userId, res] of sseClients.entries()) {
    try {
      res.write(`data: ${eventData}\n\n`);
    } catch (e) {
      console.error(`[SSE] 发送给客户端 ${userId} 失败:`, e.message);
      sseClients.delete(userId);
    }
  }
}

// 发送限流保护通知给所有用户（邮件/Gotify）
async function sendRateLimitNotificationToAllUsers(apiType, status, pauseSeconds = 60) {
  try {
    // 获取所有配置了通知的用户
    const users = await new Promise((resolve, reject) => {
      db.all(`
        SELECT DISTINCT u.* FROM users u
        WHERE u.email IS NOT NULL OR u.gotify_enabled = 1
      `, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    if (users.length === 0) {
      return;
    }

    console.log(`[限流通知] 准备向 ${users.length} 个用户发送限流保护通知`);

    let title, message, htmlContent;

    if (status === 'stopped') {
      title = '[VRC-Notifier] 监控已完全停止 - 限流保护';
      message = `您好，\n\n系统连续触发3次API限流保护，已完全停止监控以保护您的账号安全。\n\n原因：\n- API请求频率过高\n- 连续触发限流保护机制\n\n建议操作：\n1. 检查是否有其他程序在使用VRChat API\n2. 等待1小时后系统会自动重置\n3. 或手动重启程序恢复监控\n\n注意：这是为了保护您的VRChat账号不被封禁。`;
      htmlContent = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
        <h2 style="color: #dc2626;">监控已完全停止</h2>
        <p>您好，</p>
        <p>系统连续触发3次API限流保护，已完全停止监控以保护您的账号安全。</p>
        <div style="background: #fef2f2; border-left: 4px solid #dc2626; padding: 15px; margin: 20px 0;">
          <h3 style="margin: 0 0 10px 0; color: #991b1b;">原因</h3>
          <ul style="margin: 0; color: #7f1d1d;">
            <li>API请求频率过高</li>
            <li>连续触发限流保护机制</li>
          </ul>
        </div>
        <h3 style="color: #374151;">建议操作</h3>
        <ol style="color: #4b5563; line-height: 1.8;">
          <li>检查是否有其他程序在使用VRChat API</li>
          <li>等待1小时后系统会自动重置</li>
          <li>或手动重启程序恢复监控</li>
        </ol>
        <p style="color: #dc2626; font-weight: bold;">注意：这是为了保护您的VRChat账号不被封禁。</p>
      </div>`;
    } else {
      title = `[VRC-Notifier] API限流保护已触发 - 暂停${pauseSeconds}秒`;
      message = `您好，\n\n系统检测到API请求频率过高，已自动触发限流保护机制。\n\n触发接口：${apiType}\n暂停时长：${pauseSeconds}秒\n\n请检查终端日志了解更多详情。\n\n这是为了保护您的VRChat账号安全，防止因频繁调用API而导致账号被封禁。`;
      htmlContent = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
        <h2 style="color: #f59e0b;">API限流保护已触发</h2>
        <p>您好，</p>
        <p>系统检测到API请求频率过高，已自动触发限流保护机制。</p>
        <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0;">
          <p style="margin: 5px 0;"><strong>触发接口：</strong>${apiType}</p>
          <p style="margin: 5px 0;"><strong>暂停时长：</strong>${pauseSeconds}秒</p>
        </div>
        <p>请检查终端日志了解更多详情。</p>
        <p style="color: #92400e;">这是为了保护您的VRChat账号安全，防止因频繁调用API而导致账号被封禁。</p>
      </div>`;
    }

    // 发送通知给每个用户
    for (const user of users) {
      try {
        // 发送Gotify通知
        if (user.gotify_enabled) {
          await sendGotifyNotification(user, title, message, 8);
        }

        // 发送NTFY通知
        if (user.ntfy_enabled) {
          await sendNtfyNotification(user, title, message, 5, null);
        }

        // 发送Webhook通知
        if (user.webhook_enabled && user.webhook_url) {
          const webhookBody = {
            event: 'rate_limit_' + status,
            timestamp: new Date().toISOString(),
            apiType: apiType,
            status: status,
            pauseSeconds: pauseSeconds,
            message: message,
            title: title
          };
          await sendWebhookNotification(user, {
            eventType: 'rate_limit_' + status,
            timestamp: new Date().toLocaleString('zh-CN'),
            title: title,
            message: message,
            apiType: apiType,
            status: status,
            pauseSeconds: pauseSeconds
          });
        }

        // 发送邮件通知
        if (user.email && user.smtp_host) {
          const transporter = nodemailer.createTransport({
            host: user.smtp_host,
            port: user.smtp_port || 587,
            secure: user.smtp_secure === 1,
            auth: {
              user: user.smtp_user,
              pass: decrypt(user.smtp_pass)
            }
          });

          await transporter.sendMail({
            from: `"VRC-Notifier" <${user.smtp_user}>`,
            to: user.email,
            subject: title,
            text: message,
            html: htmlContent
          });

          console.log(`[限流通知] 已发送邮件通知给用户 ${user.display_name}`);
        }
      } catch (e) {
        console.error(`[限流通知] 发送通知给用户 ${user.display_name} 失败:`, e.message);
      }
    }
  } catch (e) {
    console.error('[限流通知] 发送限流通知失败:', e.message);
  }
}

// 发送会话过期事件给指定用户
function sendSessionExpiredEvent(userId, reason = 'unknown') {
  const res = sseClients.get(userId);
  if (!res) {
    console.log(`[SSE] 用户 ${userId} 没有活跃的SSE连接，无法发送会话过期通知`);
    return false;
  }
  
  const eventData = JSON.stringify({
    type: 'session_expired',
    message: '会话已过期，请重新登录',
    reason: reason,
    details: {
      title: '会话已过期',
      content: '您的 VRChat 登录会话已过期，工具已停止运行。请重新登录以恢复监控。',
      reasons: [
        '长时间未使用（通常几天到几周）',
        'IP 地址发生变化',
        'VRChat 服务器维护',
        '账号安全机制触发',
        '您在其他地方登录了 VRChat（如游戏客户端或官网）'
      ],
      action: '请退出登录后重新登录'
    }
  });
  
  try {
    res.write(`data: ${eventData}\n\n`);
    console.log(`[SSE] 已发送会话过期通知给用户 ${userId}`);
    
    // 同时发送通知到各平台
    sendSessionExpiredNotificationToAllPlatforms(userId, reason);
    
    return true;
  } catch (e) {
    console.error(`[SSE] 发送会话过期通知给用户 ${userId} 失败:`, e.message);
    sseClients.delete(userId);
    return false;
  }
}

// 发送会话过期通知到所有平台
async function sendSessionExpiredNotificationToAllPlatforms(userId, reason = 'unknown') {
  try {
    // 获取用户信息
    const user = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE id = ?', [userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });

    if (!user) {
      console.log(`[会话过期通知] 用户 ${userId} 不存在`);
      return;
    }

    const title = '[VRC-Notifier] 会话已过期 - 请重新登录';
    const message = `您好，\n\n您的 VRChat 登录会话已过期，工具已停止运行。\n\n可能原因：\n- 长时间未使用（通常几天到几周）\n- IP 地址发生变化\n- VRChat 服务器维护\n- 账号安全机制触发\n- 您在其他地方登录了 VRChat\n\n请重新登录以恢复监控。`;
    const htmlContent = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
      <h2 style="color: #dc2626;">会话已过期</h2>
      <p>您好，</p>
      <p>您的 VRChat 登录会话已过期，工具已停止运行。</p>
      <div style="background: #fef2f2; border-left: 4px solid #dc2626; padding: 15px; margin: 20px 0;">
        <h3 style="margin: 0 0 10px 0; color: #991b1b;">可能原因</h3>
        <ul style="margin: 0; color: #7f1d1d;">
          <li>长时间未使用（通常几天到几周）</li>
          <li>IP 地址发生变化</li>
          <li>VRChat 服务器维护</li>
          <li>账号安全机制触发</li>
          <li>您在其他地方登录了 VRChat</li>
        </ul>
      </div>
      <p style="color: #dc2626; font-weight: bold;">请重新登录以恢复监控。</p>
    </div>`;

    // 发送Gotify通知
    if (user.gotify_enabled) {
      try {
        await sendGotifyNotification(user, title, message, 8);
        console.log(`[会话过期通知] 已发送Gotify通知给用户 ${user.display_name}`);
      } catch (e) {
        console.error(`[会话过期通知] 发送Gotify通知给用户 ${user.display_name} 失败:`, e.message);
      }
    }

    // 发送NTFY通知
    if (user.ntfy_enabled) {
      try {
        await sendNtfyNotification(user, title, message, 5, null);
        console.log(`[会话过期通知] 已发送NTFY通知给用户 ${user.display_name}`);
      } catch (e) {
        console.error(`[会话过期通知] 发送NTFY通知给用户 ${user.display_name} 失败:`, e.message);
      }
    }

    // 发送Webhook通知
    if (user.webhook_enabled && user.webhook_url) {
      try {
        await sendWebhookNotification(user, {
          eventType: 'session_expired',
          timestamp: new Date().toLocaleString('zh-CN'),
          title: title,
          message: message,
          reason: reason,
          friendName: user.display_name
        });
        console.log(`[会话过期通知] 已发送Webhook通知给用户 ${user.display_name}`);
      } catch (e) {
        console.error(`[会话过期通知] 发送Webhook通知给用户 ${user.display_name} 失败:`, e.message);
      }
    }

    // 发送邮件通知
    if (user.email && user.smtp_host) {
      try {
        const transporter = nodemailer.createTransport({
          host: user.smtp_host,
          port: user.smtp_port || 587,
          secure: user.smtp_secure === 1,
          auth: {
            user: user.smtp_user,
            pass: decrypt(user.smtp_pass)
          }
        });

        await transporter.sendMail({
          from: `"VRC-Notifier" <${user.smtp_user}>`,
          to: user.email,
          subject: title,
          text: message,
          html: htmlContent
        });

        console.log(`[会话过期通知] 已发送邮件通知给用户 ${user.display_name}`);
      } catch (e) {
        console.error(`[会话过期通知] 发送邮件通知给用户 ${user.display_name} 失败:`, e.message);
      }
    }
  } catch (e) {
    console.error('[会话过期通知] 发送会话过期通知失败:', e.message);
  }
}

// 发送游戏登录检测事件给指定用户
function sendGameLoginEvent(userId, displayName) {
  const res = sseClients.get(userId);
  if (!res) {
    console.log(`[SSE] 用户 ${userId} 没有活跃的SSE连接，无法发送游戏登录通知`);
    return false;
  }
  
  const eventData = JSON.stringify({
    type: 'game_login_detected',
    message: '检测到您的账号在另一个位置登录',
    details: {
      title: '工具已暂停',
      subtitle: '检测到登录状态变化',
      content: `您好 ${displayName}，检测到您的账号在另一个位置登录（可能是VRChat游戏或其他设备），本工具已自动暂停运行。`,
      explanation: {
        title: '原因说明',
        text: 'VRChat检测到您的账号IP地址发生变化，出于安全考虑自动使之前的登录会话失效。这是VRChat的安全机制，不是工具故障。'
      },
      steps: {
        title: '解决方案',
        items: [
          '方案一（推荐）：将工具部署在与游戏相同的网络环境下（同一IP地址），先启动游戏，再启动工具',
          '方案二：退出游戏后，访问工具网页重新登录即可恢复监控'
        ]
      },
      note: {
        text: '如果需要在玩游戏时使用工具监控好友，请确保工具和游戏的IP地址相同，并先开游戏再开工具。'
      },
      action: '我知道了，退出登录'
    }
  });
  
  try {
    res.write(`data: ${eventData}\n\n`);
    console.log(`[SSE] 已发送游戏登录通知给用户 ${userId}`);
    return true;
  } catch (e) {
    console.error(`[SSE] 发送游戏登录通知给用户 ${userId} 失败:`, e.message);
    sseClients.delete(userId);
    return false;
  }
}

// SSE端点 - 客户端连接接收实时通知
app.get('/api/events', (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(401).json({ code: -1, msg: '未提供用户ID' });
  }

  // 设置SSE头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // 注册客户端
  sseClients.set(userId, res);
  console.log(`[SSE] 客户端 ${userId} 已连接，当前连接数: ${sseClients.size}`);

  // 发送初始连接成功消息
  res.write(`data: ${JSON.stringify({ type: 'connected', message: '已连接到事件流' })}\n\n`);

  // 检查当前是否处于限流暂停状态
  if (globalRateLimitProtection.isPaused) {
    const remaining = Math.ceil((globalRateLimitProtection.pauseEndTime - Date.now()) / 1000);
    res.write(`data: ${JSON.stringify({
      type: 'rate_limit_active',
      message: `系统正处于API限流保护状态，剩余 ${remaining} 秒`,
      remainingSeconds: remaining
    })}\n\n`);
  }

  // 客户端断开连接时清理
  req.on('close', () => {
    sseClients.delete(userId);
    console.log(`[SSE] 客户端 ${userId} 已断开，当前连接数: ${sseClients.size}`);
  });
});

// 获取当前限流状态
app.get('/api/rate-limit-status', (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(401).json({ code: -1, msg: '未提供用户ID' });
  }

  return res.json({
    code: 0,
    data: {
      isPaused: globalRateLimitProtection.isPaused,
      pauseEndTime: globalRateLimitProtection.pauseEndTime,
      remainingSeconds: globalRateLimitProtection.isPaused 
        ? Math.ceil((globalRateLimitProtection.pauseEndTime - Date.now()) / 1000)
        : 0,
      triggerCount: globalRateLimitProtection.triggerCount,
      lastTriggerTime: globalRateLimitProtection.lastTriggerTime,
      limits: {
        userProfile: API_RATE_LIMITS.userProfile,
        friendStatus: API_RATE_LIMITS.friendStatus,
        worldInfo: API_RATE_LIMITS.worldInfo
      }
    }
  });
});

// ==================== ws pipeline 集成 ====================
// 实时好友事件采集:ws 事件 -> 入库 + 通知筛选(采集与通知解耦,对照 design D3/D14)
const { createPipelineManager } = require('./ws-pipeline');

async function getUserByVrcId(vrchatUserId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE vrchat_user_id = ?', [vrchatUserId], (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}

async function getFriendFromDB(dbUserId, friendVrcId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM friends WHERE user_id = ? AND friend_vrchat_id = ?', [dbUserId, friendVrcId], (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}

// 通知偏好白名单(第4组:采集不查,通知时才查)
async function getMonitorConfig(dbUserId, friendVrcId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM friend_monitor_config WHERE user_id = ? AND friend_vrchat_id = ? AND monitor_enabled = 1', [dbUserId, friendVrcId], (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}

// 3.4 + 3.5 friends 表 upsert:无记录 INSERT 静默初始化(不通知),有记录 UPDATE
async function upsertFriend(dbUserId, friendVrcId, state) {
  const existing = await getFriendFromDB(dbUserId, friendVrcId);
  const now = new Date().toISOString();
  if (!existing) {
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO friends (user_id, friend_vrchat_id, display_name, avatar_url, status, state, world_id, world_name, status_description, platform, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [dbUserId, friendVrcId, state.displayName, state.avatarUrl, state.status || 'offline', state.state || 'offline', state.worldId, state.worldName, state.statusDescription, state.platform || 'unknown', now],
        (err) => { if (err) reject(err); else resolve(); }
      );
    });
    console.log(`[ws] 首次静默初始化好友 ${state.displayName || friendVrcId}`);
    return { isNew: true };
  }
  await new Promise((resolve, reject) => {
    db.run(
      `UPDATE friends SET display_name = ?, avatar_url = ?, status = ?, state = ?, world_id = ?, world_name = ?, status_description = ?, platform = ?, last_seen = ? WHERE id = ?`,
      [state.displayName ?? existing.display_name, state.avatarUrl ?? existing.avatar_url, state.status ?? existing.status, state.state ?? existing.state, state.worldId ?? existing.world_id, state.worldName ?? existing.world_name, state.statusDescription ?? existing.status_description, state.platform ?? existing.platform, now, existing.id],
      (err) => { if (err) reject(err); else resolve(); }
    );
  });
  return { isNew: false, existing };
}

// 3.6 friend-location 事件触发查 /worlds/{id}(走 worldInfo 缓存)
async function fetchWorldName(session, worldId, userId) {
  if (!worldId || !worldId.startsWith('wrld_')) return null;
  const worldCacheKey = `world_${worldId}_${userId}`;
  try {
    const worldRes = await cachedApiRequest(session.api, `/worlds/${worldId}`, 'worldInfo', worldCacheKey, userId);
    if (worldRes.status === 200) return worldRes.data.name;
  } catch (e) {
    console.error(`[ws] 获取世界 ${worldId} 失败:`, e.message);
  }
  return null;
}

// 4 渠道通知(复用现有函数,默认智能模板)
async function sendFriendNotification(user, friend, params) {
  const { oldStatus, newStatus, oldWorld, newWorld, changeType, oldStatusDescription, newStatusDescription, oldPlatform, newPlatform } = params;
  await sendEmailNotification(user, { friend, oldStatus, newStatus, oldWorld, newWorld, changeType, oldStatusDescription, newStatusDescription, oldPlatform, newPlatform });
  const timestamp = new Date().toLocaleString('zh-CN');
  const gotifyTitle = generateGotifyTitle(friend.display_name, changeType, oldStatus, newStatus, oldWorld, newWorld);
  const gotifyMessage = generateGotifyMessage(friend.display_name, changeType, oldStatus, newStatus, oldWorld, newWorld, timestamp, oldStatusDescription, newStatusDescription);
  const extras = { 'client::display': { 'contentType': 'text/markdown' } };
  await sendGotifyNotification(user, gotifyTitle, gotifyMessage, user.gotify_priority || 5, extras);
  if (user.ntfy_enabled) {
    const ntfyTimestamp = formatDateSafe(new Date());
    const ntfyTitle = generateGotifyTitle(friend.display_name, changeType, oldStatus, newStatus, oldWorld, newWorld);
    const ntfyMessage = generateGotifyMessage(friend.display_name, changeType, oldStatus, newStatus, oldWorld, newWorld, ntfyTimestamp, oldStatusDescription, newStatusDescription);
    await sendNtfyNotification(user, ntfyTitle, ntfyMessage, user.ntfy_priority || 3, null);
  }
  const eventType = oldStatus === 'offline' ? 'friend_online' : (newStatus === 'offline' ? 'friend_offline' : 'status_change');
  await sendWebhookNotification(user, {
    friendName: friend.display_name, oldStatus, newStatus, oldWorld, newWorld, changeType,
    oldStatusDescription, newStatusDescription, timestamp, avatarUrl: friend.avatar_url, eventType,
    oldPlatform: oldPlatform || 'unknown', newPlatform: newPlatform || 'unknown',
    oldPlatformDisplay: getPlatformDisplayName(oldPlatform || 'unknown'), newPlatformDisplay: getPlatformDisplayName(newPlatform || 'unknown')
  });
}

// 3.3 applyFriendChange:state 变化(上线/下线/web端),对照 design D14
async function applyFriendChange(user, friendId, newState) {
  const upsertResult = await upsertFriend(user.id, friendId, newState);
  if (upsertResult.isNew) return; // 3.5 首次静默,不通知

  const existing = upsertResult.existing;
  const oldStateStr = existing.state || (existing.status === 'offline' ? 'offline' : 'online');
  const newStateStr = newState.state;

  // 分类(基于 state 转换)
  let changeType = null;
  let notifyField = null;
  if (oldStateStr === 'offline' && newStateStr === 'online') { changeType = '上线'; notifyField = 'notify_online'; }
  else if (oldStateStr === 'online' && newStateStr === 'offline') { changeType = '下线'; notifyField = 'notify_offline'; }
  else if (oldStateStr === 'active' && newStateStr === 'online') { changeType = 'web端上线'; notifyField = 'notify_online'; }
  else if (oldStateStr === 'online' && newStateStr === 'active') { changeType = '下线至web端'; notifyField = 'notify_offline'; }
  else if (oldStateStr === 'offline' && newStateStr === 'active') { changeType = 'web端上线'; notifyField = 'notify_online'; }
  // active -> offline:网页下线,不通知(沿用原行为)
  if (!changeType) return;

  // 4.1 通知筛选:查 friend_monitor_config 白名单 + notify_* 偏好
  const config = await getMonitorConfig(user.id, friendId);
  if (!config) return; // 不在白名单,仅入库不通知
  if (!config[notifyField]) return; // 对应通知偏好关

  const oldStatus = existing.status;
  const newStatus = newState.status || existing.status;
  const oldWorld = existing.world_name;
  const newWorld = newState.worldName ?? existing.world_name;
  await sendFriendNotification(user, existing, {
    oldStatus, newStatus, oldWorld, newWorld, changeType,
    oldStatusDescription: existing.status_description, newStatusDescription: newState.statusDescription,
    oldPlatform: existing.platform, newPlatform: newState.platform
  });
  console.log(`[ws] 好友 ${existing.display_name} ${changeType},已发通知`);
}

// friend-update 事件:status(社交状态)/ statusDescription / 资料变
async function handleFriendUpdate(user, content) {
  const u = content.user;
  if (!u || !u.id) return;
  const dbFriend = await getFriendFromDB(user.id, u.id);
  if (!dbFriend) {
    await upsertFriend(user.id, u.id, { displayName: u.displayName, avatarUrl: u.currentAvatarImageUrl, status: u.status, statusDescription: u.statusDescription });
    return; // 首次静默
  }
  const oldStatus = dbFriend.status;
  const newStatus = u.status || oldStatus;
  const oldDesc = dbFriend.status_description;
  const newDesc = u.statusDescription ?? oldDesc;
  await new Promise((resolve, reject) => {
    db.run('UPDATE friends SET display_name = ?, avatar_url = ?, status = ?, status_description = ? WHERE id = ?',
      [u.displayName || dbFriend.display_name, u.currentAvatarImageUrl || dbFriend.avatar_url, newStatus, newDesc, dbFriend.id],
      (err) => { if (err) reject(err); else resolve(); });
  });
  // status 变化(游戏在线状态间切换 active/join me/ask me/busy)
  if (oldStatus !== newStatus && ['active', 'join me', 'ask me', 'busy'].includes(oldStatus) && ['active', 'join me', 'ask me', 'busy'].includes(newStatus)) {
    const config = await getMonitorConfig(user.id, u.id);
    if (config && config.notify_status_change) {
      await sendFriendNotification(user, dbFriend, { oldStatus, newStatus, oldWorld: dbFriend.world_name, newWorld: dbFriend.world_name, changeType: '状态变化', oldStatusDescription: oldDesc, newStatusDescription: newDesc, oldPlatform: dbFriend.platform, newPlatform: dbFriend.platform });
    }
  } else if (oldDesc !== newDesc && newStatus !== 'offline') {
    // 自定义状态变化
    const config = await getMonitorConfig(user.id, u.id);
    if (config) {
      await sendFriendNotification(user, dbFriend, { oldStatus, newStatus, oldWorld: dbFriend.world_name, newWorld: dbFriend.world_name, changeType: '自定义状态', oldStatusDescription: oldDesc, newStatusDescription: newDesc, oldPlatform: dbFriend.platform, newPlatform: dbFriend.platform });
    }
  }
}

// friend-location 事件:世界变(3.6)
async function handleFriendLocation(user, content) {
  const session = userSessions.get(user.vrchat_user_id);
  const newWorldName = session ? await fetchWorldName(session, content.worldId, user.vrchat_user_id) : null;
  const dbFriend = await getFriendFromDB(user.id, content.userId);
  if (!dbFriend) {
    await upsertFriend(user.id, content.userId, { state: 'online', location: content.location, worldId: content.worldId, worldName: newWorldName, platform: content.platform, displayName: content.user?.displayName, status: content.user?.status, statusDescription: content.user?.statusDescription });
    return; // 首次静默
  }
  const oldWorld = dbFriend.world_name;
  await upsertFriend(user.id, content.userId, { state: 'online', location: content.location, worldId: content.worldId, worldName: newWorldName, platform: content.platform, displayName: content.user?.displayName, status: dbFriend.status, statusDescription: dbFriend.status_description });
  // 4.2 世界变化通知(status_only_mode=1 时跳过)
  if (oldWorld !== newWorldName && newWorldName && ['active', 'join me'].includes(dbFriend.status) && user.status_only_mode !== 1) {
    const config = await getMonitorConfig(user.id, content.userId);
    if (config && config.notify_world_change) {
      await sendFriendNotification(user, dbFriend, { oldStatus: dbFriend.status, newStatus: dbFriend.status, oldWorld, newWorld: newWorldName, changeType: '切换世界', oldStatusDescription: dbFriend.status_description, newStatusDescription: dbFriend.status_description, oldPlatform: dbFriend.platform, newPlatform: dbFriend.platform });
    }
  }
}

// 3.2 onMessage 回调:ws 事件 -> changeType 映射(对照 design D14)
async function handlePipelineEvent(userId, raw, parsed) {
  const { type, content } = parsed;
  if (!content) return;
  const user = await getUserByVrcId(userId);
  if (!user || user.monitor_enabled === 0) return; // 6.5 用户级监控关
  try {
    switch (type) {
      case 'friend-online':
        await applyFriendChange(user, content.userId, {
          state: 'online', status: content.user?.status, location: content.location, worldId: content.worldId,
          platform: content.platform, statusDescription: content.user?.statusDescription,
          displayName: content.user?.displayName, avatarUrl: content.user?.currentAvatarImageUrl
        });
        break;
      case 'friend-active':
        await applyFriendChange(user, content.userId, {
          state: 'active', status: content.user?.status || 'active', location: 'offline', worldId: null,
          platform: content.platform || 'web', statusDescription: content.user?.statusDescription,
          displayName: content.user?.displayName, avatarUrl: content.user?.currentAvatarImageUrl
        });
        break;
      case 'friend-offline':
        await applyFriendChange(user, content.userId, {
          state: 'offline', status: 'offline', location: 'offline', worldId: null,
          platform: content.platform, statusDescription: null
        });
        break;
      case 'friend-location':
        await handleFriendLocation(user, content);
        break;
      case 'friend-update':
        await handleFriendUpdate(user, content);
        break;
      default:
        break; // 忽略 friend-add/delete 等其他事件(可选增强)
    }
  } catch (e) {
    console.error(`[ws] handlePipelineEvent 错误 type=${type}:`, e.message);
  }
}

// 创建 pipeline 管理器(依赖注入,避免循环依赖)
const pipelineManager = createPipelineManager({
  getSession: (userId) => userSessions.get(userId),
  deleteSession: (userId) => userSessions.delete(userId),
  onGameLogin: (userId, displayName) => sendGameLoginEvent(userId, displayName),
  onMessage: handlePipelineEvent,
  userAgent: USER_AGENT,
  log: (msg) => console.log(msg)
});

// 6.6 服务启动恢复 remember_me=1 用户的 ws 监控
async function restoreAllPipelineConnections() {
  const users = await new Promise((resolve, reject) => {
    db.all('SELECT * FROM users WHERE remember_me = 1', [], (err, rows) => {
      if (err) reject(err); else resolve(rows || []);
    });
  });
  for (const user of users) {
    try {
      const cookieJar = await loadUserCookies(user.vrchat_user_id);
      if (!cookieJar) continue;
      const api = createAxiosInstance(cookieJar);
      const userRes = await api.get('/auth/user');
      if (userRes.status !== 200) continue;
      userSessions.set(user.vrchat_user_id, { cookieJar, api, createdAt: Date.now() });
      await fetchAndCacheFriends(api, user.vrchat_user_id, false, true); // 写基线
      if (user.monitor_enabled !== 0) { // 6.5
        pipelineManager.connectPipeline(user.vrchat_user_id, user.display_name);
      }
      console.log(`[ws] 恢复用户 ${user.display_name} 的 ws 监控`);
    } catch (e) {
      console.error(`[ws] 恢复用户 ${user.vrchat_user_id} 失败:`, e.message);
    }
  }
}

// 启动服务器
async function startServer() {
  // 初始化访问密钥
  const accessKey = await initAccessKey();
  const enabled = await isAccessKeyEnabled();
  
  app.listen(PORT, () => {
    console.log('================================================');
    console.log('VRC-Notifier 服务已启动');
    console.log('访问地址: http://localhost:' + PORT);
    console.log('访问密钥: ' + (enabled ? '已启用 (' + accessKey + ')' : '已禁用'));
    console.log('邮件通知: 已启用');
    console.log('监控模式: WebSocket 实时事件驱动(cron 轮询已停用)');
    console.log('API限流保护: 已启用(对账路用,ws 事件驱动不限流)');
    console.log('作者官网: https://shany.cc/');
    console.log('================================================');
  });

  // 6.6 服务启动:恢复 remember_me=1 用户的 ws 监控
  restoreAllPipelineConnections().catch(e => console.error('[ws] 恢复失败:', e.message));
}

startServer();
