// ==UserScript==
// @name         Steam 游戏库存卡片视图 + 导出工具
// @namespace     https://github.com/SmallRob/steam-card-view
// @version      1.3.0
// @description  将Steam游戏库存页面改为卡片展示，增加导出JSON和CSV功能按钮，支持搜索过滤、分页、自动加载全部游戏和成就展示
// @author       SmallRob
// @match        https://steamcommunity.com/*/games/*
// @match        https://steamcommunity.com/*/newgames/*
// @match        https://steamcommunity.com/id/*/games/*
// @match        https://steamcommunity.com/profiles/*/games/*
// @match        https://steamcommunity.com/id/*/newgames/*
// @match        https://steamcommunity.com/profiles/*/newgames/*
// @icon         https://store.steampowered.com/favicon.ico
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      api.steampowered.com
// @connect      store.steampowered.com
// @connect      shared.cdn.queniuqe.com
// @connect      shared.cloudflare.steamstatic.com
// @run-at       document-idle
// @license      MIT
// @homepageURL  https://github.com/SmallRob/steam-card-view
// @supportURL   https://github.com/SmallRob/steam-card-view/issues
// @updateURL    https://github.com/SmallRob/steam-card-view/raw/main/steam-games-card-view.user.js
// @downloadURL  https://github.com/SmallRob/steam-card-view/raw/main/steam-games-card-view.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    //  配置
    // ============================================================
    const CONFIG = {
        CARDS_PER_PAGE: 48,
        CARD_IMAGE_WIDTH: 460,
        CARD_IMAGE_HEIGHT: 215,
        LAZY_LOAD_THRESHOLD: 200,
        ANIMATION_DURATION: 300,
        AUTO_LOAD_MAX_WAIT: 60000,    // 自动加载最大等待时间(ms) - 增加到60秒
        INIT_POLL_INTERVAL: 500,
        INIT_TIMEOUT: 20000,
        ACHIEVEMENT_BATCH_SIZE: 1,    // 每批请求的游戏数量（Steam API 限制）
        ACHIEVEMENT_BATCH_DELAY: 1000, // 批次间延迟(ms)
        ACHIEVEMENT_MAX_GAMES: 500,   // 最多获取成就的游戏数量
    };

    // ============================================================
    //  全局状态
    // ============================================================
    let allGames = [];
    let filteredGames = [];
    let currentPage = 1;
    let currentSort = 'name';
    let sortAscending = true;
    let cardViewVisible = false;
    let steamId = '';
    let isAutoLoading = false;
    let autoLoadAbort = false;
    let mutationObserver = null;
    let achievementCache = {};         // appid -> { total, unlocked }
    let achievementLoading = false;
    let achievementAbort = false;

    // ============================================================
    //  数据提取
    // ============================================================

    /**
     * 从 window.SSR.renderContext 的 queryData 中提取 OwnedGames 数据
     */
    function extractGamesFromSSR() {
        try {
            const rc = window.SSR?.renderContext;
            if (!rc) return null;

            let queryData = rc.queryData;
            if (typeof queryData === 'string') {
                queryData = JSON.parse(queryData);
            }

            const queries = queryData?.queries || [];
            for (const q of queries) {
                const qk = q?.queryKey || [];
                if (qk[0] === 'OwnedGames') {
                    let data = q?.state?.data;
                    if (typeof data === 'string') {
                        data = JSON.parse(data);
                    }
                    if (Array.isArray(data)) {
                        console.log(`[Steam卡片] 从SSR数据提取到 ${data.length} 个游戏`);
                        return data;
                    }
                }
            }
        } catch (e) {
            console.warn('[Steam卡片] SSR数据提取失败:', e);
        }
        return null;
    }

    /**
     * 从 React Fiber 树中查找 QueryClient 并获取游戏数据
     */
    function extractGamesFromReactQuery() {
        try {
            const rootEl = document.querySelector('[data-react-nav-root]') ||
                           document.getElementById('CommunityTemplate');
            if (!rootEl) return null;

            const fiberKey = Object.keys(rootEl).find(k => k.startsWith('__reactFiber$'));
            if (!fiberKey) return null;

            let fiber = rootEl[fiberKey];
            let queryClient = null;
            const visited = new Set();
            const queue = [fiber];

            while (queue.length > 0 && !queryClient) {
                const current = queue.shift();
                if (!current || visited.has(current)) continue;
                visited.add(current);

                const state = current.memoizedState;
                if (state?.memoizedState?.queryClient) {
                    queryClient = state.memoizedState.queryClient;
                    break;
                }
                if (current.pendingProps?.client?.queryClient) {
                    queryClient = current.pendingProps.client.queryClient;
                    break;
                }

                if (current.child) queue.push(current.child);
                if (current.sibling) queue.push(current.sibling);
                if (current.return) queue.push(current.return);
            }

            if (queryClient) {
                const cache = queryClient.getQueryCache();
                const queries = cache.getAll();
                for (const query of queries) {
                    const key = query.queryKey;
                    if (key && key[0] === 'OwnedGames') {
                        const data = query.state?.data;
                        if (Array.isArray(data)) {
                            console.log(`[Steam卡片] 从React Query提取到 ${data.length} 个游戏`);
                            return data;
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('[Steam卡片] React Query提取失败:', e);
        }
        return null;
    }

    /**
     * 解析 Steam 时间文本为分钟数
     * 支持格式: "1,234.5 hrs on record", "123.4 hrs", "45.6 hrs / 2 weeks",
     * "0.1 hrs", "1,234 小时", "123.4h" 等
     */
    function parsePlaytimeToMinutes(text) {
        if (!text) return 0;
        text = text.trim().toLowerCase();

        // 英文格式: "1,234.5 hrs on record" / "123.4 hrs" / "0.1 hrs"
        let match = text.match(/([\d,.]+)\s*hrs?\b/);
        if (match) {
            const hours = parseFloat(match[1].replace(/,/g, ''));
            return Math.round(hours * 60);
        }

        // 中文格式: "1,234.5 小时" / "123.4小时"
        match = text.match(/([\d,.]+)\s*小时/);
        if (match) {
            const hours = parseFloat(match[1].replace(/,/g, ''));
            return Math.round(hours * 60);
        }

        // 分钟格式: "45 分钟" / "45 mins"
        match = text.match(/([\d,.]+)\s*(分钟|mins?)/);
        if (match) {
            return parseInt(match[1].replace(/,/g, ''), 10);
        }

        return 0;
    }

    /**
     * 解析最后游玩时间文本为 Unix 时间戳
     * 支持格式: "Last played 2 hours ago", "今天", "昨天", "3天前" 等
     */
    function parseLastPlayedToTimestamp(text) {
        if (!text) return 0;
        text = text.trim();
        const now = Math.floor(Date.now() / 1000);

        // 英文格式
        const lowerText = text.toLowerCase();

        // "Last played X hours/minutes/days ago" 或直接 "X hours ago"
        let match = lowerText.match(/(\d+)\s*hours?\s*ago/);
        if (match) return now - parseInt(match[1]) * 3600;

        match = lowerText.match(/(\d+)\s*mins?\s*ago/);
        if (match) return now - parseInt(match[1]) * 60;

        match = lowerText.match(/(\d+)\s*days?\s*ago/);
        if (match) return now - parseInt(match[1]) * 86400;

        match = lowerText.match(/(\d+)\s*weeks?\s*ago/);
        if (match) return now - parseInt(match[1]) * 604800;

        match = lowerText.match(/(\d+)\s*months?\s*ago/);
        if (match) return now - parseInt(match[1]) * 2592000;

        if (lowerText.includes('today') || lowerText.includes('yesterday')) {
            match = lowerText.match(/(\d+)\s*hours?\s*ago/);
            if (match) return now - parseInt(match[1]) * 3600;
            return now; // "today" -> now
        }

        // 中文格式
        if (text.includes('今天')) return now;
        if (text.includes('昨天')) return now - 86400;

        match = text.match(/(\d+)\s*小时前/);
        if (match) return now - parseInt(match[1]) * 3600;

        match = text.match(/(\d+)\s*天前/);
        if (match) return now - parseInt(match[1]) * 86400;

        match = text.match(/(\d+)\s*周前/);
        if (match) return now - parseInt(match[1]) * 604800;

        match = text.match(/(\d+)\s*月前/);
        if (match) return now - parseInt(match[1]) * 2592000;

        // 日期格式: "2024-01-15" / "Jan 15, 2024"
        const dateObj = new Date(text);
        if (!isNaN(dateObj.getTime())) {
            return Math.floor(dateObj.getTime() / 1000);
        }

        return 0;
    }

    /**
     * 从 DOM 中提取可见的游戏数据（兜底方案）
     * 修复：正确解析 playtime 和 last_played 文本
     */
    function extractGamesFromDOM() {
        const games = [];
        // 使用多种选择器匹配游戏行
        const rowSelectors = [
            '[class*="JeLbcWPaZDg"]',
            '[class*="game_list_row"]',
            '[data-appid]',
        ];

        let rows = [];
        for (const sel of rowSelectors) {
            rows = document.querySelectorAll(sel);
            if (rows.length > 0) break;
        }

        rows.forEach(row => {
            try {
                // 提取 appid
                let appid = 0;
                const appidAttr = row.getAttribute('data-appid');
                if (appidAttr) {
                    appid = parseInt(appidAttr);
                }
                if (!appid) {
                    const linkEl = row.querySelector('a[href*="/app/"]') ||
                                   row.querySelector('a[class*="_5rP-WhERE5Q"]');
                    const href = linkEl?.getAttribute('href') || '';
                    const m = href.match(/\/app\/(\d+)/);
                    if (m) appid = parseInt(m[1]);
                }

                // 提取名称
                const imgEl = row.querySelector('picture img, img[class*="game_capsule"]');
                const nameEl = row.querySelector('a[class*="Kj0mLm4b2zY"]') ||
                               row.querySelector('[class*="game_name"]') ||
                               row.querySelector('.game_list_item_name');
                const name = nameEl?.textContent?.trim() || imgEl?.getAttribute('alt') || '';

                // 提取封面图
                const headerImg = imgEl?.getAttribute('src') || '';

                // 提取商店链接
                const linkEl = row.querySelector('a[href*="/app/"]') ||
                               row.querySelector('a[class*="_5rP-WhERE5Q"]');
                const storeUrl = linkEl?.getAttribute('href') || '';

                // 提取游玩时间 - 尝试多种选择器
                const playtimeEl = row.querySelector('[class*="ANL1vYNAS6E"]') ||
                                   row.querySelector('[class*="playtime"]') ||
                                   row.querySelector('.game_list_playtime');
                const playtimeText = playtimeEl?.textContent?.trim() || '';

                // 提取最后游玩时间
                const lastPlayedEl = row.querySelector('[class*="_09Z65-SltXY"]') ||
                                     row.querySelector('[class*="last_played"]') ||
                                     row.querySelector('.game_list_last_played');
                const lastPlayedText = lastPlayedEl?.textContent?.trim() || '';

                if (appid && name) {
                    games.push({
                        appid,
                        name,
                        header_img: headerImg,
                        store_url: storeUrl,
                        playtime_forever: parsePlaytimeToMinutes(playtimeText),
                        rtime_last_played: parseLastPlayedToTimestamp(lastPlayedText),
                        playtime_2weeks: 0,
                        has_dlc: false,
                        has_workshop: false,
                        has_market: false,
                        has_community_visible_stats: false,
                        has_leaderboards: false,
                        img_icon_url: '',
                        capsule_filename: 'header.jpg',
                    });
                }
            } catch (e) {
                console.warn('[Steam卡片] DOM行提取失败:', e);
            }
        });
        return games;
    }

    /**
     * 自动滚动加载 Steam 虚拟滚动列表中的所有游戏
     * 修复：使用 window.scrollTo + 轮询检测替代 Intersection Observer
     *       因为 Steam 的虚拟滚动容器不是 window，Intersection Observer 无法正确工作
     */
    function autoLoadAllGamesFromDOM() {
        return new Promise((resolve) => {
            if (isAutoLoading) {
                resolve(false);
                return;
            }

            isAutoLoading = true;
            autoLoadAbort = false;

            console.log('[Steam卡片] 开始自动加载全部游戏...');

            let lastCount = document.querySelectorAll('[class*="JeLbcWPaZDg"], [class*="game_list_row"], [data-appid]').length;
            let stableCount = 0;
            const maxStable = 5;
            let scrollAttempts = 0;
            const maxScrollAttempts = Math.ceil(CONFIG.AUTO_LOAD_MAX_WAIT / 500);

            const scrollStep = () => {
                if (autoLoadAbort) {
                    isAutoLoading = false;
                    resolve(false);
                    return;
                }

                scrollAttempts++;

                // 滚动到底部
                window.scrollTo(0, document.body.scrollHeight);

                // 检查游戏数量
                const currentCount = document.querySelectorAll(
                    '[class*="JeLbcWPaZDg"], [class*="game_list_row"], [data-appid]'
                ).length;

                if (currentCount > lastCount) {
                    console.log(`[Steam卡片] 已加载 ${currentCount} 个游戏 (新增 ${currentCount - lastCount})`);
                    lastCount = currentCount;
                    stableCount = 0;
                    updateLoadingProgress(`已加载 ${currentCount} 个游戏...`);
                } else {
                    stableCount++;
                }

                if (stableCount >= maxStable || scrollAttempts >= maxScrollAttempts) {
                    console.log(`[Steam卡片] 自动加载完成，共 ${lastCount} 个游戏`);
                    isAutoLoading = false;
                    resolve(true);
                    return;
                }

                setTimeout(scrollStep, 500);
            };

            // 开始滚动
            scrollStep();
        });
    }

    /**
     * 主数据提取入口
     */
    async function extractAllGames() {
        // 方式1: SSR renderContext
        let games = extractGamesFromSSR();
        if (games && games.length > 0) {
            return enrichGameData(games);
        }

        // 方式2: React Query 缓存
        games = extractGamesFromReactQuery();
        if (games && games.length > 0) {
            return enrichGameData(games);
        }

        // 方式3: 自动滚动加载 + DOM 提取
        console.log('[Steam卡片] SSR和React Query均未获取到数据，尝试自动滚动加载...');
        showLoadingOverlay();
        updateLoadingProgress('正在滚动加载游戏列表...');

        await autoLoadAllGamesFromDOM();
        removeLoadingOverlay();

        games = extractGamesFromDOM();
        if (games.length > 0) {
            console.log(`[Steam卡片] 自动加载后从DOM提取到 ${games.length} 个游戏`);
            return games;
        }

        // 方式4: 直接 DOM 提取
        games = extractGamesFromDOM();
        console.log(`[Steam卡片] 从DOM提取到 ${games.length} 个游戏（可能不完整）`);
        return games;
    }

    /**
     * 丰富游戏数据
     */
    function enrichGameData(games) {
        const cdnBase = 'https://shared.cdn.queniuqe.com/store_item_assets/steam/apps/';

        return games.map(g => {
            const appid = g.appid;
            const capsuleFile = g.capsule_filename || 'header.jpg';
            const isLibraryCapsule = capsuleFile.startsWith('library_600x900');

            return {
                appid,
                name: g.name || `App ${appid}`,
                playtime_forever: g.playtime_forever || 0,
                playtime_2weeks: g.playtime_2weeks || 0,
                playtime_disconnected: g.playtime_disconnected || 0,
                rtime_last_played: g.rtime_last_played || 0,
                has_dlc: g.has_dlc || false,
                has_workshop: g.has_workshop || false,
                has_market: g.has_market || false,
                has_community_visible_stats: g.has_community_visible_stats || false,
                has_leaderboards: g.has_leaderboards || false,
                img_icon_url: g.img_icon_url || '',
                capsule_filename: capsuleFile,
                header_img: g.header_img || `${cdnBase}${appid}/header.jpg`,
                library_capsule_img: isLibraryCapsule
                    ? `${cdnBase}${appid}/${capsuleFile}`
                    : `${cdnBase}${appid}/library_600x900.jpg`,
                store_url: g.store_url || `https://store.steampowered.com/app/${appid}`,
                icon_img: g.img_icon_url
                    ? `${cdnBase}${appid}/${g.img_icon_url}.jpg`
                    : '',
                playtime_hours: ((g.playtime_forever || 0) / 60).toFixed(1),
                playtime_2weeks_hours: ((g.playtime_2weeks || 0) / 60).toFixed(1),
                last_played_date: g.rtime_last_played
                    ? formatDate(g.rtime_last_played)
                    : '从未',
                // 成就数据（后续异步填充）
                achievement_total: 0,
                achievement_unlocked: 0,
            };
        });
    }

    // ============================================================
    //  成就数据获取
    // ============================================================

    /**
     * 通过 Steam Web API 获取用户游戏成就统计
     * API: https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/
     * 返回的数据中包含 playtime_forever, rtime_last_played 等字段
     * 但成就需要单独调用: GetPlayerAchievements (需要每个游戏单独请求)
     *
     * 使用 GetAchievementsForGame (全局统计) 来获取成就总数
     * 然后用 GetGlobalAchievementPercentagesForApp 获取百分比
     *
     * 简化方案：使用 ISteamUserStats/GetPlayerAchievements 逐个获取
     */
    async function fetchAchievementsForGame(appid) {
        return new Promise((resolve) => {
            if (!steamId || steamId === 'unknown') {
                resolve(null);
                return;
            }

            const url = `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/?appid=${appid}&key=${encodeURIComponent('anonymous')}&steamid=${steamId}`;

            try {
                if (typeof GM_xmlhttpRequest === 'function') {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: url,
                        timeout: 10000,
                        onload: function (response) {
                            try {
                                const data = JSON.parse(response.responseText);
                                if (data.playerstats && data.playerstats.success) {
                                    const achievements = data.playerstats.achievements || [];
                                    const total = achievements.length;
                                    const unlocked = achievements.filter(a => a.achieved === 1).length;
                                    resolve({ total, unlocked });
                                } else {
                                    // 游戏可能没有成就或隐私设置
                                    resolve({ total: 0, unlocked: 0 });
                                }
                            } catch (e) {
                                resolve(null);
                            }
                        },
                        onerror: function () {
                            resolve(null);
                        },
                        ontimeout: function () {
                            resolve(null);
                        },
                    });
                } else {
                    // 回退：使用 fetch
                    fetch(url)
                        .then(r => r.json())
                        .then(data => {
                            if (data.playerstats && data.playerstats.success) {
                                const achievements = data.playerstats.achievements || [];
                                resolve({
                                    total: achievements.length,
                                    unlocked: achievements.filter(a => a.achieved === 1).length,
                                });
                            } else {
                                resolve({ total: 0, unlocked: 0 });
                            }
                        })
                        .catch(() => resolve(null));
                }
            } catch (e) {
                resolve(null);
            }
        });
    }

    /**
     * 批量获取所有游戏的成就数据
     */
    async function fetchAllAchievements() {
        if (achievementLoading) return;
        achievementLoading = true;
        achievementAbort = false;

        const gamesToFetch = allGames
            .filter(g => (g.playtime_forever || 0) > 0) // 只获取有游玩记录的游戏
            .slice(0, CONFIG.ACHIEVEMENT_MAX_GAMES);

        console.log(`[Steam卡片] 开始获取 ${gamesToFetch.length} 个游戏的成就数据...`);
        showLoadingOverlay();
        updateLoadingProgress(`准备获取成就数据 (0/${gamesToFetch.length})...`);

        for (let i = 0; i < gamesToFetch.length; i++) {
            if (achievementAbort) {
                console.log(`[Steam卡片] 成就获取已中止 (${i}/${gamesToFetch.length})`);
                break;
            }

            const game = gamesToFetch[i];
            updateLoadingProgress(`获取成就数据 (${i + 1}/${gamesToFetch.length}): ${game.name}`);

            const result = await fetchAchievementsForGame(game.appid);
            if (result) {
                achievementCache[game.appid] = result;
                // 更新 allGames 中的数据
                const idx = allGames.findIndex(g => g.appid === game.appid);
                if (idx !== -1) {
                    allGames[idx].achievement_total = result.total;
                    allGames[idx].achievement_unlocked = result.unlocked;
                }
            }

            // 批次间延迟，避免触发 Steam API 限流
            if (i < gamesToFetch.length - 1) {
                await new Promise(r => setTimeout(r, CONFIG.ACHIEVEMENT_BATCH_DELAY));
            }
        }

        // 同步到 filteredGames
        filteredGames = [...allGames];

        removeLoadingOverlay();
        achievementLoading = false;

        const totalFetched = Object.keys(achievementCache).length;
        console.log(`[Steam卡片] 成就数据获取完成，共获取 ${totalFetched} 个游戏的成就`);

        // 重新渲染卡片视图
        renderCardView();
        showToast(`成就数据获取完成 (${totalFetched} 个游戏)`, 'success');
    }

    // ============================================================
    //  工具函数
    // ============================================================

    function formatDate(timestamp) {
        if (!timestamp) return '从未';
        const now = new Date();
        const date = new Date(timestamp * 1000);
        const diffMs = now - date;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays === 0) return '今天';
        if (diffDays === 1) return '昨天';
        if (diffDays < 7) return `${diffDays}天前`;
        if (diffDays < 30) return `${Math.floor(diffDays / 7)}周前`;
        if (diffDays < 365) return `${Math.floor(diffDays / 30)}月前`;

        const y = date.getFullYear();
        const m = date.getMonth() + 1;
        const d = date.getDate();
        return `${y}-${m < 10 ? '0' + m : m}-${d < 10 ? '0' + d : d}`;
    }

    function formatPlaytime(minutes) {
        if (!minutes || minutes === 0) return '未游玩';
        const hours = minutes / 60;
        if (hours < 1) return `${minutes}分钟`;
        if (hours < 100) return `${hours.toFixed(1)}小时`;
        return `${Math.floor(hours).toLocaleString()}小时`;
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;')
                  .replace(/'/g, '&#039;');
    }

    function showToast(message, type = 'info') {
        document.querySelectorAll('.scv-toast').forEach(t => t.remove());
        const toast = document.createElement('div');
        toast.className = `scv-toast ${type === 'success' ? 'scv-toast--success' : ''}`;
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 2500);
    }

    // ============================================================
    //  样式注入
    // ============================================================

    function injectStyles() {
        GM_addStyle(`
            /* ====== 卡片视图容器 ====== */
            .scv-root {
                --scv-bg-primary: #1b2838;
                --scv-bg-secondary: #2a475e;
                --scv-bg-card: #16202d;
                --scv-bg-card-hover: #1c3148;
                --scv-text-primary: #c7d5e0;
                --scv-text-secondary: #8f98a0;
                --scv-text-highlight: #66c0f4;
                --scv-accent: #66c0f4;
                --scv-accent-hover: #88d5ff;
                --scv-border: rgba(255,255,255,0.08);
                --scv-shadow: 0 2px 8px rgba(0,0,0,0.4);
                --scv-shadow-hover: 0 6px 20px rgba(0,0,0,0.6);
                --scv-radius: 8px;
                --scv-transition: 0.25s cubic-bezier(0.4, 0, 0.2, 1);

                font-family: "Motiva Sans", Arial, Helvetica, sans-serif;
                color: var(--scv-text-primary);
                padding: 0 16px;
                max-width: 1400px;
                margin: 0 auto;
            }

            /* ====== 工具栏 ====== */
            .scv-toolbar {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: 10px;
                padding: 16px 0;
                border-bottom: 1px solid var(--scv-border);
                margin-bottom: 16px;
            }
            .scv-toolbar-left {
                display: flex;
                align-items: center;
                gap: 10px;
                flex: 1;
                min-width: 300px;
            }
            .scv-toolbar-right {
                display: flex;
                align-items: center;
                gap: 8px;
                flex-shrink: 0;
            }

            /* 搜索框 */
            .scv-search { position: relative; flex: 1; max-width: 360px; }
            .scv-search input {
                width: 100%; padding: 8px 12px 8px 36px;
                border: 1px solid var(--scv-border); border-radius: var(--scv-radius);
                background: var(--scv-bg-primary); color: var(--scv-text-primary);
                font-size: 14px; outline: none; transition: border-color var(--scv-transition);
                box-sizing: border-box;
            }
            .scv-search input:focus { border-color: var(--scv-accent); }
            .scv-search input::placeholder { color: var(--scv-text-secondary); }
            .scv-search-icon {
                position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
                color: var(--scv-text-secondary); pointer-events: none;
            }

            /* 排序下拉 */
            .scv-sort select {
                padding: 8px 28px 8px 12px; border: 1px solid var(--scv-border);
                border-radius: var(--scv-radius); background: var(--scv-bg-primary);
                color: var(--scv-text-primary); font-size: 14px; cursor: pointer;
                outline: none; appearance: none; -webkit-appearance: none;
                background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%238f98a0' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
                background-repeat: no-repeat; background-position: right 8px center;
            }
            .scv-sort select:focus { border-color: var(--scv-accent); }

            /* 按钮 */
            .scv-btn {
                display: inline-flex; align-items: center; gap: 6px;
                padding: 8px 16px; border: 1px solid var(--scv-border);
                border-radius: var(--scv-radius); background: var(--scv-bg-secondary);
                color: var(--scv-text-primary); font-size: 13px; cursor: pointer;
                transition: all var(--scv-transition); white-space: nowrap;
                user-select: none; text-decoration: none; line-height: 1.4;
            }
            .scv-btn:hover { background: var(--scv-bg-card-hover); border-color: var(--scv-accent); color: var(--scv-accent); }
            .scv-btn:active { transform: scale(0.97); }
            .scv-btn--accent { background: linear-gradient(135deg, #66c0f4 0%, #4a90d9 100%); color: #fff; border: none; font-weight: 600; }
            .scv-btn--accent:hover { background: linear-gradient(135deg, #88d5ff 0%, #66c0f4 100%); color: #fff; }
            .scv-btn--success { background: linear-gradient(135deg, #5c7e10 0%, #4a6b0d 100%); color: #d2efa0; border: 1px solid #6b8a1a; }
            .scv-btn--success:hover { background: linear-gradient(135deg, #6b8a1a 0%, #5c7e10 100%); color: #e5ff8a; }
            .scv-btn--csv { background: linear-gradient(135deg, #8b5e3c 0%, #6b4423 100%); color: #f0d9b5; border: 1px solid #a0724d; }
            .scv-btn--csv:hover { background: linear-gradient(135deg, #a0724d 0%, #8b5e3c 100%); color: #ffe0b2; }
            .scv-btn--achievement { background: linear-gradient(135deg, #c7a02e 0%, #a68520 100%); color: #fff5cc; border: 1px solid #d4b44a; }
            .scv-btn--achievement:hover { background: linear-gradient(135deg, #d4b44a 0%, #c7a02e 100%); color: #fffde0; }
            .scv-btn--reload { background: linear-gradient(135deg, #4a6b8a 0%, #3a5570 100%); color: #b8d4e8; border: 1px solid #5a7b9a; }
            .scv-btn--reload:hover { background: linear-gradient(135deg, #5a7b9a 0%, #4a6b8a 100%); color: #d0e8f8; }

            /* 统计信息 */
            .scv-stats { display: flex; align-items: center; gap: 16px; padding: 8px 0 16px; font-size: 13px; color: var(--scv-text-secondary); flex-wrap: wrap; }
            .scv-stats span { display: inline-flex; align-items: center; gap: 4px; }
            .scv-stats-num { color: var(--scv-accent); font-weight: 600; }

            /* ====== 加载状态 ====== */
            .scv-loading-overlay {
                position: fixed; top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0, 0, 0, 0.7); backdrop-filter: blur(4px);
                display: flex; flex-direction: column; align-items: center; justify-content: center;
                z-index: 100000; gap: 16px;
            }
            .scv-loading-spinner {
                width: 48px; height: 48px;
                border: 4px solid rgba(102, 192, 244, 0.2); border-top-color: #66c0f4;
                border-radius: 50%; animation: scv-spin 0.8s linear infinite;
            }
            @keyframes scv-spin { to { transform: rotate(360deg); } }
            .scv-loading-text { color: #c7d5e0; font-size: 16px; font-family: "Motiva Sans", Arial, Helvetica, sans-serif; }
            .scv-loading-progress { color: #66c0f4; font-size: 14px; font-family: "Motiva Sans", Arial, Helvetica, sans-serif; }
            .scv-loading-cancel {
                margin-top: 8px; padding: 8px 24px; border: 1px solid rgba(255,255,255,0.2);
                border-radius: 6px; background: rgba(255,255,255,0.1); color: #c7d5e0;
                font-size: 14px; cursor: pointer; transition: all 0.2s;
                font-family: "Motiva Sans", Arial, Helvetica, sans-serif;
            }
            .scv-loading-cancel:hover { background: rgba(255,255,255,0.2); border-color: rgba(255,255,255,0.4); }

            /* ====== 卡片网格 ====== */
            .scv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; padding-bottom: 24px; }

            /* ====== 卡片 ====== */
            .scv-card {
                background: var(--scv-bg-card); border-radius: var(--scv-radius);
                overflow: hidden; border: 1px solid var(--scv-border);
                transition: all var(--scv-transition); cursor: pointer;
                position: relative; display: flex; flex-direction: column;
            }
            .scv-card:hover { transform: translateY(-4px); box-shadow: var(--scv-shadow-hover); border-color: rgba(102, 192, 244, 0.3); }

            .scv-card-img-wrap {
                position: relative; width: 100%; padding-top: 46.7%;
                overflow: hidden; background: #0e1a27;
            }
            .scv-card-img-wrap img {
                position: absolute; top: 0; left: 0; width: 100%; height: 100%;
                object-fit: cover; transition: transform 0.4s ease;
            }
            .scv-card:hover .scv-card-img-wrap img { transform: scale(1.05); }

            /* 游戏时间标签 */
            .scv-card-playtime-badge {
                position: absolute; top: 8px; right: 8px;
                background: rgba(0, 0, 0, 0.75); backdrop-filter: blur(4px);
                color: #a4d007; padding: 3px 8px; border-radius: 4px;
                font-size: 12px; font-weight: 600; line-height: 1.3; pointer-events: none;
            }

            /* 成就标签 */
            .scv-card-achievement-badge {
                position: absolute; top: 8px; left: 8px;
                background: rgba(0, 0, 0, 0.75); backdrop-filter: blur(4px);
                color: #c7a02e; padding: 3px 8px; border-radius: 4px;
                font-size: 11px; font-weight: 600; line-height: 1.3; pointer-events: none;
                display: flex; align-items: center; gap: 4px;
            }
            .scv-card-achievement-badge svg { width: 12px; height: 12px; fill: #c7a02e; flex-shrink: 0; }

            /* 功能标签 */
            .scv-card-features { position: absolute; bottom: 8px; left: 8px; display: flex; gap: 4px; }
            .scv-card-feature-tag {
                background: rgba(0, 0, 0, 0.65); backdrop-filter: blur(4px);
                color: var(--scv-text-secondary); padding: 2px 6px; border-radius: 3px;
                font-size: 10px; font-weight: 500;
            }

            /* 卡片信息区 */
            .scv-card-info { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
            .scv-card-name {
                font-size: 14px; font-weight: 600; color: var(--scv-text-primary);
                line-height: 1.3; overflow: hidden; text-overflow: ellipsis;
                white-space: nowrap; transition: color var(--scv-transition);
            }
            .scv-card:hover .scv-card-name { color: var(--scv-text-highlight); }
            .scv-card-meta { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--scv-text-secondary); }
            .scv-card-lastplayed { font-size: 11px; }

            /* 成就进度条 */
            .scv-card-achievement-bar {
                height: 4px; border-radius: 2px; background: rgba(199, 160, 46, 0.15);
                overflow: hidden; margin-top: auto;
            }
            .scv-card-achievement-bar-fill {
                height: 100%; border-radius: 2px;
                background: linear-gradient(90deg, #c7a02e, #e8c84a);
                transition: width 0.6s ease;
            }

            /* 游戏时间进度条 */
            .scv-card-bar { height: 3px; border-radius: 2px; background: rgba(255,255,255,0.06); overflow: hidden; margin-top: auto; }
            .scv-card-bar-fill { height: 100%; border-radius: 2px; background: linear-gradient(90deg, #66c0f4, #a4d007); transition: width 0.6s ease; }

            /* ====== 分页 ====== */
            .scv-pagination { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 20px 0 40px; flex-wrap: wrap; }
            .scv-page-btn {
                min-width: 36px; height: 36px; display: inline-flex; align-items: center; justify-content: center;
                border: 1px solid var(--scv-border); border-radius: var(--scv-radius);
                background: var(--scv-bg-card); color: var(--scv-text-primary);
                font-size: 13px; cursor: pointer; transition: all var(--scv-transition); padding: 0 8px;
            }
            .scv-page-btn:hover { border-color: var(--scv-accent); color: var(--scv-accent); background: var(--scv-bg-card-hover); }
            .scv-page-btn.active { background: var(--scv-accent); color: #fff; border-color: var(--scv-accent); font-weight: 600; }
            .scv-page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
            .scv-page-info { color: var(--scv-text-secondary); font-size: 13px; padding: 0 12px; }

            /* ====== 空状态 ====== */
            .scv-empty { text-align: center; padding: 60px 20px; color: var(--scv-text-secondary); }
            .scv-empty-icon { font-size: 48px; margin-bottom: 16px; opacity: 0.4; }
            .scv-empty-text { font-size: 16px; margin-bottom: 8px; }

            /* ====== 切换按钮 ====== */
            .scv-toggle-wrap { position: relative; }
            .scv-toggle-btn {
                display: inline-flex; align-items: center; gap: 6px;
                padding: 8px 16px; border-radius: var(--scv-radius);
                background: linear-gradient(135deg, #66c0f4 0%, #4a90d9 100%);
                color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
                border: none; transition: all var(--scv-transition); white-space: nowrap;
            }
            .scv-toggle-btn:hover { background: linear-gradient(135deg, #88d5ff 0%, #66c0f4 100%); transform: translateY(-1px); box-shadow: 0 2px 8px rgba(102,192,244,0.4); }
            .scv-toggle-btn:active { transform: scale(0.97); }
            .scv-toggle-btn svg { width: 16px; height: 16px; fill: currentColor; }

            /* ====== Toast ====== */
            .scv-toast {
                position: fixed; bottom: 24px; right: 24px;
                background: var(--scv-bg-secondary); color: var(--scv-text-primary);
                padding: 12px 20px; border-radius: var(--scv-radius);
                border: 1px solid var(--scv-accent); box-shadow: 0 4px 16px rgba(0,0,0,0.5);
                font-size: 14px; z-index: 99999; animation: scv-toast-in 0.3s ease; transition: opacity 0.3s ease;
            }
            .scv-toast--success { border-color: #5c7e10; }
            @keyframes scv-toast-in { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

            .scv-card-enter { animation: scv-card-fade-in 0.35s ease both; }
            @keyframes scv-card-fade-in { from { opacity: 0; transform: translateY(16px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }

            @media (max-width: 768px) {
                .scv-grid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
                .scv-toolbar { gap: 8px; }
                .scv-search { max-width: 100%; }
            }
            @media (max-width: 480px) {
                .scv-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
            }

            .scv-root::-webkit-scrollbar { width: 8px; }
            .scv-root::-webkit-scrollbar-track { background: var(--scv-bg-primary); }
            .scv-root::-webkit-scrollbar-thumb { background: var(--scv-bg-secondary); border-radius: 4px; }
            .scv-root::-webkit-scrollbar-thumb:hover { background: var(--scv-accent); }
        `);
    }

    // ============================================================
    //  UI 构建
    // ============================================================

    function showLoadingOverlay() {
        removeLoadingOverlay();
        const overlay = document.createElement('div');
        overlay.className = 'scv-loading-overlay';
        overlay.id = 'scv-loading-overlay';
        overlay.innerHTML = `
            <div class="scv-loading-spinner"></div>
            <div class="scv-loading-text">正在加载...</div>
            <div class="scv-loading-progress" id="scv-loading-progress">准备中</div>
            <button class="scv-loading-cancel" id="scv-loading-cancel">跳过</button>
        `;
        document.body.appendChild(overlay);
        document.getElementById('scv-loading-cancel')?.addEventListener('click', () => {
            autoLoadAbort = true;
            achievementAbort = true;
            removeLoadingOverlay();
        });
    }

    function updateLoadingProgress(text) {
        const el = document.getElementById('scv-loading-progress');
        if (el) el.textContent = text;
    }

    function removeLoadingOverlay() {
        document.getElementById('scv-loading-overlay')?.remove();
    }

    function createToggleButton() {
        const possibleContainers = [
            document.querySelector('[class*="JUXi4iWNsDo"]'),
            document.querySelector('[class*="w5g2mwuyMg4"]')?.parentElement,
            document.querySelector('[class*="BLeJPOr7KIk"]')?.parentElement,
            document.querySelector('.profile_small_header_text'),
            document.querySelector('[class*="gameslisttabs"]'),
        ].filter(Boolean);

        for (const container of possibleContainers) {
            if (container) {
                const wrap = document.createElement('div');
                wrap.className = 'scv-toggle-wrap';
                wrap.style.display = 'inline-flex';
                wrap.style.alignItems = 'center';
                wrap.style.marginLeft = '12px';
                wrap.style.verticalAlign = 'middle';
                wrap.innerHTML = `<button class="scv-toggle-btn" id="scv-toggle" title="切换卡片视图">
                    <svg viewBox="0 0 16 16"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>
                    <span>卡片视图</span>
                </button>`;
                container.appendChild(wrap);
                return;
            }
        }

        const wrap = document.createElement('div');
        wrap.className = 'scv-toggle-wrap';
        wrap.style.cssText = 'position:fixed;top:80px;right:20px;z-index:9999;';
        wrap.innerHTML = `<button class="scv-toggle-btn" id="scv-toggle" title="切换卡片视图">
            <svg viewBox="0 0 16 16"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>
            <span>卡片视图</span>
        </button>`;
        document.body.appendChild(wrap);
    }

    function createMainContainer() {
        const possibleContainers = [
            document.querySelector('[class*="FbG-gxCxUQw"]'),
            document.querySelector('[class*="ISUc4nhzLMI"]')?.parentElement,
            document.querySelector('[class*="game_list_container"]'),
        ].filter(Boolean);

        const container = document.createElement('div');
        container.className = 'scv-root';
        container.id = 'scv-root';
        container.style.display = 'none';

        const target = possibleContainers[0];
        if (target?.parentElement) {
            target.parentElement.insertBefore(container, target.nextSibling);
        } else {
            document.body.appendChild(container);
        }

        return container;
    }

    function renderCardView() {
        const container = document.getElementById('scv-root');
        if (!container) return;
        container.innerHTML = '';
        container.appendChild(createToolbar());
        container.appendChild(createStats());
        const gridWrap = document.createElement('div');
        gridWrap.id = 'scv-grid-wrap';
        container.appendChild(gridWrap);
        renderGrid();
        container.appendChild(createPagination());
    }

    function createToolbar() {
        const toolbar = document.createElement('div');
        toolbar.className = 'scv-toolbar';
        toolbar.innerHTML = `
            <div class="scv-toolbar-left">
                <div class="scv-search">
                    <svg class="scv-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
                    </svg>
                    <input type="text" id="scv-search-input" placeholder="搜索游戏名称..." />
                </div>
                <div class="scv-sort">
                    <select id="scv-sort-select">
                        <option value="name">按名称</option>
                        <option value="playtime_desc">按游玩时间 ↓</option>
                        <option value="playtime_asc">按游玩时间 ↑</option>
                        <option value="lastplayed_desc">按最后运行 ↓</option>
                        <option value="lastplayed_asc">按最后运行 ↑</option>
                        <option value="achievement_desc">按成就完成 ↓</option>
                        <option value="achievement_asc">按成就完成 ↑</option>
                        <option value="appid">按 AppID</option>
                    </select>
                </div>
            </div>
            <div class="scv-toolbar-right">
                <button class="scv-btn scv-btn--achievement" id="scv-fetch-achievements" title="获取所有游戏的成就数据（需要Steam个人资料公开）">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 15l-2 5l9-11h-5l2-5L7 15z"/></svg>
                    获取成就
                </button>
                <button class="scv-btn scv-btn--reload" id="scv-reload-games" title="重新加载游戏数据（滚动加载全部）">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                    重新加载
                </button>
                <button class="scv-btn scv-btn--success" id="scv-export-json" title="导出JSON">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 18 15 15"/></svg>
                    导出 JSON
                </button>
                <button class="scv-btn scv-btn--csv" id="scv-export-csv" title="导出CSV">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
                    导出 CSV
                </button>
                <button class="scv-btn" id="scv-back-list" title="返回列表视图">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
                    返回列表
                </button>
            </div>
        `;
        return toolbar;
    }

    function createStats() {
        const stats = document.createElement('div');
        stats.className = 'scv-stats';
        stats.id = 'scv-stats';

        const totalGames = filteredGames.length;
        const totalPlaytime = filteredGames.reduce((s, g) => s + (g.playtime_forever || 0), 0);
        const playedGames = filteredGames.filter(g => (g.playtime_forever || 0) > 0).length;
        const neverPlayed = totalGames - playedGames;
        const gamesWithAchievements = filteredGames.filter(g => (g.achievement_total || 0) > 0).length;
        const totalUnlocked = filteredGames.reduce((s, g) => s + (g.achievement_unlocked || 0), 0);
        const totalAchievements = filteredGames.reduce((s, g) => s + (g.achievement_total || 0), 0);

        let achievementHtml = '';
        if (totalAchievements > 0) {
            const pct = totalAchievements > 0 ? ((totalUnlocked / totalAchievements) * 100).toFixed(1) : 0;
            achievementHtml = `<span>成就 <span class="scv-stats-num">${totalUnlocked}/${totalAchievements}</span> (${pct}%)</span>`;
        }

        stats.innerHTML = `
            <span>共 <span class="scv-stats-num">${totalGames.toLocaleString()}</span> 款游戏</span>
            <span>已游玩 <span class="scv-stats-num">${playedGames.toLocaleString()}</span> 款</span>
            <span>未游玩 <span class="scv-stats-num">${neverPlayed.toLocaleString()}</span> 款</span>
            <span>总时长 <span class="scv-stats-num">${formatPlaytime(totalPlaytime)}</span></span>
            ${achievementHtml}
        `;
        return stats;
    }

    function renderGrid() {
        const gridWrap = document.getElementById('scv-grid-wrap');
        if (!gridWrap) return;

        const start = (currentPage - 1) * CONFIG.CARDS_PER_PAGE;
        const end = start + CONFIG.CARDS_PER_PAGE;
        const pageGames = filteredGames.slice(start, end);

        if (pageGames.length === 0) {
            gridWrap.innerHTML = `
                <div class="scv-empty">
                    <div class="scv-empty-icon">&#128269;</div>
                    <div class="scv-empty-text">未找到匹配的游戏</div>
                    <div>请尝试其他搜索关键词</div>
                </div>
            `;
            return;
        }

        const maxPlaytime = Math.max(...filteredGames.map(g => g.playtime_forever || 0), 1);

        const grid = document.createElement('div');
        grid.className = 'scv-grid';

        pageGames.forEach((game, index) => {
            const card = createCard(game, maxPlaytime, index);
            grid.appendChild(card);
        });

        gridWrap.innerHTML = '';
        gridWrap.appendChild(grid);
        updateStats();
    }

    function createCard(game, maxPlaytime, index) {
        const card = document.createElement('div');
        card.className = 'scv-card scv-card-enter';
        card.style.animationDelay = `${Math.min(index * 30, 600)}ms`;

        const playtimePercent = maxPlaytime > 0
            ? Math.min(((game.playtime_forever || 0) / maxPlaytime) * 100, 100)
            : 0;

        // 功能标签
        let featureTags = '';
        if (game.has_dlc) featureTags += '<span class="scv-card-feature-tag">DLC</span>';
        if (game.has_workshop) featureTags += '<span class="scv-card-feature-tag">工坊</span>';
        if (game.has_market) featureTags += '<span class="scv-card-feature-tag">市场</span>';

        // 成就标签
        let achievementBadge = '';
        let achievementBar = '';
        const achTotal = game.achievement_total || 0;
        const achUnlocked = game.achievement_unlocked || 0;
        if (achTotal > 0) {
            const achPct = ((achUnlocked / achTotal) * 100).toFixed(0);
            achievementBadge = `<div class="scv-card-achievement-badge" title="${achUnlocked}/${achTotal} 成就">
                <svg viewBox="0 0 24 24"><path d="M12 15l-2 5l9-11h-5l2-5L7 15z"/></svg>
                ${achUnlocked}/${achTotal}
            </div>`;
            achievementBar = `<div class="scv-card-achievement-bar">
                <div class="scv-card-achievement-bar-fill" style="width: ${achPct}%"></div>
            </div>`;
        }

        // 进度条：有成就用成就条，否则用游玩时间条
        const barHtml = achievementBar || `<div class="scv-card-bar"><div class="scv-card-bar-fill" style="width: ${playtimePercent.toFixed(1)}%"></div></div>`;

        card.innerHTML = `
            <div class="scv-card-img-wrap">
                <img src="${game.header_img}" alt="${escapeHtml(game.name)}" loading="lazy"
                     onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22460%22 height=%22215%22><rect fill=%22%231b2838%22 width=%22460%22 height=%22215%22/><text fill=%22%23555%22 font-size=%2216%22 x=%22230%22 y=%22110%22 text-anchor=%22middle%22>No Image</text></svg>'" />
                ${game.playtime_forever > 0 ? `<div class="scv-card-playtime-badge">${formatPlaytime(game.playtime_forever)}</div>` : ''}
                ${achievementBadge}
                ${featureTags ? `<div class="scv-card-features">${featureTags}</div>` : ''}
            </div>
            <div class="scv-card-info">
                <div class="scv-card-name" title="${escapeHtml(game.name)}">${escapeHtml(game.name)}</div>
                <div class="scv-card-meta">
                    <span class="scv-card-lastplayed">${game.last_played_date}</span>
                    <span>AppID: ${game.appid}</span>
                </div>
                ${barHtml}
            </div>
        `;

        card.addEventListener('click', (e) => {
            if (e.target.closest('a')) return;
            window.open(game.store_url, '_blank');
        });

        return card;
    }

    function createPagination() {
        const pagination = document.createElement('div');
        pagination.className = 'scv-pagination';
        pagination.id = 'scv-pagination';
        renderPaginationContent(pagination);
        return pagination;
    }

    function renderPaginationContent(container) {
        if (!container) container = document.getElementById('scv-pagination');
        if (!container) return;

        const totalPages = Math.ceil(filteredGames.length / CONFIG.CARDS_PER_PAGE);
        if (totalPages <= 1) { container.innerHTML = ''; return; }

        let html = '';
        html += `<button class="scv-page-btn" data-page="prev" ${currentPage <= 1 ? 'disabled' : ''}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>`;

        const range = getPageRange(currentPage, totalPages, 5);
        if (range[0] > 1) {
            html += `<button class="scv-page-btn" data-page="1">1</button>`;
            if (range[0] > 2) html += `<span class="scv-page-info">...</span>`;
        }
        for (const p of range) {
            html += `<button class="scv-page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
        }
        if (range[range.length - 1] < totalPages) {
            if (range[range.length - 1] < totalPages - 1) html += `<span class="scv-page-info">...</span>`;
            html += `<button class="scv-page-btn" data-page="${totalPages}">${totalPages}</button>`;
        }

        html += `<button class="scv-page-btn" data-page="next" ${currentPage >= totalPages ? 'disabled' : ''}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
        </button>`;

        const start = (currentPage - 1) * CONFIG.CARDS_PER_PAGE + 1;
        const end = Math.min(currentPage * CONFIG.CARDS_PER_PAGE, filteredGames.length);
        html += `<span class="scv-page-info">${start}-${end} / ${filteredGames.length}</span>`;
        container.innerHTML = html;
    }

    function getPageRange(current, total, size) {
        let start = Math.max(1, current - Math.floor(size / 2));
        let end = start + size - 1;
        if (end > total) { end = total; start = Math.max(1, end - size + 1); }
        const range = [];
        for (let i = start; i <= end; i++) range.push(i);
        return range;
    }

    function updateStats() {
        const statsEl = document.getElementById('scv-stats');
        if (!statsEl) return;

        const totalGames = filteredGames.length;
        const totalPlaytime = filteredGames.reduce((s, g) => s + (g.playtime_forever || 0), 0);
        const playedGames = filteredGames.filter(g => (g.playtime_forever || 0) > 0).length;
        const neverPlayed = totalGames - playedGames;
        const totalUnlocked = filteredGames.reduce((s, g) => s + (g.achievement_unlocked || 0), 0);
        const totalAchievements = filteredGames.reduce((s, g) => s + (g.achievement_total || 0), 0);

        let achievementHtml = '';
        if (totalAchievements > 0) {
            const pct = ((totalUnlocked / totalAchievements) * 100).toFixed(1);
            achievementHtml = `<span>成就 <span class="scv-stats-num">${totalUnlocked}/${totalAchievements}</span> (${pct}%)</span>`;
        }

        statsEl.innerHTML = `
            <span>共 <span class="scv-stats-num">${totalGames.toLocaleString()}</span> 款游戏</span>
            <span>已游玩 <span class="scv-stats-num">${playedGames.toLocaleString()}</span> 款</span>
            <span>未游玩 <span class="scv-stats-num">${neverPlayed.toLocaleString()}</span> 款</span>
            <span>总时长 <span class="scv-stats-num">${formatPlaytime(totalPlaytime)}</span></span>
            ${achievementHtml}
        `;
    }

    // ============================================================
    //  搜索 / 排序 / 过滤
    // ============================================================

    function applyFilterAndSort() {
        const searchText = (document.getElementById('scv-search-input')?.value || '').trim().toLowerCase();
        const sortValue = document.getElementById('scv-sort-select')?.value || 'name';

        filteredGames = allGames.filter(g => {
            if (!searchText) return true;
            const name = (g.name || '').toLowerCase();
            const appid = String(g.appid);
            return name.includes(searchText) || appid.includes(searchText);
        });

        switch (sortValue) {
            case 'name':
                filteredGames.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
                break;
            case 'playtime_desc':
                filteredGames.sort((a, b) => (b.playtime_forever || 0) - (a.playtime_forever || 0));
                break;
            case 'playtime_asc':
                filteredGames.sort((a, b) => (a.playtime_forever || 0) - (b.playtime_forever || 0));
                break;
            case 'lastplayed_desc':
                filteredGames.sort((a, b) => (b.rtime_last_played || 0) - (a.rtime_last_played || 0));
                break;
            case 'lastplayed_asc':
                filteredGames.sort((a, b) => (a.rtime_last_played || 0) - (b.rtime_last_played || 0));
                break;
            case 'achievement_desc':
                filteredGames.sort((a, b) => {
                    const aRate = a.achievement_total > 0 ? a.achievement_unlocked / a.achievement_total : -1;
                    const bRate = b.achievement_total > 0 ? b.achievement_unlocked / b.achievement_total : -1;
                    return bRate - aRate;
                });
                break;
            case 'achievement_asc':
                filteredGames.sort((a, b) => {
                    const aRate = a.achievement_total > 0 ? a.achievement_unlocked / a.achievement_total : 999;
                    const bRate = b.achievement_total > 0 ? b.achievement_unlocked / b.achievement_total : 999;
                    return aRate - bRate;
                });
                break;
            case 'appid':
                filteredGames.sort((a, b) => a.appid - b.appid);
                break;
        }

        currentPage = 1;
        renderGrid();
        renderPaginationContent();
    }

    // ============================================================
    //  导出功能
    // ============================================================

    function exportJSON() {
        const data = filteredGames.map(g => ({
            appid: g.appid,
            name: g.name,
            playtime_forever_minutes: g.playtime_forever,
            playtime_forever_hours: parseFloat(g.playtime_hours),
            playtime_2weeks_minutes: g.playtime_2weeks || 0,
            playtime_2weeks_hours: parseFloat(g.playtime_2weeks_hours || '0'),
            last_played_timestamp: g.rtime_last_played,
            last_played_date: g.last_played_date,
            achievement_total: g.achievement_total || 0,
            achievement_unlocked: g.achievement_unlocked || 0,
            achievement_percent: g.achievement_total > 0
                ? parseFloat(((g.achievement_unlocked / g.achievement_total) * 100).toFixed(1))
                : 0,
            has_dlc: g.has_dlc,
            has_workshop: g.has_workshop,
            has_market: g.has_market,
            has_leaderboards: g.has_leaderboards,
            store_url: g.store_url,
            header_image_url: g.header_img,
            icon_image_url: g.icon_img || '',
        }));

        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        downloadBlob(blob, `steam_games_${steamId}_${getDateStamp()}.json`);
        showToast(`已导出 ${data.length} 款游戏为 JSON 文件`, 'success');
    }

    function exportCSV() {
        const BOM = '\uFEFF';
        const headers = [
            'AppID', '名称', '总游玩时长(分钟)', '总游玩时长(小时)',
            '近2周游玩(分钟)', '近2周游玩(小时)', '最后运行时间戳', '最后运行日期',
            '成就总数', '已解锁成就', '成就完成率(%)',
            '有DLC', '有工坊', '有市场', '有排行榜', '商店链接', '封面图链接',
        ];

        const rows = filteredGames.map(g => [
            g.appid,
            `"${(g.name || '').replace(/"/g, '""')}"`,
            g.playtime_forever || 0,
            g.playtime_hours || '0',
            g.playtime_2weeks || 0,
            g.playtime_2weeks_hours || '0',
            g.rtime_last_played || 0,
            `"${g.last_played_date || ''}"`,
            g.achievement_total || 0,
            g.achievement_unlocked || 0,
            g.achievement_total > 0 ? ((g.achievement_unlocked / g.achievement_total) * 100).toFixed(1) : '0',
            g.has_dlc ? '是' : '否',
            g.has_workshop ? '是' : '否',
            g.has_market ? '是' : '否',
            g.has_leaderboards ? '是' : '否',
            g.store_url,
            g.header_img,
        ]);

        const csv = BOM + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        downloadBlob(blob, `steam_games_${steamId}_${getDateStamp()}.csv`);
        showToast(`已导出 ${rows.length} 款游戏为 CSV 文件`, 'success');
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
    }

    function getDateStamp() {
        const d = new Date();
        return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    }

    // ============================================================
    //  视图切换
    // ============================================================

    function toggleCardView() {
        const cardRoot = document.getElementById('scv-root');
        const originalList = document.querySelector('[class*="FbG-gxCxUQw"]') ||
                             document.querySelector('[class*="ISUc4nhzLMI"]');

        if (!cardViewVisible) {
            if (originalList) originalList.style.display = 'none';
            const remoteDownloadDetails = document.querySelector('[class*="z68jZWX2r0Y"]');
            if (remoteDownloadDetails) remoteDownloadDetails.style.display = 'none';
            cardRoot.style.display = 'block';
            cardViewVisible = true;

            const toggleBtn = document.getElementById('scv-toggle');
            if (toggleBtn) {
                toggleBtn.innerHTML = `
                    <svg viewBox="0 0 16 16" width="16" height="16"><rect x="1" y="1" width="14" height="3" rx="1"/><rect x="1" y="6" width="14" height="3" rx="1"/><rect x="1" y="11" width="14" height="3" rx="1"/></svg>
                    <span>列表视图</span>
                `;
            }
        } else {
            cardRoot.style.display = 'none';
            if (originalList) originalList.style.display = '';
            const remoteDownloadDetails = document.querySelector('[class*="z68jZWX2r0Y"]');
            if (remoteDownloadDetails) remoteDownloadDetails.style.display = '';
            cardViewVisible = false;

            const toggleBtn = document.getElementById('scv-toggle');
            if (toggleBtn) {
                toggleBtn.innerHTML = `
                    <svg viewBox="0 0 16 16" width="16" height="16"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>
                    <span>卡片视图</span>
                `;
            }
        }
    }

    // ============================================================
    //  重新加载游戏数据
    // ============================================================

    async function reloadGames() {
        showLoadingOverlay();
        updateLoadingProgress('正在重新加载游戏数据...');

        // 先尝试从 DOM 提取已有的
        let games = extractGamesFromDOM();

        if (games.length < 50) {
            // 可能数据不完整，执行自动滚动加载
            updateLoadingProgress(`当前 ${games.length} 个游戏，正在滚动加载更多...`);
            await autoLoadAllGamesFromDOM();
            games = extractGamesFromDOM();
        }

        // 再次尝试 SSR/React Query
        const ssrGames = extractGamesFromSSR();
        if (ssrGames && ssrGames.length > games.length) {
            games = enrichGameData(ssrGames);
        } else {
            const rqGames = extractGamesFromReactQuery();
            if (rqGames && rqGames.length > games.length) {
                games = enrichGameData(rqGames);
            }
        }

        removeLoadingOverlay();

        if (games.length > 0) {
            // 保留已有的成就数据
            const oldAchievementCache = { ...achievementCache };
            allGames = games;
            filteredGames = [...allGames];

            // 恢复成就数据
            for (const game of allGames) {
                if (oldAchievementCache[game.appid]) {
                    game.achievement_total = oldAchievementCache[game.appid].total;
                    game.achievement_unlocked = oldAchievementCache[game.appid].unlocked;
                }
            }
            filteredGames = [...allGames];

            renderCardView();
            showToast(`重新加载完成，共 ${allGames.length} 款游戏`, 'success');
        } else {
            showToast('未能加载到游戏数据', 'info');
        }
    }

    // ============================================================
    //  事件绑定
    // ============================================================

    function bindEvents() {
        document.addEventListener('click', (e) => {
            if (e.target.closest('#scv-toggle')) {
                e.preventDefault(); toggleCardView(); return;
            }
            if (e.target.closest('#scv-back-list')) {
                e.preventDefault(); toggleCardView(); return;
            }
            if (e.target.closest('#scv-export-json')) {
                e.preventDefault(); exportJSON(); return;
            }
            if (e.target.closest('#scv-export-csv')) {
                e.preventDefault(); exportCSV(); return;
            }
            if (e.target.closest('#scv-fetch-achievements')) {
                e.preventDefault(); fetchAllAchievements(); return;
            }
            if (e.target.closest('#scv-reload-games')) {
                e.preventDefault(); reloadGames(); return;
            }

            const pageBtn = e.target.closest('.scv-page-btn');
            if (pageBtn && !pageBtn.disabled) {
                const page = pageBtn.dataset.page;
                const totalPages = Math.ceil(filteredGames.length / CONFIG.CARDS_PER_PAGE);
                if (page === 'prev') currentPage = Math.max(1, currentPage - 1);
                else if (page === 'next') currentPage = Math.min(totalPages, currentPage + 1);
                else currentPage = parseInt(page);
                renderGrid();
                renderPaginationContent();
                document.getElementById('scv-root')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });

        let searchTimer = null;
        document.addEventListener('input', (e) => {
            if (e.target.id === 'scv-search-input') {
                clearTimeout(searchTimer);
                searchTimer = setTimeout(() => applyFilterAndSort(), 300);
            }
        });

        document.addEventListener('change', (e) => {
            if (e.target.id === 'scv-sort-select') applyFilterAndSort();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && cardViewVisible) toggleCardView();
        });
    }

    // ============================================================
    //  初始化
    // ============================================================

    function isPageReady() {
        const tabBar = document.querySelector('[class*="JUXi4iWNsDo"]') ||
                       document.querySelector('[class*="w5g2mwuyMg4"]');
        if (tabBar) return true;

        const gameList = document.querySelector('[class*="FbG-gxCxUQw"]') ||
                         document.querySelector('[class*="JeLbcWPaZDg"]') ||
                         document.querySelector('[class*="ISUc4nhzLMI"]');
        if (gameList) return true;

        if (window.SSR?.renderContext?.queryData) return true;

        if (document.querySelector('[data-react-nav-root]') ||
            document.getElementById('CommunityTemplate')) {
            return true;
        }

        return false;
    }

    function waitForPageReady() {
        return new Promise((resolve) => {
            if (isPageReady()) { resolve(); return; }

            mutationObserver = new MutationObserver((mutations, obs) => {
                if (isPageReady()) { obs.disconnect(); resolve(); }
            });
            mutationObserver.observe(document.body, { childList: true, subtree: true });

            setTimeout(() => {
                if (mutationObserver) { mutationObserver.disconnect(); mutationObserver = null; }
                resolve();
            }, CONFIG.INIT_TIMEOUT);
        });
    }

    async function init() {
        console.log('[Steam卡片] 正在初始化 v3.0...');

        await waitForPageReady();
        await new Promise(r => setTimeout(r, 1000));

        if (!isPageReady()) {
            console.log('[Steam卡片] MutationObserver 超时，尝试轮询...');
            await new Promise((resolve) => {
                let attempts = 0;
                const maxAttempts = Math.floor(CONFIG.INIT_TIMEOUT / CONFIG.INIT_POLL_INTERVAL);
                const poll = setInterval(() => {
                    attempts++;
                    if (isPageReady() || attempts >= maxAttempts) { clearInterval(poll); resolve(); }
                }, CONFIG.INIT_POLL_INTERVAL);
            });
        }

        await startApp();
    }

    async function startApp() {
        if (document.getElementById('scv-root')) {
            console.log('[Steam卡片] 已初始化，跳过');
            return;
        }

        console.log('[Steam卡片] 页面就绪，开始提取数据...');

        // 提取游戏数据
        let games = extractGamesFromSSR();
        let needAutoLoad = false;

        if (!games || games.length === 0) {
            games = extractGamesFromReactQuery();
        }

        if (!games || games.length === 0) {
            needAutoLoad = true;
        }

        if (needAutoLoad) {
            showLoadingOverlay();
            updateLoadingProgress('正在滚动加载游戏列表...');
            await autoLoadAllGamesFromDOM();
            removeLoadingOverlay();

            games = extractGamesFromDOM();

            if (games.length === 0) {
                const ssrGames = extractGamesFromSSR();
                if (ssrGames && ssrGames.length > 0) {
                    games = enrichGameData(ssrGames);
                } else {
                    const rqGames = extractGamesFromReactQuery();
                    if (rqGames && rqGames.length > 0) {
                        games = enrichGameData(rqGames);
                    }
                }
            }
        } else {
            games = enrichGameData(games);
        }

        allGames = games;
        filteredGames = [...allGames];

        // 提取 SteamID
        try {
            const loaderData = window.SSR?.loaderData;
            if (loaderData) {
                const item0 = typeof loaderData[0] === 'string' ? JSON.parse(loaderData[0]) : loaderData[0];
                const item1 = typeof loaderData[1] === 'string' ? JSON.parse(loaderData[1]) : loaderData[1];
                steamId = item1?.steamid || item0?.steamid || 'unknown';
            }
            // 从 URL 提取 SteamID 作为备选
            if (!steamId || steamId === 'unknown') {
                const urlMatch = location.pathname.match(/\/(profiles|id)\/([^/]+)\//);
                if (urlMatch) steamId = urlMatch[2];
            }
        } catch (e) {
            steamId = 'unknown';
        }

        console.log(`[Steam卡片] 提取到 ${allGames.length} 款游戏，SteamID: ${steamId}`);

        if (allGames.length === 0) {
            console.warn('[Steam卡片] 未能提取到任何游戏数据');
            showToast('未能提取到游戏数据，请点击"重新加载"按钮', 'info');
        }

        injectStyles();
        createToggleButton();
        createMainContainer();
        renderCardView();
        bindEvents();

        try {
            GM_registerMenuCommand('切换卡片/列表视图', toggleCardView);
            GM_registerMenuCommand('导出 JSON', exportJSON);
            GM_registerMenuCommand('导出 CSV', exportCSV);
            GM_registerMenuCommand('获取成就', fetchAllAchievements);
            GM_registerMenuCommand('重新加载游戏', reloadGames);
        } catch (e) { /* 非油猴环境忽略 */ }

        console.log('[Steam卡片] 初始化完成');
    }

    // 启动
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
