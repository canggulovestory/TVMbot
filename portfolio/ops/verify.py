"""Live routing checks: python3 ops/verify.py (no credentials or private data)."""
from urllib.request import build_opener, HTTPRedirectHandler
from urllib.error import HTTPError


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


client = build_opener(NoRedirect())


def get(url):
    try:
        response = client.open(url, timeout=15)
    except HTTPError as response:
        return response.code, response.headers, response.read().decode()
    with response:
        return response.status, response.headers, response.read().decode()


status, headers, body = get('https://zuzuzu.tech/')
assert status == 200 and 'UGC' in body, 'Portfolio must load with valid HTTPS'
assert 'Afni Harfiyan' in body and 'https://wa.me/6282122922252' in body
assert 'frame-ancestors' in headers.get('Content-Security-Policy', '')
for path in ['/login', '/login/']:
    status, headers, _ = get('https://zuzuzu.tech' + path)
    assert status == 302 and headers['Location'] == 'https://app.zuzuzu.tech/login'
for path in ['/api/zuzu/overview', '/data/', '/.env', '/ops/nginx-http.conf']:
    assert get('https://zuzuzu.tech' + path)[0] == 404, 'Public host exposed ' + path
assert get('https://app.zuzuzu.tech/login')[0] == 200
assert get('https://app.zuzuzu.tech/api/zuzu/overview')[0] == 401
status, headers, _ = get('http://zuzuzu.tech/')
assert status in (301, 308) and headers['Location'] == 'https://zuzuzu.tech/'
for path in ['/afni', '/afni/', '/afni/?utm_source=tvm']:
    status, headers, _ = get('https://thevillamanagers.cloud' + path)
    expected = 'https://zuzuzu.tech/' + ('?utm_source=tvm' if '?' in path else '')
    assert status == 301 and headers['Location'] == expected, 'Old portfolio must redirect: ' + path
print('PASS: Afni portfolio, contacts, HTTPS, private login, file isolation and old-site redirects')
