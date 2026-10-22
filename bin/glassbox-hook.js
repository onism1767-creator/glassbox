#!/usr/bin/env node
// Claude Code hook → glassbox：读 stdin 的 JSON，POST 到本地画布服务。
// 任何情况下都静默退出 0，绝不阻塞或干扰工具调用。
import http from "node:http";

const portIndex = process.argv.indexOf("--port");
const port = Number(portIndex >= 0 ? process.argv[portIndex + 1] : 4400) || 4400;
let data = "";
const done = () => process.exit(0);
const fallback = setTimeout(done, 3000);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  data += chunk;
});
process.stdin.on("end", () => {
  const req = http.request(
    { host: "127.0.0.1", port, path: "/api/hook", method: "POST", headers: { "content-type": "application/json" }, timeout: 1500 },
    (res) => {
      res.resume();
      res.on("end", () => {
        clearTimeout(fallback);
        done();
      });
    },
  );
  req.on("error", done);
  req.on("timeout", () => {
    req.destroy();
    done();
  });
  req.end(data || "{}");
});
process.stdin.on("error", done);
