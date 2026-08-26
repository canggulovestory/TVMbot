# Hermes Agent for TVMbot

Hermes Agent is installed separately from the TVMbot Node.js application. Its isolated profile is named `tvm` and its terminal working directory is the production checkout.

## Production layout

- Hermes code: `/usr/local/lib/hermes-agent`
- Hermes command: `/usr/local/bin/hermes`
- TVM profile: `/root/.hermes/profiles/tvm`
- TVM workspace: `/root/tvmbot-v4`
- Workspace policy: `/root/tvmbot-v4/.hermes.md`

The TVM profile uses the existing server-side Anthropic credential without storing it in Git. The profile's secret file must remain mode `600`.

## Use

```bash
cd /root/tvmbot-v4
hermes -p tvm
```

For a non-interactive health check:

```bash
cd /root/tvmbot-v4
hermes -p tvm -z "Reply only with: TVM Hermes ready"
```

## Deliberately not enabled

- Hermes Gateway is not started.
- Existing TVMbot WhatsApp and Telegram credentials are not reused.
- No Hermes cron jobs or autonomous goals are enabled.
- Browser/computer-use dependencies are not installed on the VPS.

These require a separate decision because they add public access, credentials, background execution, or meaningful server load.

## Update

```bash
hermes update
hermes -p tvm doctor
```

After an update, confirm that `terminal.cwd` still points to `/root/tvmbot-v4` and that `.hermes.md` loads from the repository.
