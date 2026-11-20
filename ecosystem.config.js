// PM2 processes for Devenum AI Phase 3. Usage: pm2 start ecosystem.config.js --only devenum-worker,devenum-bot
module.exports = {
  apps: [
    {
      name: "devenum-worker",
      cwd: "/opt/devenum-ai/worker",
      script: "dist/index.js",
      // Lets in-flight Claude runs be cancelled cleanly (tasks go back to READY) before PM2 force-kills.
      kill_timeout: 30000,
      max_restarts: 20,
      restart_delay: 5000,
      env: { NODE_ENV: "production" },
    },
    {
      name: "devenum-bot",
      cwd: "/opt/devenum-ai/bot",
      script: "dist/index.js",
      max_restarts: 20,
      restart_delay: 10000,
      env: { NODE_ENV: "production" },
    },
  ],
};
