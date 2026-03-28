# TVMbot — Autonomous Villa Management AI Agent

## Architecture: PEMS (Planner → Executor → Memory → Supervisor)

### Stack
- **Planner**: Claude decomposes user goals into structured execution plans
- **Executor**: Dispatches tool calls (Gmail, Calendar, Drive, Docs, Sheets, Finance, and more)
- **Memory**: SQLite long-term storage for villas, guests, bookings, decisions, facts
- **Supervisor**: Quality control + risk validation before/after execution
- **Ruflo**: AI intelligence layer (smart router, swarm coordination, reasoning, defence)

### Core Modules
| Module | Description |
|--------|-------------|
| `server.js` | Express server, PEMS orchestration, auth, cron jobs |
| `planner.js` | LLM-powered goal decomposition |
| `executor.js` | Tool dispatch (1,366 lines, 40+ tool handlers) |
| `memory.js` | SQLite business memory layer |
| `supervisor.js` | Pre/post execution validation |
| `tools.js` | 40+ Anthropic tool definitions |
| `whatsapp.js` | WhatsApp via Baileys (direct WA Web) |
| `telegram.js` | Telegram bot integration |
| `voice-handler.js` | Voice-to-text processing |

### Integrations (`/integrations/`)
- Gmail (read, send, flag, auto-reply)
- Google Calendar (events, availability, booking sync)
- Google Drive (search, folders, passport finder, file conversion)
- Google Docs (create, read, update, contracts)
- Google Sheets (read, write, append — expense tracking)
- Finance (invoices, payments, bank balances)
- Email Watcher (auto-log Airbnb bookings & bank payments)
- Cleaning schedule automation
- Marketing content generation
- Maintenance reminders
- Notion (optional)

### Intelligence Layer
| Module | Description |
|--------|-------------|
| `ruflo-integration.js` | Unified AI intelligence (22 sub-modules) |
| `smart-router.js` | Dynamic model selection |
| `knowledge-graph.js` | Entity linking & relationships |
| `token-optimizer.js` | Context compression |
| `proactive-monitor.js` | Autonomous problem detection |

### Skills & Agents
- `/skills/` — Progressive domain skill injection
- `/agents/` — Specialized agent modules

### Deployment
- Server: Hostinger VPS Ubuntu 24.04
- Domain: https://thevillamanagers.cloud
- Process: PM2 (tvmbot)
- Reverse Proxy: Nginx + Let's Encrypt SSL

### Setup
```bash
npm install
cp .env.example .env  # Fill in ANTHROPIC_API_KEY, LOGIN_USER, LOGIN_PASSWORD, SESSION_SECRET
# Create config/integrations.json with Google API credentials
pm2 start ecosystem.config.js
```
