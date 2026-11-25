import { createServer, type Server } from "node:http";

export type ReleaseStub = {
  port: number;
  latestUrl: string;
  versionsUrl: string;
  setLatest: (tag: string, versions?: Record<string, string>) => void;
  hits: () => string[];
  close: () => Promise<void>;
};

/** #93: local HTTP stub for GitHub releases/latest + raw versions.json so E2E never hits GitHub. */
export async function startReleaseStub(
  initialTag: string,
  initialVersions: Record<string, string> = {},
): Promise<ReleaseStub> {
  let tag = initialTag;
  let versions: Record<string, string> = { [initialTag]: "1.8.7", ...initialVersions };
  const seen: string[] = [];

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    seen.push(url);
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("content-type", "application/json");
    if (url === "/releases/latest") {
      res.end(JSON.stringify({ tag_name: tag }));
      return;
    }
    if (url === "/versions.json") {
      res.end(JSON.stringify(versions));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  return {
    port,
    latestUrl: `${base}/releases/latest`,
    versionsUrl: `${base}/versions.json`,
    setLatest: (nextTag, nextVersions) => {
      tag = nextTag;
      versions = { [nextTag]: "1.8.7", ...nextVersions };
    },
    hits: () => [...seen],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
