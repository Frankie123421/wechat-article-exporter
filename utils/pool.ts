import {sleep} from "@antfu/utils"
import dayjs from "dayjs"
import {AVAILABLE_PROXY_LIST} from '~/config'
import type {DownloadableArticle} from "~/types/types"
import type {AudioResource, VideoResource} from "~/types/video"

/**
 * 代理实例
 */
export interface ProxyInstance {
    // 代理地址
    address: string

    // 是否正在被使用
    busy: boolean

    // 是否处于冷静期
    cooldown: boolean

    // 使用次数
    usageCount: number

    // 成功次数
    successCount: number

    // 失败次数
    failureCount: number

    // 下载流量
    traffic: number
}

// 代理下载的资源
type DownloadResource =
    | string
    | HTMLLinkElement
    | HTMLImageElement
    | DownloadableArticle
    | AudioResource
    | VideoResource

// 资源下载函数，返回资源大小
type DownloadFn<T extends DownloadResource> = (resource: T, proxy: string) => Promise<number>

// 资源下载结果
export interface DownloadResult {
    // 总耗时 (s)
    totalTime: number

    // 是否成功
    success: boolean

    // 重试次数
    attempts: number

    // 资源url
    url: string

    // 资源大小
    size: number
}

function now() {
    return dayjs(new Date()).format("HH:mm:ss.SSS")
}

function formatTraffic(bytes: number) {
    if (bytes < 1024) {
        return `${bytes} Bytes`
    } else if (bytes < 1024 ** 2) {
        return `${(bytes / 1024).toFixed(2)} KB`
    } else if (bytes < 1024 ** 3) {
        return `${(bytes / (1024 ** 2)).toFixed(2)} MB`
    } else if (bytes < 1024 ** 4) {
        return `${(bytes / (1024 ** 3)).toFixed(2)} GB`
    } else if (bytes < 1024 ** 5) {
        return `${(bytes / (1024 ** 4)).toFixed(2)} TB`
    }
}

class ProxyPool {
    proxies: ProxyInstance[] = []

    constructor(proxyUrls: string[]) {
        this.proxies = proxyUrls.map(url => ({
            address: url,
            busy: false,
            cooldown: false,
            usageCount: 0,
            successCount: 0,
            failureCount: 0,
            traffic: 0,
        }));
    }

    /**
     * 初始化代理池
     * 可以传入新的代理地址列表（私有代理地址）
     * @param proxyUrls
     */
    init(proxyUrls: string[] = []) {
        if (proxyUrls.length > 0) {
            this.proxies = proxyUrls.map(url => ({
                address: url,
                busy: false,
                cooldown: false,
                usageCount: 0,
                successCount: 0,
                failureCount: 0,
                traffic: 0,
            }));
        } else {
            this.proxies.forEach(proxy => {
                proxy.busy = false
                proxy.cooldown = false
            })
        }
    }

    async getAvailableProxy() {
        let time = 0
        while (true) {
            for (const proxy of this.proxies) {
                if (!proxy.busy && !proxy.cooldown) {
                    proxy.busy = true
                    proxy.usageCount++
                    return proxy
                }
            }
            // 如果没有可用代理，稍微等待一下
            await sleep(100)
            time += 100
            if (time >= 60_000) {
                // 超时1分钟
                throw new Error('无可用代理')
            }
        }
    }

    releaseProxy(proxy: ProxyInstance, success: boolean) {
        proxy.busy = false

        if (success) {
            proxy.successCount++
        } else {
            proxy.failureCount++
            proxy.cooldown = true

            // 5秒冷却时间
            setTimeout(() => {
                proxy.cooldown = false;
            }, 5_000);

            if (proxy.failureCount >= 5 && proxy.successCount === 0) {
                // 代理被识别为不可用，从代理池中移除
                console.warn(`代理 ${proxy.address} 不可用，将被移除`)
                this.removeProxy(proxy)
            }
        }
    }

    /**
     * 移除代理
     */
    removeProxy(proxy: ProxyInstance) {
        this.proxies = this.proxies.filter(p => p.address !== proxy.address)
    }

    printProxyUsage() {
        console.debug('代理使用情况:')
        let traffic = 0
        const usageData = this.proxies.map(proxy => {
            traffic += proxy.traffic
            return {
                '代理': proxy.address,
                '使用次数': proxy.usageCount,
                '下载流量': formatTraffic(proxy.traffic),
                '成功次数': proxy.successCount,
                '失败次数': proxy.failureCount,
                '成功率': proxy.usageCount === 0 ? '-' : ((proxy.successCount / proxy.usageCount) * 100).toFixed(2) + '%',
            }
        });
        // 增加总计
        usageData.push({
            '代理': '总计',
            '使用次数': usageData.reduce((total, item) => total + item['使用次数'], 0),
            '下载流量': formatTraffic(traffic),
            '成功次数': usageData.reduce((total, item) => total + item['成功次数'], 0),
            '失败次数': usageData.reduce((total, item) => total + item['失败次数'], 0),
            '成功率': '-',
        })
        console.table(usageData);
    }

