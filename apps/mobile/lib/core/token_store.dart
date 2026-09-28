import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class Tokens {
  const Tokens({required this.accessToken, required this.refreshToken});
  final String accessToken;
  final String refreshToken;

  factory Tokens.fromJson(Map<String, dynamic> json) => Tokens(accessToken: json['accessToken'] as String, refreshToken: json['refreshToken'] as String);
}

abstract class TokenStore {
  Future<Tokens?> read();
  Future<void> write(Tokens tokens);
  Future<void> clear();
}

/// Keychain / Keystore backed storage; each app flavor uses its own namespace.
class SecureTokenStore implements TokenStore {
  SecureTokenStore(this.namespace);
  final String namespace;
  static const _storage = FlutterSecureStorage();

  String get _access => '$namespace.access';
  String get _refresh => '$namespace.refresh';

  @override
  Future<Tokens?> read() async {
    final access = await _storage.read(key: _access);
    final refresh = await _storage.read(key: _refresh);
    if (access == null || refresh == null) return null;
    return Tokens(accessToken: access, refreshToken: refresh);
  }

  @override
  Future<void> write(Tokens tokens) async {
    await _storage.write(key: _access, value: tokens.accessToken);
    await _storage.write(key: _refresh, value: tokens.refreshToken);
  }

  @override
  Future<void> clear() async {
    await _storage.delete(key: _access);
    await _storage.delete(key: _refresh);
  }
}

class MemoryTokenStore implements TokenStore {
  Tokens? _tokens;

  @override
  Future<Tokens?> read() async => _tokens;

  @override
  Future<void> write(Tokens tokens) async => _tokens = tokens;

  @override
  Future<void> clear() async => _tokens = null;
}
