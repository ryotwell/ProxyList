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

class ProxyChecker {
  private readonly IP_RESOLVER_DOMAIN = "myip.ipeek.workers.dev";
  private readonly IP_RESOLVER_PATH = "/";
  private readonly SOCKET_TIMEOUT = 5000;
  private readonly CONCURRENCY = 100;

  private readonly KV_PAIR_FILE = "./kvProxyList.json";
  private readonly RAW_PROXY_FILE = "./rawProxyList.txt";
  private readonly ACTIVE_PROXY_FILE = "./ProxyList.txt";

  private myGeoIp: GeoIpResponse | null = null;
  private activeChecks = 0;
  private readonly checkedProxies = new Set<string>();
  private readonly uniqueRawProxies: string[] = [];
  private readonly activeProxies: string[] = [];
  private readonly kvProxyMap = new Map<string, string[]>();
  private readonly MAX_PROXIES_PER_COUNTRY = 10;

  private async makeRequest(
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
        },
        () => {
          const request = [
            `GET ${path} HTTP/1.1`,
            `Host: ${host}`,
            `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36`,
            `Connection: close`,
            "",
            "",
          ].join("\r\n");

          socket.write(request);
        }
      );

      let data = "";
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("Timeout"));
      }, this.SOCKET_TIMEOUT);

      socket.on("data", (chunk) => {
        data += chunk.toString();
      });

      socket.on("end", () => {
        clearTimeout(timeout);
        const bodyStart = data.indexOf("\r\n\r\n");
        const body = bodyStart !== -1 ? data.substring(bodyStart + 4).trim() : "";
        resolve(body);
      });

      socket.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private async getMyGeoIp(): Promise<GeoIpResponse> {
    if (this.myGeoIp) return this.myGeoIp;

    const response = await this.makeRequest(this.IP_RESOLVER_DOMAIN, this.IP_RESOLVER_PATH);
    this.myGeoIp = JSON.parse(response);
    return this.myGeoIp;
  }

  private async checkSingleProxy(
    address: string,
    port: number
  ): Promise<ProxyCheckResult | null> {
    try {
      const startTime = performance.now();

      const [proxyResponse, myIp] = await Promise.all([
        this.makeRequest(this.IP_RESOLVER_DOMAIN, this.IP_RESOLVER_PATH, {
          host: address,
          port,
        }),
        this.getMyGeoIp(),
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
    } catch {
      return null;
    }
  }

  private async readProxyList(): Promise<ProxyInfo[]> {
    try {
      const content = await fs.readFile(this.RAW_PROXY_FILE, "utf-8");
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
      console.error(`Error reading ${this.RAW_PROXY_FILE}`);
      return [];
    }
  }

  private cleanOrgName(org: string): string {
    return org
      .replace(/[,.\-_+\/\\|;:!@#$%^&*()[\]{}]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private async processProxy(proxy: ProxyInfo, index: number, total: number): Promise<void> {
    const proxyKey = `${proxy.address}:${proxy.port}`;

    if (this.checkedProxies.has(proxyKey)) return;
    this.checkedProxies.add(proxyKey);

    const cleanedOrgInput = this.cleanOrgName(proxy.org);
    this.uniqueRawProxies.push(`${proxy.address},${proxy.port},${proxy.country},${cleanedOrgInput}`);

    this.activeChecks++;

    try {
      const result = await this.checkSingleProxy(proxy.address, proxy.port);

      if (result) {
        const cleanedOrgResult = this.cleanOrgName(result.org);
        this.activeProxies.push(
          `${result.proxy},${result.port},${result.country},${cleanedOrgResult}`
        );

        const countryProxies = this.kvProxyMap.get(result.country) || [];
        if (countryProxies.length < this.MAX_PROXIES_PER_COUNTRY) {
          countryProxies.push(proxyKey);
          this.kvProxyMap.set(result.country, countryProxies);
        }

        console.log(
          `[${index}/${total}] ✓ ${proxyKey} | ${result.country} | ${result.delay}ms | Total: ${this.activeProxies.length}`
        );
      }
    } finally {
      this.activeChecks--;
    }
  }

  private async waitForSlot(): Promise<void> {
    while (this.activeChecks >= this.CONCURRENCY) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private sortByCountry(a: string, b: string): number {
    const countryA = a.split(",")[2] || "";
    const countryB = b.split(",")[2] || "";
    return countryA.localeCompare(countryB);
  }

  private async saveResults(): Promise<void> {
    this.uniqueRawProxies.sort((a, b) => this.sortByCountry(a, b));
    this.activeProxies.sort((a, b) => this.sortByCountry(a, b));

    const kvObject = Object.fromEntries(this.kvProxyMap);

    await Promise.all([
      fs.writeFile(this.KV_PAIR_FILE, JSON.stringify(kvObject, null, 2)),
      fs.writeFile(this.RAW_PROXY_FILE, this.uniqueRawProxies.join("\n")),
      fs.writeFile(this.ACTIVE_PROXY_FILE, this.activeProxies.join("\n")),
    ]);
  }

  public async run(): Promise<void> {
    const startTime = performance.now();

    console.log("🚀 Memulai pengecekan proxy...\n");

    const proxyList = await this.readProxyList();

    if (proxyList.length === 0) {
      console.error("❌ Tidak ada proxy untuk dicheck");
      return;
    }

    console.log(`📋 Total proxy yang akan dicheck: ${proxyList.length}\n`);

    const promises: Promise<void>[] = [];

    for (let i = 0; i < proxyList.length; i++) {
      await this.waitForSlot();
      promises.push(this.processProxy(proxyList[i], i + 1, proxyList.length));
    }

    await Promise.all(promises);

    while (this.activeChecks > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await this.saveResults();

    const endTime = performance.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);

    console.log("\n✅ Proses selesai!");
    console.log(`📊 Proxy aktif: ${this.activeProxies.length}/${proxyList.length}`);
    console.log(`⏱️  Waktu proses: ${duration} detik`);
    console.log(`🌍 Negara unik: ${this.kvProxyMap.size}`);
  }
}

export { ProxyChecker };

if (require.main === module) {
  const checker = new ProxyChecker();
  checker.run().then(() => process.exit(0));
}
