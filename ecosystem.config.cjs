const path = require("path");

const repoRoot = __dirname;

module.exports = {
  apps: [
    {
      name: "meridian",
      script: path.join(repoRoot, "index.js"),
      cwd: repoRoot,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
      merge_logs: true,
      time: true,
      // Always start via this file (npm run pm2:start) so cwd + script path stay pinned to the repo.
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "meridian-webui",
      script: path.join(repoRoot, "webui/server.js"),
      cwd: repoRoot,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 3000,
      kill_timeout: 5000,
      max_restarts: 10,
      min_uptime: "5s",
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: "production",
        WEBUI_PORT: 3031,
      },
    },
  ],
};