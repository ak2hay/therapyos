import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:therapyos_mobile/core/api_client.dart';
import 'package:therapyos_mobile/core/token_store.dart';

typedef Handler = Object? Function(http.Request request);

/// In-memory TherapyOS API: routes are `'METHOD /path'` (without the `/api/v1` prefix) and return the
/// `data` payload, or an [http.Response] for errors.
class FakeBackend {
  final routes = <String, Handler>{};
  final requests = <http.Request>[];

  static const base = 'http://api.test/api/v1';

  List<String> get calls => requests.map(_key).toList();

  static String _key(http.Request r) => '${r.method} ${r.url.path.replaceFirst('/api/v1', '')}';

  Map<String, dynamic> bodyOf(String route) => jsonDecode(requests.lastWhere((r) => _key(r) == route).body) as Map<String, dynamic>;

  late final MockClient client = MockClient((request) async {
    requests.add(request);
    final handler = routes[_key(request)];
    if (handler == null) return error(404, 'NOT_FOUND', 'No route for ${_key(request)}');
    final result = handler(request);
    if (result is http.Response) return result;
    return json(200, {'success': true, 'data': result});
  });

  ApiClient api({TokenStore? tokens, String refreshPath = '/auth/refresh'}) => ApiClient(baseUrl: base, tokens: tokens ?? MemoryTokenStore(), refreshPath: refreshPath, client: client);

  static http.Response json(int status, Object body) => http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json; charset=utf-8'});

  static http.Response error(int status, String code, String message, [Map<String, dynamic>? details]) =>
      json(status, {'success': false, 'error': {'code': code, 'message': message, 'details': ?details}});
}
