"""Live local smoke test: creates disposable users that the requested reset removes.

Run only against this development stack; uses Mailpit and does not send real mail.
Never prints credentials, cookies, or confirmation tokens.
"""
import http.cookiejar
import json
import re
import ssl
import urllib.error
import urllib.request
import uuid


def main():
    cookies = http.cookiejar.CookieJar()
    client = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(cookies),
        urllib.request.HTTPSHandler(context=ssl._create_unverified_context()),
    )

    def api(path, body=None, expected=200):
        request = urllib.request.Request(
            'https://localhost' + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={} if body is None else {'Content-Type': 'application/json'},
        )
        try:
            response = client.open(request)
        except urllib.error.HTTPError as error:
            response = error
        assert response.status == expected, (path, response.status, expected)
        data = response.read()
        return json.loads(data) if data else None

    identifier = uuid.uuid4().hex[:16]
    email = f'smoke_{identifier}@example.test'
    target = f'confirmed_{identifier}@example.test'
    password = uuid.uuid4().hex
    new_password = uuid.uuid4().hex
    api('/api/register', {'displayed_nickname': 'Security smoke test', 'login': identifier,
                         'email': email, 'password': password}, 201)
    api('/api/login', {'email': email, 'password': password})
    profile = api('/api/me')
    assert profile['displayed_nickname'] == 'Security smoke test'
    assert 'name' not in profile and 'surname' not in profile
    assert api('/api/security')['email_delivery'] == 'preview'
    api('/api/security/email', {'current_password': password, 'new_email': target}, 202)
    assert api('/api/me')['email'] == email

    messages = json.load(urllib.request.urlopen('http://127.0.0.1:8025/api/v1/messages'))['messages']
    message = next(message for message in messages if any(
        recipient['Address'] == target for recipient in message['To']))
    detail = json.load(urllib.request.urlopen('http://127.0.0.1:8025/api/v1/message/' + message['ID']))
    token = re.search(r'/account/confirm-email#token=([a-f0-9]{64})', detail['Text']).group(1)
    api('/api/security/email/confirm', {'token': token}, 204)
    api('/api/security/email/confirm', {'token': token}, 400)
    api('/api/me', expected=401)
    api('/api/login', {'email': target, 'password': password})
    assert api('/api/security')['email_verified'] is True
    api('/api/security/password', {'current_password': password, 'new_password': new_password}, 204)
    api('/api/me', expected=401)
    api('/api/login', {'email': target, 'password': password}, 401)
    api('/api/login', {'email': target, 'password': new_password})
    assert api('/api/me')['email'] == target
    print('PASS: nickname, pending email, real SMTP preview, confirmation, replay rejection, session revocation, and password change')


if __name__ == '__main__':
    main()
