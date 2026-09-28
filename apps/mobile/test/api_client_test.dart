import 'package:flutter_test/flutter_test.dart';
import 'package:therapyos_mobile/core/api_client.dart';
import 'package:therapyos_mobile/core/token_store.dart';

import 'support/fake_backend.dart';

void main() {
  late FakeBackend backend;
  late MemoryTokenStore tokens;

  setUp(() async {
    backend = FakeBackend();
    tokens = MemoryTokenStore();
    await tokens.write(const Tokens(accessToken: 'access-1', refreshToken: 'refresh-1'));
  });

  test('unwraps the response envelope and sends the bearer token', () async {
    backend.routes['GET /auth/me'] = (r) => {'name': 'Anita', 'auth': r.headers['Authorization']};
    final me = await backend.api(tokens: tokens).get('/auth/me') as Map<String, dynamic>;
    expect(me['name'], 'Anita');
    expect(me['auth'], 'Bearer access-1');
  });

  test('maps error envelopes to ApiException with code, status and details', () async {
    backend.routes['POST /auth/login'] = (_) => FakeBackend.error(400, 'TENANT_REQUIRED', 'Choose a business', {
          'tenants': [
            {'slug': 'a', 'name': 'A'},
          ],
        });
    final api = backend.api();
    await expectLater(
      api.postPublic('/auth/login', {'identifier': 'x', 'password': 'y'}),
      throwsA(isA<ApiException>().having((e) => e.code, 'code', 'TENANT_REQUIRED').having((e) => e.status, 'status', 400).having((e) => e.details?['tenants'], 'details', isNotEmpty)),
    );
  });

  test('drops empty query parameters', () async {
    backend.routes['GET /portal/branches'] = (r) => r.url.queryParameters;
    final q = await backend.api(tokens: tokens).get('/portal/branches', query: {'lat': null, 'lng': '', 'city': 'Bengaluru'}) as Map<String, dynamic>;
    expect(q, {'city': 'Bengaluru'});
  });

  test('page() returns items with the total from meta', () async {
    backend.routes['GET /sessions'] = (_) => FakeBackend.json(200, {
          'success': true,
          'data': [
            {'id': '1'},
            {'id': '2'},
          ],
          'meta': {'total': 17},
        });
    final page = await backend.api(tokens: tokens).page('/sessions');
    expect(page.items.map((e) => e['id']), ['1', '2']);
    expect(page.total, 17);
  });

  test('refreshes an expired access token once and retries, sharing the refresh between concurrent calls', () async {
    var refreshes = 0;
    backend.routes['GET /sessions/my-day'] = (r) => r.headers['Authorization'] == 'Bearer access-2' ? {'ok': true} : FakeBackend.error(401, 'UNAUTHENTICATED', 'Expired');
    backend.routes['POST /auth/refresh'] = (_) {
      refreshes++;
      return {'accessToken': 'access-2', 'refreshToken': 'refresh-2'};
    };
    final api = backend.api(tokens: tokens);
    final results = await Future.wait([api.get('/sessions/my-day'), api.get('/sessions/my-day')]);
    expect(results, everyElement(containsPair('ok', true)));
    expect(refreshes, 1);
    expect(backend.bodyOf('POST /auth/refresh')['refreshToken'], 'refresh-1');
    expect((await tokens.read())!.refreshToken, 'refresh-2');
  });

  test('accepts refresh responses nested under data.tokens', () async {
    backend.routes['GET /portal/me'] = (r) => r.headers['Authorization'] == 'Bearer c-2' ? {'ok': true} : FakeBackend.error(401, 'UNAUTHENTICATED', 'Expired');
    backend.routes['POST /portal/auth/refresh'] = (_) => {
          'tokens': {'accessToken': 'c-2', 'refreshToken': 'cr-2'},
        };
    final res = await backend.api(tokens: tokens, refreshPath: '/portal/auth/refresh').get('/portal/me');
    expect(res, {'ok': true});
  });

  test('clears the session when the refresh token is rejected', () async {
    var expired = false;
    backend.routes['GET /auth/me'] = (_) => FakeBackend.error(401, 'UNAUTHENTICATED', 'Expired');
    backend.routes['POST /auth/refresh'] = (_) => FakeBackend.error(401, 'TOKEN_REUSED', 'Sign in again');
    final api = backend.api(tokens: tokens)..onSessionExpired = () => expired = true;
    await expectLater(api.get('/auth/me'), throwsA(isA<ApiException>().having((e) => e.isUnauthenticated, 'unauthenticated', true)));
    expect(expired, isTrue);
    expect(await tokens.read(), isNull);
  });
}
