// PM2 process definition — pinned here (instead of hoping `pm2 start` was run
// with the right flags on the server) so deploys stay consistent across
// restarts and machines. Zero-downtime reload is enabled via `exec_mode: fork`
// + `pm2 reload` semantics.
module.exports = {
  apps: [
    {
      name: 'carbon-dashboard',
      script: 'backend/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      // `wait_ready: false` — the app doesn't send process.send('ready'). PM2
      // will consider the process online as soon as the server binds its port.
      env: {
        NODE_ENV: 'production',
      },
      // Log files live inside the project so Webmin's file manager can tail
      // them without hunting through /root or /var/log.
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
