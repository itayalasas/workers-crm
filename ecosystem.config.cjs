module.exports = {
  apps: [
    {
      name: 'crmpro-imap-sync',
      cwd: __dirname,
      script: 'src/worker.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
