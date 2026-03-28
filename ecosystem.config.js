module.exports = {
  apps: [{
    name: 'tvmbot',
    script: './server.js',
    cwd: '/root/claude-chatbot',
    instances: 1,
    autorestart: true,
    watch: false,
    env: { NODE_ENV: 'production', PORT: 3000 }
  }]
};
