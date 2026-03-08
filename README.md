# TVMbot — OpenClaw-Class Autonomous Villa Management AI

## Architecture: PEMS (Planner → Executor → Memory → Supervisor)

### Stack
- **Planner**: Claude decomposes user goals into execution plans
- **Executor**: Dispatches tool calls (Gmail, Calendar, Drive, Docs, Sheets)
- **Memory**: SQLite long-term storage for villas, guests, bookings, decisions
- **Supervisor**: Quality control + risk validation before/after execution

### Integrations
- Gmail (read, send, flag)
- Google Calendar (read, create, check availability)
- Google Drive (search, find files, create folders)
- Google Docs (create, read, update, contracts)
- Google Sheets (read, write, append)
- Marketing content generation
- Cleaning schedule automation

### Deployment
- Server: Hostinger VPS Ubuntu 24.04
- Domain: https://thevillamanagers.cloud
- Process: PM2 (tvmbot)
- Reverse Proxy: Nginx + Let's Encrypt SSL

### Setup
\`\`\`bash
npm install
cp .env.example .env  # Add ANTHROPIC_API_KEY
pm2 start server.js --name tvmbot
\`\`\`
