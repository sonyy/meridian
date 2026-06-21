const path = require("path");

const repoRoot = __dirname;

module.exports = {
  apps: [
    {
      name: "meridian",
      script: path.join(repoRoot, "index.js"),
      cwd: repoRoot,
      env: {
        NODE_OPTIONS: "--max-old-space-size=192",
      },
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      max_memory_restart: "180M",
      min_uptime: "10s",
      merge_logs: true,
      time: true,
    },
    {
      name: "meridian-webui",
      script: path.join(repoRoot, "webui/server.js"),
      cwd: repoRoot,
      env: {
        NODE_OPTIONS: "--max-old-space-size=192",
        WEBUI_PORT: 3031,
      },
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 3000,
      kill_timeout: 5000,
      max_restarts: 10,
      max_memory_restart: "180M",
      min_uptime: "5s",
      merge_logs: true,
      time: true,
    },
  ],
};
