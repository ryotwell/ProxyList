import tls from "tls";
import fs from 'fs/promises'
import { getCountryNameById } from "./country";

const RAW_PROXY_FILE = "./rawProxyList.txt";
const SOCKET_TIMEOUT = 3000;
const IP_RESOLVER_DOMAIN = "myip.ipeek.workers.dev";
const IP_RESOLVER_PATH = "/";
const REQUESTS_PER_BATCH = 250;

type ProxyJson = {
    ip: string;
    port: string;
    country_code: string;
    org: string;
};

type ProxyData = {
    ip: string;
    port: number;
    country: string;
    org: string;
};

async function getParseRawProxyFileToJson(filepath: string): Promise<ProxyJson[]> {
    const content = await fs.readFile(filepath, "utf-8");
    const lines = content.trim().split("\n");
    const proxies = lines.map((line: any) => {
        const [ip, port, country_code, org] = line.split(",");
        return { ip, port, country_code, org };
    });

    return proxies;
};

type IpGeoData = {
    ip: string;
    colo: string;
    httpProtocol: string;
    clientAcceptEncoding: string;
    requestPriority: string;
    edgeRequestKeepAliveStatus: number;
    requestHeaderNames: Record<string, unknown>;
    clientTcpRtt: number;
    asn: number;
    asOrganization: string;
    country: string;
    isEUCountry: boolean;
    city: string;
    continent: string;
    region: string;
    regionCode: string;
    timezone: string;
    longitude: string;
    latitude: string;
    postalCode: string;
    tlsVersion: string;
    tlsCipher: string;
    tlsClientRandom: string;
    tlsClientCiphersSha1: string;
    tlsClientExtensionsSha1: string;
    tlsClientExtensionsSha1Le: string;
    tlsExportedAuthenticator: {
        clientHandshake: string;
        serverHandshake: string;
        clientFinished: string;
        serverFinished: string;
    };
    tlsClientHelloLength: string;
    tlsClientAuth: {
        certPresented: string;
        certVerified: string;
        certRevoked: string;
        certIssuerDN: string;
        certSubjectDN: string;
        certIssuerDNRFC2253: string;
        certSubjectDNRFC2253: string;
        certIssuerDNLegacy: string;
        certSubjectDNLegacy: string;
        certSerial: string;
        certIssuerSerial: string;
        certSKI: string;
        certIssuerSKI: string;
        certFingerprintSHA1: string;
        certFingerprintSHA256: string;
        certNotBefore: string;
        certNotAfter: string;
    };
    verifiedBotCategory: string;
};

async function makeRequest(
    host: string,
    path: string,
    proxy?: { host: string; port: number }
): Promise<string> {
    return new Promise((resolve, reject) => {
        const targetHost = proxy?.host ?? host;
        const targetPort = proxy?.port ?? 443;

        const socket = tls.connect(
            {
                host: targetHost,
                port: targetPort,
                servername: host,
                rejectUnauthorized: false,
                timeout: SOCKET_TIMEOUT,
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
        }, SOCKET_TIMEOUT);

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
}

function cleanOrgName(org: string): string {
    return org
        .replace(/[,.\-_+\/\\|;:!@#$%^&*()[\]{}]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

(async () => {
    const proxies = await getParseRawProxyFileToJson(RAW_PROXY_FILE);

    const totalProxies = proxies.length;
    let processed = 0;
    let filteredResults: ProxyData[] = [];

    while (processed < totalProxies) {
        const batch = proxies.slice(processed, processed + REQUESTS_PER_BATCH);

        const requests: Promise<ProxyData | null>[] = batch.map(async (proxy): Promise<ProxyData | null> => {
            try {
                const response = JSON.parse(await makeRequest(IP_RESOLVER_DOMAIN, IP_RESOLVER_PATH, {
                    host: proxy.ip,
                    port: Number(proxy.port)
                })) as IpGeoData;
                return {
                    ip: proxy.ip,
                    port: Number(proxy.port),
                    org: cleanOrgName(response.asOrganization),
                    country: getCountryNameById(response.country),
                }
            } catch (err) {
                // console.error(`Request failed for proxy ${proxy.ip}:${proxy.port}`, err);
                return null;
            }
        });

        const results = await Promise.all(requests);
        filteredResults.push(...results.filter((result): result is ProxyData => result !== null));
        processed += REQUESTS_PER_BATCH;
        console.log(`Processed proxies: ${Math.min(processed, totalProxies)}/${totalProxies}`);
    }

    filteredResults.sort((a, b) => {
        if (a.country < b.country) return -1;
        if (a.country > b.country) return 1;
        return 0;
    });

    await fs.writeFile('filteredResults.json', JSON.stringify(filteredResults, null, 2), 'utf-8');
    console.log("Filtered results saved to filteredResults.json");

})()