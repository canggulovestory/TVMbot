# zuzuzu.tech UGC portfolio

Afni Harfiyan’s public portfolio, adapted from the original TVM Afni page.
UGC leads, with existing technology and operations projects kept separately. No private data,
credentials, analytics, or client-side dependencies are shipped.

- Live domain: https://zuzuzu.tech
- Server: existing SSH alias `zuzu` (212.85.27.71)
- Public document root: `/var/www/zuzuzu-portfolio` — upload **only index.html**.
- Nginx site: `/etc/nginx/sites-available/zuzuzu-portfolio`
- `/login` and `/login/` redirect to https://app.zuzuzu.tech/login.
- The existing personal app and its authentication are unchanged on their separate server.
- TLS uses Certbot webroot `/var/www/letsencrypt`; the deployment hook reloads Nginx after renewal.

Preview: `python3 -m http.server 8767 --bind 127.0.0.1` from this folder.
Local preview does not implement Nginx login redirects.

Verification: `python3 ops/verify.py` checks live HTTPS, redirects, public
file isolation and denial of unauthenticated requests to the private overview.
No authenticated private data is accessed by the check.

UGC videos are still in progress; no commissioned work is invented.
Existing public WhatsApp, email and LinkedIn contacts are retained from the Afni page.
The brief form opens WhatsApp for the visitor to review and send; it does not
submit to the TVM enquiry API. The old TVM /afni routes redirect to this domain.
The stock image formerly labeled as Afni’s portrait is replaced by a name card.

For content updates, copy index.html to a staging file on the server and then
install it as `/var/www/zuzuzu-portfolio/index.html`. Keep ops and this README
outside the public document root. No application restart is needed.