    incrementTraffic(address: string, bytes: number) {
        const proxy = this.proxies.find(proxy => proxy.address === address)
        if (proxy) {
            proxy.traffic += bytes
        } else {
            console.warn(`代理${address}未找到`)
        }
    }
}


// 代理池
export const pool = new ProxyPool(AVAILABLE_PROXY_LIST);


/**
 * 使用代理 proxy 下载资源
 * @param proxy
 * @param resource
 * @param downloadFn
 */
async function downloadResource<T extends DownloadResource>(proxy: ProxyInstance, resource: T, downloadFn: DownloadFn<T>): Promise<[boolean, number]> {
    try {
        // 执行下载任务
        const size = await downloadFn(resource, proxy.address)
        return [true, size];
    } catch (error) {
        return [false, 0];
    }
}

/**
 * 使用代理池下载资源
 * @param pool
 * @param resource
 * @param downloadFn
 * @param useProxy
 * @param maxRetries
 */
async function downloadWithRetry<T extends DownloadResource>(pool: ProxyPool, resource: T, downloadFn: DownloadFn<T>, useProxy = true, maxRetries = 100): Promise<DownloadResult> {
    let attempts = 0;
    let isSuccess = false;
    let size: number = 0;

    let resourceURL: string
    if (resource instanceof HTMLLinkElement) {
        resourceURL = resource.href;
    } else if (resource instanceof HTMLImageElement) {
        resourceURL = resource.src || resource.dataset.src!
    } else if (typeof resource === 'string') {
        resourceURL = resource
    } else {
        resourceURL = resource.url
    }

    const startTime = Date.now()

    while (attempts < maxRetries) {
        let success: boolean

        if (useProxy) {
            // 使用代理下载
            const proxy = await pool.getAvailableProxy();
            [success, size] = await downloadResource<T>(proxy, resource, downloadFn);
            pool.releaseProxy(proxy, success);
        } else {
            // 不使用代理下载
            [success, size] = await downloadResource<T>({} as ProxyInstance, resource, downloadFn);
        }

        if (success) {
            isSuccess = true
            break
        } else {
            attempts++;
            await sleep(200)
            console.log(`[${now()}] Retrying ${resourceURL} (attempt ${attempts}/${maxRetries})`);
        }
    }

    const endTime = Date.now();
    const totalTime = (endTime - startTime) / 1000;

    if (!isSuccess) {
        console.warn(`[${now()}] Failed to download ${resourceURL} after ${maxRetries} attempts`);
    }

    return {
        totalTime,
        success: isSuccess,
        attempts,
        url: resourceURL,
        size,
    }
}




/**
 * 使用代理池下载单个资源
 * @param resource
 * @param downloadFn
 * @param useProxy
 */
async function download<T extends DownloadResource>(resource: T, downloadFn: DownloadFn<T>, useProxy = true) {
    return await downloadWithRetry<T>(pool, resource, downloadFn, useProxy)
}

/**
 * 使用代理池下载多个资源
 * @param resources
 * @param downloadFn
 * @param useProxy
 */
export async function downloads<T extends DownloadResource>(resources: T[], downloadFn: DownloadFn<T>, useProxy = true) {
    // 检查是否设置了私有代理地址
    const privateProxy: string[] = []
    try {
        const proxy = JSON.parse(window.localStorage.getItem('wechat-proxy')!)
        if (Array.isArray(proxy) && proxy.length > 0) {
            privateProxy.push(...proxy)
        }
    } catch (e) {
        console.log(e)
    }

    // 初始化 pool
    pool.init(privateProxy)

    console.debug('本次下载使用代理为: ', pool.proxies)

    const tasks = resources.map(resource => download<T>(resource, downloadFn, useProxy));
    return await Promise.all(tasks)
}

/**
 * 打印代理使用次数
 */
export function usage() {
    pool.printProxyUsage();
}

export function formatDownloadResult(label: string, results: DownloadResult | DownloadResult[], total: number) {
    if (!Array.isArray(results)) {
        results = [results]
    }

    console.debug(label)
    console.debug(`总耗时: ${total.toFixed(2)}s`);

    // 打印下载耗时明细
    const downloadResults = results.map(result => ({
        URL: result.url,
        size: result.size,
        '耗时': result.totalTime,
        '重试次数': result.attempts,
        '是否下载成功': result.success,
    }))
    console.table(downloadResults)
}
