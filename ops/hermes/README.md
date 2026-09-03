# Hermes Agent for TVMbot

Hermes Agent is installed separately from the TVMbot Node.js application. Its isolated profile is named `tvm` and its terminal working directory is the production checkout.

## Production layout

- Hermes code: `/usr/local/lib/hermes-agent`
- Hermes command: `/usr/local/bin/hermes`
- TVM profile: `/root/.hermes/profiles/tvm`
- TVM workspace: `/root/tvmbot-v4`
- Workspace policy: `/root/tvmbot-v4/.hermes.md`

The TVM profile is the model-provider boundary. TVMbot never imports a model SDK;
it calls Hermes through the authenticated Responses API on VPS loopback. Provider
credentials, when used, stay in the profile secret file and never enter Git.

The current transition provider is Hermes' keyless `OpenCode Free` route. TVMbot
also has a short, read-only OpenCode fallback so ordinary chat remains usable
while Hermes recovers. The model watchdog probes current free model IDs every
10 minutes. For production business traffic, replace the free route with a
chosen Hermes-supported provider or Nous Portal subscription after reviewing
its privacy, limits, and billing.

## Use

```bash
cd /root/tvmbot-v4
hermes -p tvm
```

TVMbot calls:

```bash
POST http://127.0.0.1:8642/v1/responses
```

The request uses the bearer secret from `HERMES_API_KEY`, a stable named
conversation for each authorized TVM user, and the profile's project skills.

## Deliberately not enabled

- Existing TVMbot WhatsApp and Telegram credentials are not reused.
- No Hermes cron jobs or autonomous goals are enabled.
- Browser/computer-use dependencies are not installed on the VPS.
- The Hermes API is not reverse-proxied or bound to a public interface.

These require a separate decision because they add public access, credentials, background execution, or meaningful server load.

## Update

```bash
hermes update
hermes -p tvm doctor
curl --fail http://127.0.0.1:8642/health
```

After an update, confirm that `terminal.cwd` still points to `/root/tvmbot-v4` and that `.hermes.md` loads from the repository.
