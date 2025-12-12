import tls from "tls";
import { promises as fs } from "fs";
import { performance } from "perf_hooks";

interface ProxyInfo {
    address: string;
    port: number;
    country: string;
    org: string;
}

interface ProxyCheckResult {
    success: boolean;
    proxy: string;
    port: number;
    ip: string;
    country: string;
    org: string;
    delay: number;
}

interface GeoIpResponse {
    ip: string;
    country: string;
    asOrganization: string;
}

interface ProcessingState {
    checkedProxies: Set<string>;
    uniqueRawProxies: string[];
    activeProxies: string[];
    activeProxyResults: ProxyCheckResult[];
    kvProxyMap: Map<string, string[]>;
    stats: { failed: number; success: number; total: number };
    activeChecks: number;
}

interface Config {
    IP_RESOLVER_DOMAIN: string;
    IP_RESOLVER_PATH: string;
    SOCKET_TIMEOUT: number;
    CONCURRENCY: number;
    RETRY_ATTEMPTS: number;
    RETRY_DELAY_MS: number;
    KV_PAIR_FILE: string;
    RAW_PROXY_FILE: string;
    ACTIVE_PROXY_FILE: string;
    ACTIVE_PROXY_FILE_JSON: string;
    STATS_FILE: string;
    MAX_PROXIES_PER_COUNTRY: number;
}

const CONFIG: Config = {
    IP_RESOLVER_DOMAIN: "myip.ipeek.workers.dev",
    IP_RESOLVER_PATH: "/",
    SOCKET_TIMEOUT: 3000,
    CONCURRENCY: 250,
    RETRY_ATTEMPTS: 2,
    RETRY_DELAY_MS: 500,
    KV_PAIR_FILE: "./kvProxyList.json",
    RAW_PROXY_FILE: "./rawProxyList.txt",
    ACTIVE_PROXY_FILE: "./ProxyList.txt",
    ACTIVE_PROXY_FILE_JSON: "./ProxyList.json",
    STATS_FILE: "./stats.json",
    MAX_PROXIES_PER_COUNTRY: 10,
};

const makeRequest = (
    config: Config,
    host: string,
    path: string,
    proxy?: { host: string; port: number }
): Promise<string> => {
    return new Promise((resolve, reject) => {
        const targetHost = proxy?.host ?? host;
        const targetPort = proxy?.port ?? 443;

        const socket = tls.connect(
            {
                host: targetHost,
                port: targetPort,
                servername: host,
                rejectUnauthorized: false,
                timeout: config.SOCKET_TIMEOUT,
            },
            () => {
                const request = `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n`;
                socket.write(request);
            }
        );

        let data = "";
        let headerEnded = false;
        const timeout = setTimeout(() => {
            socket.destroy();
            reject(new Error("Timeout"));
        }, config.SOCKET_TIMEOUT);

        socket.on("data", (chunk) => {
            if (!headerEnded) {
                data += chunk.toString();
                const headerIndex = data.indexOf("\r\n\r\n");
                if (headerIndex !== -1) {
                    headerEnded = true;
                    const body = data.substring(headerIndex + 4).trim();
                    clearTimeout(timeout);
                    socket.destroy();
                    resolve(body);
                }
            }
        });

        socket.on("end", () => {
            clearTimeout(timeout);
            if (!headerEnded) {
                const bodyStart = data.indexOf("\r\n\r\n");
                const body = bodyStart !== -1 ? data.substring(bodyStart + 4).trim() : "";
                resolve(body);
            }
        });

        socket.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
};

const getMyGeoIp = (() => {
    let cachedGeoIp: GeoIpResponse | null = null;

    return async (config: Config): Promise<GeoIpResponse> => {
        if (cachedGeoIp) return cachedGeoIp;

        const response = await makeRequest(config, config.IP_RESOLVER_DOMAIN, config.IP_RESOLVER_PATH);
        cachedGeoIp = JSON.parse(response) as GeoIpResponse;
        return cachedGeoIp;
    };
})();

const checkSingleProxy = async (
    config: Config,
    address: string,
    port: number,
    retries: number = config.RETRY_ATTEMPTS
): Promise<ProxyCheckResult | null> => {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const startTime = performance.now();

            const [proxyResponse, myIp] = await Promise.all([
                makeRequest(config, config.IP_RESOLVER_DOMAIN, config.IP_RESOLVER_PATH, {
                    host: address,
                    port,
                }),
                getMyGeoIp(config),
            ]);

            const endTime = performance.now();
            const delay = Math.round(endTime - startTime);

            const proxyInfo: GeoIpResponse = JSON.parse(proxyResponse);

            if (proxyInfo.ip && proxyInfo.ip !== myIp.ip && proxyInfo.country) {
                return {
                    success: true,
                    proxy: address,
                    port,
                    ip: proxyInfo.ip,
                    country: proxyInfo.country,
                    org: proxyInfo.asOrganization || "Unknown",
                    delay,
                };
            }

            return null;
        } catch (error) {
            if (attempt < retries) {
                await new Promise((resolve) => setTimeout(resolve, config.RETRY_DELAY_MS * (attempt + 1)));
            }
        }
    }

    return null;
};

const readProxyList = async (config: Config): Promise<ProxyInfo[]> => {
    try {
        const content = await fs.readFile(config.RAW_PROXY_FILE, "utf-8");
        const lines = content.trim().split("\n");

        return lines
            .map((line) => {
                const [address, port, country, org] = line.split(",");
                if (!address || !port) return null;

                return {
                    address: address.trim(),
                    port: parseInt(port.trim(), 10),
                    country: country?.trim() || "Unknown",
                    org: org?.trim().replace(/\+/g, " ") || "Unknown",
                };
            })
            .filter((proxy): proxy is ProxyInfo => proxy !== null && !isNaN(proxy.port));
    } catch {
        console.error(`Error reading ${config.RAW_PROXY_FILE}`);
        return [];
    }
};

