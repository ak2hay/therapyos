import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'token_store.dart';

class ApiException implements Exception {
  ApiException(this.code, this.message, {this.status = 0, this.details});

  final String code;
  final String message;
  final int status;
  final Map<String, dynamic>? details;

  bool get isUnauthenticated => status == 401;

  @override
  String toString() => message;
}

class Paged<T> {
  Paged(this.items, this.total);
  final List<T> items;
  final int total;
}

/// Thin client for the TherapyOS REST API: unwraps the `{ success, data, meta }` envelope, maps errors to
/// [ApiException] and transparently rotates the access token once when it expires.
class ApiClient {
  ApiClient({required this.baseUrl, required this.tokens, required this.refreshPath, http.Client? client}) : _http = client ?? http.Client();

  final String baseUrl;
  final TokenStore tokens;
  final String refreshPath;
  final http.Client _http;

  /// Called when the session cannot be refreshed any more (the user must sign in again).
  void Function()? onSessionExpired;
  Completer<bool>? _refreshing;

  Future<dynamic> get(String path, {Map<String, Object?>? query}) => _send('GET', path, query: query);
  Future<dynamic> post(String path, [Object? body]) => _send('POST', path, body: body ?? const {});
  Future<dynamic> patch(String path, Object body) => _send('PATCH', path, body: body);
  Future<dynamic> delete(String path) => _send('DELETE', path);

  Future<Paged<Map<String, dynamic>>> page(String path, {Map<String, Object?>? query}) async {
    final res = await _send('GET', path, query: query, withMeta: true) as Map<String, dynamic>;
    final items = (res['data'] as List).cast<Map<String, dynamic>>();
    final meta = res['meta'] as Map<String, dynamic>?;
    return Paged(items, (meta?['total'] as num?)?.toInt() ?? items.length);
  }

  /// Public call that never sends or refreshes credentials (sign-in, OTP).
  Future<dynamic> postPublic(String path, Object body) => _send('POST', path, body: body, auth: false);

  Uri _uri(String path, Map<String, Object?>? query) {
    final params = <String, String>{};
    query?.forEach((k, v) {
      if (v != null && '$v'.isNotEmpty) params[k] = '$v';
    });
    final uri = Uri.parse('$baseUrl$path');
    return params.isEmpty ? uri : uri.replace(queryParameters: {...uri.queryParameters, ...params});
  }

  Future<dynamic> _send(String method, String path, {Object? body, Map<String, Object?>? query, bool auth = true, bool retried = false, bool withMeta = false}) async {
    final headers = <String, String>{'Accept': 'application/json'};
    if (body != null) headers['Content-Type'] = 'application/json';
    if (auth) {
      final t = await tokens.read();
      if (t != null) headers['Authorization'] = 'Bearer ${t.accessToken}';
    }
    final request = http.Request(method, _uri(path, query))..headers.addAll(headers);
    if (body != null) request.body = jsonEncode(body);

    http.Response res;
    try {
      res = await http.Response.fromStream(await _http.send(request).timeout(const Duration(seconds: 30)));
    } on TimeoutException {
      throw ApiException('NETWORK', 'The server took too long to respond. Check your connection and try again.');
    } catch (_) {
      throw ApiException('NETWORK', 'Could not reach TherapyOS. Check your internet connection.');
    }

    Map<String, dynamic>? json;
    if (res.body.isNotEmpty) {
      try {
        json = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      } catch (_) {
        json = null;
      }
    }
    if (res.statusCode >= 200 && res.statusCode < 300) {
      if (json == null) return null;
      if (withMeta) return json;
      return json.containsKey('success') ? json['data'] : json;
    }

    final error = (json?['error'] as Map<String, dynamic>?) ?? const {};
    final code = (error['code'] as String?) ?? 'HTTP_${res.statusCode}';
    final message = (error['message'] as String?) ?? 'Something went wrong (${res.statusCode}).';
    if (res.statusCode == 401 && auth && !retried && await _refresh()) {
      return _send(method, path, body: body, query: query, auth: auth, retried: true, withMeta: withMeta);
    }
    if (res.statusCode == 401 && auth) {
      await tokens.clear();
      onSessionExpired?.call();
    }
    throw ApiException(code, message, status: res.statusCode, details: error['details'] as Map<String, dynamic>?);
  }

  /// Rotates the refresh token; concurrent callers share one refresh request.
  Future<bool> _refresh() {
    final pending = _refreshing;
    if (pending != null) return pending.future;
    final completer = _refreshing = Completer<bool>();
    () async {
      try {
        final current = await tokens.read();
        if (current == null) return completer.complete(false);
        final data = await _send('POST', refreshPath, body: {'refreshToken': current.refreshToken}, auth: false) as Map<String, dynamic>;
        final fresh = (data['tokens'] as Map<String, dynamic>?) ?? data;
        await tokens.write(Tokens.fromJson(fresh));
        completer.complete(true);
      } catch (_) {
        completer.complete(false);
      } finally {
        _refreshing = null;
      }
    }();
    return completer.future;
  }
}