const cleanOrgName = (org: string): string => {
    return org
        .replace(/[,.\-_+\/\\|;:!@#$%^&*()[\]{}]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
};

const sortByCountry = (a: string, b: string): number => {
    const countryA = a.split(",")[2] || "";
    const countryB = b.split(",")[2] || "";
    return countryA.localeCompare(countryB);
};

const createInitialState = (): ProcessingState => ({
    checkedProxies: new Set<string>(),
    uniqueRawProxies: [],
    activeProxies: [],
    activeProxyResults: [],
    kvProxyMap: new Map<string, string[]>(),
    stats: { failed: 0, success: 0, total: 0 },
    activeChecks: 0,
});

const waitForSlot = async (state: ProcessingState, config: Config): Promise<void> => {
    while (state.activeChecks >= config.CONCURRENCY) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
};

const processProxy = async (
    config: Config,
    state: ProcessingState,
    proxy: ProxyInfo,
    index: number,
    total: number
): Promise<void> => {
    const proxyKey = `${proxy.address}:${proxy.port}`;

    if (state.checkedProxies.has(proxyKey)) return;
    state.checkedProxies.add(proxyKey);

    const cleanedOrgInput = cleanOrgName(proxy.org);
    state.uniqueRawProxies.push(`${proxy.address},${proxy.port},${proxy.country},${cleanedOrgInput}`);

    state.activeChecks++;
    state.stats.total++;

    try {
        const result = await checkSingleProxy(config, proxy.address, proxy.port);

        if (result) {
            const cleanedOrgResult = cleanOrgName(result.org);
            state.activeProxies.push(`${result.proxy},${result.port},${result.country},${cleanedOrgResult}`);
            state.activeProxyResults.push(result);

            const countryProxies = state.kvProxyMap.get(result.country) || [];
            if (countryProxies.length < config.MAX_PROXIES_PER_COUNTRY) {
                countryProxies.push(proxyKey);
                state.kvProxyMap.set(result.country, countryProxies);
            }

            state.stats.success++;
            console.log(
                `[${index}/${total}] ✓ ${proxyKey} | ${result.country} | ${result.delay}ms | Total: ${state.activeProxies.length}`
            );
        } else {
            state.stats.failed++;
        }
    } finally {
        state.activeChecks--;
    }
};

const processWithConcurrency = async <T>(
    config: Config,
    state: ProcessingState,
    items: T[],
    processor: (item: T, index: number) => Promise<void>
): Promise<void> => {
    const executing: Set<Promise<void>> = new Set();

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item === undefined) continue;

        await waitForSlot(state, config);

        const promise = processor(item, i);
        executing.add(promise);

        promise.finally(() => {
            executing.delete(promise);
        });

        if (executing.size >= config.CONCURRENCY) {
            await Promise.race(executing);
        }
    }

    await Promise.all(Array.from(executing));
};

const saveResults = async (config: Config, state: ProcessingState): Promise<void> => {
    state.uniqueRawProxies.sort((a, b) => sortByCountry(a, b));
    state.activeProxies.sort((a, b) => sortByCountry(a, b));
    
    // Sort activeProxyResults by country to match the text file order
    state.activeProxyResults.sort((a, b) => a.country.localeCompare(b.country));

    const kvObject = Object.fromEntries(state.kvProxyMap);

    const statsData = {
        ...state.stats,
        successRate: `${((state.stats.success / state.stats.total) * 100).toFixed(2)}%`,
        countriesCount: state.kvProxyMap.size,
        timestamp: new Date().toISOString(),
    };

    await Promise.all([
        fs.writeFile(config.KV_PAIR_FILE, JSON.stringify(kvObject, null, 2)),
        fs.writeFile(config.RAW_PROXY_FILE, state.uniqueRawProxies.join("\n")),
        fs.writeFile(config.ACTIVE_PROXY_FILE, state.activeProxies.join("\n")),
        fs.writeFile(config.ACTIVE_PROXY_FILE_JSON, JSON.stringify(state.activeProxyResults, null, 2)),
        fs.writeFile(config.STATS_FILE, JSON.stringify(statsData, null, 2)),
    ]);
};

const run = async (): Promise<void> => {
    const startTime = performance.now();
    const state = createInitialState();

    console.log("🚀 Memulai pengecekan proxy...\n");

    const proxyList = await readProxyList(CONFIG);

    if (proxyList.length === 0) {
        console.error("❌ Tidak ada proxy untuk dicheck");
        return;
    }

    console.log(`📋 Total proxy yang akan dicheck: ${proxyList.length}\n`);

    await processWithConcurrency(CONFIG, state, proxyList, (proxy, index) =>
        processProxy(CONFIG, state, proxy, index + 1, proxyList.length)
    );

    while (state.activeChecks > 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await saveResults(CONFIG, state);

    const endTime = performance.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    console.log("\n✅ Proses selesai!");
    console.log(
        `📊 Proxy aktif: ${state.activeProxies.length}/${proxyList.length} (${((state.activeProxies.length / proxyList.length) * 100).toFixed(2)}%)`
    );
    console.log(`✔️  Berhasil: ${state.stats.success} | ❌ Gagal: ${state.stats.failed}`);
    console.log(`⏱️  Waktu proses: ${duration} detik`);
    console.log(`🌍 Negara unik: ${state.kvProxyMap.size}`);
};

run().then(() => process.exit(0));
